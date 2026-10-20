//! The tour's sample project: a small folder in the app config dir, so Go to File and the
//! files window have real files to show. The agents in it are scripted in the frontend.

use tauri::{AppHandle, Manager};

const FILES: &[(&str, &str)] = &[
    ("README.md", include_str!("../tour/README.md")),
    ("package.json", include_str!("../tour/package.json")),
    ("index.html", include_str!("../tour/index.html")),
    ("src/main.tsx", include_str!("../tour/src/main.tsx")),
    ("src/App.tsx", include_str!("../tour/src/App.tsx")),
    ("src/Settings.tsx", include_str!("../tour/src/Settings.tsx")),
    ("src/theme.ts", include_str!("../tour/src/theme.ts")),
    ("src/components/Toggle.tsx", include_str!("../tour/src/components/Toggle.tsx")),
    ("tests/settings.test.ts", include_str!("../tour/tests/settings.test.ts")),
];

/// Write the sample files that are missing (edits made during the tour stay) and return the folder.
#[tauri::command]
pub fn tour_folder(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("tour");
    for (rel, text) in FILES {
        let path = dir.join(rel);
        if path.exists() {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, text).map_err(|e| format!("{rel}: {e}"))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}
