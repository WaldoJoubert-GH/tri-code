//! The tour's sample project: a small folder in the app config dir, so the palette and the editor
//! have real files to show, and a git repo, so the git window has a change and the worktree stop can
//! make a worktree. The agents in it are scripted in the frontend.

use std::path::Path;
use std::process::Command;
use tauri::{AppHandle, Manager};

/// Left out of the first commit, so the git window shows the test claude "wrote" as a new file.
const UNCOMMITTED: &str = "tests/settings.test.ts";

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
    if !dir.join(".git").exists() {
        // Without git the tour still runs; only the git window and the worktree stop have less to show.
        if let Err(e) = init_repo(&dir) {
            eprintln!("tour: git init failed: {e}");
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// `git init` and one commit of the sample, by a fixed author so it works without a git identity.
fn init_repo(dir: &Path) -> Result<(), String> {
    let git = |args: &[&str]| -> Result<(), String> {
        let mut cmd = Command::new("git");
        cmd.current_dir(dir)
            .args(["-c", "user.name=tri-code", "-c", "user.email=tour@tri-code.invalid", "-c", "commit.gpgsign=false"])
            .args(args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    };
    git(&["init", "-q", "-b", "main"])?;
    let mut add = vec!["add", "--"];
    add.extend(FILES.iter().map(|(rel, _)| *rel).filter(|rel| *rel != UNCOMMITTED));
    git(&add)?;
    git(&["commit", "-q", "-m", "Settings page"])
}
