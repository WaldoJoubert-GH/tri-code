//! The `tri` command: `tri .`, `tri <folder>`, `tri <file>[:line[:col]]`, like `code .`.
//!
//! A launch with paths, first or second, turns them into Targets and queues them here. The first
//! launch reads its own arguments; a second one hands its arguments and working folder to the
//! running app through the single-instance plugin and exits. The UI drains the queue with
//! `cli_take` once it has loaded and again on each `cli-open` event, so neither launch races it.
//!
//! `tri` itself is a small script that starts the app's exe; Settings › General writes it
//! (`cli_install`) and puts its folder on PATH.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// What one argument asks to open, on this machine.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Target {
    /// The full path, as the OS writes it (backslashes on Windows).
    pub path: String,
    /// A folder opens as a project; a file opens in the project that holds it.
    pub dir: bool,
    /// For a file, the folder to open when no project holds it: its repo, else its folder.
    pub root: Option<String>,
    pub line: Option<u32>,
    pub col: Option<u32>,
}

/// Targets waiting for the UI.
#[derive(Default)]
pub struct Pending(Mutex<Vec<Target>>);

/// `\\?\C:\…` back to `C:\…`, and `\\?\UNC\server\…` to `\\server\…`.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// `file:12` or `file:12:4`, when `file` alone exists and the whole argument doesn't.
fn split_line(arg: &str, cwd: &Path) -> (PathBuf, Option<u32>, Option<u32>) {
    let whole = cwd.join(arg);
    if whole.exists() {
        return (whole, None, None);
    }
    let mut parts = arg.rsplitn(3, ':');
    let last = parts.next().and_then(|s| s.parse::<u32>().ok());
    let mid = parts.next();
    let rest = parts.next();
    // `a:12:4`, then `a:12`. A drive letter (`C:`) never parses as a number, so it stays in the path.
    if let (Some(col), Some(line), Some(file)) = (last, mid.and_then(|s| s.parse::<u32>().ok()), rest) {
        let p = cwd.join(file);
        if p.exists() {
            return (p, Some(line), Some(col));
        }
    }
    if let (Some(line), Some(file)) = (last, arg.rsplit_once(':').map(|(f, _)| f)) {
        let p = cwd.join(file);
        if p.exists() {
            return (p, Some(line), None);
        }
    }
    (whole, None, None)
}

/// The nearest folder at or above `dir` with a `.git` (a folder, or a worktree's file).
fn repo_root(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find(|d| d.join(".git").exists()).map(Path::to_path_buf)
}

/// The Targets in a launch's arguments, resolved against the folder it was started in. Flags and
/// paths that don't exist are skipped: a missing path has nothing to open, and the app still shows.
pub fn targets(args: &[OsString], cwd: &Path) -> Vec<Target> {
    args.iter()
        .filter_map(|a| a.to_str())
        .filter(|a| !a.is_empty() && !a.starts_with('-'))
        .filter_map(|a| {
            let (p, line, col) = split_line(a, cwd);
            let p = plain(fs::canonicalize(&p).ok()?);
            let dir = p.is_dir();
            let root = if dir { None } else { p.parent().map(|d| repo_root(d).unwrap_or_else(|| d.to_path_buf())) };
            Some(Target {
                path: p.to_string_lossy().into_owned(),
                dir,
                root: root.map(|r| r.to_string_lossy().into_owned()),
                line,
                col,
            })
        })
        .collect()
}

/// Queues a launch's Targets and tells the UI. `argv` includes the exe, as both launches see it.
pub fn queue(app: &AppHandle, argv: &[OsString], cwd: &Path) {
    let found = targets(argv.get(1..).unwrap_or_default(), cwd);
    if found.is_empty() {
        return;
    }
    app.state::<Pending>().0.lock().unwrap().extend(found);
    let _ = app.emit("cli-open", ());
}

#[tauri::command]
pub fn cli_take(pending: tauri::State<'_, Pending>) -> Vec<Target> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

// ---- Installing `tri` ----

const NAME: &str = "tri";

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Missing,
    Installed,
    /// The script starts another exe (an old install, a dev build).
    Stale,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSetup {
    pub state: State,
    /// Where the script is, or would be written.
    pub script: String,
    /// Whether its folder is on the user's PATH. New terminals see it; ones already open don't.
    pub on_path: bool,
}

fn exe() -> Result<PathBuf, String> {
    std::env::current_exe().map(plain).map_err(|e| format!("can't find tri-code's exe: {e}"))
}

/// The folder `tri` is written to: the app's own on Windows (put on PATH), `~/.local/bin` elsewhere.
fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(windows) {
        return app.path().app_local_data_dir().map(|d| d.join("bin")).map_err(|e| e.to_string());
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("bin")).ok_or_else(|| "HOME isn't set".into())
}

