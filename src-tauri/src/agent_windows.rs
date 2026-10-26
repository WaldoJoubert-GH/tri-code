//! Agent windows: an agent in a tri-code terminal opens, reads, types into and closes terminal
//! windows of its own project or worktree, through the MCP shim in `mcp/tri-code.mjs`.
//!
//! A loopback endpoint on 127.0.0.1 serves the calls. Every terminal gets its own token in
//! `TRICODE_TOKEN` when it starts, and the token names the window it belongs to. So a caller
//! sees the windows of its own project and nothing else; the request can't widen that.
//!
//! Which Commands an agent may open is the Agent toggle in the Commands Window. The webview
//! pushes that list here (`agent_allowed`) and checks it again when the window is made. Opening
//! and closing tabs is the webview's job: this module emits an event, and the webview's own spawn
//! of the PTY completes an open.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::get;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::pty::Ptys;

/// The endpoint's port, and the address every terminal is told in `TRICODE_URL`.
pub const PORT: u16 = 7521;
pub const URL: &str = "http://127.0.0.1:7521";

const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_WAIT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_millis(200);
/// Lines of output a read or a wait returns.
const LINES: usize = 40;

/// The terminal that asked for a window, sent with its spawn. `by` is "agent" for a window an
/// agent opened, `req` the open request that waits for this spawn.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub project: String,
    pub tab: String,
    pub name: String,
    #[serde(default)]
    pub by: Option<String>,
    #[serde(default)]
    pub req: Option<String>,
}

/// A Command an agent may open in a project: what the webview pushes.
#[derive(Clone, Deserialize)]
pub struct Allowed {
    pub id: String,
    pub name: String,
}

#[derive(Clone)]
pub struct Window {
    pub project: String,
    pub tab: String,
    pub pty: u32,
    pub name: String,
    pub token: String,
    pub by_agent: bool,
}

/// Who a request comes from: the project and window its token belongs to.
pub struct Caller {
    pub project: String,
}

/// The pure state: tokens, windows, the allowed Commands and the opens waiting to start.
#[derive(Default)]
pub struct Registry {
    /// token -> tab
    tokens: HashMap<String, String>,
    /// tab -> window
    windows: HashMap<String, Window>,
    /// project -> the Commands its agents may open
    allowed: HashMap<String, Vec<Allowed>>,
    /// open requests waiting for their window to start
    pending: HashMap<String, oneshot::Sender<Result<String, String>>>,
}

impl Registry {
    pub fn set_allowed(&mut self, allowed: HashMap<String, Vec<Allowed>>) {
        self.allowed = allowed;
    }

    /// The Command named `command` in `project`, matched by name without case.
    pub fn allowed(&self, project: &str, command: &str) -> Option<&Allowed> {
        let want = command.trim().to_lowercase();
        if want.is_empty() {
            return None;
        }
        self.allowed.get(project)?.iter().find(|a| a.name.trim().to_lowercase() == want)
    }

    pub fn issue(&mut self, o: &Owner, pty: u32, token: String) {
        if let Some(old) = self.windows.remove(&o.tab) {
            self.tokens.remove(&old.token);
        }
        self.tokens.insert(token.clone(), o.tab.clone());
        let window = Window {
            project: o.project.clone(),
            tab: o.tab.clone(),
            pty,
            name: o.name.clone(),
            token,
            by_agent: o.by.as_deref() == Some("agent"),
        };
        self.windows.insert(o.tab.clone(), window);
    }

    /// Forgets a window when its PTY exits. A tab that has since respawned keeps its new window.
    pub fn forget(&mut self, tab: &str, pty: u32) {
        if self.windows.get(tab).is_some_and(|w| w.pty == pty)
            && let Some(w) = self.windows.remove(tab)
        {
            self.tokens.remove(&w.token);
        }
    }

    pub fn caller(&self, token: &str) -> Option<Caller> {
        let tab = self.tokens.get(token)?;
        let w = self.windows.get(tab)?;
        Some(Caller { project: w.project.clone() })
    }

    /// A window the caller may see: one in its own project.
    pub fn window(&self, caller: &Caller, id: &str) -> Option<&Window> {
        self.windows.get(id).filter(|w| w.project == caller.project)
    }

