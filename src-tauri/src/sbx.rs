//! Docker Sandboxes (`sbx`): a Sandboxed Worktree's terminals run in a microVM that sees only its
//! checkout, the repo's `.git` and the folders Settings › Sandbox adds. This finds the `sbx` binary,
//! runs its management commands for the app (sandbox.ts parses their JSON) and turns a terminal's
//! command into the `sbx` call that runs it inside the sandbox (`args`, used by spawn.rs).
//! An ssh Environment's projects use the sbx installed on that host: every command here takes the
//! project's host and runs there over ssh, in its login shell, where its PATH has sbx.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::git::blocking;
use crate::remote;
use crate::spawn::{remote_path, sq};

fn is_local(host: Option<&str>) -> bool {
    matches!(host, None | Some("") | Some("local"))
}

/// Where the agent launchers go on an ssh host, under its `$HOME`.
pub const REMOTE_SHIM_DIR: &str = ".local/share/tri-code/sbx-shims";

/// An argument for a remote shell: a path under `~` stays expandable, anything else is quoted.
fn remote_arg(a: &str) -> String {
    if a == "~" || a.starts_with("~/") { remote_path(a) } else { sq(a) }
}

/// `script` run in the host's login shell, where sbx and git are on PATH.
fn login(script: &str) -> String {
    format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", sq(script))
}

/// The remote script that runs `sbx --no-input <args>`.
fn remote_sbx(args: &[String]) -> String {
    let words: Vec<String> = args.iter().map(|a| remote_arg(a)).collect();
    login(&format!("exec sbx --no-input {}", words.join(" ")))
}

const EXE: &str = if cfg!(windows) { "sbx.exe" } else { "sbx" };

/// Where `sbx` is: on PATH, else where its installers put it. A GUI app on a Mac doesn't get the
/// shell's PATH, and tri-code may have started before the install put it on PATH (Windows).
pub fn exe() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        if let Some(p) = std::env::split_paths(&path).map(|d| d.join(EXE)).find(|p| p.is_file()) {
            return Some(p);
        }
    }
    let fixed: Vec<PathBuf> = if cfg!(windows) {
        ["LOCALAPPDATA", "ProgramFiles"]
            .iter()
            .filter_map(|v| std::env::var_os(v))
            .map(|b| PathBuf::from(b).join("DockerSandboxes").join("bin").join(EXE))
            .collect()
    } else {
        ["/opt/homebrew/bin/sbx", "/usr/local/bin/sbx", "/usr/bin/sbx"].iter().map(PathBuf::from).collect()
    };
    fixed.into_iter().find(|p| p.is_file())
}

/// The folder `sbx` is in, for tri-code's terminals' PATH, so `sbx login` works in one.
pub fn bin_dir() -> Option<PathBuf> {
    exe().and_then(|p| p.parent().map(Path::to_path_buf))
}

/// The arguments to `sbx` that run `cmd` (None: a login shell) in sandbox `name`: `sbx exec` in a
/// bash login shell, in the workspace, as typed. claude too: `sbx run` would attach every window to
/// the one agent session, and would add its own flags to the command.
pub fn args(name: &str, cmd: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = ["exec", "-it", name, "bash"].map(String::from).to_vec();
    match cmd.map(str::trim).filter(|c| !c.is_empty()) {
        None => a.push("-l".into()),
        Some(c) => a.extend(["-lc".into(), c.to_string()]),
    }
    a
}

// ── agents typed in a Sandboxed Worktree's own shells ────────────────

/// The agents a shell of a Sandboxed Worktree runs in its sandbox when typed there, whatever started
/// the shell (a Command, an agent that quit). Claude only for now.
const SHIMMED: &[&str] = &["claude"];

/// A launcher per agent that runs it in `$TRI_SANDBOX` with the arguments it was given; the shell
/// finds it first on PATH. The arguments reach bash as its own `$@`, so nothing is quoted twice.
fn shim_files() -> Vec<(String, String)> {
    SHIMMED
        .iter()
        .flat_map(|a| {
            [
                (format!("{a}.cmd"), format!("@echo off\r\n\"%TRI_SBX%\" exec -it %TRI_SANDBOX% bash -lc \"{a} \\\"$@\\\"\" {a} %*\r\n")),
                (a.to_string(), format!("#!/bin/sh\nexec \"$TRI_SBX\" exec -it \"$TRI_SANDBOX\" bash -lc '{a} \"$@\"' {a} \"$@\"\n")),
            ]
        })
        .collect()
}

