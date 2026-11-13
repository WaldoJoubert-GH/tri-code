//! The Open project dialog's New folder and Clone tabs, on the chosen Environment, locally or
//! over ssh: `make_folder` makes a folder (and can `git init` it); `git_clone` streams a clone's
//! progress until it ends or `git_clone_cancel` stops it. The dialog opens the result as a project.

use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, mpsc};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;

use crate::git::blocking;
use crate::spawn::{expand_home, remote_path, sq};
use crate::{envssh, remote};

fn is_local(host: &str) -> bool {
    matches!(host, "" | "local")
}

/// A folder name, not a path: no separators, nothing Windows refuses, and no trailing dot or
/// space (Windows drops those, so the folder would not be called what was asked).
fn check_name(name: &str) -> Result<(), String> {
    let bad = name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.ends_with([' ', '.'])
        || name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    if bad { Err(format!("“{name}” is not a valid folder name")) } else { Ok(()) }
}

fn hide_window(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

// ── New folder ───────────────────────────────────────────────────────

fn make_script(parent: &str, name: &str, git_init: bool) -> String {
    let init = if git_init { format!(" && cd -- {} && git init -q", sq(name)) } else { String::new() };
    format!("cd {} && mkdir -- {}{init}", remote_path(parent), sq(name))
}

/// Make `parent/name`, which must not exist yet, and `git init` it when asked.
#[tauri::command]
pub async fn make_folder(host: String, parent: String, name: String, git_init: bool) -> Result<(), String> {
    check_name(&name)?;
    blocking(move || {
        if !is_local(&host) {
            return remote::run(&host, &make_script(&parent, &name, git_init)).map(|_| ());
        }
        let dir = Path::new(&expand_home(&parent)).join(&name);
        std::fs::create_dir(&dir).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!("{name} already exists"),
            _ => format!("{}: {e}", dir.display()),
        })?;
        if git_init {
            crate::git::exec(&host, &dir.to_string_lossy(), "git", &["init", "-q"], None)
                .map_err(|e| format!("Made {name}, but git init failed: {e}"))?;
        }
        Ok(())
    })
    .await
}

// ── Clone ────────────────────────────────────────────────────────────

/// One piece of git's output. `partial` pieces ended in `\r`: a progress line the next one replaces.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Line {
    pub text: String,
    pub partial: bool,
}

const LINE_MAX: usize = 4096;
const BATCH_WAIT: Duration = Duration::from_millis(50);

/// Split git's output on `\n` and on the `\r` its progress meters redraw with.
fn split_progress(from: impl Read, mut emit: impl FnMut(Line) -> bool) {
    let mut buf = Vec::new();
    let flush = |buf: &mut Vec<u8>, partial: bool, emit: &mut dyn FnMut(Line) -> bool| -> bool {
        if buf.is_empty() {
            return true;
        }
        let text = String::from_utf8_lossy(buf).into_owned();
        buf.clear();
        emit(Line { text, partial })
    };
    for b in BufReader::new(from).bytes() {
        let Ok(b) = b else { break };
        let more = match b {
            b'\r' => flush(&mut buf, true, &mut emit),
            b'\n' => flush(&mut buf, false, &mut emit),
            _ => {
                if buf.len() < LINE_MAX {
                    buf.push(b);
                }
                true
            }
        };
        if !more {
            return;
        }
    }
    flush(&mut buf, false, &mut emit);
}

struct Job {
    pid: u32,
    cancelled: bool,
}

static JOBS: LazyLock<Mutex<HashMap<u64, Job>>> = LazyLock::new(Default::default);
static NEXT: AtomicU64 = AtomicU64::new(1);

fn clone_script(parent: &str, url: &str, name: &str) -> String {
    format!("cd {} && GIT_TERMINAL_PROMPT=0 exec git clone --progress -- {} {}", remote_path(parent), sq(url), sq(name))
}

fn clone_command(host: &str, parent: &str, url: &str, name: &str) -> Result<Command, String> {
    if !is_local(host) {
        envssh::check(host)?;
        return Ok(remote::command(host, &clone_script(parent, url, name)));
    }
    let mut cmd = Command::new("git");
    cmd.args(["clone", "--progress", "--", url, name])
        .current_dir(expand_home(parent))
        // Fail on a credential prompt rather than wait on a terminal nobody can type into.
        .env("GIT_TERMINAL_PROMPT", "0");
    hide_window(&mut cmd);
    Ok(cmd)
}

/// Stop the clone and whatever it started (git-remote-https, ssh): the whole tree on Windows,
/// the process group (`git_clone` makes one) elsewhere.
fn kill_tree(pid: u32) {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("taskkill");
        c.args(["/T", "/F", "/PID", &pid.to_string()]);
        c
    } else {
        let mut c = Command::new("kill");
        c.args(["-KILL", "--", &format!("-{pid}")]);
        c
    };
    hide_window(&mut cmd);
    let _ = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Git's pack files are read-only, which stops `remove_dir_all` on Windows; and a killed git can