    pub fn windows_of<'a>(&'a self, project: &'a str) -> impl Iterator<Item = &'a Window> + 'a {
        self.windows.values().filter(move |w| w.project == project)
    }

    pub fn park(&mut self, req: String, tx: oneshot::Sender<Result<String, String>>) {
        self.pending.insert(req, tx);
    }

    pub fn unpark(&mut self, req: &str) {
        self.pending.remove(req);
    }

    pub fn resolve(&mut self, req: &str, result: Result<String, String>) {
        if let Some(tx) = self.pending.remove(req) {
            let _ = tx.send(result);
        }
    }
}

pub struct AgentWindows {
    app: AppHandle,
    ptys: Arc<Ptys>,
    reg: Mutex<Registry>,
}

impl AgentWindows {
    pub fn new(app: AppHandle, ptys: Arc<Ptys>) -> Arc<Self> {
        Arc::new(Self { app, ptys, reg: Mutex::new(Registry::default()) })
    }

    pub fn issue(&self, o: &Owner, pty: u32, token: String) {
        self.reg.lock().unwrap().issue(o, pty, token);
    }

    pub fn forget(&self, tab: &str, pty: u32) {
        self.reg.lock().unwrap().forget(tab, pty);
    }

    pub fn resolve(&self, req: &str, result: Result<String, String>) {
        self.reg.lock().unwrap().resolve(req, result);
    }
}

/// 24 random bytes as hex: a window's token, or an open request's id.
pub fn new_token() -> String {
    let mut b = [0u8; 24];
    getrandom::getrandom(&mut b).expect("os random");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Plain text from PTY bytes: CSI, OSC and two-character escapes removed, carriage returns dropped.
pub fn plain(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: parameters, then a final byte from @ to ~.
            Some('[') => {
                chars.next();
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ESC \.
            Some(']') => {
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '\x07' {
                        break;
                    }
                    if n == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out.retain(|c| c != '\r');
    out
}

/// The last `n` lines of `text`, without trailing blank lines.
pub fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.trim_end().split('\n').collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// The newest `fresh` bytes of `bytes`: what came after a point `fresh` bytes ago.
pub fn fresh(bytes: &[u8], fresh: u64) -> &[u8] {
    let n = usize::try_from(fresh).unwrap_or(usize::MAX).min(bytes.len());
    &bytes[bytes.len() - n..]
}

type Reply = Result<axum::Json<Value>, (StatusCode, axum::Json<Value>)>;

fn fail(code: StatusCode, msg: impl Into<String>) -> (StatusCode, axum::Json<Value>) {
    (code, axum::Json(json!({ "error": msg.into() })))
}

fn caller(hub: &AgentWindows, headers: &HeaderMap) -> Result<Caller, (StatusCode, axum::Json<Value>)> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| hub.reg.lock().unwrap().caller(t))
        .ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "not a tri-code terminal: TRICODE_TOKEN is missing or unknown"))
}

fn window_of(hub: &AgentWindows, c: &Caller, id: &str) -> Result<Window, (StatusCode, axum::Json<Value>)> {
    hub.reg
        .lock()
        .unwrap()
        .window(c, id)
        .cloned()
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, format!("no window {id} in this project")))
}

fn gone(_: String) -> (StatusCode, axum::Json<Value>) {
    fail(StatusCode::NOT_FOUND, "that window has closed")
}

#[derive(Deserialize)]
struct OpenBody {
    command: String,
}

#[derive(Deserialize)]
struct OutputQuery {
    lines: Option<usize>,
}

