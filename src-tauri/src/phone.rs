//! Remote Control: the agents on your phone. While it is on, a small web server on
//! 127.0.0.1 serves the phone page (`phone/`) and a WebSocket, and `tailscale serve` puts it
//! on the tailnet over HTTPS, which Web Push needs. Nothing listens on the LAN.
//!
//! The frontend owns the agent list and their signals; it sends a snapshot here
//! (`phone_agents`) whenever it changes, and asks for a push when a signal alerts
//! (`phone_push`). Terminal output and input go straight between the phone and the PTY.
//!
//! A phone pairs once with a short code from Settings › Remote and keeps a device token;
//! only the token's hash is stored, beside the VAPID key, in `phone.json`. So is whether it is
//! on, so it comes back on with the app (kept here, not in state.json, which every tri-code
//! running on the machine rewrites).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use p256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, oneshot, watch};

use crate::pty::Ptys;
use crate::push::{self, PushError, Subscription};

/// Where the server listens, and the tailnet HTTPS port `tailscale serve` maps to it. Not 443,
/// which is often serving something else on the same machine.
const PORT: u16 = 7520;
const TS_PORT: u16 = 7443;
const PAIR_TTL: Duration = Duration::from_secs(10 * 60);
const PAIR_TRIES: u32 = 5;

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    name: String,
    /// SHA-256 of the device token, hex.
    token: String,
    added: u64,
    seen: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    push: Option<Subscription>,
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    /// Turned on and not turned off since: the frontend starts it again at launch.
    #[serde(default)]
    on: bool,
    /// The VAPID private key, base64url.
    vapid: Option<String>,
    devices: Vec<Device>,
}

struct Pairing {
    code: String,
    until: Instant,
    tries: u32,
}

struct Inner {
    saved: Saved,
    vapid: SigningKey,
    pairing: Option<Pairing>,
    /// The tailnet URL and the server's shutdown, while on.
    running: Option<(String, oneshot::Sender<()>)>,
    /// Phones watching each PTY. While any are, the PTY has the phone's size.
    holds: HashMap<u32, usize>,
    /// Open sockets per device.
    online: HashMap<String, usize>,
}

pub struct Phone {
    app: AppHandle,
    ptys: Arc<Ptys>,
    inner: Mutex<Inner>,
    /// The frontend's latest agents snapshot (JSON), sent to every phone on change.
    agents: watch::Sender<String>,
    /// Ends sockets: `None` all of them (server stopped), `Some(id)` one device's (forgotten).
    kick: broadcast::Sender<Option<String>>,
}

#[derive(Serialize)]
pub struct DeviceView {
    id: String,
    name: String,
    added: u64,
    seen: u64,
    online: bool,
    push: bool,
}

#[derive(Serialize)]
pub struct Status {
    url: Option<String>,
    /// Should be serving: on at launch, or retrying while Tailscale isn't up yet.
    on: bool,
    devices: Vec<DeviceView>,
}

#[derive(Serialize)]
pub struct PairInfo {
    code: String,
    url: String,
    qr: String,
    seconds: u64,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn random(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("os random");
    b
}

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Pair codes are typed on a phone: no 0/O, 1/I/L.
fn pair_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    random(6).iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

fn saved_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("phone.json"))
}

