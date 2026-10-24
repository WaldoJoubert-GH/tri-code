//! Plan usage for the two agents that meter it (the numbers their own `/usage`
//! shows): Claude Code, read with the OAuth token in
//! `~/.claude/.credentials.json`, and Command Code, read with the API key in
//! `~/.commandcode/auth.json`.
//!
//! The requests go through the system `curl` (bundled with Windows 10+) so the
//! app does not need its own TLS stack. The token is passed as a header on
//! stdin, so it never appears on a command line.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;

const URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// The billing surface `cmd /usage` reads: rolling money limits, no plan needed to know.
const COMMAND_CODE_URL: &str = "https://api.commandcode.ai/alpha/billing/credits";
/// The subscription behind those limits: its `planId` says how big the monthly credit pool is.
const COMMAND_CODE_PLAN_URL: &str = "https://api.commandcode.ai/alpha/billing/subscriptions";
/// Monthly credit grant (USD) per plan, as the CLI's own `/usage` reads it. Plan ids are matched
/// by their longest prefix, like the CLI does, so `individual-provider` never lands on Pro (30).
const PLAN_CREDITS: &[(&str, f64)] = &[
    ("individual-go", 10.0),
    ("individual-goat", 70.0),
    ("individual-pro", 30.0),
    ("individual-pro-v1", 80.0),
    ("individual-provider", 15.0),
    ("individual-max", 150.0),
    ("individual-ultra", 300.0),
    ("teams-pro", 40.0),
];

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
    /// Command Code's credit pool: what is left, and the plan's grant. Claude has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<Credits>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credits {
    /// Dollars left of the monthly grant, plus any purchased or free credit.
    pub remaining: f64,
    /// The plan's monthly grant, plus any purchased or free credit.
    pub total: f64,
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

/// A rolling window from `/alpha/billing/credits`: money spent against the window's cap, and the
/// epoch-millisecond time it reopens. `cap` 0 is a window the plan doesn't meter.
fn limit(v: &Value) -> Option<Window> {
    let used = v.get("used")?.as_f64()?;
    let cap = v.get("cap")?.as_f64()?;
    if cap <= 0.0 {
        return None;
    }
    Some(Window {
        percent: (used / cap * 100.0).clamp(0.0, 100.0),
        resets_at: v.get("resetAt").and_then(Value::as_i64).map(rfc3339),
    })
}

/// Epoch milliseconds as RFC 3339 to the second, the shape Claude's endpoint sends
/// (`2026-10-24T22:23:10Z`), so the status line parses both the same way.
fn rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days: days since 1970 → Y-M-D without a date crate.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3_600, rem % 3_600 / 60, rem % 60)
}

