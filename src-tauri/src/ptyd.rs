//! The terminal host: a small background process that owns every PTY, so agents keep running while
//! the app is closed, crashed or being updated. It is this same executable started with
//! `--pty-daemon <info file>`; see `launch` for how and from where.
//!
//! The app talks to it over one loopback TCP connection, authenticated with a random token from the
//! info file, the same pattern as the agent-windows endpoint. Only one app is connected at a time.
//! A frame is `u32 length, u8 kind, payload`. Nothing here knows about Tauri.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};

/// Bumped when the messages change. A host on another version is stopped and its agents resumed.
/// `Hello`, `Welcome` and `Shutdown` must keep their shape in every version.
pub const PROTOCOL: u32 = 1;
/// How much recent output is kept for an app that attaches later.
pub const SCROLLBACK: usize = 256 * 1024;
/// With no app and no terminals, the host leaves after this long.
const IDLE_EXIT: Duration = Duration::from_secs(30);
const MAX_FRAME: usize = 64 * 1024 * 1024;

pub const KIND_JSON: u8 = 0;
pub const KIND_OUTPUT: u8 = 1;
pub const KIND_INPUT: u8 = 2;

/// Where the running host listens, written once it is ready.
#[derive(Serialize, Deserialize, Clone)]
pub struct Info {
    pub port: u16,
    pub token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum ToHost {
    Hello { token: String, protocol: u32 },
    Spawn { req: u64, key: String, meta: String, program: String, args: Vec<String>, cwd: Option<String>, env: Vec<(String, String)>, cols: u16, rows: u16 },
    Resize { id: u32, cols: u16, rows: u16 },
    Kill { id: u32 },
    /// Ends every terminal whose key isn't in `keep`: tabs that were closed while nothing saved it.
    Reap { keep: Vec<String> },
    KillAll,
    Shutdown,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum FromHost {
    Welcome { protocol: u32, sessions: Vec<Running> },
    Spawned { req: u64, result: Result<u32, String> },
    Exit { id: u32, code: i32 },
}

/// A terminal that was already running when the app connected.
#[derive(Serialize, Deserialize)]
pub struct Running {
    pub id: u32,
    pub key: String,
    /// The app's own data for this terminal, kept for it across restarts.
    pub meta: String,
    pub total: u64,
    /// Its recent output, base64.
    pub recent: String,
    /// The latest OSC 7501 report, as the program sent it.
    pub report: Option<String>,
}

pub fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&frame(kind, payload))?;
    w.flush()
}

pub fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    out
}

pub fn read_frame(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let len = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok((head[4], payload))
}

/// An output frame's payload: the terminal's id, then its bytes.
pub fn with_id(id: u32, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 4);
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

pub fn split_id(payload: &[u8]) -> Option<(u32, &[u8])> {
    let (id, rest) = payload.split_first_chunk::<4>()?;
    Some((u32::from_le_bytes(*id), rest))
}

/// Reads a terminal's output for what the host must act on itself: the probes a program waits on
/// when no xterm is there to answer, and its latest OSC 7501 report. Holds its place between chunks,
/// so a sequence split across two reads is still seen.
#[derive(Default)]
pub struct Scanner {
    state: ScanState,
    buf: Vec<u8>,
    pub report: Option<String>,
}

#[derive(Default, PartialEq)]
enum ScanState {
    #[default]
    Text,
    Esc,
    Csi,
    Osc,
    OscEsc,
}

const SCAN_MAX: usize = 8 * 1024;

