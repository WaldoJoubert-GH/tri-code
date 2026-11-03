//! PTY sessions, as the app sees them: spawn, stream output to the webview, write, resize, kill.
//!
//! The PTYs themselves live in the terminal host (ptyd.rs), so they outlive the app. This is the
//! app's connection to it. Output goes to the webview over a Tauri `Channel` as raw bytes (an
//! `ArrayBuffer` on the JS side), so there is no JSON or base64 on the hot path. Each session also
//! keeps its recent output and hands a copy of new output to phones watching it (phone.rs), so a
//! phone can join a running agent.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::AppHandle;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::agent_windows::{self, AgentWindows, Owner};
use crate::envssh;
use crate::ptyd::{self, FromHost, Info, KIND_INPUT, KIND_JSON, KIND_OUTPUT, ToHost};
use crate::resume;
use crate::spawn::{self, SpawnSpec};

/// The webview's end of a session. Replaced when a reloaded page attaches again.
#[derive(Default)]
struct Sink {
    data: Option<Channel<InvokeResponseBody>>,
    exit: Option<Channel<i32>>,
    /// The tab, to forget its agent window when the session ends.
    tab: Option<String>,
}

struct Session {
    key: String,
    /// The terminal's `TRICODE_TOKEN`. It is in the running program's environment, so it stays.
    token: String,
    /// The latest OSC 7501 report from before this app connected.
    report: Option<String>,
    /// Asked to end, and not to be attached to while it does.
    killed: AtomicBool,
    sink: Mutex<Sink>,
    tap: Mutex<Tap>,
}

/// A session's recent output and the phones watching it.
#[derive(Default)]
struct Tap {
    recent: VecDeque<u8>,
    /// Bytes written since the session began, so a wait can tell new output from old.
    total: u64,
    watchers: Vec<UnboundedSender<Vec<u8>>>,
}

impl Tap {
    fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len() as u64;
        self.recent.extend(bytes);
        let over = self.recent.len().saturating_sub(ptyd::SCROLLBACK);
        self.recent.drain(..over);
        self.watchers.retain(|w| w.send(bytes.to_vec()).is_ok());
    }
}

/// The open connection to the host.
struct Conn {
    tx: Sender<Vec<u8>>,
    stream: TcpStream,
    next_req: AtomicU64,
    waiting: Mutex<HashMap<u64, Waiting>>,
}

/// A spawn on its way: who is waiting for the reply, and the session to list when it comes.
struct Waiting {
    tx: Sender<Result<u32, String>>,
    session: Arc<Session>,
}

impl Conn {
    fn send(&self, msg: &ToHost) -> Result<(), String> {
        let json = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        self.tx.send(ptyd::frame(KIND_JSON, &json)).map_err(|_| HOST_GONE.to_string())
    }
}

const HOST_GONE: &str = "the terminal host stopped";

#[derive(Default)]
pub struct Ptys {
    conn: Mutex<Option<Arc<Conn>>>,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    hub: Mutex<Option<Arc<AgentWindows>>>,
    /// Where the host says where it is, and where its copy of the exe goes.
    dir: Mutex<Option<PathBuf>>,
    /// Holds a second caller back while the first connects, so only one host is started.
    connecting: Mutex<()>,
}

impl Ptys {
    pub fn configure(&self, dir: PathBuf, hub: Arc<AgentWindows>) {
        *self.dir.lock().unwrap() = Some(dir);
        *self.hub.lock().unwrap() = Some(hub);
    }

    /// The open connection, or a new one, starting the host if it isn't running.
    fn conn(self: &Arc<Self>) -> Result<Arc<Conn>, String> {
        if let Some(c) = self.conn.lock().unwrap().as_ref() {
            return Ok(Arc::clone(c));
        }
        let _one = self.connecting.lock().unwrap();
        if let Some(c) = self.conn.lock().unwrap().as_ref() {
            return Ok(Arc::clone(c));
        }
        let dir = self.dir.lock().unwrap().clone().ok_or("the app is still starting")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // A debug build and an installed app never share a host.
        let info_file = dir.join(if cfg!(debug_assertions) { "pty-host-dev.json" } else { "pty-host.json" });

        let conn = match read_info(&info_file).and_then(|i| self.open(&i)) {
            Some(Opened::Ready(c)) => c,
            // A host from another version: stop it, and agents resume in the one started below.
            Some(Opened::OldHost(old)) => {
                let _ = old.send(&ToHost::Shutdown);
                std::thread::sleep(Duration::from_millis(300));
                let _ = std::fs::remove_file(&info_file);
                self.start_host(&dir, &info_file)?
            }
            None => {
                let _ = std::fs::remove_file(&info_file);
                self.start_host(&dir, &info_file)?
            }
        };
        *self.conn.lock().unwrap() = Some(Arc::clone(&conn));
        Ok(conn)
    }