/// GET `url` as JSON, with `extra` curl flags, and `headers` on stdin (one per line).
fn curl_json(url: &str, extra: &[&str], headers: &str) -> Result<Value, String> {
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "-f", "--max-time", "10", "-H", "@-"])
        .args(extra)
        .arg(url)
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
        .write_all(headers.as_bytes())
        .map_err(|e| format!("curl: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claude_usage() -> Result<Usage, String> {
    let token = access_token()?;
    let json = curl_json(URL, &["-H", "anthropic-beta: oauth-2025-04-20"], &format!("Authorization: Bearer {token}\n"))?;
    Ok(Usage { session: window(&json["five_hour"]), weekly: window(&json["seven_day"]), credits: None })
}

/// The key `cmd` itself uses: an override in the environment, else its stored login.
fn command_code_key() -> Result<String, String> {
    for var in ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"] {
        if let Ok(key) = std::env::var(var) {
            if !key.trim().is_empty() {
                return Ok(key);
            }
        }
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok_or("no home directory")?;
    let path = PathBuf::from(home).join(".commandcode").join("auth.json");
    let text = std::fs::read_to_string(&path).map_err(|_| "not signed in to Command Code".to_string())?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json["apiKey"]
        .as_str()
        .filter(|k| !k.trim().is_empty())
        .map(String::from)
        .ok_or_else(|| "not signed in to Command Code".into())
}

#[tauri::command]
pub async fn command_code_usage() -> Result<Usage, String> {
    let key = command_code_key()?;
    let headers = format!("Authorization: Bearer {key}\nx-api-key: {key}\n");
    let json = curl_json(COMMAND_CODE_URL, &[], &headers)?;
    // A plan we can't name is no reason to hide the windows: only the credit meter needs it.
    let plan_id = curl_json(COMMAND_CODE_PLAN_URL, &[], &headers).ok().and_then(|p| p["data"]["planId"].as_str().map(String::from));
    let limits = &json["windowLimits"];
    Ok(Usage {
        session: limit(&limits["fiveHour"]),
        weekly: limit(&limits["weekly"]),
        credits: command_code_credits(&json, plan_id.as_deref()),
    })
}

fn plan_credits(plan_id: &str) -> Option<f64> {
    let id = plan_id.to_lowercase().replace('_', "-");
    PLAN_CREDITS
        .iter()
        .filter(|(prefix, _)| id.starts_with(prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, credits)| *credits)
}

/// What is left of the monthly pool and how big it is. Needs the plan: the credits response says
/// only what remains, and the grant lives on the subscription's `planId`.
fn command_code_credits(v: &Value, plan_id: Option<&str>) -> Option<Credits> {
    let c = &v["credits"];
    let money = |field: &str| c[field].as_f64().unwrap_or(0.0).max(0.0);
    let (monthly, purchased, free) = (money("monthlyCredits"), money("purchasedCredits"), money("freeCredits"));
    let grant = plan_id.and_then(plan_credits)?;
    let total = grant + purchased + free;
    (total > 0.0).then(|| Credits { remaining: monthly + purchased + free, total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rfc3339_matches_the_wire_shape() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_792_880_590_338), "2026-10-24T22:23:10Z");
        assert_eq!(rfc3339(1_793_383_457_720), "2026-10-30T18:04:17Z");
    }

    #[test]
    fn limit_reads_used_over_cap() {
        let w = limit(&json!({ "used": 0.0534510069, "cap": 14, "resetAt": 1_792_880_590_338i64 })).unwrap();
        assert!((w.percent - 0.381_792_906_4).abs() < 1e-9);
        assert_eq!(w.resets_at.as_deref(), Some("2026-10-24T22:23:10Z"));
        // Over the cap clamps to 100; a window without a cap or a `used` shows nothing.
        assert_eq!(limit(&json!({ "used": 40, "cap": 35 })).unwrap().percent, 100.0);
        assert!(limit(&json!({ "used": 1, "cap": 0 })).is_none());
        assert!(limit(&json!({ "cap": 5 })).is_none());
    }

    #[test]
    fn plan_credits_takes_the_longest_prefix() {
        assert_eq!(plan_credits("individual-go"), Some(10.0));
        assert_eq!(plan_credits("individual-goat"), Some(70.0));
        assert_eq!(plan_credits("individual-pro"), Some(30.0));
        assert_eq!(plan_credits("individual-pro-v1"), Some(80.0));
        // Pro is a prefix of Provider: the longer one has to win.
        assert_eq!(plan_credits("individual-provider"), Some(15.0));
        assert_eq!(plan_credits("mystery-plan"), None);
    }

    #[test]
    fn credits_need_a_known_plan() {
        let body = json!({ "credits": { "monthlyCredits": 52.6886491575, "purchasedCredits": 5.0, "freeCredits": 0 } });
        let c = command_code_credits(&body, Some("individual-goat")).unwrap();
        assert!((c.remaining - 57.6886491575).abs() < 1e-9);
        assert_eq!(c.total, 75.0);
        assert!(command_code_credits(&body, None).is_none());
    }
}