impl Scanner {
    /// Takes in output and returns what a terminal would answer to it.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut reply = Vec::new();
        for &b in bytes {
            match self.state {
                ScanState::Text => {
                    if b == 0x1b {
                        self.state = ScanState::Esc;
                    }
                }
                ScanState::Esc => {
                    self.buf.clear();
                    self.state = match b {
                        b'[' => ScanState::Csi,
                        b']' => ScanState::Osc,
                        0x1b => ScanState::Esc,
                        _ => ScanState::Text,
                    };
                }
                ScanState::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        match (self.buf.as_slice(), b) {
                            // Where the cursor is. ConPTY prints nothing until this is answered.
                            (b"6", b'n') => reply.extend_from_slice(b"\x1b[1;1R"),
                            // What the terminal is.
                            (b"" | b"0", b'c') => reply.extend_from_slice(b"\x1b[?1;2c"),
                            _ => {}
                        }
                        self.state = ScanState::Text;
                    } else if self.buf.len() < SCAN_MAX {
                        self.buf.push(b);
                    }
                }
                ScanState::Osc => match b {
                    0x07 => {
                        self.osc(&mut reply);
                        self.state = ScanState::Text;
                    }
                    0x1b => self.state = ScanState::OscEsc,
                    _ if self.buf.len() < SCAN_MAX => self.buf.push(b),
                    _ => {}
                },
                ScanState::OscEsc => {
                    if b == b'\\' {
                        self.osc(&mut reply);
                    }
                    self.state = ScanState::Text;
                }
            }
        }
        reply
    }

    fn osc(&mut self, reply: &mut Vec<u8>) {
        let Some(data) = self.buf.strip_prefix(b"7501;") else { return };
        if data.starts_with(b"?") {
            reply.extend_from_slice(b"\x1b]7501;?\x1b\\");
            return;
        }
        // Records with an `id` describe sub-tasks; only the root one is kept, as in terms.ts.
        let text = String::from_utf8_lossy(data);
        if !text.split(':').any(|f| f.starts_with("id=")) {
            self.report = Some(text.into_owned());
        }
    }
}

struct Sess {
    key: String,
    meta: String,
    recent: VecDeque<u8>,
    total: u64,
    scan: Scanner,
    master: Box<dyn MasterPty + Send>,
    input: Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

#[derive(Default)]
struct Host {
    sessions: HashMap<u32, Sess>,
    next_id: u32,
    client: Option<(u64, Sender<Vec<u8>>)>,
    next_client: u64,
    idle_since: Option<Instant>,
}

type Shared = Arc<Mutex<Host>>;

fn to_client(h: &Host, msg: &FromHost) {
    if let Some((_, tx)) = &h.client
        && let Ok(json) = serde_json::to_vec(msg)
    {
        let _ = tx.send(frame(KIND_JSON, &json));
    }
}

/// Ends the program and, on Windows, what it started: killing it alone leaves a dev server under
/// the shell running with no window, holding files and the folder open.
fn kill_tree(pid: Option<u32>, mut killer: Box<dyn ChildKiller + Send + Sync>) {
    #[cfg(windows)]
    if let Some(pid) = pid {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(windows))]
    let _ = pid;
    let _ = killer.kill();
}

fn kill_in_background(s: &Sess) {
    let (pid, killer) = (s.pid, s.killer.clone_killer());
    std::thread::spawn(move || kill_tree(pid, killer));
}

