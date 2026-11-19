//! Browser windows of a remote project reach the remote's own `localhost` through ssh tunnels
//! (`forward_port`), and its HTML files through a small static server started there and tunnelled
//! the same way (`forward_dir`). A forward lasts until `forward_close`, or until its ssh dies, which
//! is reported as a `forward-closed` event so the window can open it again.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpStream;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, LazyLock, Mutex, Once};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::tunnel::{self, Tunnel};
use crate::spawn::sq;
use crate::{envssh, remote};

/// A remote static server: the ssh running it, held so that ending it (dropping this) ends the server.
struct Server {
    child: Child,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Entry {
    // Field order is drop order: the tunnel goes before the server behind it.
    tunnel: Tunnel,
    server: Option<Server>,
}

impl Entry {
    fn alive(&mut self) -> bool {
        self.tunnel.alive() && self.server.as_mut().is_none_or(|s| matches!(s.child.try_wait(), Ok(None)))
    }
}

static FORWARDS: LazyLock<Mutex<HashMap<u64, Entry>>> = LazyLock::new(Default::default);
static NEXT: AtomicU64 = AtomicU64::new(1);
static WATCH: Once = Once::new();

#[derive(Debug, Serialize)]
pub struct Forward {
    pub id: u64,
    /// The local port: the one asked for when it was free here.
    pub port: u16,
}

#[derive(Clone, Serialize)]
struct Closed {
    id: u64,
}

/// Check every few seconds for forwards whose ssh has ended, and report them.
fn watch(app: &AppHandle) {
    let app = app.clone();
    WATCH.call_once(move || {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(3));
            let dead: Vec<u64> = {
                let mut map = FORWARDS.lock().unwrap();
                let dead: Vec<u64> = map.iter_mut().filter_map(|(id, e)| (!e.alive()).then_some(*id)).collect();
                for id in &dead {
                    map.remove(id);
                }
                dead
            };
            for id in dead {
                let _ = app.emit("forward-closed", Closed { id });
            }
        });
    });
}

fn keep(app: &AppHandle, tunnel: Tunnel, server: Option<Server>) -> Forward {
    watch(app);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let port = tunnel.port;
    FORWARDS.lock().unwrap().insert(id, Entry { tunnel, server });
    Forward { id, port }
}

/// Through a tunnel, a refused connection on the far side is accepted here and then closed at
/// once; a listening server waits for the request instead.
fn answers(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1200)));
    let mut b = [0u8; 1];
    !matches!(s.read(&mut b), Ok(0))
}

/// Reach `localhost:port` of `host` from here, on the same port when it is free (or on `prefer`).
#[tauri::command]
pub async fn forward_port(app: AppHandle, host: String, port: u16, prefer: Option<u16>) -> Result<Forward, String> {
    let t = tunnel::open_at(&host, "localhost", port, Some(prefer.unwrap_or(port))).await?;
    let local = t.port;
    if !tauri::async_runtime::spawn_blocking(move || answers(local)).await.unwrap_or(false) {
        return Err(format!("nothing is listening on localhost:{port} on {host}"));
    }
    Ok(keep(&app, t, None))
}

/// `cd` into a remote folder, where `~/` stays the remote's home.
fn cd(dir: &str) -> String {
    match dir.strip_prefix("~/") {
        Some(rest) => format!("cd ~/{}", sq(rest)),
        None if dir == "~" => "cd ~".into(),
        None => format!("cd -- {}", sq(dir)),
    }
}

/// Serve `dir` on a free loopback port of the host and print it, then end with the ssh connection:
/// a background job's stdin is /dev/null, so the watcher reads ssh's stdin as fd 3.
fn serve_script(dir: &str) -> String {
    format!(
        "{} || exit 1; py=$(command -v python3 || command -v python) || {{ echo 'python3 is needed on this host to serve its HTML files' >&2; exit 127; }}; \
         exec 3<&0; \"$py\" -u -m http.server --bind 127.0.0.1 0 </dev/null & p=$!; \
         (cat <&3 >/dev/null 2>&1; kill $p 2>/dev/null) & w=$!; wait $p; r=$?; kill $w 2>/dev/null; exit $r",
        cd(dir)
    )
}

