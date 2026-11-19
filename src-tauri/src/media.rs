//! Media Controls: what this machine is playing, as the OS reports it, and play / pause / skip / seek.
//!
//! - Windows: the system media sessions (`GlobalSystemMediaTransportControlsSessionManager`), the
//!   ones the volume flyout shows. Any app that shows there (Spotify, a browser tab, Media Player).
//! - Linux: MPRIS players through `playerctl`, when it is installed.
//! - macOS: none yet; `media_watch` says so and the dock stays hidden.
//!
//! `media_watch` streams the sessions (the OS's current one first) until `media_unwatch` or the
//! next `media_watch`. It polls, and sends only when something changed: a playing position that
//! moves as expected is not a change, since the page runs the clock itself from `position` and `at`.
//! Always this machine, whatever Environment the active project is on.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Stable for the app's session: Windows' app id, or the MPRIS player name.
    pub id: String,
    /// The app, for people: "Spotify", "Edge".
    pub app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    /// Seconds into the track at `at`, when the app says.
    pub position: Option<f64>,
    /// Unix ms the position was true at; the page adds the time since while playing.
    pub at: u64,
    /// Seconds, when the app says.
    pub duration: Option<f64>,
    pub can_prev: bool,
    pub can_next: bool,
    pub can_seek: bool,
    /// The artwork as a data: or http(s) URL.
    pub art: Option<String>,
}

impl Session {
    /// Where the position should be by `now` if it simply played on.
    fn expected(&self, now: u64) -> Option<f64> {
        let p = self.position?;
        Some(if self.playing { p + now.saturating_sub(self.at) as f64 / 1000.0 } else { p })
    }
}