#[allow(clippy::too_many_arguments)]
fn spawn(host: &Shared, key: String, meta: String, program: String, args: Vec<String>, cwd: Option<String>, env: Vec<(String, String)>, cols: u16, rows: u16, req: u64) -> Result<(), String> {
    let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    if let Some(cwd) = &cwd {
        cmd.cwd(cwd);
    }
    // The host outlives the app, so a terminal gets the environment of the app that asked for it.
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("failed to start {program}: {e}"))?;
    // Drop our copy of the slave so the reader sees EOF when the child exits.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Its own thread: a program that stops reading must not hold up the other terminals.
    let (input, input_rx) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in input_rx {
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    let id = {
        let mut h = host.lock().unwrap();
        // A new start under a key still in use replaces it.
        let old: Vec<u32> = h.sessions.iter().filter(|(_, s)| s.key == key).map(|(id, _)| *id).collect();
        for o in old {
            if let Some(s) = h.sessions.get_mut(&o) {
                s.key = String::new();
                kill_in_background(s);
            }
        }
        let id = h.next_id;
        h.next_id += 1;
        let sess = Sess {
            key,
            meta,
            recent: VecDeque::new(),
            total: 0,
            scan: Scanner::default(),
            master: pair.master,
            input,
            killer: child.clone_killer(),
            pid: child.process_id(),
        };
        h.sessions.insert(id, sess);
        // Before the reader starts, so the app knows the id before any of its output.
        to_client(&h, &FromHost::Spawned { req, result: Ok(id) });
        id
    };

    let reading = Arc::clone(host);
    let reader_thread = std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut h = reading.lock().unwrap();
                    let attached = h.client.is_some();
                    if let Some(s) = h.sessions.get_mut(&id) {
                        s.total += n as u64;
                        s.recent.extend(&buf[..n]);
                        let over = s.recent.len().saturating_sub(SCROLLBACK);
                        s.recent.drain(..over);
                        let reply = s.scan.feed(&buf[..n]);
                        // With an app attached, its xterm answers.
                        if !attached && !reply.is_empty() {
                            let _ = s.input.send(reply);
                        }
                    }
                    if let Some((_, tx)) = &h.client {
                        let _ = tx.send(frame(KIND_OUTPUT, &with_id(id, &buf[..n])));
                    }
                }
            }
        }
    });

    let waiting = Arc::clone(host);
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
        let removed = waiting.lock().unwrap().sessions.remove(&id);
        // Closing the PTY is what unblocks the reader on Windows, and it can wait on the program's
        // last output, so it happens outside the lock.
        drop(removed);
        let _ = reader_thread.join();
        to_client(&waiting.lock().unwrap(), &FromHost::Exit { id, code });
    });
    Ok(())
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle(host: &Shared, stream: TcpStream, token: &str) -> std::io::Result<()> {
    stream.set_nodelay(true)?;
    let mut reader = stream.try_clone()?;
    let mut writer = stream.try_clone()?;
    reader.set_read_timeout(Some(Duration::from_secs(5)))?;
    let (kind, payload) = read_frame(&mut reader)?;
    let hello = (kind == KIND_JSON).then(|| serde_json::from_slice::<ToHost>(&payload).ok()).flatten();
    let Some(ToHost::Hello { token: given, .. }) = hello else { return Ok(()) };
    if !same(&given, token) {
        return Ok(());
    }
    reader.set_read_timeout(None)?;

    let (tx, rx) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for f in rx {
            if writer.write_all(&f).is_err() {
                break;
            }
        }
        let _ = writer.shutdown(Shutdown::Both);
    });

    let me = {
        let mut h = host.lock().unwrap();
        let me = h.next_client;
        h.next_client += 1;
        let b64 = base64::engine::general_purpose::STANDARD;
        let sessions = h
            .sessions
            .iter()
            .filter(|(_, s)| !s.key.is_empty())
            .map(|(id, s)| Running {
                id: *id,
                key: s.key.clone(),
                meta: s.meta.clone(),
                total: s.total,
                recent: b64.encode(s.recent.iter().copied().collect::<Vec<u8>>()),
                report: s.scan.report.clone(),
            })
            .collect();
        // The state lock is held from this snapshot until the slot is set, so no output is lost or
        // sent twice. Replacing the sender closes the connection of an app before this one.
        h.client = Some((me, tx));
        to_client(&h, &FromHost::Welcome { protocol: PROTOCOL, sessions });
        me
    };

    let result = serve_client(host, &mut reader);
    let mut h = host.lock().unwrap();
    if h.client.as_ref().is_some_and(|(c, _)| *c == me) {
        h.client = None;
    }
    result
}

fn serve_client(host: &Shared, reader: &mut TcpStream) -> std::io::Result<()> {
    loop {
        let (kind, payload) = read_frame(reader)?;
        if kind == KIND_INPUT {
            if let Some((id, bytes)) = split_id(&payload)
                && let Some(s) = host.lock().unwrap().sessions.get(&id)
            {
                let _ = s.input.send(bytes.to_vec());
            }
            continue;
        }
        let Ok(msg) = serde_json::from_slice::<ToHost>(&payload) else { continue };
        match msg {
            ToHost::Hello { .. } => {}
            ToHost::Spawn { req, key, meta, program, args, cwd, env, cols, rows } => {
                if let Err(e) = spawn(host, key, meta, program, args, cwd, env, cols, rows, req) {
                    to_client(&host.lock().unwrap(), &FromHost::Spawned { req, result: Err(e) });
                }
            }
            ToHost::Resize { id, cols, rows } => {
                if let Some(s) = host.lock().unwrap().sessions.get(&id) {
                    let _ = s.master.resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 });
                }
            }
            ToHost::Kill { id } => {
                if let Some(s) = host.lock().unwrap().sessions.get_mut(&id) {
                    s.key = String::new();
                    kill_in_background(s);
                }
            }
            ToHost::Reap { keep } => {
                for s in host.lock().unwrap().sessions.values_mut() {
                    if !keep.contains(&s.key) {
                        s.key = String::new();
                        kill_in_background(s);
                    }
                }
            }
            ToHost::KillAll => {
                for s in host.lock().unwrap().sessions.values_mut() {
                    s.key = String::new();
                    kill_in_background(s);
                }
            }
            ToHost::Shutdown => {
                let all: Vec<_> = host.lock().unwrap().sessions.values().map(|s| (s.pid, s.killer.clone_killer())).collect();
                for (pid, killer) in all {
                    kill_tree(pid, killer);
                }
                std::process::exit(0);
            }
        }
    }
}

