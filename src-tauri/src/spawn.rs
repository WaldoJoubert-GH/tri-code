//! Turns a tab description into the concrete program + args to run in a PTY.
//!
//! Local tabs run through the platform shell so PATH lookups behave like a
//! normal terminal (`claude.cmd` on Windows, login-shell PATH on unix).
//! Remote tabs run system `ssh` and attach to a persistent shpool session,
//! falling back to tmux, so agents survive disconnects and app restarts.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    /// `None` or `"local"` runs on this machine; anything else is an ssh destination.
    pub host: Option<String>,
    pub cwd: String,
    /// Command to run (`claude`, `pi`, ...). `None` opens a plain shell.
    pub cmd: Option<String>,
    /// Stable name for the remote persistent session.
    pub session: String,
}

#[derive(Debug, PartialEq)]
pub struct Program {
    pub program: String,
    pub args: Vec<String>,
    /// Working directory for the local process (remote tabs `cd` on the far side).
    pub cwd: Option<String>,
}

pub fn build(spec: &SpawnSpec) -> Program {
    match spec.host.as_deref() {
        None | Some("") | Some("local") => local(spec),
        Some(host) => ssh(host, spec),
    }
}

fn local(spec: &SpawnSpec) -> Program {
    let cwd = Some(expand_home(&spec.cwd));
    if cfg!(windows) {
        let (program, args) = match &spec.cmd {
            Some(cmd) => ("cmd.exe", vec!["/d".into(), "/c".into(), cmd.clone()]),
            None => ("powershell.exe", vec!["-NoLogo".into()]),
        };
        Program { program: program.into(), args, cwd }
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let args = match &spec.cmd {
            Some(cmd) => vec!["-lc".into(), cmd.clone()],
            None => vec!["-l".into()],
        };
        Program { program: shell, args, cwd }
    }
}

fn ssh(host: &str, spec: &SpawnSpec) -> Program {
    let name = sanitize_session(&spec.session);
    let run = spec.cmd.as_deref();

    // shpool starts in $HOME unless told otherwise (`-d .` = where we cd'd), and
    // execs --cmd directly after shell-words splitting, so wrap it in a login
    // shell for PATH. The double quotes let the remote shell expand $SHELL.
    let shpool = match run {
        Some(cmd) => format!(
            "shpool attach -f -d . -c \"${{SHELL:-/bin/sh}} -lc {}\" {}",
            dq_escape(&sq(cmd)),
            sq(&name)
        ),
        None => format!("shpool attach -f -d . {}", sq(&name)),
    };
    let tmux = match run {
        Some(cmd) => format!("tmux new -A -s {} {}", sq(&name), sq(cmd)),
        None => format!("tmux new -A -s {}", sq(&name)),
    };
    let bare = match run {
        Some(cmd) => format!("\"${{SHELL:-/bin/sh}}\" -lc {}", sq(cmd)),
        None => "\"${SHELL:-/bin/sh}\" -l".to_string(),
    };

    let inner = format!(
        "cd {} || exit 1; \
         if command -v shpool >/dev/null 2>&1; then exec {shpool}; \
         elif command -v tmux >/dev/null 2>&1; then exec {tmux}; \
         else exec {bare}; fi",
        remote_path(&spec.cwd)
    );
    // Run inside the user's login shell so PATH includes ~/.local/bin etc.
    let remote = format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", sq(&inner));

    Program {
        program: "ssh".into(),
        args: vec![
            "-t".into(),
            "-o".into(),
            "ServerAliveInterval=10".into(),
            "-o".into(),
            "ServerAliveCountMax=3".into(),
            host.into(),
            remote,
        ],
        cwd: None,
    }
}

/// Non-interactive ssh invocation that ends a tab's persistent remote session.
pub fn kill_remote(host: &str, session: &str) -> Program {
    let name = sq(&sanitize_session(session));
    let inner = format!(
        "shpool kill {name} >/dev/null 2>&1; tmux kill-session -t {name} >/dev/null 2>&1; true"
    );
    Program {
        program: "ssh".into(),
        args: vec![
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            "ConnectTimeout=5".into(),
            host.into(),
            format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", sq(&inner)),
        ],
        cwd: None,
    }
}

/// POSIX single-quote escaping.
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Escape for use inside a double-quoted shell string.
fn dq_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '"' | '$' | '`' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Quote a remote path while keeping a leading `~` expandable.
fn remote_path(path: &str) -> String {
    match path {
        "" | "~" => "~".into(),
        p if p.starts_with("~/") => format!("~/{}", sq(&p[2..])),
        p => sq(p),
    }
}

