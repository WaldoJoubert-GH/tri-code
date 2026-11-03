//! The Docker Window's commands: the `docker` CLI on the project's host, locally or over ssh.
//! `docker_ps` is one call; `docker_logs` and `docker_events` are streams of lines that run until
//! `docker_stop`. Parsing lives in `docker.ts`, so this only runs things and passes text on.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, mpsc};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;

use crate::db::tunnel::{self, Tunnel};
use crate::remote;
use crate::spawn::{expand_home, remote_path, sq};
use crate::{envssh, git::blocking};

/// One log line longer than this is cut, so a runaway line can't stall the window.
const LINE_MAX: usize = 16 * 1024;
const BATCH_MAX: usize = 500;
const BATCH_WAIT: Duration = Duration::from_millis(40);

fn is_local(host: &str) -> bool {
    matches!(host, "" | "local")
}

fn line(args: &[&str]) -> String {
    std::iter::once("docker").chain(args.iter().copied()).map(sq).collect::<Vec<_>>().join(" ")
}

/// What runs docker through the host's login shell, which is where a Mac or a remote host has it.
fn login(args: &[&str]) -> String {
    format!("\"${{SHELL:-/bin/sh}}\" -lc {}", sq(&format!("exec {}", line(args))))
}

fn hide_window(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// docker on this machine. `docker` is a real executable on Windows, so no cmd.exe to quote for.
fn local_command(args: &[&str]) -> Command {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("docker");
        c.args(args);
        c
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = Command::new(shell);
        c.args(["-lc", &format!("exec {}", line(args))]);
        c
    };
    hide_window(&mut cmd);
    cmd
}

fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == ErrorKind::NotFound { "docker: command not found".into() } else { format!("docker: {e}") }
}

/// The containers on the host, as docker prints them, and the project folder as the host spells it.
#[derive(Debug, Serialize, PartialEq)]
pub struct Ps {
    /// The folder, and its real path when a symlink makes that different.
    pub dirs: Vec<String>,
    /// One JSON object per line.
    pub out: String,
}

/// `pwd` and `pwd -P`, a separator line, then the containers: all in one ssh round trip.
const SEP: char = '\u{1e}';

fn ps_args() -> [&'static str; 5] {
    ["ps", "-a", "--no-trunc", "--format", "{{json .}}"]
}

fn ps_script(path: &str) -> String {
    format!("cd {} 2>/dev/null && pwd && pwd -P; printf '\\036\\n'; exec {}", remote_path(path), login(&ps_args()))
}

fn split_ps(out: &str) -> Ps {
    let (head, rest) = out.split_once(SEP).unwrap_or(("", out));
    let mut dirs: Vec<String> = Vec::new();
    for d in head.lines().map(str::trim).filter(|d| !d.is_empty()) {
        if !dirs.iter().any(|x| x == d) {
            dirs.push(d.to_string());
        }
    }
    Ps { dirs, out: rest.trim_start_matches(['\r', '\n']).to_string() }
}

fn local_dirs(path: &str) -> Vec<String> {
    let dir = expand_home(path);
    let real = std::fs::canonicalize(&dir).ok().map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    let mut dirs = vec![dir];
    if let Some(r) = real.filter(|r| !dirs.contains(r)) {
        dirs.push(r);
    }
    dirs
}

#[tauri::command]
pub async fn docker_ps(host: String, path: String) -> Result<Ps, String> {
    blocking(move || {
        if !is_local(&host) {
            return Ok(split_ps(&remote::run(&host, &ps_script(&path))?));
        }
        Ok(Ps { dirs: local_dirs(&path), out: run_local(&ps_args())? })
    })
    .await
}