#[derive(Deserialize)]
struct InputBody {
    text: String,
    #[serde(default = "yes")]
    enter: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct WaitBody {
    pattern: String,
    timeout_secs: Option<u64>,
}

async fn list(State(hub): State<Arc<AgentWindows>>, headers: HeaderMap) -> Reply {
    let c = caller(&hub, &headers)?;
    let reg = hub.reg.lock().unwrap();
    let windows: Vec<Value> = reg
        .windows_of(&c.project)
        .map(|w| json!({ "window": w.tab, "name": w.name, "by": if w.by_agent { "agent" } else { "you" } }))
        .collect();
    Ok(axum::Json(json!({ "windows": windows })))
}

async fn open(State(hub): State<Arc<AgentWindows>>, headers: HeaderMap, axum::Json(body): axum::Json<OpenBody>) -> Reply {
    let c = caller(&hub, &headers)?;
    let allowed = {
        let reg = hub.reg.lock().unwrap();
        reg.allowed(&c.project, &body.command).cloned()
    };
    let Some(allowed) = allowed else {
        return Err(fail(
            StatusCode::FORBIDDEN,
            format!("agents may not open “{}” here: turn on Agent for it in the Commands window", body.command.trim()),
        ));
    };

    let req = new_token();
    let (tx, rx) = oneshot::channel();
    hub.reg.lock().unwrap().park(req.clone(), tx);
    let sent = hub.app.emit("agent-open", json!({ "req": req, "project": c.project, "agent": allowed.id }));
    if let Err(e) = sent {
        hub.reg.lock().unwrap().unpark(&req);
        return Err(fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }

    match tokio::time::timeout(OPEN_TIMEOUT, rx).await {
        Ok(Ok(Ok(tab))) => Ok(axum::Json(json!({ "window": tab, "name": allowed.name }))),
        Ok(Ok(Err(e))) => Err(fail(StatusCode::INTERNAL_SERVER_ERROR, e)),
        _ => {
            hub.reg.lock().unwrap().unpark(&req);
            Err(fail(StatusCode::GATEWAY_TIMEOUT, "the window did not start in time"))
        }
    }
}

async fn status(State(hub): State<Arc<AgentWindows>>, headers: HeaderMap, Path(id): Path<String>) -> Reply {
    let c = caller(&hub, &headers)?;
    let w = window_of(&hub, &c, &id)?;
    Ok(axum::Json(json!({ "window": w.tab, "name": w.name, "by": if w.by_agent { "agent" } else { "you" } })))
}

async fn output(State(hub): State<Arc<AgentWindows>>, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<OutputQuery>) -> Reply {
    let c = caller(&hub, &headers)?;
    let w = window_of(&hub, &c, &id)?;
    let (bytes, _) = hub.ptys.snapshot(w.pty).map_err(gone)?;
    let n = q.lines.unwrap_or(LINES).clamp(1, 2000);
    Ok(axum::Json(json!({ "output": last_lines(&plain(&bytes), n) })))
}

async fn input(State(hub): State<Arc<AgentWindows>>, headers: HeaderMap, Path(id): Path<String>, axum::Json(body): axum::Json<InputBody>) -> Reply {
    let c = caller(&hub, &headers)?;
    let w = window_of(&hub, &c, &id)?;
    let mut data = body.text;
    if body.enter {
        data.push('\r');
    }
    hub.ptys.write(w.pty, data.as_bytes()).map_err(gone)?;
    Ok(axum::Json(json!({ "sent": true })))
}

async fn wait(State(hub): State<Arc<AgentWindows>>, headers: HeaderMap, Path(id): Path<String>, axum::Json(body): axum::Json<WaitBody>) -> Reply {
    let c = caller(&hub, &headers)?;
    let w = window_of(&hub, &c, &id)?;
    if body.pattern.is_empty() {
        return Err(fail(StatusCode::BAD_REQUEST, "pattern is empty"));
    }
    let limit = Duration::from_secs(body.timeout_secs.unwrap_or(60)).min(MAX_WAIT);
    // Only output that arrives after the call counts, so an old "ready" doesn't match.
    let (_, start) = hub.ptys.snapshot(w.pty).map_err(gone)?;
    let deadline = Instant::now() + limit;
    loop {
        let (bytes, total) = hub.ptys.snapshot(w.pty).map_err(gone)?;
        let matched = plain(fresh(&bytes, total.saturating_sub(start))).contains(&body.pattern);
        if matched || Instant::now() >= deadline {
            return Ok(axum::Json(json!({ "matched": matched, "output": last_lines(&plain(&bytes), LINES) })));
        }
        tokio::time::sleep(POLL).await;
    }
}

async fn close(State(hub): State<Arc<AgentWindows>>, headers: HeaderMap, Path(id): Path<String>) -> Reply {
    let c = caller(&hub, &headers)?;
    let w = window_of(&hub, &c, &id)?;
    if !w.by_agent {
        return Err(fail(StatusCode::FORBIDDEN, "you opened this window; an agent can only close windows it opened"));
    }
    hub.app
        .emit("agent-close", json!({ "project": w.project, "tab": w.tab }))
        .map_err(|e| fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(axum::Json(json!({ "closed": true })))
}

fn router(hub: Arc<AgentWindows>) -> Router {
    Router::new()
        .route("/v1/windows", get(list).post(open))
        .route("/v1/windows/{id}", get(status).delete(close))
        .route("/v1/windows/{id}/output", get(output))
        .route("/v1/windows/{id}/input", axum::routing::post(input))
        .route("/v1/windows/{id}/wait", axum::routing::post(wait))
        .with_state(hub)
}

/// Starts the endpoint on 127.0.0.1. If the port is taken, agent windows are off and the app runs on.
pub fn serve(hub: Arc<AgentWindows>) {
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("agent windows: couldn't listen on port {PORT}: {e}");
                return;
            }
        };
        let _ = axum::serve(listener, router(hub)).await;
    });
}