fn script_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = bin_dir(app)?;
    Ok(if cfg!(windows) { dir.join(format!("{NAME}.cmd")) } else { dir.join(NAME) })
}

/// The script that starts `exe` with the arguments, in the caller's folder, without waiting for it.
pub fn script(exe: &Path) -> String {
    if cfg!(windows) {
        // `start` returns at once; a batch file would otherwise wait for the app to quit.
        format!("@echo off\r\nstart \"\" \"{}\" %*\r\n", exe.display())
    } else {
        let q = exe.to_string_lossy().replace('\'', r"'\''");
        // The exe itself, not `open -a`: a running app gets Apple events from `open`, not arguments.
        format!("#!/bin/sh\n# tri-code's command line: tri . opens this folder in tri-code.\nnohup '{q}' \"$@\" >/dev/null 2>&1 &\n")
    }
}

fn same_dir(a: &str, b: &Path) -> bool {
    let norm = |s: &str| {
        let s = s.trim().trim_end_matches(['\\', '/']).replace('\\', "/");
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    norm(a) == norm(&b.to_string_lossy())
}

/// Whether `dir` is one of the entries of a PATH value.
pub fn path_has(path: &str, dir: &Path) -> bool {
    let sep = if cfg!(windows) { ';' } else { ':' };
    path.split(sep).any(|e| !e.is_empty() && same_dir(e, dir))
}

#[cfg(windows)]
mod user_path {
    use std::path::Path;
    use windows_registry::{CURRENT_USER, Type};

    /// The user's PATH as stored, `%VARS%` unexpanded, and whether it is REG_EXPAND_SZ.
    fn read() -> Result<(String, bool), String> {
        let key = CURRENT_USER.create("Environment").map_err(|e| e.to_string())?;
        match key.get_type("Path") {
            Ok(ty) => Ok((key.get_string("Path").map_err(|e| e.to_string())?, ty == Type::ExpandString)),
            Err(_) => Ok((String::new(), true)),
        }
    }

    fn write(value: &str, expand: bool) -> Result<(), String> {
        let key = CURRENT_USER.create("Environment").map_err(|e| e.to_string())?;
        if expand { key.set_expand_string("Path", value) } else { key.set_string("Path", value) }.map_err(|e| e.to_string())?;
        broadcast();
        Ok(())
    }

    /// Tells Explorer the environment changed, so terminals started from now on get the new PATH.
    fn broadcast() {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn SendMessageTimeoutW(hwnd: isize, msg: u32, wparam: usize, lparam: *const u16, flags: u32, timeout: u32, result: *mut usize) -> isize;
        }
        const HWND_BROADCAST: isize = 0xffff;
        const WM_SETTINGCHANGE: u32 = 0x001a;
        const SMTO_ABORTIFHUNG: u32 = 0x0002;
        let env: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut out = 0usize;
        unsafe {
            SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, env.as_ptr(), SMTO_ABORTIFHUNG, 2000, &mut out);
        }
    }

    pub fn has(dir: &Path) -> bool {
        read().is_ok_and(|(p, _)| super::path_has(&p, dir))
    }

    pub fn add(dir: &Path) -> Result<(), String> {
        let (p, expand) = read()?;
        if super::path_has(&p, dir) {
            return Ok(());
        }
        let p = p.trim_end_matches(';');
        let next = if p.is_empty() { dir.display().to_string() } else { format!("{p};{}", dir.display()) };
        write(&next, expand)
    }

    pub fn remove(dir: &Path) -> Result<(), String> {
        let (p, expand) = read()?;
        if !super::path_has(&p, dir) {
            return Ok(());
        }
        let next: Vec<&str> = p.split(';').filter(|e| !e.is_empty() && !super::same_dir(e, dir)).collect();
        write(&next.join(";"), expand)
    }
}

fn on_path(dir: &Path) -> bool {
    #[cfg(windows)]
    {
        user_path::has(dir)
    }
    #[cfg(not(windows))]
    {
        std::env::var("PATH").is_ok_and(|p| path_has(&p, dir))
    }
}

fn status(app: &AppHandle) -> Result<CliSetup, String> {
    let path = script_path(app)?;
    let state = match fs::read_to_string(&path) {
        Err(_) => State::Missing,
        Ok(s) if s == script(&exe()?) => State::Installed,
        Ok(_) => State::Stale,
    };
    Ok(CliSetup { state, script: path.display().to_string(), on_path: on_path(&bin_dir(app)?) })
}

fn install(app: &AppHandle) -> Result<(), String> {
    let dir = bin_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = script_path(app)?;
    fs::write(&path, script(&exe()?)).map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    user_path::add(&dir)?;
    Ok(())
}