/// The folder of the launchers, written into `base` (the app's data folder) when they differ.
pub fn shim_dir(base: &Path) -> Option<PathBuf> {
    let dir = base.join("sbx-shims");
    std::fs::create_dir_all(&dir).ok()?;
    for (name, text) in shim_files() {
        let file = dir.join(&name);
        if std::fs::read_to_string(&file).ok().as_deref() != Some(text.as_str()) {
            std::fs::write(&file, &text).ok()?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755));
        }
    }
    Some(dir)
}

/// The management commands the app may run. Terminals start sandboxes through `args`; `exec` here
/// is the background preparing of a new sandbox, `template` the repo's saved setup (sandbox.ts).
const ALLOWED: &[&str] = &["version", "ls", "create", "rm", "stop", "exec", "secret", "policy", "template"];

fn allowed(args: &[String]) -> Result<(), String> {
    let first = args.first().map(String::as_str).unwrap_or("");
    if ALLOWED.contains(&first) { Ok(()) } else { Err(format!("sbx {first}: not a command tri-code runs")) }
}

/// Run `sbx <args>` on `host` (this machine when None) to completion, never prompting, with `input`
/// on stdin: over ssh too, so a key never shows in a command line. Errors carry stderr.
fn run_on(host: Option<&str>, args: &[String], input: Option<&str>) -> Result<String, String> {
    let Some(host) = host.filter(|h| !is_local(Some(h))) else { return run(args, input) };
    allowed(args)?;
    let script = remote_sbx(args);
    let out = match input {
        Some(text) => remote::run_stdin(host, &script, text.as_bytes()),
        None => remote::run(host, &script),
    };
    out.map_err(|e| if e.contains("sbx: not found") || e.contains("sbx: command not found") { format!("sbx: not installed on {host}") } else { e })
}

