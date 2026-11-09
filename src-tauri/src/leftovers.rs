//! Leftovers: what tri-code started that outlived its window and still holds a place (CONTEXT.md).
//!
//! - a ghost terminal: a terminal-host session whose key no tab has any more;
//! - a stray process: a program started in a tri-code terminal (it inherited `SESSION_ENV`) whose
//!   working folder, executable or arguments are under a project's folder and whose parent is gone
//!   (a dev server an agent backgrounded, esbuild's service);
//! - a remote session: a `tri-*` shpool or tmux session on an ssh host that no tab has;
//! - a leftover checkout: a folder in `<repo>.worktrees/` that git no longer lists;
//! - a prunable entry: a worktree git still lists whose folder is gone.
//!
//! Only what tri-code started is listed, so nothing else is offered to end. Any other process in a
//! folder (an editor opened on it) is reported too, for Remove worktree to name as a holder to close
//! by hand. Chosen from design/orphans.html (B).

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::pty::Ptys;
use crate::remote;
use crate::spawn::{expand_home, remote_path};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn is_local(host: &str) -> bool {
    matches!(host, "" | "local")
}

#[derive(Debug, Serialize)]
pub struct Ghost {
    pub id: u32,
    pub key: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    /// Its command line, shortened.
    pub cmd: String,
    /// The folder of `dirs` it is in.
    pub dir: String,
    /// Started in a tri-code terminal (`SESSION_ENV` is that terminal's key), and its parent is gone:
    /// nothing will end it. Otherwise it is someone else's (an editor's) and only named, never ended.
    pub orphan: bool,
    /// The key of the terminal it was started in, if it was.
    pub session: Option<String>,
    /// Seconds since it started.
    pub age: u64,
}

#[derive(Debug, Serialize)]
pub struct Local {
    pub ghosts: Vec<Ghost>,
    pub procs: Vec<Proc>,
}

/// `/`-separated, no trailing slash, and on Windows lower case, for comparing paths.
fn norm(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) { s.to_lowercase() } else { s.to_string() }
}

fn under(path: &str, dir: &str) -> bool {
    path == dir || (path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'/')
}

/// The first of `dirs` (normalized) that the process works in, runs from, or names in its arguments.
fn place_of(p: &Process, dirs: &[String]) -> Option<usize> {
    let mut paths: Vec<String> = Vec::new();
    if let Some(c) = p.cwd() {
        paths.push(norm(&c.to_string_lossy()));
    }
    if let Some(e) = p.exe() {
        paths.push(norm(&e.to_string_lossy()));
    }
    for a in p.cmd().iter().skip(1) {
        let a = a.to_string_lossy();
        // `--root=C:\x` names a path after the `=`.
        let a = a.rsplit_once('=').map_or(a.as_ref(), |(_, v)| v);
        if a.contains(['/', '\\']) {
            paths.push(norm(a.trim_matches('"')));
        }
    }
    dirs.iter().position(|d| paths.iter().any(|p| under(p, d)))
}

/// `pid`'s parent if it is still the process that started it: a pid can be reused, and a process
/// started after the child cannot be its parent.
fn live_parent<'a>(procs: &'a HashMap<Pid, Process>, p: &Process) -> Option<&'a Process> {
    let parent = procs.get(&p.parent()?)?;
    (parent.start_time() <= p.start_time()).then_some(parent)
}

/// Every terminal's environment names its session key here; what it starts inherits it.
pub const SESSION_ENV: &str = "TRICODE_SESSION";

fn session_of(p: &Process) -> Option<String> {
    let prefix = format!("{SESSION_ENV}=");
    p.environ().iter().find_map(|e| e.to_str()?.strip_prefix(&prefix).map(str::to_string))
}

fn is_host(p: &Process) -> bool {
    p.cmd().iter().any(|a| a == "--pty-daemon")
}

/// Started by tri-code: the app or the terminal host is among its ancestors (a tab's agent, a git
/// call). Those end with their tab, so they are not leftovers.
fn is_ours(procs: &HashMap<Pid, Process>, p: &Process, me: Pid) -> bool {
    let mut at = p;
    for _ in 0..64 {
        if at.pid() == me || is_host(at) {
            return true;
        }
        match live_parent(procs, at) {
            Some(parent) => at = parent,
            None => return false,
        }
    }
    false
}

fn system() -> Result<System, String> {
    let mut sys = System::new().map_err(|e| e.to_string())?;
    let kind = ProcessRefreshKind::nothing()
        .with_cwd(UpdateKind::Always)
        .with_exe(UpdateKind::Always)
        .with_cmd(UpdateKind::Always)
        .with_environ(UpdateKind::Always);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    Ok(sys)
}

