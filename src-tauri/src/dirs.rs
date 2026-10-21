//! Directory listing for the project folder picker, local or over ssh.

use serde::Serialize;

use crate::remote;
use crate::spawn::{expand_home, remote_path, sq};

#[derive(Debug, Serialize)]
pub struct DirList {
    /// Absolute, normalized path that was listed.
    pub path: String,
    /// Names of the subdirectories, sorted, dot-folders last.
    pub dirs: Vec<String>,
    /// The subset of `dirs` that are git repositories (contain `.git`).
    pub repos: Vec<String>,
    /// Drive roots (`C:\`, `D:\`, ...) to jump between; only for local Windows.
    pub drives: Vec<String>,
    /// VS Code `.code-workspace` files in the folder, sorted.
    pub workspaces: Vec<String>,
}

const WORKSPACE_EXT: &str = ".code-workspace";

/// Sort key: dot-folders after the rest, then case-insensitive.
fn sort_key(n: &String) -> (bool, String) {
    (n.starts_with('.'), n.to_lowercase())
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
    // A bare `D:` means the current directory on D:, not its root.
    let path = &if path.len() == 2 && path.ends_with(':') { format!("{path}\\") } else { path.to_string() };
    let dir = std::fs::canonicalize(expand_home(path)).map_err(|e| format!("{path}: {e}"))?;
    let mut dirs = Vec::new();
    let mut workspaces = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(Result::ok) {
        let Ok(name) = e.file_name().into_string() else { continue };
        if e.path().is_dir() {
            dirs.push(name);
        } else if name.ends_with(WORKSPACE_EXT) {
            workspaces.push(name);
        }
    }
    dirs.sort_by_key(sort_key);
    workspaces.sort_by_key(sort_key);
    let repos = dirs.iter().filter(|n| dir.join(n).join(".git").exists()).cloned().collect();
    let path = dir.to_string_lossy();
    // canonicalize returns verbatim `\\?\C:\...` paths on Windows.
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path).to_string();
    Ok(DirList { path, dirs, repos, drives: drives(), workspaces })
}

#[cfg(windows)]
fn drives() -> Vec<String> {
    // Skip A: and B: so a floppy controller with no disk doesn't stall the listing.
    (b'C'..=b'Z').map(|c| format!("{}:\\", c as char)).filter(|d| std::path::Path::new(d).exists()).collect()
}

#[cfg(not(windows))]
fn drives() -> Vec<String> {
    Vec::new()
}

/// Remote script: print the resolved directory, then one subdirectory per line,
/// prefixed `g` for a git repository and `d` otherwise, then `w` and each `.code-workspace` file.
fn remote_script(path: &str) -> String {
    let inner = format!(
        "cd {} || exit 1; pwd; for d in */ .*/; do [ -d \"$d\" ] || continue; case $d in ./|../) continue;; esac; t=d; [ -e \"$d.git\" ] && t=g; printf '%s%s\\n' \"$t\" \"${{d%/}}\"; done; for f in *{WORKSPACE_EXT}; do [ -f \"$f\" ] && printf 'w%s\\n' \"$f\"; done; true",
        remote_path(path)
    );
    // `sh -c` so it works whatever the login shell is (bash, zsh, fish, ...).
    format!("sh -c {}", sq(&inner))
}

fn list_remote(host: &str, path: &str) -> Result<DirList, String> {
    let text = remote::run(host, &remote_script(path))?;
    let mut lines = text.lines();
    let path = lines.next().unwrap_or("/").to_string();
    let mut dirs = Vec::new();
    let mut repos = Vec::new();
    let mut workspaces = Vec::new();
    for line in lines {
        let (kind, name) = line.split_at(line.len().min(1));
        match kind {
            "w" => workspaces.push(name.to_string()),
            "g" => {
                repos.push(name.to_string());
                dirs.push(name.to_string());
            }
            _ => dirs.push(name.to_string()),
        }
    }
    dirs.sort_by_key(sort_key);
    repos.sort_by_key(sort_key);
    workspaces.sort_by_key(sort_key);
    Ok(DirList { path, dirs, repos, drives: Vec::new(), workspaces })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn local_lists_subdirs_and_normalizes() {
        let root = std::env::temp_dir().join(format!("tri-dirs-{}", std::process::id()));
        std::fs::create_dir_all(root.join("b dir")).unwrap();
        std::fs::create_dir_all(root.join("A")).unwrap();
        std::fs::create_dir_all(root.join("b dir/.git")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join("file"), "").unwrap();
        std::fs::write(root.join("shop.code-workspace"), "{}").unwrap();
        let l = list_local(&format!("{}/A/..", root.display())).unwrap();
        std::fs::remove_dir_all(&root).ok();
        assert_eq!(l.dirs, ["A", "b dir", ".hidden"]);
        assert_eq!(l.repos, ["b dir"]);
        assert_eq!(l.workspaces, ["shop.code-workspace"]);
        assert_eq!(l.path, std::fs::canonicalize(std::env::temp_dir()).unwrap().join(root.file_name().unwrap()).to_string_lossy());
    }

    #[test]
    fn remote_script_runs_in_a_real_shell() {
        let root = std::env::temp_dir().join(format!("tri-rdirs-{}", std::process::id()));
        std::fs::create_dir_all(root.join("it's here")).unwrap();
        std::fs::create_dir_all(root.join("repo/.git")).unwrap();
        std::fs::create_dir_all(root.join(".config")).unwrap();
        std::fs::write(root.join("file"), "").unwrap();
        std::fs::write(root.join("my shop.code-workspace"), "{}").unwrap();
        // ssh hands the command string to the remote login shell as-is.
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(remote_script(&root.to_string_lossy()))
            .output()
            .unwrap();
        std::fs::remove_dir_all(&root).ok();
        let text = String::from_utf8_lossy(&out.stdout);
        assert_eq!(text.lines().nth(1), Some("dit's here"), "{out:?}");
        assert_eq!(text.lines().nth(2), Some("grepo"), "{out:?}");
        assert_eq!(text.lines().nth(3), Some("d.config"), "{out:?}");
        assert_eq!(text.lines().nth(4), Some("wmy shop.code-workspace"), "{out:?}");
        assert_eq!(text.lines().count(), 5, "{out:?}");
    }
}