impl Phone {
    pub fn new(app: AppHandle, ptys: Arc<Ptys>) -> Arc<Self> {
        let saved: Saved = saved_file(&app)
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let vapid = push::vapid_key(saved.vapid.as_deref());
        let phone = Arc::new(Self {
            app,
            ptys,
            inner: Mutex::new(Inner {
                saved,
                vapid,
                pairing: None,
                running: None,
                holds: HashMap::new(),
                online: HashMap::new(),
            }),
            agents: watch::channel(r#"{"projects":[]}"#.to_string()).0,
            kick: broadcast::channel(16).0,
        });
        let mut inner = phone.inner.lock().unwrap();
        if inner.saved.vapid.is_none() {
            inner.saved.vapid = Some(push::vapid_private(&inner.vapid));
            phone.save(&inner);
        }
        drop(inner);
        phone
    }

    fn save(&self, inner: &Inner) {
        let write = || -> Result<(), String> {
            let path = saved_file(&self.app)?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_string_pretty(&inner.saved).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
        };
        if let Err(e) = write() {
            eprintln!("phone.json: {e}");
        }
    }

    /// Tell the frontend to re-read the status (a phone paired, came online, subscribed, ...).
    fn changed(&self) {
        let _ = self.app.emit("phone-changed", ());
    }

    fn status(&self) -> Status {
        let inner = self.inner.lock().unwrap();
        Status {
            url: inner.running.as_ref().map(|(u, _)| u.clone()),
            on: inner.saved.on,
            devices: inner
                .saved
                .devices
                .iter()
                .map(|d| DeviceView {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    added: d.added,
                    seen: d.seen,
                    online: inner.online.get(&d.id).is_some_and(|n| *n > 0),
                    push: d.push.is_some(),
                })
                .collect(),
        }
    }

    /// The device a token belongs to; marks it seen.
    fn device(&self, token: &str) -> Option<String> {
        let h = hash(token);
        let mut inner = self.inner.lock().unwrap();
        let d = inner.saved.devices.iter_mut().find(|d| d.token == h)?;
        d.seen = now();
        let id = d.id.clone();
        self.save(&inner);
        Some(id)
    }

    fn online(&self, device: &str, delta: isize) {
        let mut inner = self.inner.lock().unwrap();
        let n = inner.online.entry(device.to_string()).or_default();
        *n = n.saturating_add_signed(delta);
        drop(inner);
        self.changed();
    }

    /// A phone starts watching a PTY: it takes the phone's size until the last phone lets go.
    fn hold(&self, pty: u32, cols: u16, rows: u16) {
        let mut inner = self.inner.lock().unwrap();
        let n = inner.holds.entry(pty).or_default();
        *n += 1;
        let first = *n == 1;
        drop(inner);
        if first {
            let _ = self.app.emit("phone-hold", serde_json::json!({ "pty": pty, "held": true }));
        }
        if cols > 0 && rows > 0 {
            let _ = self.ptys.resize(pty, cols, rows);
        }
    }

    /// The frontend puts the desktop size back once no phone holds the PTY.
    fn release(&self, pty: u32) {
        let mut inner = self.inner.lock().unwrap();
        let Some(n) = inner.holds.get_mut(&pty) else { return };
        *n -= 1;
        let last = *n == 0;
        if last {
            inner.holds.remove(&pty);
        }
        drop(inner);
        if last {
            let _ = self.app.emit("phone-hold", serde_json::json!({ "pty": pty, "held": false }));
        }
    }

    fn stop(&self) {
        let running = self.inner.lock().unwrap().running.take();
        if let Some((_, shutdown)) = running {
            let _ = shutdown.send(());
            let _ = self.kick.send(None);
            if let Err(e) = tailscale_off() {
                eprintln!("tailscale serve off: {e}");
            }
        }
    }

    /// App exit: take the tailnet port down so it doesn't point at nothing.
    pub fn shutdown(&self) {
        self.stop();
    }
}

// ---------- tailscale ----------

fn tailscale() -> Command {
    let mut program = "tailscale".to_string();
    for p in [r"C:\Program Files\Tailscale\tailscale.exe", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] {
        if std::path::Path::new(p).exists() {
            program = p.to_string();
        }
    }
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run tailscale with `args`, giving up after `limit`: `serve` waits for you to enable Serve
/// in the admin console when it isn't yet, and prints the link to do it.
fn run_tailscale(args: &[&str], limit: Duration) -> Result<String, String> {
    let mut child = tailscale().args(args).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Tailscale isn't installed: get it from tailscale.com/download, on this computer and your phone".to_string()
        } else {
            e.to_string()
        }
    })?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let read_out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut out, &mut s);
        s
    });
    let read_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut err, &mut s);
        s
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(s);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let text = format!("{}{}", read_out.join().unwrap_or_default(), read_err.join().unwrap_or_default());
    match status {
        Some(s) if s.success() => Ok(text),
        Some(_) => Err(text.trim().to_string()),
        None => Err(format!("tailscale didn't finish: {}", text.trim())),
    }
}

/// This machine's tailnet name, e.g. `laptop.tail1234.ts.net`.
fn tailnet_name() -> Result<String, String> {
    let json = run_tailscale(&["status", "--json"], Duration::from_secs(10))?;
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if v["BackendState"] != "Running" {
        return Err("Tailscale isn't connected: sign in and connect it on this computer".to_string());
    }
    let name = v["Self"]["DNSName"].as_str().unwrap_or("").trim_end_matches('.');
    if name.is_empty() {
        return Err("Tailscale has no name for this computer: turn on MagicDNS for your tailnet".to_string());
    }
    Ok(name.to_string())
}