    fn start_host(self: &Arc<Self>, dir: &Path, info_file: &Path) -> Result<Arc<Conn>, String> {
        let exe = ptyd::host_exe(&dir.join("pty-host"));
        ptyd::launch(&exe, info_file).map_err(|e| format!("couldn't start the terminal host: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(Opened::Ready(c)) = read_info(info_file).and_then(|i| self.open(&i)) {
                return Ok(c);
            }
            if Instant::now() >= deadline {
                return Err("the terminal host didn't start in time".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Connects, and takes on the sessions the host already has.
    fn open(self: &Arc<Self>, info: &Info) -> Option<Opened> {
        let mut stream = TcpStream::connect_timeout(&(std::net::Ipv4Addr::LOCALHOST, info.port).into(), Duration::from_secs(2)).ok()?;
        stream.set_nodelay(true).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let hello = serde_json::to_vec(&ToHost::Hello { token: info.token.clone(), protocol: ptyd::PROTOCOL }).ok()?;
        ptyd::write_frame(&mut stream, KIND_JSON, &hello).ok()?;
        let (kind, payload) = ptyd::read_frame(&mut stream).ok()?;
        if kind != KIND_JSON {
            return None;
        }
        let FromHost::Welcome { protocol, sessions } = serde_json::from_slice(&payload).ok()? else { return None };
        stream.set_read_timeout(None).ok()?;

        let mut writer = stream.try_clone().ok()?;
        let mut reader = stream.try_clone().ok()?;
        let (tx, rx) = channel::<Vec<u8>>();
        std::thread::spawn(move || {
            for f in rx {
                if writer.write_all(&f).is_err() {
                    break;
                }
            }
        });
        let conn = Arc::new(Conn { tx, stream, next_req: AtomicU64::new(0), waiting: Mutex::default() });
        if protocol != ptyd::PROTOCOL {
            return Some(Opened::OldHost(conn));
        }

        let b64 = base64::engine::general_purpose::STANDARD;
        {
            let mut map = self.sessions.lock().unwrap();
            map.clear();
            for s in sessions {
                let tap = Tap { recent: b64.decode(&s.recent).unwrap_or_default().into(), total: s.total, watchers: Vec::new() };
                map.insert(s.id, Arc::new(Session { key: s.key, token: s.meta, report: s.report, killed: AtomicBool::new(false), sink: Mutex::default(), tap: Mutex::new(tap) }));
            }
        }
        let (ptys, reading) = (Arc::clone(self), Arc::clone(&conn));
        std::thread::spawn(move || {
            while let Ok((kind, payload)) = ptyd::read_frame(&mut reader) {
                ptys.on_frame(&reading, kind, &payload);
            }
            ptys.on_lost(&reading);
        });
        Some(Opened::Ready(conn))
    }

    fn on_frame(&self, conn: &Conn, kind: u8, payload: &[u8]) {
        if kind == KIND_OUTPUT {
            let Some((id, bytes)) = ptyd::split_id(payload) else { return };
            let session = self.sessions.lock().unwrap().get(&id).cloned();
            if let Some(s) = session {
                // One lock over both, so an attach sees each chunk in its replay or its channel.
                let mut tap = s.tap.lock().unwrap();
                tap.push(bytes);
                if let Some(ch) = &s.sink.lock().unwrap().data {
                    let _ = ch.send(InvokeResponseBody::Raw(bytes.to_vec()));
                }
            }
            return;
        }
        match serde_json::from_slice(payload) {
            Ok(FromHost::Spawned { req, result }) => {
                if let Some(w) = conn.waiting.lock().unwrap().remove(&req) {
                    if let Ok(id) = result {
                        self.sessions.lock().unwrap().insert(id, w.session);
                    }
                    let _ = w.tx.send(result);
                }
            }
            Ok(FromHost::Exit { id, code }) => self.ended(id, code),
            _ => {}
        }
    }

    /// A session is gone: tell the watchers, the agent endpoint and the webview.
    fn ended(&self, id: u32, code: i32) {
        let Some(s) = self.sessions.lock().unwrap().remove(&id) else { return };
        // Closes the phones' receivers: the agent is gone.
        s.tap.lock().unwrap().watchers.clear();
        let mut sink = s.sink.lock().unwrap();
        if let (Some(tab), Some(hub)) = (&sink.tab, self.hub.lock().unwrap().as_ref()) {
            hub.forget(tab, id);
        }
        sink.data = None;
        if let Some(exit) = sink.exit.take() {
            let _ = exit.send(code);
        }
    }

    /// The connection dropped with the app still here: the host died, or another app took over.
    fn on_lost(&self, conn: &Arc<Conn>) {
        {
            let mut current = self.conn.lock().unwrap();
            if !current.as_ref().is_some_and(|c| Arc::ptr_eq(c, conn)) {
                return;
            }
            *current = None;
        }
        conn.waiting.lock().unwrap().clear();
        let ids: Vec<u32> = self.sessions.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.ended(id, -1);
        }
    }

    /// Ends every terminal, for "Quit and stop agents".
    pub fn kill_all(self: &Arc<Self>) {
        if let Some(c) = self.conn.lock().unwrap().as_ref() {
            let _ = c.send(&ToHost::KillAll);
        }
    }

    /// The terminals still running.
    pub fn running(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    /// Lets go of the host at app exit. Its terminals carry on.
    pub fn detach(&self) {
        if let Some(c) = self.conn.lock().unwrap().take() {
            let _ = c.stream.shutdown(Shutdown::Both);
        }
    }

    fn get(&self, id: u32) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("no pty {id}"))
    }

    /// Start watching a session: its recent output, then everything after it. The receiver
    /// closes when the session ends.
    pub fn watch(&self, id: u32) -> Result<(Vec<u8>, UnboundedReceiver<Vec<u8>>), String> {
        let session = self.get(id)?;
        let mut tap = session.tap.lock().unwrap();
        let (tx, rx) = unbounded_channel();
        tap.watchers.push(tx);
        Ok((tap.recent.iter().copied().collect(), rx))
    }

    /// The recent output and the total bytes so far (agent windows read and wait on these).
    pub fn snapshot(&self, id: u32) -> Result<(Vec<u8>, u64), String> {
        let session = self.get(id)?;
        let tap = session.tap.lock().unwrap();
        Ok((tap.recent.iter().copied().collect(), tap.total))
    }

    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        self.get(id)?;
        let conn = self.conn.lock().unwrap().clone().ok_or(HOST_GONE)?;
        conn.tx.send(ptyd::frame(KIND_INPUT, &ptyd::with_id(id, data))).map_err(|_| HOST_GONE.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        self.get(id)?;
        let conn = self.conn.lock().unwrap().clone().ok_or(HOST_GONE)?;
        conn.send(&ToHost::Resize { id, cols, rows })
    }

    fn kill(&self, id: u32) {
        // Marked now, so a tab starting over under this key doesn't attach to what is ending.
        if let Some(s) = self.sessions.lock().unwrap().get(&id) {
            s.killed.store(true, Ordering::Relaxed);
        }
        if let Some(c) = self.conn.lock().unwrap().as_ref() {
            let _ = c.send(&ToHost::Kill { id });
        }
    }

    /// The running session under `key`, if there is one.
    fn find(&self, key: &str) -> Option<(u32, Arc<Session>)> {
        self.sessions.lock().unwrap().iter().find(|(_, s)| s.key == key && !s.killed.load(Ordering::Relaxed)).map(|(id, s)| (*id, Arc::clone(s)))
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_new(&self, conn: &Conn, key: String, token: String, sink: Sink, prog: spawn::Program, extra_env: Vec<(String, String)>, cols: u16, rows: u16) -> Result<u32, String> {
        let req = conn.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        // Complete before the request goes: the reader lists it on the reply, ahead of any output.
        let session = Arc::new(Session { key: key.clone(), token: token.clone(), report: None, killed: AtomicBool::new(false), sink: Mutex::new(sink), tap: Mutex::default() });
        conn.waiting.lock().unwrap().insert(req, Waiting { tx, session });
        let mut env: Vec<(String, String)> = std::env::vars().collect();
        env.extend(extra_env);
        conn.send(&ToHost::Spawn { req, key, meta: token, program: prog.program, args: prog.args, cwd: prog.cwd, env, cols, rows })?;
        rx.recv_timeout(Duration::from_secs(15)).map_err(|_| HOST_GONE.to_string())?
    }
}

enum Opened {
    Ready(Arc<Conn>),
    OldHost(Arc<Conn>),
}

fn read_info(path: &Path) -> Option<Info> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// What `pty_spawn` did. `recent` is set when it attached to a terminal that was already running.
#[derive(Serialize)]
pub struct Started {
    id: u32,
    /// What the terminal printed before this page, base64.
    recent: Option<String>,
    /// The latest OSC 7501 report from before this app connected.
    report: Option<String>,
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, Arc<Ptys>>,
    hub: tauri::State<'_, Arc<AgentWindows>>,
    spec: SpawnSpec,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
    owner: Option<Owner>,
) -> Result<Started, String> {
    let ptys = Arc::clone(state.inner());
    let agents = Arc::clone(hub.inner());
    // Starting the host and waiting on it mustn't hold up the app's other calls.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = start_session(&app, &ptys, &agents, spec, cols, rows, on_data, on_exit, owner.as_ref());
        if let Some(o) = &owner
            && let Some(req) = &o.req
        {
            agents.resolve(req, result.as_ref().map(|_| o.tab.clone()).map_err(Clone::clone));
        }
        result
    })
    .await;
    result.map_err(|e| e.to_string())?
}

#[allow(clippy::too_many_arguments)]
fn start_session(
    app: &AppHandle,
    state: &Arc<Ptys>,
    hub: &Arc<AgentWindows>,
    spec: SpawnSpec,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
    owner: Option<&Owner>,
) -> Result<Started, String> {
    let conn = state.conn()?;

    // Already running, from before this page or this app: attach to it.
    if let Some((id, session)) = state.find(&spec.session) {
        let tap = session.tap.lock().unwrap();
        let recent: Vec<u8> = tap.recent.iter().copied().collect();
        {
            let mut sink = session.sink.lock().unwrap();
            sink.data = Some(on_data);
            sink.exit = Some(on_exit);
            sink.tab = owner.map(|o| o.tab.clone());
        }
        drop(tap);
        if let Some(o) = owner
            && !session.token.is_empty()
        {
            hub.issue(o, id, session.token.clone());
        }
        let recent = base64::engine::general_purpose::STANDARD.encode(recent);
        return Ok(Started { id, recent: Some(recent), report: session.report.clone() });
    }

    let local = matches!(spec.host.as_deref(), None | Some("") | Some("local"));
    if !local && let Some(host) = spec.host.as_deref() {
        envssh::check(host)?;
    }
    let mut spec = spec;
    let mut env: Vec<(String, String)> = vec![("TERM".into(), "xterm-256color".into()), ("COLORTERM".into(), "truecolor".into())];
    if local && let Some(cmd) = spec.cmd.take() {
        let launch = resume::launch(app, &cmd, spec.resume.as_ref());
        env.extend(launch.env);
        spec.cmd = Some(launch.cmd);
    }
    let prog = spawn::build(&spec);
    // portable-pty silently falls back to the home dir for a missing cwd.
    if let Some(cwd) = &prog.cwd
        && !Path::new(cwd).is_dir()
    {
        return Err(format!("directory not found: {cwd}"));
    }
    // The token goes in the terminal's environment; the window is registered once it has started,
    // and an open that waits on this spawn is answered either way.
    let token = owner.map(|_| agent_windows::new_token()).unwrap_or_default();
    if !token.is_empty() {
        env.push(("TRICODE_TOKEN".into(), token.clone()));
        env.push(("TRICODE_URL".into(), agent_windows::url()));
    }
    let sink = Sink { data: Some(on_data), exit: Some(on_exit), tab: owner.map(|o| o.tab.clone()) };
    let id = state.spawn_new(&conn, spec.session.clone(), token.clone(), sink, prog, env, cols, rows)?;
    if let Some(o) = owner {
        hub.issue(o, id, token);
    }
    Ok(Started { id, recent: None, report: None })
}

#[tauri::command]
pub async fn pty_write(state: tauri::State<'_, Arc<Ptys>>, id: u32, data: String) -> Result<(), String> {
    state.write(id, data.as_bytes())
}

#[tauri::command]
pub async fn pty_resize(state: tauri::State<'_, Arc<Ptys>>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    state.resize(id, cols, rows)
}

/// Ends the persistent shpool/tmux session behind a remote tab (closing the
/// tab only kills the local ssh client, which would leave the agent running).
#[tauri::command]
pub async fn remote_kill_session(host: String, session: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || kill_remote_blocking(&host, &session))
        .await
        .map_err(|e| e.to_string())?
}

fn kill_remote_blocking(host: &str, session: &str) -> Result<(), String> {
    envssh::check(host)?;
    let prog = spawn::kill_remote(host, session);
    let mut cmd = std::process::Command::new(&prog.program);
    cmd.args(&prog.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.status().map(|_| ()).map_err(|e| e.to_string())
}

/// After loading the tabs: ends terminals that no tab has any more, which a closed tab's kill or a
/// lost save can leave behind. Connects first, so running sessions are known to attach to.
#[tauri::command]
pub async fn pty_reap(state: tauri::State<'_, Arc<Ptys>>, keep: Vec<String>) -> Result<(), String> {
    let ptys = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let conn = ptys.conn()?;
        let gone: Vec<u32> = ptys.sessions.lock().unwrap().iter().filter(|(_, s)| !keep.contains(&s.key)).map(|(id, _)| *id).collect();
        for id in gone {
            ptys.ended(id, -1);
        }
        conn.send(&ToHost::Reap { keep })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_kill(state: tauri::State<'_, Arc<Ptys>>, id: u32) -> Result<(), String> {
    state.kill(id);
    Ok(())
}
