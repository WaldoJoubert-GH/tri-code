//! The operating system's own alert sounds, offered as signal sounds: macOS's /System/Library/Sounds
//! (and the user's ~/Library/Sounds), Windows' Media folder, the freedesktop theme on Linux.
//! A sound is named by its file stem; loading looks the name up in the listing again, so a name
//! can never reach outside these folders.

use std::path::PathBuf;

use base64::Engine as _;

/// Where to look, most personal first: a name found twice plays the first one.
fn dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut v = Vec::new();
        if let Ok(home) = std::env::var("HOME") {
            v.push(PathBuf::from(home).join("Library/Sounds"));
        }
        v.push(PathBuf::from("/Library/Sounds"));
        v.push(PathBuf::from("/System/Library/Sounds"));
        v
    }
    #[cfg(windows)]
    {
        let root = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
        vec![PathBuf::from(root).join("Media")]
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        vec![PathBuf::from("/usr/share/sounds/freedesktop/stereo")]
    }
}

const EXTS: &[&str] = &["aiff", "aif", "caf", "wav", "mp3", "m4a", "oga", "ogg"];
/// Larger files are music or startup jingles, not alerts.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

fn mime(ext: &str) -> &'static str {
    match ext {
        "aiff" | "aif" => "audio/aiff",
        "caf" => "audio/x-caf",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        _ => "audio/ogg",
    }
}

/// Every system sound as (name, file), sorted by name, the first of a repeated name kept.
fn listing() -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for dir in dirs() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let path = e.path();
            let ext = path.extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase()).unwrap_or_default();
            if !EXTS.contains(&ext.as_str()) || e.metadata().map(|m| !m.is_file() || m.len() > MAX_BYTES).unwrap_or(true) {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if !out.iter().any(|(n, _)| n.eq_ignore_ascii_case(name)) {
                out.push((name.to_string(), path.clone()));
            }
        }
    }
    out.sort_by_key(|(n, _)| n.to_lowercase());
    out
}

/// The names of the system's sounds, for the signal sound pickers.
#[tauri::command]
pub async fn system_sounds() -> Vec<String> {
    listing().into_iter().map(|(n, _)| n).collect()
}

/// One system sound as a data URL, or None when this machine has no sound by that name.
#[tauri::command]
pub async fn system_sound_load(name: String) -> Result<Option<String>, String> {
    let Some((_, path)) = listing().into_iter().find(|(n, _)| *n == name) else { return Ok(None) };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    Ok(Some(format!("data:{};base64,{}", mime(&ext), base64::engine::general_purpose::STANDARD.encode(bytes))))
}
