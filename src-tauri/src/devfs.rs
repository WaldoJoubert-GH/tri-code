//! Read and write files under a project's `.dev/` on that project's host.
//!
//! Local projects use the filesystem directly; remote projects `ssh cat` to
//! read and `cat > tmp && mv` to write, so a partially written file is never
//! visible to pi-todos or dev-hub. This is the third client of the shared
//! `.dev/` contract (see the project CONTEXT/ADR).

use crate::remote;
use crate::spawn::{expand_home, remote_path};

/// A one-byte marker is printed before the body so an empty file is not
/// confused with a missing one (ssh cannot tell us that from the exit code).
const MISSING: u8 = b'0';
const PRESENT: u8 = b'1';

#[tauri::command]
pub async fn dev_read(host: String, path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read(&host, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dev_write(host: String, path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_ignored(&host, &path)?;
        write(&host, &path, contents.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The `.dev` folder `path` sits in, if any: `/repo/.dev/plane/x.json` → `/repo/.dev`.
fn dev_dir(path: &str) -> Option<&str> {
    path.rfind("/.dev/").map(|i| &path[..i + "/.dev".len()])
}

/// Keep `.dev/` out of git the way pi-todos does: a `.gitignore` of `*` inside it.
/// Checked once per folder per run, so writes over ssh don't pay an extra round trip each.
fn ensure_ignored(host: &str, path: &str) -> Result<(), String> {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static DONE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

    let Some(dir) = dev_dir(path) else { return Ok(()) };
    let key = format!("{host}\n{dir}");
    if DONE.get_or_init(Default::default).lock().unwrap().contains(&key) {
        return Ok(());
    }
    let ignore = format!("{dir}/.gitignore");
    if read(host, &ignore)?.is_none() {
        write(host, &ignore, b"*\n")?;
    }
    DONE.get_or_init(Default::default).lock().unwrap().insert(key);
    Ok(())
}

/// Save a pasted image (base64 PNG) on `host` and return its path, so a
/// terminal agent can attach it: claude and pi read images from pasted paths,
/// and a remote agent cannot see this machine's clipboard.
#[tauri::command]
pub async fn save_pasted_image(host: String, png_base64: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| format!("bad base64: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let name = format!("tri-code-paste-{stamp}.png");
    let path = match host.as_str() {
        "" | "local" => std::env::temp_dir().join(name).to_string_lossy().into_owned(),
        _ => format!("/tmp/{name}"),
    };
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || write(&host, &target, &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok(path)
}

/// Read a text file on `host`, or `None` when it does not exist.
pub(crate) fn read(host: &str, path: &str) -> Result<Option<String>, String> {
    match host {
        "" | "local" => match std::fs::read_to_string(expand_home(path)) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{path}: {e}")),
        },
        _ => {
            let script = format!(
                "if [ -f {p} ]; then printf '1'; cat {p}; else printf '0'; fi",
                p = remote_path(path)
            );
            let out = remote::run(host, &script)?;
            match out.as_bytes().first() {
                Some(&PRESENT) => Ok(Some(out[1..].to_string())),
                Some(&MISSING) => Ok(None),
                _ => Err(format!("{host}: unexpected reply reading {path}")),
            }
        }
    }
}

/// Write a file on `host`, creating its parent directory and publishing it
/// atomically (temp file plus rename).
pub(crate) fn write(host: &str, path: &str, contents: &[u8]) -> Result<(), String> {
    match host {
        "" | "local" => write_local(&expand_home(path), contents),
        _ => {
            let p = remote_path(path);
            let script = format!(
                "p={p}; d=$(dirname \"$p\"); mkdir -p \"$d\" && t=\"$d/.tri-dev-$$\" && cat > \"$t\" && mv \"$t\" \"$p\""
            );
            remote::run_stdin(host, &script, contents).map(|_| ())
        }
    }
}

fn write_local(path: &str, contents: &[u8]) -> Result<(), String> {
    let path = std::path::Path::new(path);
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, contents).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod dev_dir_tests {
    use super::*;

    #[test]
    fn finds_the_dev_folder_a_file_is_in() {
        assert_eq!(dev_dir("/srv/app/.dev/issues.json"), Some("/srv/app/.dev"));
        assert_eq!(dev_dir("C:/p/app/.dev/github/comments/2.json"), Some("C:/p/app/.dev"));
        assert_eq!(dev_dir("~/.pi/agent/secrets/plane.json"), None);
        assert_eq!(dev_dir("/srv/app/.devtools/x.json"), None);
    }

    #[test]
    fn writing_into_dev_adds_a_gitignore() {
        let root = std::env::temp_dir().join(format!("tri-devignore-{}", std::process::id()));
        let at = |tag: &str| format!("{}/{tag}/.dev/issues.json", root.to_string_lossy().replace('\\', "/"));

        ensure_ignored("local", &at("new")).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("new/.dev/.gitignore")).unwrap(), "*\n");

        // a .gitignore the folder already has is left as it is
        std::fs::create_dir_all(root.join("own/.dev")).unwrap();
        std::fs::write(root.join("own/.dev/.gitignore"), "*\n!keep.json\n").unwrap();
        ensure_ignored("local", &at("own")).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("own/.dev/.gitignore")).unwrap(), "*\n!keep.json\n");
        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("tri-devfs-{tag}-{}", std::process::id()))
    }

    #[test]
    fn local_round_trips_and_creates_parents() {
        let root = tmp("local");
        let file = root.join("plane/comments/1.json");
        write("local", file.to_str().unwrap(), b"hello").unwrap();
        assert_eq!(read("local", file.to_str().unwrap()).unwrap().as_deref(), Some("hello"));
        // an empty file is present, not missing
        write("local", file.to_str().unwrap(), b"").unwrap();
        assert_eq!(read("local", file.to_str().unwrap()).unwrap().as_deref(), Some(""));
        assert_eq!(read("local", root.join("nope.json").to_str().unwrap()).unwrap(), None);
        std::fs::remove_dir_all(&root).ok();
    }

    /// The remote scripts are handed to the remote login shell verbatim, so run
    /// them through a real `/bin/sh` here (no ssh) to prove the quoting, the
    /// missing-file marker and the atomic rename all behave.
    #[test]
    fn remote_scripts_run_in_a_real_shell() {
        let root = tmp("remote");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("plane/issues.json");

        let write_script = {
            let p = remote_path(file.to_str().unwrap());
            format!("p={p}; d=$(dirname \"$p\"); mkdir -p \"$d\" && t=\"$d/.tri-dev-$$\" && cat > \"$t\" && mv \"$t\" \"$p\"")
        };
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&write_script)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child.stdin.take().unwrap().write_all(b"{\"issues\":[]}").unwrap();
        assert!(child.wait().unwrap().success());

        let read_script = format!(
            "if [ -f {p} ]; then printf '1'; cat {p}; else printf '0'; fi",
            p = remote_path(file.to_str().unwrap())
        );
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(&read_script).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "1{\"issues\":[]}");

        let missing = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("if [ -f {p} ]; then printf '1'; cat {p}; else printf '0'; fi", p = remote_path(root.join("no.json").to_str().unwrap())))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&missing.stdout), "0");
        std::fs::remove_dir_all(&root).ok();
    }
}