fn sanitize_session(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

fn expand_home(path: &str) -> String {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))
    } else {
        std::env::var("HOME")
    };
    match (path, home) {
        ("" | "~", Ok(h)) => h,
        (p, Ok(h)) if p.starts_with("~/") || p.starts_with("~\\") => format!("{h}{}", &p[1..]),
        (p, _) => p.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(host: &str, cwd: &str, cmd: Option<&str>) -> SpawnSpec {
        SpawnSpec {
            host: Some(host.into()),
            cwd: cwd.into(),
            cmd: cmd.map(Into::into),
            session: "tri-p1-t1".into(),
        }
    }

    #[test]
    fn sq_escapes_single_quotes() {
        assert_eq!(sq("it's"), r"'it'\''s'");
    }

    #[test]
    fn remote_path_keeps_tilde_expandable() {
        assert_eq!(remote_path("~/my app"), "~/'my app'");
        assert_eq!(remote_path("/srv/x"), "'/srv/x'");
        assert_eq!(remote_path(""), "~");
    }

    #[test]
    fn ssh_command_runs_through_login_shell_and_shpool() {
        let p = build(&spec("box", "~/app", Some("claude")));
        assert_eq!(p.program, "ssh");
        assert_eq!(p.args[5], "box");
        let remote = &p.args[6];
        assert!(remote.starts_with("exec \"${SHELL:-/bin/sh}\" -lc '"));
        assert!(remote.contains("shpool attach -f -d . -c"));
        assert!(remote.contains("tmux new -A -s"));
    }

    #[test]
    fn local_host_is_not_ssh() {
        assert_ne!(build(&spec("local", "/tmp", None)).program, "ssh");
    }

    #[test]
    fn session_names_are_sanitized() {
        assert_eq!(sanitize_session("a b/c'd"), "a-b-c-d");
    }

    /// End to end against a real ssh host with shpool: start a session, drop the
    /// connection, reattach, and check the same process is still there.
    /// Run with `TRI_SSH_HOST=localhost cargo test -- --ignored`.
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn ssh_shpool_session_survives_disconnect() {
        use portable_pty::{CommandBuilder, PtySize, native_pty_system};
        use std::io::Read;
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let host = std::env::var("TRI_SSH_HOST").unwrap_or("localhost".into());
        let session = format!("tri-test-{}", std::process::id());
        let mut spec = spec(&host, "/tmp", Some("echo pid=$$ cwd=$(pwd); sleep 120"));
        spec.session = session.clone();

        // Spawn ssh in a PTY and wait until `needle` shows up in its output.
        let run = |needle: &str| -> String {
            let p = build(&spec);
            let pair = native_pty_system()
                .openpty(PtySize { rows: 24, cols: 120, pixel_width: 0, pixel_height: 0 })
                .unwrap();
            let mut cmd = CommandBuilder::new(&p.program);
            cmd.args(&p.args);
            let mut child = pair.slave.spawn_command(cmd).unwrap();
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().unwrap();
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
            let mut out = String::new();
            let deadline = Instant::now() + Duration::from_secs(15);
            while !out.contains(needle) && Instant::now() < deadline {
                if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                    out.push_str(&String::from_utf8_lossy(&b));
                }
            }
            child.kill().ok(); // drop the connection, like a network loss
            out
        };

        let first = run("pid=");
        let pid = first.split("pid=").nth(1).and_then(|s| s.split_whitespace().next()).map(String::from);
        assert!(first.contains("cwd=/tmp"), "first attach output: {first}");
        let pid = pid.expect("pid in output");

        // Reattach: shpool replays the screen, so the original pid is visible.
        let second = run(&format!("pid={pid}"));
        let _ = std::process::Command::new("ssh")
            .args(&kill_remote(&host, &session).args)
            .status();
        assert!(second.contains(&format!("pid={pid}")), "reattach output: {second}");
    }

    /// Run the generated remote script through a real shell to make sure the
    /// nested quoting survives (ssh hands the string to the remote shell as-is).
    #[cfg(unix)]
    #[test]
    fn remote_script_quoting_survives_a_real_shell() {
        // PATH holds only `printf`, forcing the no-multiplexer branch.
        let bin = std::env::temp_dir().join(format!("tri-spawn-test-{}", std::process::id()));
        std::fs::create_dir_all(&bin).unwrap();
        let _ = std::os::unix::fs::symlink("/usr/bin/printf", bin.join("printf"));
        // A non-login stand-in for $SHELL: a real `-l` would reset PATH via /etc/profile.
        let fake_shell = bin.join("fake-shell");
        std::fs::write(&fake_shell, "#!/bin/sh\nexec /bin/sh -c \"$2\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_shell, std::fs::Permissions::from_mode(0o755)).unwrap();

        let p = build(&spec("box", "/tmp", Some("printf '%s' \"it's ok\"")));
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&p.args[6])
            .env("PATH", &bin)
            .env("SHELL", &fake_shell)
            .output()
            .unwrap();
        std::fs::remove_dir_all(&bin).ok();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "it's ok", "{out:?}");
    }
}