/// Run `sbx <args>` on this machine to completion, never prompting, with `input` on stdin. Errors carry stderr.
fn run(args: &[String], input: Option<&str>) -> Result<String, String> {
    allowed(args)?;
    let first = args.first().map(String::as_str).unwrap_or("");
    let exe = exe().ok_or("sbx: not installed")?;
    let mut cmd = Command::new(exe);
    cmd.arg("--no-input").args(args);
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("sbx: {e}"))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("sbx: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| format!("sbx: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        return Err(if err.is_empty() { format!("sbx {first}: {}", out.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Where sbx is on `host` (this machine when None), or None when it isn't installed there. An ssh
/// host that can't be reached is an error, not a missing sbx.
#[tauri::command]
pub async fn sbx_where(host: Option<String>) -> Result<Option<String>, String> {
    blocking(move || match host.as_deref().filter(|h| !is_local(Some(h))) {
        None => Ok(exe().map(|p| p.to_string_lossy().into_owned())),
        Some(h) => {
            let out = remote::run(h, &login("command -v sbx || true"))?;
            Ok(out.lines().map(str::trim).find(|l| !l.is_empty()).map(String::from))
        }
    })
    .await
}

/// `sbx <args>` on `host` (this machine when None); its stdout. A secret's value goes in `input`, never in `args`.
#[tauri::command]
pub async fn sbx_cli(host: Option<String>, args: Vec<String>, input: Option<String>) -> Result<String, String> {
    blocking(move || run_on(host.as_deref(), &args, input.as_deref())).await
}

/// Write the agent launchers on an ssh host, where its Sandboxed Worktrees' shells find them first
/// on PATH (spawn.rs). sbx there is found on the login shell's PATH.
#[tauri::command]
pub async fn sbx_remote_shims(host: String) -> Result<(), String> {
    blocking(move || {
        for (name, text) in shim_files().into_iter().filter(|(n, _)| !n.ends_with(".cmd")) {
            let script = format!("d=\"$HOME/{REMOTE_SHIM_DIR}\"; mkdir -p \"$d\" && cat > \"$d/{name}\" && chmod 755 \"$d/{name}\"");
            remote::run_stdin(&host, &format!("sh -c {}", sq(&script)), text.as_bytes())?;
        }
        Ok(())
    })
    .await
}

// ── git in a sandbox ─────────────────────────────────────────────────

/// `target` relative to `dir`, as the gitdir line of a worktree's `.git` file: git reads that the
/// same on Windows and inside the sandbox's Linux, where the absolute `C:/...` it writes means
/// nothing. Both are mounted at the same place relative to each other. None across drives.
pub fn relative_gitdir(dir: &str, target: &str) -> Option<String> {
    let parts = |p: &str| p.replace('\\', "/").split('/').filter(|s| !s.is_empty() && *s != ".").map(String::from).collect::<Vec<_>>();
    let (from, to) = (parts(dir), parts(target));
    let same = |a: &str, b: &str| if cfg!(windows) || a.ends_with(':') { a.eq_ignore_ascii_case(b) } else { a == b };
    let common = from.iter().zip(&to).take_while(|(a, b)| same(a, b)).count();
    if common == 0 {
        return None;
    }
    let mut rel: Vec<String> = vec!["..".into(); from.len() - common];
    rel.extend(to[common..].iter().cloned());
    Some(rel.join("/"))
}

/// Make a worktree's `.git` pointer relative, so git works in its sandbox too. Left as it was when
/// it is already relative, or when git on this machine can't read the relative one.
#[tauri::command]
pub async fn sandbox_gitdir_relative(host: Option<String>, dir: String) -> Result<(), String> {
    blocking(move || match host.as_deref().filter(|h| !is_local(Some(h))) {
        None => gitdir_relative_local(&dir),
        Some(h) => gitdir_relative_remote(h, &dir),
    })
    .await
}

/// On an ssh host: read where the pointer points from the folder's real path, then write the relative
/// one and put the old one back if git can't read it.
fn gitdir_relative_remote(host: &str, dir: &str) -> Result<(), String> {
    let out = remote::run(host, &format!("cd {} && pwd -P && sed -n 's/^gitdir: *//p' .git", remote_path(dir)))?;
    let mut lines = out.lines().map(str::trim);
    let (Some(here), Some(target)) = (lines.next(), lines.next().filter(|t| !t.is_empty())) else {
        return Err(format!("{dir}/.git is not a worktree's pointer"));
    };
    if !target.starts_with('/') {
        return Ok(());
    }
    let rel = relative_gitdir(here, target).ok_or("the repo is on another filesystem root")?;
    let script = format!(
        "cd {} && cp .git .git.tri-was && printf 'gitdir: %s\\n' {} > .git && \
         if git rev-parse --git-dir >/dev/null 2>&1; then rm -f .git.tri-was; \
         else mv -f .git.tri-was .git; echo \"git can't read a relative pointer here; left it as it was\" >&2; exit 1; fi",
        remote_path(dir),
        sq(&rel)
    );
    remote::run(host, &login(&script)).map(|_| ())
}

fn gitdir_relative_local(dir: &str) -> Result<(), String> {
    let dir = dir.to_string();
    let file = Path::new(&dir).join(".git");
    let text = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    let Some(target) = text.trim().strip_prefix("gitdir:").map(str::trim) else {
        return Err(format!("{} is not a worktree's pointer", file.display()));
    };
    if !Path::new(target).is_absolute() {
        return Ok(());
    }
    let rel = relative_gitdir(&dir, target).ok_or("the repo is on another drive")?;
    // Truncate in place: Windows won't recreate a hidden file (git hides `.git`).
    let write = |s: &str| -> Result<(), String> {
        let mut f = std::fs::OpenOptions::new().write(true).truncate(true).open(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        f.write_all(s.as_bytes()).map_err(|e| e.to_string())
    };
    write(&format!("gitdir: {rel}\n"))?;
    if git_out(&dir, &["rev-parse", "--git-dir"]).is_none() {
        write(&text)?;
        return Err("git can't read a relative pointer here; left it as it was".into());
    }
    Ok(())
}

fn git_out(dir: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

/// What git in a sandbox should take from git here: who commits, and line endings (Git for Windows
/// checks files out with CRLF, so a sandbox without autocrlf sees every file as changed).
#[derive(serde::Serialize)]
pub struct GitIdentity {
    name: Option<String>,
    email: Option<String>,
    autocrlf: Option<String>,
}

#[tauri::command]
pub async fn sandbox_git_identity(host: Option<String>, dir: String) -> Result<GitIdentity, String> {
    blocking(move || {
        if let Some(h) = host.as_deref().filter(|h| !is_local(Some(h))) {
            let script = format!("cd {} 2>/dev/null; for k in user.name user.email core.autocrlf; do printf '%s\\n' \"$(git config --get $k)\"; done", remote_path(&dir));
            let out = remote::run(h, &login(&script))?;
            let mut v = out.lines().map(|l| Some(l.trim().to_string()).filter(|s| !s.is_empty()));
            return Ok(GitIdentity { name: v.next().flatten(), email: v.next().flatten(), autocrlf: v.next().flatten() });
        }
        Ok(GitIdentity {
            name: git_out(&dir, &["config", "--get", "user.name"]),
            email: git_out(&dir, &["config", "--get", "user.email"]),
            autocrlf: git_out(&dir, &["config", "--get", "core.autocrlf"]),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_is_a_bash_login_shell_in_the_sandbox() {
        assert_eq!(args("tri-x", None), ["exec", "-it", "tri-x", "bash", "-l"]);
        assert_eq!(args("tri-x", Some("  ")), ["exec", "-it", "tri-x", "bash", "-l"]);
    }

    #[test]
    fn a_command_is_one_argument_to_bash_whatever_it_holds() {
        assert_eq!(args("tri-x", Some("claude --model opus")), ["exec", "-it", "tri-x", "bash", "-lc", "claude --model opus"]);
        assert_eq!(args("tri-x", Some("bun run dev && echo 'ok'")), ["exec", "-it", "tri-x", "bash", "-lc", "bun run dev && echo 'ok'"]);
    }

    #[test]
    fn the_launchers_hand_their_arguments_to_claude_in_the_sandbox() {
        let files = shim_files();
        let cmd = &files.iter().find(|(n, _)| n == "claude.cmd").unwrap().1;
        assert!(cmd.contains("exec -it %TRI_SANDBOX% bash -lc \"claude \\\"$@\\\"\" claude %*"), "{cmd}");
        let sh = &files.iter().find(|(n, _)| n == "claude").unwrap().1;
        assert!(sh.starts_with("#!/bin/sh\nexec \"$TRI_SBX\" exec -it \"$TRI_SANDBOX\""), "{sh}");
        let dir = std::env::temp_dir().join(format!("tri-shim-test-{}", std::process::id()));
        let made = shim_dir(&dir).unwrap();
        assert!(made.join("claude.cmd").is_file() && made.join("claude").is_file());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The Windows launcher, run by cmd.exe as PowerShell would, against a stand-in for sbx that
    /// prints what it was given: claude gets its arguments one by one, spaces and all.
    #[cfg(windows)]
    #[test]
    fn the_windows_launcher_passes_arguments_through_cmd() {
        let dir = std::env::temp_dir().join(format!("tri-shim-cmd-{}", std::process::id()));
        let shims = shim_dir(&dir).unwrap();
        let fake = dir.join("fake-sbx.cmd");
        std::fs::write(&fake, "@echo off\r\necho [%1] [%2] [%3] [%4] [%5] [%6] [%7] [%8]\r\n").unwrap();
        let out = Command::new("cmd.exe")
            .args(["/d", "/c", "claude", "--model", "opus"])
            .env("PATH", format!("{};{}", shims.display(), std::env::var("PATH").unwrap_or_default()))
            .env("TRI_SBX", &fake)
            .env("TRI_SANDBOX", "tri-x")
            .output()
            .unwrap();
        std::fs::remove_dir_all(&dir).ok();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("[exec] [-it] [tri-x] [bash] [-lc]"), "{text}");
        assert!(text.contains("[claude] [--model]"), "{text}");
    }

    #[test]
    fn a_worktree_pointer_becomes_relative_to_its_folder() {
        assert_eq!(
            relative_gitdir(r"C:\Users\me\Projects\app.worktrees\fix", "C:/Users/me/Projects/app/.git/worktrees/fix").as_deref(),
            Some("../../app/.git/worktrees/fix")
        );
        assert_eq!(relative_gitdir("/home/me/app.worktrees/fix", "/home/me/app/.git/worktrees/fix").as_deref(), Some("../../app/.git/worktrees/fix"));
        assert_eq!(relative_gitdir(r"D:\work\x", "C:/Users/me/app/.git/worktrees/x"), None);
    }

    #[test]
    fn over_ssh_sbx_runs_in_the_login_shell_with_home_paths_expandable() {
        let s = remote_sbx(&["create".into(), "--name".into(), "tri-app-x".into(), "claude".into(), "~/app.worktrees/x".into(), "/srv/it's".into()]);
        assert_eq!(s, r#"exec "${SHELL:-/bin/sh}" -lc 'exec sbx --no-input '\''create'\'' '\''--name'\'' '\''tri-app-x'\'' '\''claude'\'' ~/'\''app.worktrees/x'\'' '\''/srv/it'\''\'\'''\''s'\'''"#);
    }

    #[test]
    fn only_management_commands_run() {
        assert!(run_on(Some("box"), &["login".into()], None).unwrap_err().contains("not a command"));
        assert!(run(&["login".into()], None).unwrap_err().contains("not a command"));
        assert!(run(&[], None).unwrap_err().contains("not a command"));
    }
}