fn tailscale_on() -> Result<String, String> {
    let name = tailnet_name()?;
    let https = format!("--https={TS_PORT}");
    let target = format!("http://127.0.0.1:{PORT}");
    run_tailscale(&["serve", "--bg", &https, &target], Duration::from_secs(20)).map_err(|e| {
        if e.contains("login.tailscale.com") || e.to_lowercase().contains("not enabled") {
            format!("Turn on Serve and HTTPS certificates for your tailnet, then try again: {e}")
        } else {
            e
        }
    })?;
    Ok(format!("https://{name}:{TS_PORT}"))
}

fn tailscale_off() -> Result<(), String> {
    run_tailscale(&["serve", &format!("--https={TS_PORT}"), "off"], Duration::from_secs(10)).map(|_| ())
}

// ---------- the web server ----------

type Shared = Arc<Phone>;

fn asset(content_type: &'static str, body: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "no-cache")], body).into_response()
}

fn router(phone: Shared) -> Router {
    Router::new()
        .route("/", get(|| async { asset("text/html; charset=utf-8", include_bytes!("../phone/index.html")) }))
        .route("/app.js", get(|| async { asset("text/javascript", include_bytes!("../phone/app.js")) }))
        .route("/app.css", get(|| async { asset("text/css", include_bytes!("../phone/app.css")) }))
        .route("/sw.js", get(|| async { asset("text/javascript", include_bytes!("../phone/sw.js")) }))
        .route("/icon.png", get(|| async { asset("image/png", include_bytes!("../icons/icon.png")) }))
        .route("/xterm.js", get(|| async { asset("text/javascript", include_bytes!("../../node_modules/@xterm/xterm/lib/xterm.js")) }))
        .route("/xterm.css", get(|| async { asset("text/css", include_bytes!("../../node_modules/@xterm/xterm/css/xterm.css")) }))
        .route("/addon-fit.js", get(|| async { asset("text/javascript", include_bytes!("../../node_modules/@xterm/addon-fit/lib/addon-fit.js")) }))
        .route("/manifest.webmanifest", get(manifest))
        .route("/api/pair", post(pair))
        .route("/api/push", post(subscribe))
        .route("/api/ws", get(socket))
        .with_state(phone)
}

#[derive(Deserialize)]
struct PairQuery {
    pair: Option<String>,
}

/// The pair code rides along in `start_url`: on iOS a Home Screen app has its own storage, so
/// it pairs on its first launch rather than in the Safari tab it was added from.
async fn manifest(Query(q): Query<PairQuery>) -> Response {
    let code: String = q.pair.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    let start = if code.is_empty() { "/".to_string() } else { format!("/?pair={code}") };
    let body = serde_json::json!({
        "name": "tri-code",
        "short_name": "tri-code",
        "start_url": start,
        "scope": "/",
        "display": "standalone",
        "background_color": "#0e0f12",
        "theme_color": "#0e0f12",
        "icons": [{ "src": "/icon.png", "sizes": "512x512", "type": "image/png" }],
    });
    ([(header::CONTENT_TYPE, "application/manifest+json")], body.to_string()).into_response()
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
    name: String,
}

async fn pair(State(phone): State<Shared>, axum::Json(b): axum::Json<PairBody>) -> Response {
    let code: String = b.code.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase();
    let mut inner = phone.inner.lock().unwrap();
    let ok = match inner.pairing.as_mut() {
        Some(p) if p.until > Instant::now() && p.tries < PAIR_TRIES => {
            if p.code == code {
                true
            } else {
                p.tries += 1;
                false
            }
        }
        _ => false,
    };
    if !ok {
        let gone = inner.pairing.as_ref().is_none_or(|p| p.until <= Instant::now() || p.tries >= PAIR_TRIES);
        let why = if gone { "That code has expired. Pair again from Settings › Remote in tri-code." } else { "That code is wrong." };
        return (StatusCode::FORBIDDEN, why).into_response();
    }
    inner.pairing = None;
    let token = B64.encode(random(32));
    let id: String = random(4).iter().map(|b| format!("{b:02x}")).collect();
    let name: String = b.name.chars().take(60).collect();
    inner.saved.devices.push(Device { id, name, token: hash(&token), added: now(), seen: now(), push: None });
    phone.save(&inner);
    let vapid = push::vapid_public(&inner.vapid);
    drop(inner);
    let _ = phone.app.emit("phone-paired", ());
    phone.changed();
    axum::Json(serde_json::json!({ "token": token, "vapid": vapid })).into_response()
}

fn bearer(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
}

