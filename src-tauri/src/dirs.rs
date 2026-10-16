//! Directory listing for the project folder picker, local or over ssh.

use serde::Serialize;

use crate::spawn::{expand_home, remote_path, sq};

#[derive(Debug, Serialize)]
pub struct DirList {
    /// Absolute, normalized path that was listed.
    pub path: String,
    /// Names of the visible subdirectories, sorted.
    pub dirs: Vec<String>,
}

#[tauri::command]
pub async fn list_dirs(host: String, path: String) -> Result<DirList, String> {
    tauri::async_runtime::spawn_blocking(move || match host.as_str() {
        "" | "local" => list_local(&path),
        _ => list_remote(&host, &path),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn list_local(path: &str) -> Result<DirList, String> {
    let dir = std::fs::canonicalize(expand_home(path)).map_err(|e| format!("{path}: {e}"))?;
    let mut dirs: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    dirs.sort_by_key(|n| n.to_lowercase());
    let path = dir.to_string_lossy();
    // canonicalize returns verbatim `\\?\C:\...` paths on Windows.
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path).to_string();
    Ok(DirList { path, dirs })
}

/// Remote script: print the resolved directory, then one subdirectory per line.
fn remote_script(path: &str) -> String {
    let inner = format!(
        "cd {} || exit 1; pwd; for d in */; do [ -d \"$d\" ] && printf '%s\\n' \"${{d%/}}\"; done; true",
        remote_path(path)
    );
    // `sh -c` so it works whatever the login shell is (bash, zsh, fish, ...).
    format!("sh -c {}", sq(&inner))
}

fn list_remote(host: &str, path: &str) -> Result<DirList, String> {
    let mut cmd = std::process::Command::new("ssh");
    cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, &remote_script(path)])
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("ssh: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("{host}: cannot open {path}") } else { err });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let path = lines.next().unwrap_or("/").to_string();
    let mut dirs: Vec<String> = lines.map(String::from).collect();
    dirs.sort_by_key(|n| n.to_lowercase());
    Ok(DirList { path, dirs })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn local_lists_subdirs_and_normalizes() {
        let root = std::env::temp_dir().join(format!("tri-dirs-{}", std::process::id()));
        std::fs::create_dir_all(root.join("b dir")).unwrap();
        std::fs::create_dir_all(root.join("A")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join("file"), "").unwrap();
        let l = list_local(&format!("{}/A/..", root.display())).unwrap();
        std::fs::remove_dir_all(&root).ok();
        assert_eq!(l.dirs, ["A", "b dir"]);
        assert_eq!(l.path, std::fs::canonicalize(std::env::temp_dir()).unwrap().join(root.file_name().unwrap()).to_string_lossy());
    }

    #[test]
    fn remote_script_runs_in_a_real_shell() {
        let root = std::env::temp_dir().join(format!("tri-rdirs-{}", std::process::id()));
        std::fs::create_dir_all(root.join("it's here")).unwrap();
        std::fs::write(root.join("file"), "").unwrap();
        // ssh hands the command string to the remote login shell as-is.
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(remote_script(&root.to_string_lossy()))
            .output()
            .unwrap();
        std::fs::remove_dir_all(&root).ok();
        let text = String::from_utf8_lossy(&out.stdout);
        assert_eq!(text.lines().nth(1), Some("it's here"), "{out:?}");
        assert_eq!(text.lines().count(), 2, "{out:?}");
    }
}
