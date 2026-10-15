//! PTY sessions: spawn, stream output to the webview, write, resize, kill.
//!
//! Output goes over a Tauri `Channel` as raw bytes (an `ArrayBuffer` on the JS
//! side), so there is no JSON or base64 on the hot path.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::spawn::{self, SpawnSpec};

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
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
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

#[tauri::command]
pub async fn pty_spawn(
    state: tauri::State<'_, Arc<Ptys>>,
    spec: SpawnSpec,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
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
    });
    state.sessions.lock().unwrap().insert(id, session);

    let reader_thread = std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let ptys = Arc::clone(state.inner());
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
        // Dropping the master closes the PTY; on Windows (ConPTY) that is what
        // unblocks the reader, on unix it has usually hit EOF already.
        // Bind first so the guard is released before the PTY is closed.
        let removed = ptys.sessions.lock().unwrap().remove(&id);
        drop(removed);
        let _ = reader_thread.join();
        let _ = on_exit.send(code);
    });

    Ok(id)
}

#[tauri::command]
pub async fn pty_write(state: tauri::State<'_, Arc<Ptys>>, id: u32, data: String) -> Result<(), String> {
    let session = state.get(id)?;
    let mut w = session.writer.lock().unwrap();
    w.write_all(data.as_bytes()).and_then(|_| w.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(state: tauri::State<'_, Arc<Ptys>>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let session = state.get(id)?;
    let master = session.master.lock().unwrap();
    master.resize(size(cols, rows)).map_err(|e| e.to_string())
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