fn remove(app: &AppHandle) -> Result<(), String> {
    let path = script_path(app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    #[cfg(windows)]
    user_path::remove(&bin_dir(app)?)?;
    Ok(())
}

/// The folder tri-code's own terminals get on PATH once `tri` is installed, since the terminal
/// host was started before the install and keeps the PATH it had.
pub fn terminal_bin(app: &AppHandle) -> Option<PathBuf> {
    script_path(app).ok().filter(|p| p.is_file()).and_then(|p| p.parent().map(Path::to_path_buf))
}

#[tauri::command]
pub async fn cli_status(app: AppHandle) -> Result<CliSetup, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cli_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cli_remove(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove(&app)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A temp tree: `repo/.git/`, `repo/src/main.rs`, `loose/notes.txt`.
    fn tree(name: &str) -> Tmp {
        let root = std::env::temp_dir().join(format!("tri-cli-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("repo/.git")).unwrap();
        fs::create_dir_all(root.join("repo/src")).unwrap();
        fs::create_dir_all(root.join("loose")).unwrap();
        fs::write(root.join("repo/src/main.rs"), "").unwrap();
        fs::write(root.join("loose/notes.txt"), "").unwrap();
        Tmp(plain(fs::canonicalize(&root).unwrap()))
    }

    fn args(a: &[&str]) -> Vec<OsString> {
        a.iter().map(OsString::from).collect()
    }

    #[test]
    fn dot_is_the_folder_it_was_run_in() {
        let t = tree("dot");
        let got = targets(&args(&["."]), &t.0.join("repo"));
        assert_eq!(got.len(), 1);
        assert!(got[0].dir);
        assert_eq!(got[0].path, t.0.join("repo").to_string_lossy());
        assert_eq!(got[0].root, None);
    }

    #[test]
    fn a_file_names_its_repo_as_the_root() {
        let t = tree("file");
        let got = targets(&args(&["src/main.rs"]), &t.0.join("repo"));
        assert!(!got[0].dir);
        assert_eq!(got[0].path, t.0.join("repo").join("src").join("main.rs").to_string_lossy());
        assert_eq!(got[0].root.as_deref(), Some(&*t.0.join("repo").to_string_lossy()));
    }

    #[test]
    fn a_file_outside_a_repo_names_its_folder() {
        let t = tree("loose");
        let got = targets(&args(&["notes.txt"]), &t.0.join("loose"));
        assert_eq!(got[0].root.as_deref(), Some(&*t.0.join("loose").to_string_lossy()));
    }

    #[test]
    fn line_and_column_come_off_the_end() {
        let t = tree("line");
        let cwd = t.0.join("repo");
        let got = targets(&args(&["src/main.rs:12", "src/main.rs:3:7"]), &cwd);
        assert_eq!((got[0].line, got[0].col), (Some(12), None));
        assert_eq!((got[1].line, got[1].col), (Some(3), Some(7)));
        assert!(got[1].path.ends_with("main.rs"));
    }

    #[test]
    fn an_absolute_path_ignores_the_cwd() {
        let t = tree("abs");
        let abs = t.0.join("repo").join("src").join("main.rs");
        let got = targets(&[OsString::from(format!("{}:5", abs.display()))], Path::new("/"));
        assert_eq!(got[0].path, abs.to_string_lossy());
        assert_eq!(got[0].line, Some(5));
    }

    #[test]
    fn flags_and_missing_paths_are_skipped() {
        let t = tree("skip");
        assert!(targets(&args(&["--new-window", "nope", ""]), &t.0).is_empty());
    }

    #[test]
    fn path_entries_match_however_they_are_written() {
        let dir = if cfg!(windows) { Path::new(r"C:\Users\me\AppData\Local\dev.tricode.app\bin") } else { Path::new("/home/me/.local/bin") };
        let path = if cfg!(windows) { r"C:\Windows;c:/users/me/appdata/local/dev.tricode.app/bin/;" } else { "/usr/bin:/home/me/.local/bin/" };
        assert!(path_has(path, dir));
        assert!(!path_has(if cfg!(windows) { r"C:\Windows" } else { "/usr/bin" }, dir));
    }

    #[test]
    fn the_script_starts_the_exe_without_waiting() {
        let s = script(Path::new(if cfg!(windows) { r"C:\Apps\tri-code\tri-code.exe" } else { "/Applications/tri-code.app/Contents/MacOS/tri-code" }));
        if cfg!(windows) {
            assert!(s.contains(r#"start "" "C:\Apps\tri-code\tri-code.exe" %*"#));
        } else {
            assert!(s.starts_with("#!/bin/sh") && s.contains("\"$@\"") && s.trim_end().ends_with('&'));
        }
    }
}