/// docker on this machine, to completion. Errors carry stderr.
fn run_local(args: &[&str]) -> Result<String, String> {
    let output = local_command(args).stdin(Stdio::null()).output().map_err(spawn_error)?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("docker {}: {}", args.first().unwrap_or(&""), output.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `docker compose -p <stack> start` needs no compose file and keeps the stack's start order.
fn action_args(action: &str, stack: Option<&str>, container: Option<&str>) -> Result<Vec<String>, String> {
    if !matches!(action, "start" | "stop") {
        return Err(format!("docker: unknown action {action}"));
    }
    match (stack, container) {
        (Some(s), None) => Ok(["compose", "-p", s, action].map(String::from).to_vec()),
        (None, Some(c)) => Ok([action, c].map(String::from).to_vec()),
        _ => Err("docker: name a stack or a container".into()),
    }
}

/// Start or stop a stack or a container. Stopping can take a while: docker waits for it to exit.
#[tauri::command]
pub async fn docker_action(host: String, action: String, stack: Option<String>, container: Option<String>) -> Result<(), String> {
    let args = action_args(&action, stack.as_deref(), container.as_deref())?;
    blocking(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        if is_local(&host) {
            run_local(&args)?;
        } else {
            remote::run(&host, &format!("exec {}", login(&args)))?;
        }
        Ok(())
    })
    .await
}

// ── streams ──────────────────────────────────────────────────────────

struct Stream {
    pid: u32,
    /// Held open: over ssh, its end is what tells the far side to stop (see `follow_script`).
    _stdin: Option<ChildStdin>,
}

static STREAMS: LazyLock<Mutex<HashMap<u64, Stream>>> = LazyLock::new(Default::default);
static TUNNELS: LazyLock<Mutex<HashMap<u64, Tunnel>>> = LazyLock::new(Default::default);
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Ending ssh alone can leave a following docker running on the host until its next write, and a
/// quiet container may never write. So docker runs beside a reader of ssh's stdin, which ends with
/// the connection and takes docker with it. A background job's stdin is /dev/null even with `<&0`,
/// hence fd 3.
fn follow_script(args: &[&str]) -> String {
    format!(
        "exec 3<&0; {} & p=$!; (cat <&3 >/dev/null 2>&1; kill $p 2>/dev/null) & w=$!; wait $p; r=$?; kill $w 2>/dev/null; exit $r",
        login(args)
    )
}

fn stream_command(host: &str, args: &[&str]) -> Result<Command, String> {
    if is_local(host) {
        return Ok(local_command(args));
    }
    envssh::check(host)?;
    Ok(remote::command(host, &follow_script(args)))
}

/// Docker's compose plugin is a child of `docker`, and a parent's death doesn't end it, so a stream
/// is stopped as a whole tree (Windows) or process group (`start` makes one per stream).
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

/// A line without its ending, cut to `LINE_MAX` on a character boundary.
fn clean_line(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let s = s.trim_end_matches(['\r', '\n']);
    if s.len() <= LINE_MAX {
        return s.to_string();
    }
    let mut end = LINE_MAX;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

fn read_lines(from: impl Read + Send + 'static, to: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(from);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    if to.send(clean_line(&buf)).is_err() {
                        return;
                    }
                }
            }
        }
    });
}

/// Hand lines over in batches, so a burst is one update of the window rather than thousands.
fn pump(rx: mpsc::Receiver<String>, on_lines: &Channel<Vec<String>>) {
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        while batch.len() < BATCH_MAX {
            match rx.recv_timeout(BATCH_WAIT) {
                Ok(l) => batch.push(l),
                Err(_) => break,
            }
        }
        let _ = on_lines.send(batch);
    }
}

fn start(mut cmd: Command, on_lines: Channel<Vec<String>>, on_exit: Channel<i32>) -> Result<u64, String> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child: Child = cmd.spawn().map_err(spawn_error)?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    read_lines(child.stdout.take().expect("stdout is piped"), tx.clone());
    read_lines(child.stderr.take().expect("stderr is piped"), tx);
    STREAMS.lock().unwrap().insert(id, Stream { pid: child.id(), _stdin: child.stdin.take() });
    std::thread::spawn(move || {
        pump(rx, &on_lines);
        // Out of the table before the wait: once reaped, the pid could belong to anything.
        STREAMS.lock().unwrap().remove(&id);
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = on_exit.send(code);
    });
    Ok(id)
}

fn logs_args(stack: Option<&str>, container: Option<&str>, tail: u32, since: Option<&str>) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = match (stack, container) {
        (Some(s), None) => ["compose", "-p", s, "logs", "--follow", "--no-color", "--timestamps"].map(String::from).to_vec(),
        (None, Some(_)) => ["logs", "--follow", "--timestamps"].map(String::from).to_vec(),
        _ => return Err("docker logs: name a stack or a container".into()),
    };
    // Carrying on takes everything since then: a tail would cap it, and --tail 0 would drop it all.
    match since {
        Some(s) => args.extend(["--since".to_string(), s.to_string()]),
        None => args.extend(["--tail".to_string(), tail.to_string()]),
    }
    if let Some(c) = container {
        args.push(c.to_string());
    }
    Ok(args)
}

/// Follow a compose stack's logs or a container's. The id goes to `docker_stop`.
#[tauri::command]
pub async fn docker_logs(
    host: String,
    stack: Option<String>,
    container: Option<String>,
    tail: u32,
    since: Option<String>,
    on_lines: Channel<Vec<String>>,
    on_exit: Channel<i32>,
) -> Result<u64, String> {
    let args = logs_args(stack.as_deref(), container.as_deref(), tail, since.as_deref())?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    start(stream_command(&host, &args)?, on_lines, on_exit)
}

