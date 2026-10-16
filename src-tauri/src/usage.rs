//! Claude plan usage (the numbers Claude Code's `/usage` shows), read with the
//! OAuth token Claude Code stores in `~/.claude/.credentials.json`.
//!
//! The request goes through the system `curl` (bundled with Windows 10+) so the
//! app does not need its own TLS stack. The token is passed as a header on
//! stdin, so it never appears on a command line.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;

const URL: &str = "https://api.anthropic.com/api/oauth/usage";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// Percent of the limit used, 0–100.
    pub percent: f64,
    /// RFC 3339 time the window resets, if known.
    pub resets_at: Option<String>,
}

#[derive(Serialize)]
pub struct Usage {
    pub session: Option<Window>,
    pub weekly: Option<Window>,
}

fn credentials_path() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join(".credentials.json"));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".claude").join(".credentials.json"))
}

fn access_token() -> Result<String, String> {
    let path = credentials_path().ok_or("no home directory")?;
    let text = std::fs::read_to_string(&path).map_err(|_| "not signed in to Claude Code".to_string())?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json["claudeAiOauth"]["accessToken"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "not signed in to Claude Code".into())
}

fn window(v: &Value) -> Option<Window> {
    Some(Window {
        percent: v.get("utilization")?.as_f64()?,
        resets_at: v.get("resets_at").and_then(Value::as_str).map(String::from),
    })
}

#[tauri::command]
pub async fn claude_usage() -> Result<Usage, String> {
    let token = access_token()?;
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "-f", "--max-time", "10", "-H", "@-", "-H", "anthropic-beta: oauth-2025-04-20", URL])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("curl: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("curl: no stdin")?
        .write_all(format!("Authorization: Bearer {token}\n").as_bytes())
        .map_err(|e| format!("curl: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let json: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(Usage { session: window(&json["five_hour"]), weekly: window(&json["seven_day"]) })
}
