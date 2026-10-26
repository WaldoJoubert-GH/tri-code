//! Agent setup: whether Claude and pi have tri-code's agent-windows server (mcp/tri-code.mjs)
//! registered, and the install and remove that register it.
//!
//! Detection reads the agents' own config files, so it is the truth the agents see. Install and
//! remove run the agent's own CLI with the server's path from the app. Nothing typed on screen
//! ends up in a command line.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// The name the server is registered under, in both agents.
const NAME: &str = "tri-code";

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Not registered.
    Missing,
    /// Registered, pointing at this app's server.
    Installed,
    /// Registered, but pointing somewhere else (an old checkout, a moved app).
    Stale,
}

#[derive(Serialize)]
pub struct AgentSetup {
    /// Whether the agent's command is on PATH.
    pub present: bool,
    pub state: State,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// Node runs the server, and is on PATH.
    pub node: bool,
    pub claude: AgentSetup,
    pub pi: AgentSetup,
}

/// Where the server file is: in the repo for a debug build, in the app's resources otherwise
/// (tauri.conf.json bundles it there as `mcp/tri-code.mjs`).
pub fn shim_path(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let p = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../mcp/tri-code.mjs"));
        return fs::canonicalize(p).map(strip_verbatim).map_err(|e| format!("server file: {e}"));
    }
    let p = app.path().resource_dir().map_err(|e| e.to_string())?.join("mcp").join("tri-code.mjs");
    if p.is_file() { Ok(p) } else { Err(format!("the server file is missing from the app: {}", p.display())) }
}

/// `\\?\C:\…` back to `C:\…`, which the agents' own CLIs and configs expect.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Forward slashes, lowercase on Windows: the same path however the agent wrote it.
fn norm(p: &str) -> String {
    let s = p.replace('\\', "/");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// What a config's `mcpServers` says about tri-code's server. Claude's `~/.claude.json` and pi's
/// `~/.pi/agent/mcp.json` both keep servers under `mcpServers`, with `command` and `args`.
pub fn state_in(config: &str, shim: &str) -> State {
    let Ok(v) = serde_json::from_str::<Value>(config) else { return State::Missing };
    let Some(entry) = v.get("mcpServers").and_then(|m| m.get(NAME)) else { return State::Missing };
    let ours = entry.get("command").and_then(Value::as_str) == Some("node")
        && entry
            .get("args")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .is_some_and(|p| norm(p) == norm(shim));
    if ours { State::Installed } else { State::Stale }
}

/// The platform shell, running `line`, as a terminal runs a Command.
fn shell(line: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd.exe");
        // The line goes in raw: `/s` strips the outer quotes, and Rust's own quoting would
        // escape the quotes around the server's path, which cmd doesn't read.
        c.raw_arg(format!("/d /s /c \"{line}\""));
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = Command::new(sh);
        c.args(["-lc", line]);
        c
    }
}

/// Runs a command line through the platform shell and returns its stdout.
fn run(line: &str) -> Result<String, String> {
    let out = shell(line)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() { String::from_utf8_lossy(&out.stdout).into_owned() } else { err.into_owned() };
        Err(msg.trim().to_string())
    }
}

/// A path as one shell word.
fn word(p: &Path) -> String {
    if cfg!(windows) {
        format!("\"{}\"", p.display())
    } else {
        format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"))
    }
}

fn present(cmd: &str) -> bool {
    let line = if cfg!(windows) { format!("where {cmd}") } else { format!("command -v {cmd}") };
    run(&line).is_ok()
}

fn read(path: Option<PathBuf>) -> String {
    path.and_then(|p| fs::read_to_string(p).ok()).unwrap_or_default()
}

