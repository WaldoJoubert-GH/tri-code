//! Persists app state (projects, tabs) as one JSON file in the app config dir.
//! The shape is owned by the frontend; Rust just stores the text atomically.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
pub fn state_load(app: AppHandle) -> Result<Option<String>, String> {
    match std::fs::read_to_string(state_file(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn state_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = state_file(&app)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