/// hold a handle for a moment. So clear read-only and try a few times.
fn remove_tree(dir: &Path) {
    fn writable(p: &Path) {
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    writable(&path);
                } else if let Ok(m) = std::fs::metadata(&path) {
                    let mut perm = m.permissions();
                    #[allow(clippy::permissions_set_readonly_false)]
                    perm.set_readonly(false);
                    let _ = std::fs::set_permissions(&path, perm);
                }
            }
        }
    }
    for _ in 0..5 {
        if !dir.exists() {
            return;
        }
        writable(dir);
        if std::fs::remove_dir_all(dir).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// What a cancelled clone leaves behind goes. git refuses a destination that holds anything,
/// so the folder is the clone's own.
fn clean_up(host: &str, parent: &str, name: &str) {
    if is_local(host) {
        remove_tree(&PathBuf::from(expand_home(parent)).join(name));
    } else {
        let _ = remote::run(host, &format!("cd {} && rm -rf -- {}", remote_path(parent), sq(name)));
    }
}

/// `git clone url parent/name`. Output arrives on `on_lines` in batches; `on_exit` gets git's exit
/// code. The id goes to `git_clone_cancel`.
#[tauri::command]
pub async fn git_clone(
    host: String,
    parent: String,
    url: String,
    name: String,
    on_lines: Channel<Vec<Line>>,
    on_exit: Channel<i32>,
) -> Result<u64, String> {
    check_name(&name)?;
    let url = url.trim().to_string();
    if url.is_empty() || url.starts_with('-') {
        return Err("Not a repository URL".into());
    }
    let mut cmd = clone_command(&host, &parent, &url, &name)?;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("git: {e}"))?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    JOBS.lock().unwrap().insert(id, Job { pid: child.id(), cancelled: false });

    let (tx, rx) = mpsc::channel::<Line>();
    for from in [Box::new(child.stdout.take().expect("piped")) as Box<dyn Read + Send>, Box::new(child.stderr.take().expect("piped"))] {
        let tx = tx.clone();
        std::thread::spawn(move || split_progress(from, |l| tx.send(l).is_ok()));
    }
    drop(tx);
    std::thread::spawn(move || {
        // Batched, so a fast progress meter is a few updates a second, not hundreds.
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            while let Ok(l) = rx.recv_timeout(BATCH_WAIT) {
                batch.push(l);
            }
            let _ = on_lines.send(batch);
        }
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        let cancelled = JOBS.lock().unwrap().remove(&id).is_some_and(|j| j.cancelled);
        if cancelled {
            clean_up(&host, &parent, &name);
        }
        let _ = on_exit.send(code);
    });
    Ok(id)
}

/// Stop a clone. Its half-made folder is removed once git has gone.
#[tauri::command]
pub async fn git_clone_cancel(id: u64) -> Result<(), String> {
    blocking(move || {
        let pid = JOBS.lock().unwrap().get_mut(&id).map(|j| {
            j.cancelled = true;
            j.pid
        });
        if let Some(pid) = pid {
            kill_tree(pid);
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_names_not_paths() {
        for ok in ["app", "my app", ".config", "a.b", "über"] {
            assert!(check_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", " ", ".", "..", "a/b", "a\\b", "c:", "x?", "trailing.", "trailing ", "tab\there"] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn progress_splits_on_carriage_returns() {
        let out = b"Cloning into 'x'...\nReceiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.\nlast";
        let mut lines = Vec::new();
        split_progress(&out[..], |l| {
            lines.push(l);
            true
        });
        let l = |t: &str, partial| Line { text: t.into(), partial };
        assert_eq!(
            lines,
            [
                l("Cloning into 'x'...", false),
                l("Receiving objects:  10% (1/10)", true),
                l("Receiving objects: 100% (10/10), done.", false),
                l("last", false),
            ]
        );
    }

    #[test]
    fn scripts_quote_everything() {
        assert_eq!(make_script("~/src", "it's", true), "cd ~/'src' && mkdir -- 'it'\\''s' && cd -- 'it'\\''s' && git init -q");
        assert_eq!(make_script("/srv", "a", false), "cd '/srv' && mkdir -- 'a'");
        assert_eq!(
            clone_script("~", "https://x/y.git", "y"),
            "cd ~ && GIT_TERMINAL_PROMPT=0 exec git clone --progress -- 'https://x/y.git' 'y'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn make_script_runs_in_a_real_shell() {
        let root = std::env::temp_dir().join(format!("tri-newfolder-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let run = || std::process::Command::new("/bin/sh").arg("-c").arg(make_script(&root.to_string_lossy(), "it's new", false)).status().unwrap();
        assert!(run().success());
        assert!(root.join("it's new").is_dir());
        assert!(!run().success(), "a second mkdir of the same name fails");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn local_make_folder_refuses_an_existing_one() {
        let root = std::env::temp_dir().join(format!("tri-newfolder-local-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let parent = root.to_string_lossy().to_string();
        let rt = tauri::async_runtime::block_on(make_folder("local".into(), parent.clone(), "made".into(), false));
        assert_eq!(rt, Ok(()));
        assert!(root.join("made").is_dir());
        let again = tauri::async_runtime::block_on(make_folder("local".into(), parent, "made".into(), false));
        assert_eq!(again, Err("made already exists".into()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_tree_clears_read_only_files() {
        let root = std::env::temp_dir().join(format!("tri-newfolder-rm-{}", std::process::id()));
        std::fs::create_dir_all(root.join("objects/pack")).unwrap();
        let f = root.join("objects/pack/p.pack");
        std::fs::write(&f, "x").unwrap();
        let mut perm = std::fs::metadata(&f).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&f, perm).unwrap();
        remove_tree(&root);
        assert!(!root.exists());
    }
}