async fn subscribe(State(phone): State<Shared>, headers: HeaderMap, axum::Json(sub): axum::Json<Subscription>) -> Response {
    let Some(id) = phone.device(bearer(&headers)) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let mut inner = phone.inner.lock().unwrap();
    if let Some(d) = inner.saved.devices.iter_mut().find(|d| d.id == id) {
        d.push = Some(sub);
    }
    phone.save(&inner);
    drop(inner);
    phone.changed();
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

async fn socket(State(phone): State<Shared>, Query(q): Query<WsQuery>, ws: WebSocketUpgrade) -> Response {
    // Upgrade either way: a browser can't read why a refused upgrade failed, but it can read a message.
    let device = phone.device(&q.token);
    ws.on_upgrade(move |socket| serve_socket(phone, socket, device))
}

/// What a phone sends over the socket.
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum FromPhone {
    /// Show a PTY: its recent output, then live output; take the phone's size.
    Watch { pty: u32, cols: u16, rows: u16 },
    /// The phone's terminal changed size (rotation, keyboard).
    Size { cols: u16, rows: u16 },
    Unwatch,
    Input { pty: u32, data: String },
}

fn text(v: serde_json::Value) -> Message {
    Message::Text(v.to_string().into())
}

/// Output of `pty`: its id (big-endian u32), then the bytes, so output that was in flight when
/// the phone switched agents can be told apart.
fn output(pty: u32, bytes: &[u8]) -> Message {
    let mut frame = Vec::with_capacity(4 + bytes.len());
    frame.extend_from_slice(&pty.to_be_bytes());
    frame.extend_from_slice(bytes);
    Message::Binary(frame.into())
}

async fn serve_socket(phone: Shared, mut ws: WebSocket, device: Option<String>) {
    let Some(device) = device else {
        let _ = ws.send(text(serde_json::json!({ "t": "bye", "why": "forgotten" }))).await;
        return;
    };
    let mut kick = phone.kick.subscribe();
    let mut agents = phone.agents.subscribe();
    phone.online(&device, 1);
    let vapid = push::vapid_public(&phone.inner.lock().unwrap().vapid);
    let hello = serde_json::json!({ "t": "hello", "vapid": vapid });
    let first = agents.borrow_and_update().clone();
    let mut watching: Option<(u32, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>)> = None;

    if ws.send(text(hello)).await.is_ok() && ws.send(Message::Text(format!(r#"{{"t":"agents","data":{first}}}"#).into())).await.is_ok() {
        loop {
            tokio::select! {
                msg = ws.recv() => {
                    let t = match msg {
                        Some(Ok(Message::Text(t))) => t,
                        Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                        Some(Ok(_)) => continue,
                    };
                    let Ok(cmd) = serde_json::from_str::<FromPhone>(t.as_str()) else { continue };
                    match cmd {
                        FromPhone::Watch { pty, cols, rows } => {
                            if let Some((old, _)) = watching.take() {
                                phone.release(old);
                            }
                            match phone.ptys.watch(pty) {
                                Ok((recent, rx)) => {
                                    phone.hold(pty, cols, rows);
                                    watching = Some((pty, rx));
                                    if ws.send(output(pty, &recent)).await.is_err() { break }
                                }
                                Err(_) => {
                                    if ws.send(text(serde_json::json!({ "t": "exit", "pty": pty }))).await.is_err() { break }
                                }
                            }
                        }
                        FromPhone::Size { cols, rows } => {
                            if let Some((pty, _)) = &watching {
                                let _ = phone.ptys.resize(*pty, cols, rows);
                            }
                        }
                        FromPhone::Unwatch => {
                            if let Some((old, _)) = watching.take() {
                                phone.release(old);
                            }
                        }
                        FromPhone::Input { pty, data } => {
                            let _ = phone.ptys.write(pty, data.as_bytes());
                        }
                    }
                }
                chunk = async {
                    match watching.as_mut() {
                        Some((_, rx)) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    let pty = watching.as_ref().map(|(p, _)| *p).unwrap_or_default();
                    match chunk {
                        Some(bytes) => if ws.send(output(pty, &bytes)).await.is_err() { break },
                        None => {
                            watching = None;
                            phone.release(pty);
                            if ws.send(text(serde_json::json!({ "t": "exit", "pty": pty }))).await.is_err() { break }
                        }
                    }
                }
                changed = agents.changed() => {
                    if changed.is_err() { break }
                    let snapshot = agents.borrow_and_update().clone();
                    if ws.send(Message::Text(format!(r#"{{"t":"agents","data":{snapshot}}}"#).into())).await.is_err() { break }
                }
                who = kick.recv() => {
                    match who {
                        Ok(Some(id)) if id != device => continue,
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Ok(Some(_)) => {
                            let _ = ws.send(text(serde_json::json!({ "t": "bye", "why": "forgotten" }))).await;
                            break;
                        }
                        _ => {
                            let _ = ws.send(text(serde_json::json!({ "t": "bye", "why": "stopped" }))).await;
                            break;
                        }
                    }
                }
            }
        }
    }
    if let Some((pty, _)) = watching {
        phone.release(pty);
    }
    phone.online(&device, -1);
}

// ---------- commands ----------

#[tauri::command]
pub async fn phone_start(phone: tauri::State<'_, Arc<Phone>>) -> Result<Status, String> {
    let phone = Arc::clone(phone.inner());
    if phone.inner.lock().unwrap().running.is_some() {
        return Ok(phone.status());
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", PORT))
        .await
        .map_err(|e| format!("couldn't listen on port {PORT}: {e}"))?;
    let (tx, rx) = oneshot::channel::<()>();
    let app = router(Arc::clone(&phone));
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(async { let _ = rx.await; }).await;
    });
    match tauri::async_runtime::spawn_blocking(tailscale_on).await.map_err(|e| e.to_string())? {
        Ok(url) => {
            let mut inner = phone.inner.lock().unwrap();
            inner.running = Some((url, tx));
            inner.saved.on = true;
            phone.save(&inner);
            drop(inner);
            phone.changed();
            Ok(phone.status())
        }
        Err(e) => {
            let _ = tx.send(());
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn phone_stop(phone: tauri::State<'_, Arc<Phone>>) -> Result<(), String> {
    let phone = Arc::clone(phone.inner());
    tauri::async_runtime::spawn_blocking(move || {
        phone.stop();
        let mut inner = phone.inner.lock().unwrap();
        inner.saved.on = false;
        phone.save(&inner);
        drop(inner);
        phone.changed();
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn phone_status(phone: tauri::State<'_, Arc<Phone>>) -> Status {
    phone.status()
}

/// A new pair code, with the link and its QR code (SVG).
#[tauri::command]
pub fn phone_pair(phone: tauri::State<'_, Arc<Phone>>) -> Result<PairInfo, String> {
    let mut inner = phone.inner.lock().unwrap();
    let base = inner.running.as_ref().map(|(u, _)| u.clone()).ok_or("Remote control is off")?;
    let code = pair_code();
    let url = format!("{base}/?pair={code}");
    let qr = qrcode::QrCode::new(url.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(180, 180)
        .quiet_zone(true)
        .build();
    inner.pairing = Some(Pairing { code: code.clone(), until: Instant::now() + PAIR_TTL, tries: 0 });
    Ok(PairInfo { code, url, qr, seconds: PAIR_TTL.as_secs() })
}

#[tauri::command]
pub fn phone_forget(phone: tauri::State<'_, Arc<Phone>>, id: String) {
    let mut inner = phone.inner.lock().unwrap();
    inner.saved.devices.retain(|d| d.id != id);
    phone.save(&inner);
    drop(inner);
    let _ = phone.kick.send(Some(id));
    phone.changed();
}

/// The frontend's agent snapshot, already JSON; phones get it as is.
#[tauri::command]
pub fn phone_agents(phone: tauri::State<'_, Arc<Phone>>, json: String) {
    if serde_json::from_str::<serde_json::Value>(&json).is_ok() {
        phone.agents.send_replace(json);
    }
}

/// Push a signal to every phone that allowed notifications. `tab` is what a tap opens. Fails with
/// the push services' answers when no phone took it.
#[tauri::command]
pub async fn phone_push(phone: tauri::State<'_, Arc<Phone>>, title: String, body: String, tab: String) -> Result<(), String> {
    let phone = Arc::clone(phone.inner());
    let (key, targets) = {
        let inner = phone.inner.lock().unwrap();
        if inner.running.is_none() {
            return Ok(());
        }
        let targets: Vec<_> = inner.saved.devices.iter().filter_map(|d| Some((d.id.clone(), d.push.clone()?))).collect();
        (inner.vapid.clone(), targets)
    };
    let payload = serde_json::json!({ "title": title, "body": body, "tab": tab }).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut gone = vec![];
        let mut errors = vec![];
        let mut sent = 0;
        for (id, sub) in targets {
            match push::send(&key, &sub, &payload) {
                Ok(()) => sent += 1,
                Err(PushError::Gone) => gone.push(id),
                Err(PushError::Other(e)) => errors.push(e),
            }
        }
        if !gone.is_empty() {
            let mut inner = phone.inner.lock().unwrap();
            for d in inner.saved.devices.iter_mut().filter(|d| gone.contains(&d.id)) {
                d.push = None;
            }
            phone.save(&inner);
            drop(inner);
            phone.changed();
        }
        if sent == 0 && !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
