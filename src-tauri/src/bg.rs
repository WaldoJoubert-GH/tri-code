//! Project background images, stored as data URL text outside state.json.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// `<app_config_dir>/backgrounds/<project_id>.dataurl`, with the id validated
/// so it cannot escape the directory.
fn bg_file(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let valid = !project_id.is_empty()
        && project_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err(format!("invalid project id: {project_id}"));
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("backgrounds");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{project_id}.dataurl")))
}

#[tauri::command]
pub async fn bg_save(app: AppHandle, project_id: String, data_url: String) -> Result<(), String> {
    let path = bg_file(&app, &project_id)?;
    let tmp = path.with_extension("dataurl.tmp");
    std::fs::write(&tmp, data_url).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bg_load(app: AppHandle, project_id: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(bg_file(&app, &project_id)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn bg_delete(app: AppHandle, project_id: String) -> Result<(), String> {
    match std::fs::remove_file(bg_file(&app, &project_id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
