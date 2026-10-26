//! PTY sessions: spawn, stream output to the webview, write, resize, kill.
//!
//! Output goes over a Tauri `Channel` as raw bytes (an `ArrayBuffer` on the JS
//! side), so there is no JSON or base64 on the hot path. Each session also keeps
//! its recent output and hands a copy of new output to phones watching it
//! (phone.rs), so a phone can join a running agent.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::agent_windows::{self, AgentWindows, Owner};
use crate::envssh;
use crate::spawn::{self, SpawnSpec};

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Its own Arc: the reader thread holds it, and must not hold the master (see below).
    tap: Arc<Mutex<Tap>>,
}

/// How much recent output a phone gets when it starts watching.
const SCROLLBACK: usize = 256 * 1024;

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
        let over = self.recent.len().saturating_sub(SCROLLBACK);
        self.recent.drain(..over);
        self.watchers.retain(|w| w.send(bytes.to_vec()).is_ok());
    }
}

#[derive(Default)]
pub struct Ptys {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
}

impl Ptys {
    pub fn kill_all(&self) {
        let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        for s in sessions {
            let _ = s.killer.lock().unwrap().kill();
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
        let session = self.get(id)?;
        let mut w = session.writer.lock().unwrap();
        w.write_all(data).and_then(|_| w.flush()).map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.get(id)?;
        let master = session.master.lock().unwrap();
        master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

#[tauri::command]
pub async fn pty_spawn(
    state: tauri::State<'_, Arc<Ptys>>,
    hub: tauri::State<'_, Arc<AgentWindows>>,
    spec: SpawnSpec,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
    owner: Option<Owner>,
) -> Result<u32, String> {
    // The token goes in the terminal's environment; the window is registered once the process
    // has started, and an open that waits on this spawn is answered either way.
    let token = owner.as_ref().map(|_| agent_windows::new_token());
    let result = spawn_session(state.inner(), hub.inner(), spec, cols, rows, on_data, on_exit, owner.as_ref(), token.as_deref());
    if let Some(o) = &owner
        && let Some(req) = &o.req
    {
        hub.resolve(req, result.clone().map(|_| o.tab.clone()));
    }
    result
}

fn spawn_session(
    state: &Arc<Ptys>,
    hub: &Arc<AgentWindows>,
    spec: SpawnSpec,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
    owner: Option<&Owner>,
    token: Option<&str>,
) -> Result<u32, String> {
    if let Some(host) = spec.host.as_deref().filter(|h| !matches!(*h, "" | "local")) {
        envssh::check(host)?;
    }
    let prog = spawn::build(&spec);
    // portable-pty silently falls back to the home dir for a missing cwd.
    if let Some(cwd) = &prog.cwd
        && !std::path::Path::new(cwd).is_dir()
    {
        return Err(format!("directory not found: {cwd}"));
    }
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&prog.program);
    cmd.args(&prog.args);
    if let Some(cwd) = &prog.cwd {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(t) = token {
        cmd.env("TRICODE_TOKEN", t);
        cmd.env("TRICODE_URL", agent_windows::URL);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to start {}: {e}", prog.program))?;
    // Drop our copy of the slave so the reader sees EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let session = Arc::new(Session {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(child.clone_killer()),
        tap: Arc::default(),
    });
    let tap = Arc::clone(&session.tap);
    state.sessions.lock().unwrap().insert(id, session);
    if let (Some(o), Some(t)) = (owner, token) {
        hub.issue(o, id, t.to_string());
    }

    let reader_thread = std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    tap.lock().unwrap().push(&buf[..n]);
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        // Closes the phones' receivers: the agent is gone.
        tap.lock().unwrap().watchers.clear();
    });

    let ptys = Arc::clone(state);
    let hub = Arc::clone(hub);
    let tab = owner.map(|o| o.tab.clone());
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
        // Dropping the master closes the PTY; on Windows (ConPTY) that is what
        // unblocks the reader, on unix it has usually hit EOF already.
        // Bind first so the guard is released before the PTY is closed.
        let removed = ptys.sessions.lock().unwrap().remove(&id);
        drop(removed);
        if let Some(tab) = &tab {
            hub.forget(tab, id);
        }
        let _ = reader_thread.join();
        let _ = on_exit.send(code);
    });

    Ok(id)
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

/// Kills every PTY. Called on app exit, and by the frontend on load so a
/// webview reload doesn't orphan processes it no longer knows about.
#[tauri::command]
pub async fn pty_kill_all(state: tauri::State<'_, Arc<Ptys>>) -> Result<(), String> {
    state.kill_all();
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(state: tauri::State<'_, Arc<Ptys>>, id: u32) -> Result<(), String> {
    match state.get(id) {
        Ok(session) => session.killer.lock().unwrap().kill().map_err(|e| e.to_string()),
        Err(_) => Ok(()), // already gone
    }
}