pub fn status(app: &AppHandle) -> Result<Setup, String> {
    let shim = shim_path(app)?;
    let shim_s = shim.to_string_lossy().into_owned();
    let claude_cfg = read(home().map(|h| h.join(".claude.json")));
    let pi_cfg = read(home().map(|h| h.join(".pi").join("agent").join("mcp.json")));
    Ok(Setup {
        node: present("node"),
        claude: AgentSetup { present: present("claude"), state: state_in(&claude_cfg, &shim_s) },
        pi: AgentSetup { present: present("pi"), state: state_in(&pi_cfg, &shim_s) },
    })
}

#[derive(Clone, Copy)]
enum Agent {
    Claude,
    Pi,
}

fn agent_of(name: &str) -> Result<Agent, String> {
    match name {
        "claude" => Ok(Agent::Claude),
        "pi" => Ok(Agent::Pi),
        other => Err(format!("unknown agent {other}")),
    }
}

/// Registers the server with the agent. Claude has no replace, so an entry at another path is
/// removed first.
fn install(app: &AppHandle, agent: Agent) -> Result<(), String> {
    let shim = shim_path(app)?;
    if !present("node") {
        return Err("Node isn't on PATH, so the server can't run. Install Node, then try again.".into());
    }
    match agent {
        Agent::Claude => {
            let _ = run(&format!("claude mcp remove --scope user {NAME}"));
            run(&format!("claude mcp add --scope user {NAME} -- node {}", word(&shim))).map(|_| ())
        }
        Agent::Pi => run(&format!("pi mcp add {NAME} --exposure direct -- node {}", word(&shim))).map(|_| ()),
    }
}

fn remove(agent: Agent) -> Result<(), String> {
    match agent {
        Agent::Claude => run(&format!("claude mcp remove --scope user {NAME}")).map(|_| ()),
        Agent::Pi => run(&format!("pi mcp remove {NAME}")).map(|_| ()),
    }
}

#[tauri::command]
pub async fn agent_setup_status(app: AppHandle) -> Result<Setup, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_setup_install(app: AppHandle, agent: String) -> Result<(), String> {
    let agent = agent_of(&agent)?;
    tauri::async_runtime::spawn_blocking(move || install(&app, agent)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_setup_remove(agent: String) -> Result<(), String> {
    let agent = agent_of(&agent)?;
    tauri::async_runtime::spawn_blocking(move || remove(agent)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHIM: &str = "C:/apps/tri-code/mcp/tri-code.mjs";

    fn config(path: &str) -> String {
        serde_json::json!({ "mcpServers": { "tri-code": { "command": "node", "args": [path] } } }).to_string()
    }

    #[test]
    fn no_config_or_no_entry_is_missing() {
        assert_eq!(state_in("", SHIM), State::Missing);
        assert_eq!(state_in("{}", SHIM), State::Missing);
        assert_eq!(state_in(r#"{"mcpServers":{"other":{"command":"node","args":[]}}}"#, SHIM), State::Missing);
    }

    #[test]
    fn an_entry_for_this_server_is_installed() {
        assert_eq!(state_in(&config(SHIM), SHIM), State::Installed);
    }

    #[test]
    fn an_entry_at_another_path_is_stale() {
        assert_eq!(state_in(&config("C:/old/checkout/mcp/tri-code.mjs"), SHIM), State::Stale);
    }

    #[test]
    fn backslashes_and_case_do_not_make_it_stale_on_windows() {
        if cfg!(windows) {
            assert_eq!(state_in(&config(r"c:\apps\tri-code\mcp\tri-code.mjs"), SHIM), State::Installed);
        }
    }

    #[test]
    fn a_different_command_is_stale() {
        let c = r#"{"mcpServers":{"tri-code":{"command":"bun","args":["C:/apps/tri-code/mcp/tri-code.mjs"]}}}"#;
        assert_eq!(state_in(c, SHIM), State::Stale);
    }

    #[test]
    fn agent_names_are_checked() {
        assert!(agent_of("claude").is_ok());
        assert!(agent_of("pi").is_ok());
        assert!(agent_of("bash").is_err());
    }
}