/// The processes in `dirs` that tri-code didn't start and doesn't run in a tab.
fn scan(sys: &System, dirs: &[String]) -> Vec<Proc> {
    let me = Pid::from_u32(std::process::id());
    // A drive or the home folder would match nearly everything.
    let dirs: Vec<&String> = dirs.iter().filter(|d| norm(&expand_home(d)).matches('/').count() >= 2).collect();
    let norms: Vec<String> = dirs.iter().map(|d| norm(&expand_home(d))).collect();
    let procs = sys.processes();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let mut out: Vec<Proc> = procs
        .values()
        .filter(|p| p.thread_kind().is_none())
        .filter_map(|p| {
            let at = place_of(p, &norms)?;
            if is_ours(procs, p, me) {
                return None;
            }
            let cmd: Vec<String> = p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
            let mut cmd = cmd.join(" ");
            if cmd.chars().count() > 160 {
                cmd = cmd.chars().take(159).collect::<String>() + "…";
            }
            let session = session_of(p);
            Some(Proc {
                pid: p.pid().as_u32(),
                name: p.name().to_string_lossy().into_owned(),
                cmd,
                dir: dirs[at].clone(),
                orphan: session.is_some() && live_parent(procs, p).is_none(),
                session,
                age: now.saturating_sub(p.start_time()),
            })
        })
        .collect();
    // A child of a stray goes with it (taskkill /T, the process group), so list the top one only.
    let pids: Vec<u32> = out.iter().map(|p| p.pid).collect();
    out.retain(|p| {
        let proc = &procs[&Pid::from_u32(p.pid)];
        !live_parent(procs, proc).is_some_and(|parent| pids.contains(&parent.pid().as_u32()))
    });
    out.sort_by(|a, b| a.dir.cmp(&b.dir).then(b.age.cmp(&a.age)));
    out
}

/// This machine's leftovers: terminals no tab in `keep` has, and processes in `dirs` (the local
/// projects' folders) that tri-code isn't running in a tab.
#[tauri::command]
pub async fn leftovers_local(state: tauri::State<'_, Arc<Ptys>>, keep: Vec<String>, dirs: Vec<String>) -> Result<Local, String> {
    let ptys = Arc::clone(state.inner());
    blocking(move || {
        let ghosts = ptys.keys().into_iter().filter(|(_, k)| !k.is_empty() && !keep.contains(k)).map(|(id, key)| Ghost { id, key }).collect();
        let procs = scan(&system()?, &dirs);
        Ok(Local { ghosts, procs })
    })
    .await
}

/// End the processes `pids`, and what they started, if each is still one `leftovers_local` lists for
/// `dirs`: a pid that was reused since is left alone.
#[tauri::command]
pub async fn leftovers_end(pids: Vec<u32>, dirs: Vec<String>) -> Result<Vec<u32>, String> {
    blocking(move || {
        let sys = system()?;
        let still: Vec<u32> = scan(&sys, &dirs).into_iter().map(|p| p.pid).filter(|p| pids.contains(p)).collect();
        for &pid in &still {
            end_tree(&sys, pid);
        }
        Ok(still)
    })
    .await
}

#[cfg(windows)]
fn end_tree(_sys: &System, pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(CREATE_NO_WINDOW).output();
}

#[cfg(not(windows))]
fn end_tree(sys: &System, pid: u32) {
    // Children first, so none is left with no parent to become a stray of its own.
    let procs = sys.processes();
    let mut order = vec![Pid::from_u32(pid)];
    let mut i = 0;
    while i < order.len() {
        let at = order[i];
        order.extend(procs.values().filter(|p| p.parent() == Some(at) && !order.contains(&p.pid())).map(|p| p.pid()));
        i += 1;
    }
    for p in order.iter().rev() {
        if let Some(p) = procs.get(p) {
            p.kill_with(sysinfo::Signal::Term);
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(800));
    let mut sys = System::new().ok();
    if let Some(s) = sys.as_mut() {
        s.refresh_processes(ProcessesToUpdate::Some(&order), true);
        for p in &order {
            if let Some(p) = s.process(*p) {
                p.kill();
            }
        }
    }
}

/// The `tri-*` shpool and tmux sessions on `host` that no tab in `keep` has.
#[tauri::command]
pub async fn leftovers_remote(host: String, keep: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || {
        let out = remote::run(&host, "{ shpool list 2>/dev/null; tmux ls -F '#S' 2>/dev/null; }; true")?;
        Ok(remote_sessions(&out, &keep))
    })
    .await
}

