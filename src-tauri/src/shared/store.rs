//! Persists app state (projects, tabs) as one JSON file in the app config dir.
//! The shape is owned by the frontend; Rust just stores the text safely: flushed to disk before it
//! replaces the old file, with an older copy to fall back on if the file is ever unreadable.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

/// How old the fallback copy may get before the next save refreshes it. Long enough that a bad
/// state which saved itself doesn't also overwrite the copy straight away.
const BACKUP_EVERY: Duration = Duration::from_secs(15 * 60);

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

fn backup_of(path: &Path) -> PathBuf {
    path.with_extension("backup.json")
}

fn readable(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).is_ok_and(|v| v.is_object())
}

/// The saved state, or the backup if it can't be read. An unreadable file is moved aside rather
/// than overwritten by the next save.
fn load(path: &Path) -> Result<Option<String>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return load_backup(path),
        // Not UTF-8: as unreadable as bad JSON.
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => String::new(),
        Err(e) => return Err(e.to_string()),
    };
    if readable(&text) {
        return Ok(Some(text));
    }
    let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let aside = path.with_extension(format!("unreadable-{stamp}.json"));
    eprintln!("state: {} can't be read, moving it to {}", path.display(), aside.display());
    std::fs::rename(path, &aside).map_err(|e| e.to_string())?;
    load_backup(path)
}

fn load_backup(path: &Path) -> Result<Option<String>, String> {
    Ok(std::fs::read_to_string(backup_of(path)).ok().filter(|t| readable(t)))
}

/// Writes `text` so that a power cut leaves either the old file or the new one, never a torn one.
fn write_durably(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn save(path: &Path, text: &str) -> Result<(), String> {
    let backup = backup_of(path);
    let stale = std::fs::metadata(&backup)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|age| age >= BACKUP_EVERY);
    if stale && let Ok(current) = std::fs::read_to_string(path).map_err(|_| ()).and_then(|t| if readable(&t) { Ok(t) } else { Err(()) }) {
        // A failed backup must not stop the save itself.
        let _ = write_durably(&backup, &current);
    }
    write_durably(path, text)
}

#[tauri::command]
pub fn state_load(app: AppHandle) -> Result<Option<String>, String> {
    load(&state_file(&app)?)
}

#[tauri::command]
pub fn state_save(app: AppHandle, json: String) -> Result<(), String> {
    save(&state_file(&app)?, &json)
}

/// Settings › Backup: write an exported configuration where the save dialog pointed.
#[tauri::command]
pub fn config_write(path: String, json: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Settings › Backup: read a configuration file the open dialog picked.
#[tauri::command]
pub fn config_read(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tri-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn saves_and_loads() {
        let d = dir("plain");
        let p = d.join("state.json");
        assert_eq!(load(&p).unwrap(), None);
        save(&p, r#"{"a":1}"#).unwrap();
        assert_eq!(load(&p).unwrap().as_deref(), Some(r#"{"a":1}"#));
    }

    #[test]
    fn a_torn_file_is_moved_aside_and_the_backup_loads() {
        let d = dir("torn");
        let p = d.join("state.json");
        std::fs::write(&p, r#"{"good":true}"#).unwrap();
        save(&p, r#"{"newer":true}"#).unwrap();
        std::fs::write(&p, r#"{"newer":tr"#).unwrap();
        assert_eq!(load(&p).unwrap().as_deref(), Some(r#"{"good":true}"#));
        assert!(!p.exists());
        let kept: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains("unreadable")).collect();
        assert_eq!(kept.len(), 1, "the unreadable file is kept for recovery");
    }

    #[test]
    fn an_empty_file_with_no_backup_starts_fresh() {
        let d = dir("empty");
        let p = d.join("state.json");
        std::fs::write(&p, "").unwrap();
        assert_eq!(load(&p).unwrap(), None);
    }

    #[test]
    fn a_recent_backup_is_not_overwritten() {
        let d = dir("recent");
        let p = d.join("state.json");
        std::fs::write(&p, r#"{"v":1}"#).unwrap();
        save(&p, r#"{"v":2}"#).unwrap();
        save(&p, r#"{"v":3}"#).unwrap();
        assert_eq!(std::fs::read_to_string(backup_of(&p)).unwrap(), r#"{"v":1}"#);
    }
}