/// The container events that can change what the window shows. Health checks run as execs, so
/// leaving exec_* out keeps a healthy host quiet.
const EVENTS: &[&str] = &["create", "start", "restart", "die", "stop", "kill", "pause", "unpause", "destroy", "rename", "health_status"];

fn events_args() -> Vec<String> {
    let mut args: Vec<String> = ["events", "--format", "{{json .}}", "--filter", "type=container"].map(String::from).to_vec();
    for e in EVENTS {
        args.extend(["--filter".to_string(), format!("event={e}")]);
    }
    args
}

/// Follow `docker events`, one JSON object per line. The id goes to `docker_stop`.
#[tauri::command]
pub async fn docker_events(host: String, on_lines: Channel<Vec<String>>, on_exit: Channel<i32>) -> Result<u64, String> {
    let args = events_args();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    start(stream_command(&host, &args)?, on_lines, on_exit)
}

#[tauri::command]
pub async fn docker_stop(id: u64) -> Result<(), String> {
    blocking(move || {
        if let Some(s) = STREAMS.lock().unwrap().remove(&id) {
            kill_tree(s.pid);
        }
        Ok(())
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct Forward {
    pub id: u64,
    pub port: u16,
}

/// Reach a port of an ssh host from here. The tunnel lasts until `docker_unforward`.
#[tauri::command]
pub async fn docker_forward(host: String, to_host: String, port: u16) -> Result<Forward, String> {
    let t = tunnel::open(&host, &to_host, port).await?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let local = t.port;
    TUNNELS.lock().unwrap().insert(id, t);
    Ok(Forward { id, port: local })
}

#[tauri::command]
pub async fn docker_unforward(id: u64) -> Result<(), String> {
    TUNNELS.lock().unwrap().remove(&id);
    Ok(())
}

/// End every stream and tunnel as the app exits.
pub fn close_all() {
    for (_, s) in STREAMS.lock().unwrap().drain() {
        kill_tree(s.pid);
    }
    TUNNELS.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_logs_name_the_stack_and_container_logs_end_with_the_container() {
        assert_eq!(
            logs_args(Some("my app"), None, 500, None).unwrap(),
            ["compose", "-p", "my app", "logs", "--follow", "--no-color", "--timestamps", "--tail", "500"]
        );
        assert_eq!(
            logs_args(None, Some("abc"), 0, Some("2026-11-03T10:00:00Z")).unwrap(),
            ["logs", "--follow", "--timestamps", "--since", "2026-11-03T10:00:00Z", "abc"]
        );
        assert!(logs_args(None, None, 1, None).is_err());
        assert!(logs_args(Some("a"), Some("b"), 1, None).is_err());
    }

    #[test]
    fn actions_go_through_compose_for_a_stack_and_only_start_and_stop_are_allowed() {
        assert_eq!(action_args("stop", Some("my app"), None).unwrap(), ["compose", "-p", "my app", "stop"]);
        assert_eq!(action_args("start", None, Some("web")).unwrap(), ["start", "web"]);
        assert!(action_args("rm", None, Some("web")).is_err());
        assert!(action_args("stop", None, None).is_err());
        assert!(action_args("stop", Some("a"), Some("b")).is_err());
    }

    #[test]
    fn events_leave_out_health_check_execs() {
        let args = events_args();
        assert!(args.contains(&"event=health_status".to_string()));
        assert!(!args.iter().any(|a| a.contains("exec")));
    }

    #[test]
    fn the_host_runs_docker_through_its_login_shell_with_one_layer_of_quotes_each() {
        assert_eq!(login(&["logs", "a b"]), r#""${SHELL:-/bin/sh}" -lc 'exec '\''docker'\'' '\''logs'\'' '\''a b'\'''"#);
    }

    #[test]
    fn a_followed_stream_reads_ssh_stdin_through_fd_3() {
        let s = follow_script(&["events"]);
        assert!(s.starts_with("exec 3<&0; "));
        assert!(s.contains("cat <&3"));
        assert!(s.ends_with("exit $r"));
    }

    #[test]
    fn ps_output_splits_into_the_folder_and_the_containers() {
        let p = split_ps("/home/w/app\n/data/app\n\u{1e}\n{\"ID\":\"1\"}\n");
        assert_eq!(p.dirs, ["/home/w/app", "/data/app"]);
        assert_eq!(p.out, "{\"ID\":\"1\"}\n");
        assert_eq!(split_ps("/same\n/same\n\u{1e}\n").dirs, ["/same"]);
        // A folder gone from the host: no dirs, and the containers still come through.
        let p = split_ps("\u{1e}\n{\"ID\":\"2\"}\n");
        assert!(p.dirs.is_empty());
        assert_eq!(p.out, "{\"ID\":\"2\"}\n");
    }

    fn channels() -> (Channel<Vec<String>>, Channel<i32>, mpsc::Receiver<String>, mpsc::Receiver<i32>) {
        use tauri::ipc::InvokeResponseBody;
        let (line_tx, lines) = mpsc::channel();
        let (exit_tx, exits) = mpsc::channel();
        let on_lines = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                for l in serde_json::from_str::<Vec<String>>(&json).unwrap() {
                    let _ = line_tx.send(l);
                }
            }
            Ok(())
        });
        let on_exit = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let _ = exit_tx.send(json.parse::<i32>().unwrap());
            }
            Ok(())
        });
        (on_lines, on_exit, lines, exits)
    }

    fn shell(script_unix: &str, script_windows: &str) -> Command {
        if cfg!(windows) {
            let mut c = Command::new("cmd.exe");
            c.args(["/d", "/c", script_windows]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", script_unix]);
            c
        }
    }

    const WAIT: Duration = Duration::from_secs(20);

    #[test]
    fn a_stream_hands_over_both_outputs_and_its_exit_code() {
        let (on_lines, on_exit, lines, exits) = channels();
        start(shell("echo out; echo err >&2; exit 3", "echo out& echo err 1>&2& exit /b 3"), on_lines, on_exit).unwrap();
        assert_eq!(exits.recv_timeout(WAIT).unwrap(), 3);
        let mut got: Vec<String> = lines.try_iter().map(|l| l.trim().to_string()).collect();
        got.sort();
        assert_eq!(got, ["err", "out"]);
    }

    #[test]
    fn stopping_a_stream_ends_its_children_too() {
        let (on_lines, on_exit, lines, exits) = channels();
        // The long wait is a child of the shell, as compose is of docker: its end proves the tree went.
        let cmd = shell("echo up; sleep 60; echo late", "echo up& ping -n 60 127.0.0.1 >nul& echo late");
        let id = start(cmd, on_lines, on_exit).unwrap();
        assert_eq!(lines.recv_timeout(WAIT).unwrap().trim(), "up");
        tauri::async_runtime::block_on(docker_stop(id)).unwrap();
        exits.recv_timeout(WAIT).unwrap();
        assert!(!STREAMS.lock().unwrap().contains_key(&id));
        assert!(lines.try_iter().all(|l| !l.contains("late")));
    }

    /// The script that runs on an ssh host, with a stand-in for ssh's stdin and for docker.
    #[cfg(unix)]
    #[test]
    fn the_host_side_of_a_stream_stops_when_stdin_closes_and_passes_on_the_exit_code() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("tri-docker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("docker");
        std::fs::write(&fake, "#!/bin/sh\n[ \"$1\" = fail ] && exit 7\necho started\nexec sleep 60\n").unwrap();
        std::process::Command::new("chmod").arg("+x").arg(&fake).status().unwrap();
        let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap());
        let run = |arg: &str| {
            let mut c = Command::new("sh");
            c.args(["-c", &follow_script(&[arg])]).env("PATH", &path).env("SHELL", "/bin/sh");
            c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
            c.spawn().unwrap()
        };
        // docker ending by itself ends the script, with its code, though stdin stays open.
        let mut failed = run("fail");
        let held = failed.stdin.take();
        assert_eq!(failed.wait().unwrap().code(), Some(7));
        drop(held);
        // Closing stdin, which is what a dropped ssh does, ends docker.
        let mut child = run("follow");
        let mut stdin = child.stdin.take().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut first = String::new();
        out.read_line(&mut first).unwrap();
        assert_eq!(first.trim(), "started");
        stdin.flush().unwrap();
        drop(stdin);
        let begun = std::time::Instant::now();
        child.wait().unwrap();
        assert!(begun.elapsed() < Duration::from_secs(20));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn long_lines_are_cut_on_a_character_boundary() {
        assert_eq!(clean_line(b"hello\r\n"), "hello");
        let long = "é".repeat(LINE_MAX);
        let cut = clean_line(long.as_bytes());
        assert!(cut.ends_with('…') && cut.len() <= LINE_MAX + '…'.len_utf8());
    }
}
