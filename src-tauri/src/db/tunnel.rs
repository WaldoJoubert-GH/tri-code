//! `ssh -N -L` from a free local port to the database, through the project's host, with the
//! Environment's key and options. It lives as long as the Session and dies with it.

use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::envssh;

pub struct Tunnel {
    child: Child,
    pub port: u16,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Forward a local port to `to_host:to_port` as `host` sees it, and wait until it accepts.
pub async fn open(host: &str, to_host: &str, to_port: u16) -> Result<Tunnel, String> {
    envssh::check(host)?;
    let port = TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let to = if to_host.contains(':') { format!("[{to_host}]") } else { to_host.to_string() };
    let mut cmd = Command::new("ssh");
    cmd.args(["-N", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30"])
        .args(envssh::args(host))
        .arg("-L")
        .arg(format!("127.0.0.1:{port}:{to}:{to_port}"))
        .arg(host)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            let err = err.trim();
            return Err(format!("ssh tunnel through {host} closed ({status}){}", if err.is_empty() { String::new() } else { format!(": {err}") }));
        }
        if TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(200)).is_ok() {
            return Ok(Tunnel { child, port });
        }
        if start.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            return Err(format!("ssh tunnel through {host} didn't open in 15 s"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