/// The port in python's "Serving HTTP on 127.0.0.1 port 41234 (http://…) ..." line.
fn served_port(line: &str) -> Option<u16> {
    let rest = line.split(" port ").nth(1)?;
    rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// Serve a folder of `host` and reach it from here. Its files load with their relative assets.
#[tauri::command]
pub async fn forward_dir(app: AppHandle, host: String, dir: String, prefer: Option<u16>) -> Result<Forward, String> {
    envssh::check(&host)?;
    let h = host.clone();
    let (server, port) = tauri::async_runtime::spawn_blocking(move || -> Result<(Server, u16), String> {
        let mut cmd = remote::command(&h, &serve_script(&dir));
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;
        let (tx, rx) = mpsc::channel::<Result<u16, String>>();
        let out = child.stdout.take().expect("stdout is piped");
        let err = child.stderr.take().expect("stderr is piped");
        // Both pipes are drained for as long as the server runs, or its request log would fill one and stop it.
        let tx2 = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(p) = served_port(&line) {
                    let _ = tx2.send(Ok(p));
                }
            }
        });
        std::thread::spawn(move || {
            let mut last = String::new();
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if let Some(p) = served_port(&line) {
                    let _ = tx.send(Ok(p));
                } else if !line.trim().is_empty() && !line.contains("\"GET ") && !line.contains("\"HEAD ") {
                    last = line;
                }
            }
            let _ = tx.send(Err(last));
        });
        let server = Server { child };
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(p)) => Ok((server, p)),
            Ok(Err(e)) if !e.trim().is_empty() => Err(e.trim().to_string()),
            Ok(Err(_)) => Err(format!("the file server on {h} stopped")),
            Err(_) => Err(format!("the file server on {h} didn't start in 15 s")),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let t = tunnel::open_at(&host, "127.0.0.1", port, prefer).await?;
    Ok(keep(&app, t, Some(server)))
}

#[tauri::command]
pub async fn forward_close(id: u64) -> Result<(), String> {
    let e = FORWARDS.lock().unwrap().remove(&id);
    drop(e);
    Ok(())
}

/// The Unix listing: `ss` where there is one, else `lsof` (macOS), then `ps`, each after a marker
/// line. An app started from the Finder has a PATH without `/usr/sbin`, where macOS keeps `lsof`.
const LISTENING_SH: &str = "PATH=\"$PATH:/usr/sbin:/sbin:/usr/bin:/bin\"; \
    if command -v ss >/dev/null 2>&1; then echo '<<ss>>'; ss -ltnpH 2>/dev/null; \
    else echo '<<lsof>>'; lsof -nP -iTCP -sTCP:LISTEN -a -u \"$(id -u)\" 2>/dev/null; fi; \
    echo '<<ps>>'; ps -o pid=,args= -u \"$(id -u)\" 2>/dev/null; exit 0";

/// The Windows listing: `port pid name` lines, then `pid command line`. "The user's own" is the
/// processes in this login session, which leaves out services (session 0) and is far quicker than
/// asking each process for its owner.
#[cfg(windows)]
const LISTENING_PS1: &str = r#"$ErrorActionPreference='SilentlyContinue'
$s=(Get-Process -Id $PID).SessionId; $mine=@{}; $rows=@()
foreach($l in netstat -ano -p TCP){
  if($l -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)'){
    $port=$matches[1]; $id=[int]$matches[2]
    if(-not $mine.ContainsKey($id)){ $p=Get-Process -Id $id; $mine[$id]=if($p -and $p.SessionId -eq $s){$p}else{$null} }
    if($mine[$id]){ $rows+="$port $id $($mine[$id].ProcessName)" }
  }
}
'<<win>>'; $rows
'<<ps>>'
$ids=@($mine.Keys | Where-Object { $mine[$_] })
if($ids){ foreach($p in Get-CimInstance Win32_Process -Filter (($ids | ForEach-Object { "ProcessId=$_" }) -join ' OR ')){ "$($p.ProcessId) $(if($p.CommandLine){$p.CommandLine}else{$p.Name})" } }"#;

/// What listens on this machine's TCP ports, for a local project's start page.
fn local_listening() -> Result<String, String> {
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", LISTENING_PS1]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = std::process::Command::new("/bin/sh");
        c.args(["-c", LISTENING_SH]);
        c
    };
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// What listens on `host`'s TCP ports (this machine's for a local project), with the processes'
/// command lines, for the start page to parse.
#[tauri::command]
pub async fn remote_listening(host: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if matches!(host.as_str(), "" | "local") {
            local_listening()
        } else {
            remote::run(&host, LISTENING_SH)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// End every forward as the app exits.
pub fn close_all() {
    FORWARDS.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_port_python_serves_on() {
        assert_eq!(served_port("Serving HTTP on 127.0.0.1 port 41234 (http://127.0.0.1:41234/) ..."), Some(41234));
        assert_eq!(served_port("127.0.0.1 - - [09/Nov/2026] \"GET / HTTP/1.1\" 200 -"), None);
    }

    #[test]
    fn a_home_folder_stays_the_remotes() {
        assert_eq!(cd("~/api server/coverage"), "cd ~/'api server/coverage'");
        assert_eq!(cd("/srv/it's"), r"cd -- '/srv/it'\''s'");
    }
}