/// The Commands an agent may open, per project, from the Commands Window.
#[tauri::command]
pub fn agent_allowed(hub: tauri::State<'_, Arc<AgentWindows>>, allowed: HashMap<String, Vec<Allowed>>) {
    hub.reg.lock().unwrap().set_allowed(allowed);
}

/// An open the webview refused (the Command is no longer allowed): the agent gets the reason.
#[tauri::command]
pub fn agent_open_failed(hub: tauri::State<'_, Arc<AgentWindows>>, req: String, error: String) {
    hub.resolve(&req, Err(error));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(project: &str, tab: &str) -> Owner {
        Owner { project: project.into(), tab: tab.into(), name: "shell".into(), by: None, req: None }
    }

    #[test]
    fn strips_escapes_and_carriage_returns() {
        assert_eq!(plain(b"\x1b[31mhello\x1b[0m\r\nworld"), "hello\nworld");
        assert_eq!(plain(b"\x1b]0;title\x07done"), "done");
        assert_eq!(plain(b"\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"), "link");
        assert_eq!(plain(b"\x1b7saved\x1b8"), "saved");
    }

    #[test]
    fn last_lines_drops_trailing_newlines() {
        assert_eq!(last_lines("a\nb\nc\n\n", 2), "b\nc");
        assert_eq!(last_lines("a", 5), "a");
    }

    #[test]
    fn fresh_takes_the_newest_bytes() {
        assert_eq!(fresh(b"abcdef", 2), b"ef");
        assert_eq!(fresh(b"abc", 0), b"");
        assert_eq!(fresh(b"abc", 9), b"abc");
    }

    #[test]
    fn windows_are_visible_only_within_their_project() {
        let mut r = Registry::default();
        r.issue(&owner("tri", "t1"), 1, "tok-a".into());
        r.issue(&owner("tri-wt", "t2"), 2, "tok-b".into());
        let a = r.caller("tok-a").unwrap();
        assert!(r.window(&a, "t1").is_some());
        assert!(r.window(&a, "t2").is_none());
        assert_eq!(r.windows_of("tri").count(), 1);
        assert!(r.caller("nope").is_none());
    }

    #[test]
    fn an_exit_forgets_only_its_own_pty() {
        let mut r = Registry::default();
        r.issue(&owner("tri", "t1"), 1, "tok-a".into());
        // The tab respawned before the old PTY's exit arrived.
        r.issue(&owner("tri", "t1"), 3, "tok-c".into());
        r.forget("t1", 1);
        assert!(r.caller("tok-a").is_none());
        assert!(r.caller("tok-c").is_some());
        r.forget("t1", 3);
        assert!(r.caller("tok-c").is_none());
    }

    #[test]
    fn allowed_commands_are_matched_by_name_within_the_project() {
        let mut r = Registry::default();
        let mut map = HashMap::new();
        map.insert("tri".to_string(), vec![Allowed { id: "dev".into(), name: "Dev server".into() }]);
        r.set_allowed(map);
        assert_eq!(r.allowed("tri", "dev server").map(|a| a.id.as_str()), Some("dev"));
        assert!(r.allowed("tri-wt", "Dev server").is_none());
        assert!(r.allowed("tri", "  ").is_none());
    }
}
