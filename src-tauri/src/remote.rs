//! One-shot, non-interactive ssh for remote projects.
//!
//! The interactive `ssh` used by terminal tabs lives in `spawn.rs`; this module
//! is the shared builder for commands that run a script and read its output
//! (directory listing, `.dev/` reads and writes).

use std::io::Write;
use std::process::{Command, Output, Stdio};

use crate::envssh;

/// `ssh` Command that runs `script` on `host` with no TTY and no prompts. Callers
/// check `envssh::check` first: `run*` here do, and so does git.rs.
pub fn command(host: &str, script: &str) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"])
        .args(envssh::args(host))
        .arg(host)
        .arg(script)
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run `script` and return stdout. A non-zero exit becomes an error carrying
/// stderr, so `list_dirs` and `dev_read` can surface the remote message.
pub fn run(host: &str, script: &str) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&run_bytes(host, script)?).into_owned())
}

/// Run `script` and return raw stdout bytes, for a file that may be binary.
pub fn run_bytes(host: &str, script: &str) -> Result<Vec<u8>, String> {
    envssh::check(host)?;
    let out = command(host, script).output().map_err(|e| format!("ssh: {e}"))?;
    checked(out, host)
}

/// Run `script`, feeding `input` on stdin (used to write a file remotely).
pub fn run_stdin(host: &str, script: &str, input: &[u8]) -> Result<String, String> {
    envssh::check(host)?;
    let mut cmd = command(host, script);
    cmd.stdin(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(input)
        .map_err(|e| format!("{host}: {e}"))?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&checked(out, host)?).into_owned())
}

fn checked(out: Output, host: &str) -> Result<Vec<u8>, String> {
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("{host}: ssh failed") } else { err });
    }
    Ok(out.stdout)
}
