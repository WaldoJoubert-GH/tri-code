//! Project background and icon images, and uploaded signal sounds, stored as data URL text outside state.json.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// `<app_config_dir>/<dir>/<project_id>.dataurl`, with the id validated
/// so it cannot escape the directory.
fn image_file(app: &AppHandle, dir: &str, project_id: &str) -> Result<PathBuf, String> {
    let valid = !project_id.is_empty()
        && project_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err(format!("invalid project id: {project_id}"));
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join(dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{project_id}.dataurl")))
}

fn save(path: PathBuf, data_url: String) -> Result<(), String> {
    let tmp = path.with_extension("dataurl.tmp");
    std::fs::write(&tmp, data_url).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn load(path: PathBuf) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn delete(path: PathBuf) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn bg_save(app: AppHandle, project_id: String, data_url: String) -> Result<(), String> {
    save(image_file(&app, "backgrounds", &project_id)?, data_url)
}

#[tauri::command]
pub async fn bg_load(app: AppHandle, project_id: String) -> Result<Option<String>, String> {
    load(image_file(&app, "backgrounds", &project_id)?)
}

#[tauri::command]
pub async fn bg_delete(app: AppHandle, project_id: String) -> Result<(), String> {
    delete(image_file(&app, "backgrounds", &project_id)?)
}

/// The project's icon image: an uploaded file or a logo picked from the project.
#[tauri::command]
pub async fn icon_save(app: AppHandle, project_id: String, data_url: String) -> Result<(), String> {
    save(image_file(&app, "icons", &project_id)?, data_url)
}

#[tauri::command]
pub async fn icon_load(app: AppHandle, project_id: String) -> Result<Option<String>, String> {
    load(image_file(&app, "icons", &project_id)?)
}

#[tauri::command]
pub async fn icon_delete(app: AppHandle, project_id: String) -> Result<(), String> {
    delete(image_file(&app, "icons", &project_id)?)
}

/// A project's uploaded sound for one agent signal. `key` is `<project_id>-<event>`.
#[tauri::command]
pub async fn sound_save(app: AppHandle, key: String, data_url: String) -> Result<(), String> {
    save(image_file(&app, "sounds", &key)?, data_url)
}

#[tauri::command]
pub async fn sound_load(app: AppHandle, key: String) -> Result<Option<String>, String> {
    load(image_file(&app, "sounds", &key)?)
}

#[tauri::command]
pub async fn sound_delete(app: AppHandle, key: String) -> Result<(), String> {
    delete(image_file(&app, "sounds", &key)?)
}