/// The same but for a position that played on as expected.
fn changed(old: &[Session], new: &[Session]) -> bool {
    if old.len() != new.len() {
        return true;
    }
    let now = now_ms();
    old.iter().zip(new).any(|(a, b)| {
        let same = Session { position: None, at: 0, ..a.clone() } == Session { position: None, at: 0, ..b.clone() };
        let drift = match (a.expected(now), b.expected(now)) {
            (Some(x), Some(y)) => (x - y).abs() > 1.5,
            (None, None) => false,
            _ => true,
        };
        !same || drift
    })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The watcher that is current; an older thread sees the number move on and ends.
static GEN: AtomicU64 = AtomicU64::new(0);
/// A control just ran: read again now rather than at the next tick.
static POKE: AtomicBool = AtomicBool::new(false);

/// Stream the sessions to `on` until unwatched. Err on a system with no media sessions to read.
#[tauri::command]
pub fn media_watch(on: Channel<Vec<Session>>) -> Result<(), String> {
    if !sys::SUPPORTED {
        return Err("media controls aren't available on this system".into());
    }
    let me = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::Builder::new()
        .name("media".into())
        .spawn(move || {
            let mut reader = sys::Reader::default();
            let mut last: Option<Vec<Session>> = None;
            while GEN.load(Ordering::SeqCst) == me {
                let now = reader.read();
                if last.as_ref().is_none_or(|l| changed(l, &now)) {
                    if on.send(now.clone()).is_err() {
                        break;
                    }
                    last = Some(now);
                }
                // A second between reads, cut short by a control or an unwatch.
                for _ in 0..10 {
                    if POKE.swap(false, Ordering::SeqCst) || GEN.load(Ordering::SeqCst) != me {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn media_unwatch() {
    GEN.fetch_add(1, Ordering::SeqCst);
}

/// `action` is "toggle", "next", "prev" or "seek" (to `position` seconds), on session `id`.
#[tauri::command]
pub async fn media_control(id: String, action: String, position: Option<f64>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = sys::control(&id, &action, position);
        // The OS takes a moment to report the new state.
        std::thread::sleep(Duration::from_millis(150));
        POKE.store(true, Ordering::SeqCst);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Spotify.exe" → "Spotify"; "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → "ZuneMusic".
#[cfg_attr(not(windows), allow(dead_code))]
fn app_name(id: &str) -> String {
    let tail = id.rsplit('!').next().unwrap_or(id);
    let tail = tail.rsplit(['\\', '/']).next().unwrap_or(tail);
    let tail = tail.strip_suffix(".exe").or_else(|| tail.strip_suffix(".EXE")).unwrap_or(tail);
    let tail = tail.rsplit('.').next().unwrap_or(tail);
    match tail.to_ascii_lowercase().as_str() {
        "msedge" => "Edge".into(),
        "chrome" => "Chrome".into(),
        "firefox" => "Firefox".into(),
        "spotify" | "spotifymusic" => "Spotify".into(),
        "zunemusic" | "mediaplayer" => "Media Player".into(),
        "vlc" => "VLC".into(),
        "brave" => "Brave".into(),
        "" => id.into(),
        _ => {
            let mut c = tail.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        }
    }
}

#[cfg(windows)]
mod sys {
    use super::{Session, app_name, now_ms};
    use base64::Engine as _;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Smtc, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    pub const SUPPORTED: bool = true;

    /// 100 ns ticks per second, for TimeSpan and DateTime.
    const TICKS: f64 = 10_000_000.0;
    /// DateTime counts from 1601; Unix time from 1970.
    const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;

    #[derive(Default)]
    pub struct Reader {
        manager: Option<Manager>,
        /// The artwork read last, by session id and track, so it is read once per track.
        art: Vec<(String, String, Option<String>)>,
    }

    impl Reader {
        pub fn read(&mut self) -> Vec<Session> {
            if self.manager.is_none() {
                self.manager = Manager::RequestAsync().and_then(|op| op.join()).ok();
            }
            let Some(m) = &self.manager else { return Vec::new() };
            let current = m.GetCurrentSession().ok().and_then(|s| s.SourceAppUserModelId().ok()).map(|h| h.to_string_lossy());
            let Ok(list) = m.GetSessions() else {
                self.manager = None;
                return Vec::new();
            };
            let mut out: Vec<Session> = list.into_iter().filter_map(|s| self.session(&s)).collect();
            if let Some(c) = current
                && let Some(i) = out.iter().position(|s| s.id == c)
            {
                let s = out.remove(i);
                out.insert(0, s);
            }
            out
        }

        fn session(&mut self, s: &Smtc) -> Option<Session> {
            let id = s.SourceAppUserModelId().ok()?.to_string_lossy();
            let props = s.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
            let title = props.Title().map(|h| h.to_string_lossy()).unwrap_or_default();
            let artist = props.Artist().map(|h| h.to_string_lossy()).unwrap_or_default();
            if title.is_empty() && artist.is_empty() {
                return None;
            }
            let info = s.GetPlaybackInfo().ok()?;
            let playing = info.PlaybackStatus().map(|st| st == Status::Playing).unwrap_or(false);
            let controls = info.Controls().ok();
            let can = |f: fn(&windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackControls) -> windows::core::Result<bool>| {
                controls.as_ref().and_then(|c| f(c).ok()).unwrap_or(false)
            };
            let (mut position, mut duration, mut at) = (None, None, now_ms());
            if let Ok(t) = s.GetTimelineProperties() {
                let start = t.StartTime().map(|x| x.Duration).unwrap_or(0);
                let end = t.EndTime().map(|x| x.Duration).unwrap_or(0);
                if end > start {
                    duration = Some((end - start) as f64 / TICKS);
                    position = t.Position().ok().map(|p| ((p.Duration - start).max(0)) as f64 / TICKS);
                    if let Ok(u) = t.LastUpdatedTime() {
                        let ms = u.UniversalTime / 10_000 - EPOCH_DIFF_MS;
                        if ms > 0 && (ms as u64) <= at {
                            at = ms as u64;
                        }
                    }
                }
            }
            let track = format!("{title}\u{1f}{artist}");
            let art = match self.art.iter().find(|(i, t, _)| *i == id && *t == track) {
                Some((_, _, a)) => a.clone(),
                None => {
                    let a = thumbnail(&props).ok().flatten();
                    self.art.retain(|(i, _, _)| *i != id);
                    self.art.push((id.clone(), track, a.clone()));
                    a
                }
            };
            Some(Session {
                app: app_name(&id),
                id,
                title,
                artist,
                album: props.AlbumTitle().map(|h| h.to_string_lossy()).unwrap_or_default(),
                playing,
                position,
                at,
                duration,
                can_prev: can(|c| c.IsPreviousEnabled()),
                can_next: can(|c| c.IsNextEnabled()),
                can_seek: can(|c| c.IsPlaybackPositionEnabled()) && duration.is_some(),
                art,
            })
        }
    }

    /// The track's artwork as a data URL; None when the app gives none.
    fn thumbnail(
        props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
    ) -> windows::core::Result<Option<String>> {
        let Ok(r) = props.Thumbnail() else { return Ok(None) };
        let stream = r.OpenReadAsync()?.join()?;
        let size = stream.Size()? as u32;
        if size == 0 || size > 4 * 1024 * 1024 {
            return Ok(None);
        }
        let mime = stream.ContentType().map(|h| h.to_string_lossy()).unwrap_or_default();
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        let n = reader.LoadAsync(size)?.join()?;
        let mut buf = vec![0u8; n as usize];
        reader.ReadBytes(&mut buf)?;
        let mime = if mime.starts_with("image/") { mime } else { "image/png".into() };
        Ok(Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf))))
    }

    pub fn control(id: &str, action: &str, position: Option<f64>) -> Result<(), String> {
        let e = |e: windows::core::Error| e.message().to_string();
        let m = Manager::RequestAsync().and_then(|op| op.join()).map_err(e)?;
        let s = m
            .GetSessions()
            .map_err(e)?
            .into_iter()
            .find(|s| s.SourceAppUserModelId().map(|h| h.to_string_lossy() == id).unwrap_or(false))
            .ok_or("that player has closed")?;
        let ok = match action {
            "toggle" => s.TryTogglePlayPauseAsync().and_then(|o| o.join()),
            "next" => s.TrySkipNextAsync().and_then(|o| o.join()),
            "prev" => s.TrySkipPreviousAsync().and_then(|o| o.join()),
            "seek" => {
                let start = s.GetTimelineProperties().and_then(|t| t.StartTime()).map(|t| t.Duration).unwrap_or(0);
                let to = start + (position.unwrap_or(0.0).max(0.0) * TICKS) as i64;
                s.TryChangePlaybackPositionAsync(to).and_then(|o| o.join())
            }
            _ => return Err(format!("unknown media action {action}")),
        }
        .map_err(e)?;
        if ok { Ok(()) } else { Err(format!("{} didn't take {action}", app_name(id))) }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod sys {
    //! MPRIS through playerctl: one call lists every player, a field per tab.
    use super::{Session, now_ms};
    use base64::Engine as _;
    use std::process::Command;

    pub const SUPPORTED: bool = true;

    const FORMAT: &str = "{{playerName}}\t{{status}}\t{{title}}\t{{artist}}\t{{album}}\t{{mpris:length}}\t{{position}}\t{{mpris:artUrl}}";

    #[derive(Default)]
    pub struct Reader {
        art: Vec<(String, Option<String>)>,
        /// playerctl isn't installed: stop trying.
        missing: bool,
    }

    impl Reader {
        pub fn read(&mut self) -> Vec<Session> {
            if self.missing {
                return Vec::new();
            }
            let out = match Command::new("playerctl").args(["-a", "metadata", "--format", FORMAT]).output() {
                Ok(o) => o,
                Err(_) => {
                    self.missing = true;
                    return Vec::new();
                }
            };
            let at = now_ms();
            let mut v: Vec<Session> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|l| {
                    let f: Vec<&str> = l.split('\t').collect();
                    let [name, status, title, artist, album, len, pos, art] = f.as_slice() else { return None };
                    if title.is_empty() && artist.is_empty() {
                        return None;
                    }
                    let us = |s: &str| s.trim().parse::<f64>().ok().map(|x| x / 1_000_000.0);
                    let duration = us(len).filter(|d| *d > 0.0);
                    Some(Session {
                        id: name.to_string(),
                        app: pretty(name),
                        title: title.to_string(),
                        artist: artist.to_string(),
                        album: album.to_string(),
                        playing: *status == "Playing",
                        position: us(pos),
                        at,
                        duration,
                        can_prev: true,
                        can_next: true,
                        can_seek: duration.is_some(),
                        art: self.art(art),
                    })
                })
                .collect();
            // Playing first, as the OS's "current" one.
            v.sort_by_key(|s| !s.playing);
            v
        }

        fn art(&mut self, url: &str) -> Option<String> {
            if url.is_empty() {
                return None;
            }
            if let Some((_, a)) = self.art.iter().find(|(u, _)| u == url) {
                return a.clone();
            }
            let a = if let Some(path) = url.strip_prefix("file://") {
                std::fs::read(path).ok().filter(|b| b.len() < 4 * 1024 * 1024).map(|b| {
                    let mime = if path.ends_with(".png") { "image/png" } else { "image/jpeg" };
                    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(b))
                })
            } else if url.starts_with("https://") || url.starts_with("http://") {
                Some(url.to_string())
            } else {
                None
            };
            if self.art.len() > 16 {
                self.art.remove(0);
            }
            self.art.push((url.to_string(), a.clone()));
            a
        }
    }

    /// "spotify" → "Spotify", "firefox.instance_1_42" → "Firefox".
    fn pretty(name: &str) -> String {
        let base = name.split('.').next().unwrap_or(name);
        let mut c = base.chars();
        c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
    }

    pub fn control(id: &str, action: &str, position: Option<f64>) -> Result<(), String> {
        let pos;
        let args: Vec<&str> = match action {
            "toggle" => vec!["play-pause"],
            "next" => vec!["next"],
            "prev" => vec!["previous"],
            "seek" => {
                pos = format!("{:.2}", position.unwrap_or(0.0).max(0.0));
                vec!["position", &pos]
            }
            _ => return Err(format!("unknown media action {action}")),
        };
        let out = Command::new("playerctl").arg("-p").arg(id).args(args).output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    }
}

#[cfg(not(any(windows, all(unix, not(target_os = "macos")))))]
mod sys {
    use super::Session;

    pub const SUPPORTED: bool = false;

    #[derive(Default)]
    pub struct Reader;

    impl Reader {
        pub fn read(&mut self) -> Vec<Session> {
            Vec::new()
        }
    }

    pub fn control(_: &str, _: &str, _: Option<f64>) -> Result<(), String> {
        Err("media controls aren't available on this system".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(pos: f64, at: u64, playing: bool) -> Session {
        Session {
            id: "a".into(), app: "A".into(), title: "t".into(), artist: "r".into(), album: String::new(), playing,
            position: Some(pos), at, duration: Some(200.0), can_prev: true, can_next: true, can_seek: true, art: None,
        }
    }

    #[test]
    fn playing_on_is_not_a_change() {
        let now = now_ms();
        assert!(!changed(&[s(10.0, now - 5000, true)], &[s(15.0, now, true)]));
    }

    #[test]
    fn a_seek_or_pause_is() {
        let now = now_ms();
        assert!(changed(&[s(10.0, now - 5000, true)], &[s(60.0, now, true)]));
        assert!(changed(&[s(10.0, now, true)], &[s(10.0, now, false)]));
    }

    #[test]
    fn app_names() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("MSEdge"), "Edge");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(app_name("308046B0AF4A39CB"), "308046B0AF4A39CB");
    }
}