fn remote_sessions(out: &str, keep: &[String]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for l in out.lines() {
        let Some(name) = l.split_whitespace().next() else { continue };
        if name.starts_with("tri-") && !keep.iter().any(|k| k == name) && !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    names
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Prunable {
    pub path: String,
    pub branch: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Checkouts {
    /// Folders in `<repo>.worktrees/` that git doesn't list.
    pub folders: Vec<String>,
    pub prunable: Vec<Prunable>,
}

/// The repo at `path`'s leftover checkouts and prunable entries. Nothing for a folder that isn't a repo.
#[tauri::command]
pub async fn leftovers_checkouts(host: String, path: String) -> Result<Checkouts, String> {
    blocking(move || {
        let Ok(list) = crate::git::exec(&host, &path, "git", &["worktree", "list", "--porcelain"], None) else {
            return Ok(Checkouts { folders: vec![], prunable: vec![] });
        };
        let listed = crate::git::parse_worktrees(&list);
        let dir = format!("{}.worktrees", path.trim_end_matches(['/', '\\']));
        let found = if is_local(&host) {
            std::fs::read_dir(expand_home(&dir))
                .map(|r| r.flatten().filter(|e| e.path().is_dir()).map(|e| e.path().to_string_lossy().into_owned()).collect())
                .unwrap_or_default()
        } else {
            let out = remote::run(&host, &format!("find {} -mindepth 1 -maxdepth 1 -type d 2>/dev/null; true", remote_path(&dir)))?;
            out.lines().map(str::to_string).filter(|l| !l.is_empty()).collect()
        };
        Ok(checkouts(&listed, found))
    })
    .await
}

fn checkouts(listed: &[crate::git::Worktree], found: Vec<String>) -> Checkouts {
    let known: Vec<String> = listed.iter().map(|w| norm(&w.path)).collect();
    let folders = found.into_iter().filter(|f| !known.contains(&norm(f))).collect();
    let prunable = listed.iter().filter(|w| w.prunable && !w.main).map(|w| Prunable { path: w.path.clone(), branch: w.branch.clone() }).collect();
    Checkouts { folders, prunable }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_under_its_folder_and_not_a_sibling_with_the_same_start() {
        assert!(under("/r.worktrees/a/src/x.ts", "/r.worktrees/a"));
        assert!(under("/r.worktrees/a", "/r.worktrees/a"));
        assert!(!under("/r.worktrees/ab", "/r.worktrees/a"));
        assert!(!under("/r", "/r.worktrees/a"));
    }

    #[test]
    fn remote_sessions_are_tri_ones_no_tab_has_once_each() {
        let out = "NAME\tSTARTED_AT\tSTATUS\ntri-a-1\t2026\tdisconnected\ntri-b-2\t2026\tattached\nwork\ntri-a-1\n";
        assert_eq!(remote_sessions(out, &["tri-b-2".into()]), vec!["tri-a-1".to_string()]);
    }

    #[test]
    fn checkouts_are_folders_git_does_not_list_and_entries_whose_folder_is_gone() {
        let listed = crate::git::parse_worktrees("worktree /r\nbranch refs/heads/main\n\nworktree /r.worktrees/a\nbranch refs/heads/a\n\nworktree /r.worktrees/gone\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n\n");
        let c = checkouts(&listed, vec!["/r.worktrees/a".into(), "/r.worktrees/old".into()]);
        assert_eq!(c.folders, vec!["/r.worktrees/old".to_string()]);
        assert_eq!(c.prunable, vec![Prunable { path: "/r.worktrees/gone".into(), branch: Some("gone".into()) }]);
    }

    /// A shell in `dir` that starts a sleeper and exits at once, so the sleeper's parent is gone.
    fn detach(dir: &std::path::Path, session: Option<&str>) {
        #[cfg(windows)]
        let mut c = {
            let mut c = std::process::Command::new("cmd");
            c.args(["/c", "start", "/b", "powershell", "-NoProfile", "-Command", "Start-Sleep 20"]);
            c
        };
        #[cfg(not(windows))]
        let mut c = {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "sleep 20 >/dev/null 2>&1 &"]);
            c
        };
        c.current_dir(dir).env_remove(SESSION_ENV);
        if let Some(s) = session {
            c.env(SESSION_ENV, s);
        }
        c.status().unwrap();
    }

    /// Left running by a terminal, it is a stray; started from anywhere else (`code .`), it is only
    /// named as holding the folder, never offered to end.
    #[test]
    fn a_detached_process_is_a_stray_only_when_a_tri_code_terminal_started_it() {
        let dir = std::env::temp_dir().join(format!("tri-leftover-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        detach(&dir, Some("tri-p-t"));
        detach(&dir, None);
        std::thread::sleep(std::time::Duration::from_millis(2000));
        let d = dir.to_string_lossy().into_owned();
        let found = scan(&system().unwrap(), std::slice::from_ref(&d));
        for p in &found {
            end_tree(&system().unwrap(), p.pid);
        }
        let _ = std::fs::remove_dir_all(&dir);
        let ours: Vec<_> = found.iter().filter(|p| p.session.as_deref() == Some("tri-p-t")).collect();
        let theirs: Vec<_> = found.iter().filter(|p| p.session.is_none()).collect();
        assert!(ours.iter().any(|p| p.orphan && p.dir == d), "{found:?}");
        assert!(!theirs.is_empty() && theirs.iter().all(|p| !p.orphan), "{found:?}");
    }
}