/// Binds and serves on a background thread, and returns where. The tests run the host this way.
fn serve() -> std::io::Result<(Info, Shared)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let mut raw = [0u8; 24];
    getrandom::getrandom(&mut raw).map_err(std::io::Error::other)?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let host: Shared = Arc::default();
    let (accepting, expected) = (Arc::clone(&host), token.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (host, token) = (Arc::clone(&accepting), expected.clone());
            std::thread::spawn(move || {
                let _ = handle(&host, stream, &token);
            });
        }
    });
    Ok((Info { port, token }, host))
}

/// The host process's whole life: listen, say where, and stay until it has nothing left to do.
pub fn run_daemon(info_file: &Path) {
    let Ok((info, host)) = serve() else { return };
    if write_info(info_file, &info).is_err() {
        return;
    }
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let mut h = host.lock().unwrap();
        if h.client.is_some() || !h.sessions.is_empty() {
            h.idle_since = None;
        } else if h.idle_since.get_or_insert_with(Instant::now).elapsed() >= IDLE_EXIT {
            std::process::exit(0);
        }
    }
}

fn write_info(path: &Path, info: &Info) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec(info)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    // The token opens every terminal, so only this user may read it. On Windows the config folder's
    // own permissions already do that.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(&json)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)
}

/// Starts the host from `exe`, detached from this process so it outlives it.
pub fn launch(exe: &Path, info_file: &Path) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--pty-daemon")
        .arg(info_file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Not the app's folder: the dll search looks in the working directory too, and the host
    // shouldn't hold the install folder open.
    if let Some(d) = exe.parent() {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        // Out of any job the app runs in, whose end would take the host along. A job may refuse that.
        cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        cmd.creation_flags(base);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, away from any signal sent to the app's.
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ())
}

/// The host's exe inside its folder of the cache.
const HOST_EXE: &str = "tri-code-host.exe";
/// Files next to the app's exe that the host loads or starts. ConPTY looks for `conpty.dll` next to
/// the exe and starts `OpenConsole.exe` from next to the dll, so the host needs its own copies.
const HOST_COMPANIONS: [&str; 2] = ["conpty.dll", "OpenConsole.exe"];

/// What to run the host from. On Windows a running exe or loaded dll can't be replaced, so a host
/// running from the install folder would make every update fail while a terminal is open. It runs
/// from a copy of the exe and its ConPTY files in a folder per build (named by size and time); older
/// folders are removed once their host has exited.
pub fn host_exe(cache_dir: &Path) -> PathBuf {
    let current = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("tri-code"));
    if !cfg!(windows) {
        return current;
    }
    copy_for_host(&current, cache_dir).unwrap_or(current)
}

