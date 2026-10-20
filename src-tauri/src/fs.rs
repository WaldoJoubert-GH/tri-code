//! File listing and reading for the files window, local or over ssh.
//! Mirrors `dirs.rs`: local paths via `std::fs`, remote paths over one `ssh` call.

use std::io::Read;

use serde::Serialize;

use crate::remote;
use crate::spawn::{expand_home, remote_path, sq};

/// Largest file read into a pane. Bigger files are truncated.
const LIMIT: u64 = 1_000_000;
/// Largest image inlined into a Markdown preview.
const IMAGE_LIMIT: u64 = 10_000_000;
/// Largest image or video shown in a file window.
const MEDIA_LIMIT: u64 = 500_000_000;

#[derive(Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    /// Bytes for files; 0 for directories and for remote entries.
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct FileList {
    /// Absolute, normalized path that was listed.
    pub path: String,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Serialize)]
pub struct FileText {
    pub path: String,
    pub size: u64,
    /// The first `LIMIT` bytes are not valid text (a NUL byte was found).
    pub binary: bool,
    /// Only the first `LIMIT` bytes are present in `text`.
    pub truncated: bool,
    /// `None` for a binary file.
    pub text: Option<String>,
}

#[tauri::command]
pub async fn list_files(host: String, path: String) -> Result<FileList, String> {
    tauri::async_runtime::spawn_blocking(move || match host.as_str() {
        "" | "local" => list_local(&path),
        _ => list_remote(&host, &path),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_file(host: String, path: String) -> Result<FileText, String> {
    tauri::async_runtime::spawn_blocking(move || match host.as_str() {
        "" | "local" => read_local(&path),
        _ => read_remote(&host, &path),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An image as a `data:` URL, for a Markdown preview's relative `<img>`s. The webview
/// cannot load the project's files itself (and a remote project's not at all).
#[tauri::command]
pub async fn read_image(host: String, path: String) -> Result<String, String> {
    use base64::Engine as _;
    tauri::async_runtime::spawn_blocking(move || {
        let b64 = match host.as_str() {
            "" | "local" => {
                let p = expand_home(&path);
                let meta = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?;
                if meta.len() > IMAGE_LIMIT {
                    return Err(format!("{path}: image too large"));
                }
                base64::engine::general_purpose::STANDARD.encode(std::fs::read(&p).map_err(|e| format!("{path}: {e}"))?)
            }
            _ => {
                let inner = format!(
                    "p={}; [ -f \"$p\" ] || exit 2; [ $(wc -c < \"$p\") -le {IMAGE_LIMIT} ] || exit 3; base64 < \"$p\"",
                    remote_path(&path)
                );
                remote::run(&host, &format!("sh -c {}", sq(&inner)))?.split_whitespace().collect()
            }
        };
        Ok(format!("data:{};base64,{b64}", image_mime(&path)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An image, video or audio file's raw bytes for the file window, which plays them from a
/// blob URL. Bytes cross the IPC as-is: a base64 `data:` URL of a video would be huge.
#[tauri::command]
pub async fn read_media(host: String, path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = match host.as_str() {
            "" | "local" => {
                let p = expand_home(&path);
                let meta = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?;
                if meta.len() > MEDIA_LIMIT {
                    return Err(format!("{path}: too large to show ({} MB)", meta.len() / 1_000_000));
                }
                std::fs::read(&p).map_err(|e| format!("{path}: {e}"))?
            }
            _ => {
                let inner = format!(
                    "p={}; [ -f \"$p\" ] || exit 2; [ $(wc -c < \"$p\") -le {MEDIA_LIMIT} ] || exit 3; cat \"$p\"",
                    remote_path(&path)
                );
                remote::run_bytes(&host, &format!("sh -c {}", sq(&inner)))?
            }
        };
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Overwrite a text file from the file window's editor. Written in place, not via a
/// temp file and rename, so the file keeps its permissions and a symlink stays a link.
#[tauri::command]
pub async fn write_file(host: String, path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match host.as_str() {
        "" | "local" => std::fs::write(expand_home(&path), contents).map_err(|e| format!("{path}: {e}")),
        _ => {
            let inner = format!("p={}; [ -f \"$p\" ] || exit 2; cat > \"$p\"", remote_path(&path));
            remote::run_stdin(&host, &format!("sh -c {}", sq(&inner)), contents.as_bytes()).map(|_| ())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn image_mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "image/png",
    }
}

fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
}

/// Strip the verbatim `\\?\` prefix that canonicalize adds on Windows.
fn strip_verbatim(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn list_local(path: &str) -> Result<FileList, String> {
    let dir = std::fs::canonicalize(expand_home(path)).map_err(|e| format!("{path}: {e}"))?;
    let mut entries = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(Result::ok) {
        let name = match e.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue, // skip non-UTF-8 names
        };
        let meta = e.metadata().ok();
        let dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = match (dir, meta) {
            (false, Some(m)) => m.len(),
            _ => 0,
        };
        entries.push(Entry { name, dir, size });
    }
    sort_entries(&mut entries);
    Ok(FileList { path: strip_verbatim(&dir), entries })
}

/// Print the resolved directory, then one `d\tname` / `f\tname` line per entry.
/// `* .[!.]* ..?*` includes dotfiles, matching the local listing.
fn remote_list_script(path: &str) -> String {
    let inner = format!(
        "cd {} || exit 1; pwd; \
         for e in * .[!.]* ..?*; do [ -e \"$e\" ] || continue; \
           if [ -d \"$e\" ]; then printf 'd\\t%s\\n' \"$e\"; else printf 'f\\t%s\\n' \"$e\"; fi; \
         done; true",
        remote_path(path)
    );
    format!("sh -c {}", sq(&inner))
}

fn list_remote(host: &str, path: &str) -> Result<FileList, String> {
    let text = remote::run(host, &remote_list_script(path))?;
    let mut lines = text.lines();
    let path = lines.next().unwrap_or("/").to_string();
    let mut entries: Vec<Entry> = lines
        .filter_map(|l| l.split_once('\t'))
        .map(|(kind, name)| Entry { name: name.to_string(), dir: kind == "d", size: 0 })
        .collect();
    sort_entries(&mut entries);
    Ok(FileList { path, entries })
}

fn read_local(path: &str) -> Result<FileText, String> {
    let p = std::fs::canonicalize(expand_home(path)).map_err(|e| format!("{path}: {e}"))?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err(format!("{path} is a directory"));
    }
    let size = meta.len();
    let mut buf = Vec::new();
    std::fs::File::open(&p)
        .map_err(|e| e.to_string())?
        .take(LIMIT)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    let binary = buf.contains(&0);
    Ok(FileText {
        path: strip_verbatim(&p),
        size,
        binary,
        truncated: size > LIMIT,
        text: if binary { None } else { Some(String::from_utf8_lossy(&buf).into_owned()) },
    })
}

fn read_remote(host: &str, path: &str) -> Result<FileText, String> {
    // Print the byte size on the first line, then the first LIMIT bytes.
    let inner = format!("p={}; [ -f \"$p\" ] || exit 2; wc -c < \"$p\"; head -c {LIMIT} \"$p\"", remote_path(path));
    let out = remote::run_bytes(host, &format!("sh -c {}", sq(&inner)))?;
    let nl = out.iter().position(|&b| b == b'\n').ok_or("unexpected output from ssh")?;
    let size: u64 = String::from_utf8_lossy(&out[..nl]).trim().parse().map_err(|_| "unexpected size from ssh")?;
    let body = &out[nl + 1..];
    let binary = body.contains(&0);
    Ok(FileText {
        path: path.to_string(),
        size,
        binary,
        truncated: size > LIMIT,
        text: if binary { None } else { Some(String::from_utf8_lossy(body).into_owned()) },
    })
}

/// Folders a walk never enters: build output and dependencies, which dwarf the source.
const SKIP: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".cache"];

/// Every file under `path` (relative, `/`-separated) for a project that is not a git repo, up to
/// `limit`. The second value is true when the limit cut the walk short.
pub fn walk(host: &str, path: &str, limit: usize) -> Result<(Vec<String>, bool), String> {
    if !matches!(host, "" | "local") {
        let out = remote::run(host, &remote_walk_script(path, limit + 1))?;
        let mut files: Vec<String> = out.lines().map(|l| l.strip_prefix("./").unwrap_or(l).to_string()).filter(|l| !l.is_empty()).collect();
        let cut = files.len() > limit;
        files.truncate(limit);
        return Ok((files, cut));
    }
    let root = std::fs::canonicalize(expand_home(path)).map_err(|e| format!("{path}: {e}"))?;
    let mut files = Vec::new();
    let mut stack = vec![(root, String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.filter_map(Result::ok) {
            let Ok(name) = e.file_name().into_string() else { continue };
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            // file_type does not follow symlinks, so a linked folder is listed, not entered
            match e.file_type() {
                Ok(t) if t.is_dir() => {
                    if !SKIP.contains(&name.as_str()) {
                        stack.push((e.path(), child));
                    }
                }
                Ok(_) => {
                    if files.len() == limit {
                        return Ok((files, true));
                    }
                    files.push(child);
                }
                Err(_) => {}
            }
        }
    }
    Ok((files, false))
}

fn remote_walk_script(path: &str, limit: usize) -> String {
    let prune = SKIP.iter().map(|n| format!("-name {}", sq(n))).collect::<Vec<_>>().join(" -o ");
    let inner = format!("cd {} || exit 1; find . \\( {prune} \\) -prune -o \\( -type f -o -type l \\) -print | head -n {limit}", remote_path(path));
    format!("sh -c {}", sq(&inner))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("tri-fs-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn local_list_is_dirs_first_and_includes_dotfiles() {
        let root = tmp("list");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join(".env"), "x").unwrap();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        let l = list_local(root.to_str().unwrap()).unwrap();
        std::fs::remove_dir_all(&root).ok();
        let names: Vec<&str> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["sub", ".env", "a.txt"]);
        assert!(l.entries[0].dir);
        assert_eq!(l.entries[1].size, 1);
    }

    #[test]
    fn local_read_reports_text_and_binary() {
        let root = tmp("read");
        std::fs::write(root.join("t.txt"), "hi there").unwrap();
        std::fs::write(root.join("b.bin"), [0u8, 1, 2, 3]).unwrap();
        let t = read_local(root.join("t.txt").to_str().unwrap()).unwrap();
        let b = read_local(root.join("b.bin").to_str().unwrap()).unwrap();
        std::fs::remove_dir_all(&root).ok();
        assert_eq!(t.text.as_deref(), Some("hi there"));
        assert!(!t.binary);
        assert!(b.binary);
        assert_eq!(b.text, None);
        assert_eq!(b.size, 4);
    }

    #[test]
    fn local_write_keeps_the_file_and_images_read_as_data_urls() {
        let root = tmp("write");
        let f = root.join("a.md");
        std::fs::write(&f, "old").unwrap();
        std::fs::write(root.join("i.svg"), "<svg/>").unwrap();
        let p = f.to_string_lossy().to_string();
        tauri::async_runtime::block_on(write_file("local".into(), p.clone(), "new".into())).unwrap();
        let img = tauri::async_runtime::block_on(read_image("local".into(), root.join("i.svg").to_string_lossy().into())).unwrap();
        let text = std::fs::read_to_string(&f).unwrap();
        std::fs::remove_dir_all(&root).ok();
        assert_eq!(text, "new");
        assert_eq!(img, "data:image/svg+xml;base64,PHN2Zy8+");
    }

    #[test]
    fn walk_skips_dependency_folders_and_stops_at_the_limit() {
        let root = tmp("walk");
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("src/deep/a.rs"), "").unwrap();
        std::fs::write(root.join("node_modules/x/i.js"), "").unwrap();
        std::fs::write(root.join(".env"), "").unwrap();
        let p = root.to_string_lossy().to_string();
        let (mut files, cut) = walk("local", &p, 100).unwrap();
        files.sort();
        assert_eq!(files, [".env", "src/deep/a.rs"]);
        assert!(!cut);
        assert_eq!(walk("local", &p, 1).unwrap().1, true);

        // the script a remote project runs over ssh, run here by a real shell
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(remote_walk_script(&p, 100)).output().unwrap();
        std::fs::remove_dir_all(&root).ok();
        let mut got: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().map(String::from).collect();
        got.sort();
        assert_eq!(got, ["./.env", "./src/deep/a.rs"]);
    }

    #[test]
    fn remote_list_script_runs_in_a_real_shell_and_keeps_dotfiles() {
        let root = tmp("rlist");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join(".env"), "x").unwrap();
        std::fs::write(root.join("it's here"), "").unwrap();
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(remote_list_script(&root.to_string_lossy())).output().unwrap();
        std::fs::remove_dir_all(&root).ok();
        let text = String::from_utf8_lossy(&out.stdout);
        let mut lines = text.lines();
        assert!(lines.next().is_some(), "resolved path line");
        let mut got: Vec<&str> = lines.collect();
        got.sort();
        assert_eq!(got, ["d\tsub", "f\t.env", "f\tit's here"]);
    }
}