fn copy_for_host(current: &Path, dir: &Path) -> std::io::Result<PathBuf> {
    let meta = std::fs::metadata(current)?;
    let stamp = meta.modified()?.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    std::fs::create_dir_all(dir)?;
    let name = format!("{}-{stamp}", meta.len());
    let target = dir.join(&name);
    if !target.join(HOST_EXE).exists() {
        let tmp = dir.join(format!("{name}.tmp"));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp)?;
        std::fs::copy(current, tmp.join(HOST_EXE))?;
        let from = current.parent().unwrap_or(Path::new("."));
        for f in HOST_COMPANIONS {
            if from.join(f).exists() {
                std::fs::copy(from.join(f), tmp.join(f))?;
            }
        }
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&tmp, &target)?;
    }
    for entry in std::fs::read_dir(dir)?.flatten() {
        let n = entry.file_name();
        if *n.to_string_lossy() == *name {
            continue;
        }
        let p = entry.path();
        if p.is_dir() {
            // Deleting the exe fails while its host runs; only then is the rest of the folder free.
            let exe = p.join(HOST_EXE);
            if !exe.exists() || std::fs::remove_file(&exe).is_ok() {
                let _ = std::fs::remove_dir_all(&p);
            }
        } else if n.to_string_lossy().starts_with("tri-code-host-") {
            // A copy from before hosts had their own folders.
            let _ = std::fs::remove_file(&p);
        }
    }
    Ok(target.join(HOST_EXE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_copy_brings_its_conpty_and_clears_old_copies() {
        let root = std::env::temp_dir().join(format!("tri-code-hostcopy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (app, cache) = (root.join("app"), root.join("cache"));
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(cache.join("1-1")).unwrap();
        std::fs::write(cache.join("1-1").join(HOST_EXE), "old").unwrap();
        std::fs::write(cache.join("1-1").join("conpty.dll"), "old").unwrap();
        std::fs::write(cache.join("tri-code-host-1-1.exe"), "old").unwrap();
        for f in ["tri-code.exe", "conpty.dll", "OpenConsole.exe"] {
            std::fs::write(app.join(f), f).unwrap();
        }

        let exe = copy_for_host(&app.join("tri-code.exe"), &cache).unwrap();
        let dir = exe.parent().unwrap();
        assert_eq!(exe.file_name().unwrap(), HOST_EXE);
        assert_eq!(std::fs::read_to_string(dir.join("conpty.dll")).unwrap(), "conpty.dll");
        assert_eq!(std::fs::read_to_string(dir.join("OpenConsole.exe")).unwrap(), "OpenConsole.exe");
        let left: Vec<_> = std::fs::read_dir(&cache).unwrap().flatten().map(|e| e.path()).collect();
        assert_eq!(left, vec![dir.to_path_buf()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn answers_the_probes_a_program_waits_on() {
        let mut s = Scanner::default();
        assert_eq!(s.feed(b"hello\x1b[6n"), b"\x1b[1;1R");
        assert_eq!(s.feed(b"\x1b[c"), b"\x1b[?1;2c");
        assert_eq!(s.feed(b"\x1b]7501;?\x1b\\"), b"\x1b]7501;?\x1b\\");
        assert_eq!(s.feed(b"\x1b[31mred\x1b[0m"), b"");
    }

    #[test]
    fn a_probe_split_across_reads_is_still_answered() {
        let mut s = Scanner::default();
        assert_eq!(s.feed(b"\x1b"), b"");
        assert_eq!(s.feed(b"[6"), b"");
        assert_eq!(s.feed(b"n"), b"\x1b[1;1R");
    }

    #[test]
    fn keeps_the_latest_root_report_only() {
        let mut s = Scanner::default();
        s.feed(b"\x1b]7501;state=working:app=pi\x07");
        assert_eq!(s.report.as_deref(), Some("state=working:app=pi"));
        s.feed(b"\x1b]7501;state=done:id=sub1\x07");
        assert_eq!(s.report.as_deref(), Some("state=working:app=pi"));
        s.feed(b"\x1b]7501;state=blocked:app=pi\x1b\\");
        assert_eq!(s.report.as_deref(), Some("state=blocked:app=pi"));
    }

    #[test]
    fn other_oscs_are_not_reports() {
        let mut s = Scanner::default();
        assert_eq!(s.feed(b"\x1b]0;a title\x07"), b"");
        assert!(s.report.is_none());
    }

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, KIND_OUTPUT, &with_id(7, b"abc")).unwrap();
        let (kind, payload) = read_frame(&mut buf.as_slice()).unwrap();
        assert_eq!(kind, KIND_OUTPUT);
        assert_eq!(split_id(&payload), Some((7, &b"abc"[..])));
    }

    fn hello(s: &mut TcpStream, token: &str) -> FromHost {
        let msg = serde_json::to_vec(&ToHost::Hello { token: token.into(), protocol: PROTOCOL }).unwrap();
        write_frame(s, KIND_JSON, &msg).unwrap();
        next_json(s)
    }

    fn next_json(s: &mut TcpStream) -> FromHost {
        loop {
            let (kind, payload) = read_frame(s).unwrap();
            if kind == KIND_JSON {
                return serde_json::from_slice(&payload).unwrap();
            }
        }
    }

    fn send(s: &mut TcpStream, msg: &ToHost) {
        write_frame(s, KIND_JSON, &serde_json::to_vec(msg).unwrap()).unwrap();
    }

    /// A program that prints a line, then stays until killed.
    fn long_runner() -> (String, Vec<String>) {
        if cfg!(windows) {
            ("cmd.exe".into(), vec!["/d".into(), "/c".into(), "echo marker-one& ping -n 60 127.0.0.1 >NUL".into()])
        } else {
            ("/bin/sh".into(), vec!["-c".into(), "echo marker-one; sleep 60".into()])
        }
    }

    fn connect(info: &Info) -> TcpStream {
        let s = TcpStream::connect(("127.0.0.1", info.port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        s
    }

    #[test]
    fn a_wrong_token_gets_nothing() {
        let (info, _host) = serve().unwrap();
        let mut s = connect(&info);
        let msg = serde_json::to_vec(&ToHost::Hello { token: "wrong".into(), protocol: PROTOCOL }).unwrap();
        write_frame(&mut s, KIND_JSON, &msg).unwrap();
        assert!(read_frame(&mut s).is_err());
    }

    /// The point of the host: the terminal goes on when the app goes away, and the next app gets it
    /// back with what it printed in between. Uses a real PTY.
    #[test]
    fn a_terminal_outlives_its_app_and_the_next_app_gets_it_back() {
        let (info, _host) = serve().unwrap();
        let mut first = connect(&info);
        assert!(matches!(hello(&mut first, &info.token), FromHost::Welcome { .. }));
        let (program, args) = long_runner();
        let env: Vec<(String, String)> = std::env::vars().collect();
        send(&mut first, &ToHost::Spawn { req: 1, key: "tab-a".into(), meta: "tok".into(), program, args, cwd: None, env, cols: 80, rows: 24 });
        let id = match next_json(&mut first) {
            FromHost::Spawned { req: 1, result: Ok(id) } => id,
            _ => panic!("no spawn reply"),
        };
        drop(first);

        // On Windows nothing is printed until the cursor query is answered, and no app is here to.
        let b64 = base64::engine::general_purpose::STANDARD;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let mut next = connect(&info);
            let FromHost::Welcome { sessions, protocol } = hello(&mut next, &info.token) else { panic!("no welcome") };
            assert_eq!(protocol, PROTOCOL);
            let s = sessions.iter().find(|s| s.key == "tab-a").expect("the terminal is still there");
            assert_eq!((s.id, s.meta.as_str()), (id, "tok"));
            let recent = b64.decode(&s.recent).unwrap();
            if String::from_utf8_lossy(&recent).contains("marker-one") {
                send(&mut next, &ToHost::KillAll);
                return;
            }
            assert!(Instant::now() < deadline, "no output arrived while detached: {:?}", String::from_utf8_lossy(&recent));
            drop(next);
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    #[test]
    fn a_new_app_replaces_the_old_one() {
        let (info, _host) = serve().unwrap();
        let mut first = connect(&info);
        hello(&mut first, &info.token);
        let mut second = connect(&info);
        hello(&mut second, &info.token);
        assert!(read_frame(&mut first).is_err());
    }

    #[test]
    fn reap_ends_only_terminals_with_no_tab() {
        let (info, host) = serve().unwrap();
        let mut c = connect(&info);
        hello(&mut c, &info.token);
        let env: Vec<(String, String)> = std::env::vars().collect();
        for (req, key) in [(1, "keep"), (2, "gone")] {
            let (program, args) = long_runner();
            send(&mut c, &ToHost::Spawn { req, key: key.into(), meta: String::new(), program, args, cwd: None, env: env.clone(), cols: 80, rows: 24 });
            assert!(matches!(next_json(&mut c), FromHost::Spawned { result: Ok(_), .. }));
        }
        send(&mut c, &ToHost::Reap { keep: vec!["keep".into()] });
        let deadline = Instant::now() + Duration::from_secs(15);
        while host.lock().unwrap().sessions.len() != 1 {
            assert!(Instant::now() < deadline, "the reaped terminal is still running");
            std::thread::sleep(Duration::from_millis(100));
        }
        let keys: Vec<String> = host.lock().unwrap().sessions.values().map(|s| s.key.clone()).collect();
        assert_eq!(keys, ["keep"]);
        send(&mut c, &ToHost::KillAll);
    }
}
