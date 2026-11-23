//! Remote Control: tri-code on your phone. While it is on, a small web server serves the phone
//! page (`phone/`) and a WebSocket. How a phone reaches it is the user's pick (`Reach`): by
//! default it listens on 127.0.0.1 and `tailscale serve` puts it on the tailnet over HTTPS, which
//! Web Push needs; or it listens on the local network over plain HTTP (no pushes); or only on
//! 127.0.0.1, for a tunnel or reverse proxy of the user's own. The port is theirs to change too.
//!
//! The frontend owns the projects, their windows and signals; it sends a snapshot here
//! (`phone_snapshot`) whenever it changes, the last lines of each terminal's screen for the
//! window tiles (`phone_tails`) while a phone is connected, and asks for a push when a signal
//! alerts (`phone_push`). Terminal output and input go straight between the phone and the PTY.
//!
//! A phone pairs once with a short code from Settings › Remote and keeps a device token;
//! only the token's hash is stored, beside the VAPID key, in `phone.json`. So is whether it is
//! on, so it comes back on with the app (kept here, not in state.json, which every tri-code
//! running on the machine rewrites).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use p256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::pty::Ptys;
use crate::push::{self, PushError, Subscription};

/// Where the server listens, and the tailnet HTTPS port `tailscale serve` maps to it, unless
/// Settings › Remote picks others. Not 443, which is often serving something else on the machine.
const PORT: u16 = 7520;
const TS_PORT: u16 = 7443;

/// How a phone reaches the server.
#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reach {
    /// On 127.0.0.1, put on the tailnet over HTTPS by `tailscale serve`.
    #[default]
    Tailscale,
    /// On every interface over plain HTTP: the phone uses this computer's LAN address. No pushes.
    Lan,
    /// On 127.0.0.1 only, for the user's own tunnel or reverse proxy (`address` is what it gives).
    Local,
}
const PAIR_TTL: Duration = Duration::from_secs(10 * 60);
const PAIR_TRIES: u32 = 5;

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    name: String,
    /// SHA-256 of the device token, hex.
    token: String,
    added: u64,
    seen: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    push: Option<Subscription>,
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    /// Turned on and not turned off since: the frontend starts it again at launch.
    #[serde(default)]
    on: bool,
    /// The VAPID private key, base64url.
    vapid: Option<String>,
    devices: Vec<Device>,
    #[serde(default)]
    reach: Reach,
    /// The port it listens on; unset is PORT.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    /// The tailnet HTTPS port; unset is TS_PORT.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ts_port: Option<u16>,
    /// `Reach::Local`: the address the user's tunnel or proxy gives, shown and put in pair links.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    address: Option<String>,
}

/// The server while it runs: its address, how to stop it, and the tailnet port it serves on (to
/// take down when it stops, even after Settings picked another).
struct Running {
    url: String,
    shutdown: oneshot::Sender<()>,
    ts_port: Option<u16>,
}

struct Pairing {
    code: String,
    until: Instant,
    tries: u32,
}

struct Inner {
    saved: Saved,
    vapid: SigningKey,
    pairing: Option<Pairing>,
    running: Option<Running>,
    /// Phones watching each PTY. While any are, the PTY has the phone's size.
    holds: HashMap<u32, usize>,
    /// Open sockets per device.
    online: HashMap<String, usize>,
    /// Questions passed to the frontend (`phone-ask`), by id: the socket that asked and its own
    /// number for the question, which the answer goes back with.
    asks: HashMap<u64, (mpsc::UnboundedSender<Message>, u64)>,
    next_ask: u64,
}

pub struct Phone {
    app: AppHandle,
    ptys: Arc<Ptys>,
    inner: Mutex<Inner>,
    /// The frontend's latest snapshot of projects and windows (JSON), sent to every phone on change.
    snapshot: watch::Sender<String>,
    /// The last lines of each terminal's screen by tab id (JSON), sent to every phone on change.
    tails: watch::Sender<String>,
    /// Ends sockets: `None` all of them (server stopped), `Some(id)` one device's (forgotten).
    kick: broadcast::Sender<Option<String>>,
}

#[derive(Serialize)]
pub struct DeviceView {
    id: String,
    name: String,
    added: u64,
    seen: u64,
    online: bool,
    push: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    url: Option<String>,
    /// Should be serving: on at launch, or retrying while Tailscale isn't up yet.
    on: bool,
    devices: Vec<DeviceView>,
    reach: Reach,
    port: u16,
    ts_port: u16,
    address: String,
}

/// What Settings › Remote can change.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    reach: Reach,
    port: u16,
    ts_port: u16,
    address: String,
}

#[derive(Serialize)]
pub struct PairInfo {
    code: String,
    url: String,
    qr: String,
    seconds: u64,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn random(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("os random");
    b
}

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Pair codes are typed on a phone: no 0/O, 1/I/L.
fn pair_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    random(6).iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

fn saved_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("phone.json"))
}

impl Phone {
    pub fn new(app: AppHandle, ptys: Arc<Ptys>) -> Arc<Self> {
        let saved: Saved = saved_file(&app)
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let vapid = push::vapid_key(saved.vapid.as_deref());
        let phone = Arc::new(Self {
            app,
            ptys,
            inner: Mutex::new(Inner {
                saved,
                vapid,
                pairing: None,
                running: None,
                holds: HashMap::new(),
                online: HashMap::new(),
                asks: HashMap::new(),
                next_ask: 0,
            }),
            snapshot: watch::channel(r#"{"envs":[],"pinned":[],"projects":[]}"#.to_string()).0,
            tails: watch::channel("{}".to_string()).0,
            kick: broadcast::channel(16).0,
        });
        let mut inner = phone.inner.lock().unwrap();
        if inner.saved.vapid.is_none() {
            inner.saved.vapid = Some(push::vapid_private(&inner.vapid));
            phone.save(&inner);
        }
        drop(inner);
        phone
    }

    fn save(&self, inner: &Inner) {
        let write = || -> Result<(), String> {
            let path = saved_file(&self.app)?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_string_pretty(&inner.saved).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
        };
        if let Err(e) = write() {
            eprintln!("phone.json: {e}");
        }
    }

    /// Tell the frontend to re-read the status (a phone paired, came online, subscribed, ...).
    fn changed(&self) {
        let _ = self.app.emit("phone-changed", ());
    }

    fn status(&self) -> Status {
        let inner = self.inner.lock().unwrap();
        Status {
            url: inner.running.as_ref().map(|r| r.url.clone()),
            on: inner.saved.on,
            reach: inner.saved.reach,
            port: inner.saved.port.unwrap_or(PORT),
            ts_port: inner.saved.ts_port.unwrap_or(TS_PORT),
            address: inner.saved.address.clone().unwrap_or_default(),
            devices: inner
                .saved
                .devices
                .iter()
                .map(|d| DeviceView {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    added: d.added,
                    seen: d.seen,
                    online: inner.online.get(&d.id).is_some_and(|n| *n > 0),
                    push: d.push.is_some(),
                })
                .collect(),
        }
    }

    /// The device a token belongs to; marks it seen.
    fn device(&self, token: &str) -> Option<String> {
        let h = hash(token);
        let mut inner = self.inner.lock().unwrap();
        let d = inner.saved.devices.iter_mut().find(|d| d.token == h)?;
        d.seen = now();
        let id = d.id.clone();
        self.save(&inner);
        Some(id)
    }

    fn online(&self, device: &str, delta: isize) {
        let mut inner = self.inner.lock().unwrap();
        let n = inner.online.entry(device.to_string()).or_default();
        *n = n.saturating_add_signed(delta);
        drop(inner);
        self.changed();
    }

    /// A phone starts watching a PTY: it takes the phone's size until the last phone lets go.
    fn hold(&self, pty: u32, cols: u16, rows: u16) {
        let mut inner = self.inner.lock().unwrap();
        let n = inner.holds.entry(pty).or_default();
        *n += 1;
        let first = *n == 1;
        drop(inner);
        if first {
            let _ = self.app.emit("phone-hold", serde_json::json!({ "pty": pty, "held": true }));
        }
        if cols > 0 && rows > 0 {
            let _ = self.ptys.resize(pty, cols, rows);
        }
    }

    /// The frontend puts the desktop size back once no phone holds the PTY.
    fn release(&self, pty: u32) {
        let mut inner = self.inner.lock().unwrap();
        let Some(n) = inner.holds.get_mut(&pty) else { return };
        *n -= 1;
        let last = *n == 0;
        if last {
            inner.holds.remove(&pty);
        }
        drop(inner);
        if last {
            let _ = self.app.emit("phone-hold", serde_json::json!({ "pty": pty, "held": false }));
        }
    }

    fn stop(&self) {
        let running = self.inner.lock().unwrap().running.take();
        if let Some(r) = running {
            let _ = r.shutdown.send(());
            let _ = self.kick.send(None);
            if let Some(ts_port) = r.ts_port
                && let Err(e) = tailscale_off(ts_port)
            {
                eprintln!("tailscale serve off: {e}");
            }
        }
    }

    /// App exit: take the tailnet port down so it doesn't point at nothing.
    pub fn shutdown(&self) {
        self.stop();
    }
}

// ---------- tailscale ----------

fn tailscale() -> Command {
    let mut program = "tailscale".to_string();
    for p in [r"C:\Program Files\Tailscale\tailscale.exe", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] {
        if std::path::Path::new(p).exists() {
            program = p.to_string();
        }
    }
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run tailscale with `args`, giving up after `limit`: `serve` waits for you to enable Serve
/// in the admin console when it isn't yet, and prints the link to do it.
fn run_tailscale(args: &[&str], limit: Duration) -> Result<String, String> {
    let mut child = tailscale().args(args).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Tailscale isn't installed: get it from tailscale.com/download, on this computer and your phone".to_string()
        } else {
            e.to_string()
        }
    })?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let read_out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut out, &mut s);
        s
    });
    let read_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut err, &mut s);
        s
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(s);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let text = format!("{}{}", read_out.join().unwrap_or_default(), read_err.join().unwrap_or_default());
    match status {
        Some(s) if s.success() => Ok(text),
        Some(_) => Err(text.trim().to_string()),
        None => Err(format!("tailscale didn't finish: {}", text.trim())),
    }
}

/// This machine's tailnet name, e.g. `laptop.tail1234.ts.net`.
fn tailnet_name() -> Result<String, String> {
    let json = run_tailscale(&["status", "--json"], Duration::from_secs(10))?;
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if v["BackendState"] != "Running" {
        return Err("Tailscale isn't connected: sign in and connect it on this computer".to_string());
    }
    let name = v["Self"]["DNSName"].as_str().unwrap_or("").trim_end_matches('.');
    if name.is_empty() {
        return Err("Tailscale has no name for this computer: turn on MagicDNS for your tailnet".to_string());
    }
    Ok(name.to_string())
}

fn tailscale_on(port: u16, ts_port: u16) -> Result<String, String> {
    let name = tailnet_name()?;
    let https = format!("--https={ts_port}");
    let target = format!("http://127.0.0.1:{port}");
    run_tailscale(&["serve", "--bg", &https, &target], Duration::from_secs(20)).map_err(|e| {
        if e.contains("login.tailscale.com") || e.to_lowercase().contains("not enabled") {
            format!("Turn on Serve and HTTPS certificates for your tailnet, then try again: {e}")
        } else {
            e
        }
    })?;
    Ok(format!("https://{name}:{ts_port}"))
}

fn tailscale_off(ts_port: u16) -> Result<(), String> {
    run_tailscale(&["serve", &format!("--https={ts_port}"), "off"], Duration::from_secs(10)).map(|_| ())
}

/// This computer's address on the local network: the one the OS would send from to reach the
/// internet. A UDP connect only picks the route; nothing is sent.
fn lan_ip() -> Result<std::net::IpAddr, String> {
    let none = || "This computer isn't on a network: connect to Wi-Fi or Ethernet, or use Tailscale".to_string();
    let socket = std::net::UdpSocket::bind(("0.0.0.0", 0)).map_err(|_| none())?;
    socket.connect(("8.8.8.8", 80)).map_err(|_| none())?;
    let ip = socket.local_addr().map_err(|_| none())?.ip();
    if ip.is_unspecified() { Err(none()) } else { Ok(ip) }
}

// ---------- the web server ----------

type Shared = Arc<Phone>;

fn asset(content_type: &'static str, body: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "no-cache")], body).into_response()
}

fn router(phone: Shared) -> Router {
    Router::new()
        .route("/", get(|| async { asset("text/html; charset=utf-8", include_bytes!("../phone/index.html")) }))
        .route("/app.js", get(|| async { asset("text/javascript", include_bytes!("../phone/app.js")) }))
        .route("/app.css", get(|| async { asset("text/css", include_bytes!("../phone/app.css")) }))
        .route("/sw.js", get(|| async { asset("text/javascript", include_bytes!("../phone/sw.js")) }))
        .route("/icon.png", get(|| async { asset("image/png", include_bytes!("../icons/icon.png")) }))
        .route("/icon.svg", get(|| async { asset("image/svg+xml", include_bytes!("../../assets/icon.svg")) }))
        .route("/icon-192.png", get(|| async { asset("image/png", include_bytes!("../icons/phone-192.png")) }))
        .route("/icon-maskable.png", get(|| async { asset("image/png", include_bytes!("../icons/phone-maskable.png")) }))
        .route("/apple-touch-icon.png", get(|| async { asset("image/png", include_bytes!("../icons/phone-apple-touch.png")) }))
        .route("/badge.png", get(|| async { asset("image/png", include_bytes!("../icons/phone-badge.png")) }))
        .route("/xterm.js", get(|| async { asset("text/javascript", include_bytes!("../../node_modules/@xterm/xterm/lib/xterm.js")) }))
        .route("/xterm.css", get(|| async { asset("text/css", include_bytes!("../../node_modules/@xterm/xterm/css/xterm.css")) }))
        .route("/addon-fit.js", get(|| async { asset("text/javascript", include_bytes!("../../node_modules/@xterm/addon-fit/lib/addon-fit.js")) }))
        .route("/manifest.webmanifest", get(manifest))
        .route("/api/pair", post(pair))
        .route("/api/push", post(subscribe))
        .route("/api/ws", get(socket))
        .with_state(phone)
}

#[derive(Deserialize)]
struct PairQuery {
    pair: Option<String>,
}

/// The pair code rides along in `start_url`: on iOS a Home Screen app has its own storage, so
/// it pairs on its first launch rather than in the Safari tab it was added from. A fixed `id`
/// keeps that varying `start_url` from making each pairing a different app. Android Chrome only
/// installs it as a real app (its notifications under tri-code, not Chrome) with 192 and 512
/// icons, and the maskable one stops Android framing the rounded icon in a white circle.
async fn manifest(Query(q): Query<PairQuery>) -> Response {
    let code: String = q.pair.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    let start = if code.is_empty() { "/".to_string() } else { format!("/?pair={code}") };
    let body = serde_json::json!({
        "id": "/",
        "name": "tri-code",
        "short_name": "tri-code",
        "start_url": start,
        "scope": "/",
        "display": "standalone",
        "background_color": "#0e0f12",
        "theme_color": "#0e0f12",
        "icons": [
            { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
            { "src": "/icon.png", "sizes": "512x512", "type": "image/png" },
            { "src": "/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
        ],
    });
    ([(header::CONTENT_TYPE, "application/manifest+json")], body.to_string()).into_response()
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
    name: String,
}

async fn pair(State(phone): State<Shared>, axum::Json(b): axum::Json<PairBody>) -> Response {
    let code: String = b.code.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase();
    let mut inner = phone.inner.lock().unwrap();
    let ok = match inner.pairing.as_mut() {
        Some(p) if p.until > Instant::now() && p.tries < PAIR_TRIES => {
            if p.code == code {
                true
            } else {
                p.tries += 1;
                false
            }
        }
        _ => false,
    };
    if !ok {
        let gone = inner.pairing.as_ref().is_none_or(|p| p.until <= Instant::now() || p.tries >= PAIR_TRIES);
        let why = if gone { "That code has expired. Pair again from Settings › Remote in tri-code." } else { "That code is wrong." };
        return (StatusCode::FORBIDDEN, why).into_response();
    }
    inner.pairing = None;
    let token = B64.encode(random(32));
    let id: String = random(4).iter().map(|b| format!("{b:02x}")).collect();
    let name: String = b.name.chars().take(60).collect();
    inner.saved.devices.push(Device { id, name, token: hash(&token), added: now(), seen: now(), push: None });
    phone.save(&inner);
    let vapid = push::vapid_public(&inner.vapid);
    drop(inner);
    let _ = phone.app.emit("phone-paired", ());
    phone.changed();
    axum::Json(serde_json::json!({ "token": token, "vapid": vapid })).into_response()
}

fn bearer(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
}

async fn subscribe(State(phone): State<Shared>, headers: HeaderMap, axum::Json(sub): axum::Json<Subscription>) -> Response {
    let Some(id) = phone.device(bearer(&headers)) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let mut inner = phone.inner.lock().unwrap();
    if let Some(d) = inner.saved.devices.iter_mut().find(|d| d.id == id) {
        d.push = Some(sub);
    }
    phone.save(&inner);
    drop(inner);
    phone.changed();
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

async fn socket(State(phone): State<Shared>, Query(q): Query<WsQuery>, ws: WebSocketUpgrade) -> Response {
    // Upgrade either way: a browser can't read why a refused upgrade failed, but it can read a message.
    let device = phone.device(&q.token);
    ws.on_upgrade(move |socket| serve_socket(phone, socket, device))
}

/// What a phone sends over the socket.
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum FromPhone {
    /// Show a PTY: its recent output, then live output; take the phone's size.
    Watch { pty: u32, cols: u16, rows: u16 },
    /// The phone's terminal changed size (rotation, keyboard).
    Size { cols: u16, rows: u16 },
    Unwatch,
    Input { pty: u32, data: String },
    /// A question for the frontend (phoneask.ts): open a window, a project's git changes, a diff,
    /// a folder or a file. The answer comes back as `{"t":"reply","req":<req>,"data":...}`.
    Ask { req: u64, q: serde_json::Value },
}

fn text(v: serde_json::Value) -> Message {
    Message::Text(v.to_string().into())
}

/// `{"t":<t>,"data":<json>}` around JSON the frontend already made (checked when it came in).
fn raw(t: &str, json: &str) -> Message {
    Message::Text(format!(r#"{{"t":"{t}","data":{json}}}"#).into())
}

/// Output of `pty`: its id (big-endian u32), then the bytes, so output that was in flight when
/// the phone switched agents can be told apart.
fn output(pty: u32, bytes: &[u8]) -> Message {
    let mut frame = Vec::with_capacity(4 + bytes.len());
    frame.extend_from_slice(&pty.to_be_bytes());
    frame.extend_from_slice(bytes);
    Message::Binary(frame.into())
}

async fn serve_socket(phone: Shared, mut ws: WebSocket, device: Option<String>) {
    let Some(device) = device else {
        let _ = ws.send(text(serde_json::json!({ "t": "bye", "why": "forgotten" }))).await;
        return;
    };
    let mut kick = phone.kick.subscribe();
    let mut snapshot = phone.snapshot.subscribe();
    let mut tails = phone.tails.subscribe();
    phone.online(&device, 1);
    let vapid = push::vapid_public(&phone.inner.lock().unwrap().vapid);
    let hello = serde_json::json!({ "t": "hello", "vapid": vapid });
    let first = snapshot.borrow_and_update().clone();
    let first_tails = tails.borrow_and_update().clone();
    let mut watching: Option<(u32, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>)> = None;
    let (replies_tx, mut replies) = mpsc::unbounded_channel::<Message>();

    if ws.send(text(hello)).await.is_ok()
        && ws.send(raw("snap", &first)).await.is_ok()
        && ws.send(raw("tails", &first_tails)).await.is_ok()
    {
        loop {
            tokio::select! {
                msg = ws.recv() => {
                    let t = match msg {
                        Some(Ok(Message::Text(t))) => t,
                        Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                        Some(Ok(_)) => continue,
                    };
                    let Ok(cmd) = serde_json::from_str::<FromPhone>(t.as_str()) else { continue };
                    match cmd {
                        FromPhone::Watch { pty, cols, rows } => {
                            if let Some((old, _)) = watching.take() {
                                phone.release(old);
                            }
                            match phone.ptys.watch(pty) {
                                Ok((recent, rx)) => {
                                    phone.hold(pty, cols, rows);
                                    watching = Some((pty, rx));
                                    if ws.send(output(pty, &recent)).await.is_err() { break }
                                }
                                Err(_) => {
                                    if ws.send(text(serde_json::json!({ "t": "exit", "pty": pty }))).await.is_err() { break }
                                }
                            }
                        }
                        FromPhone::Size { cols, rows } => {
                            if let Some((pty, _)) = &watching {
                                let _ = phone.ptys.resize(*pty, cols, rows);
                            }
                        }
                        FromPhone::Unwatch => {
                            if let Some((old, _)) = watching.take() {
                                phone.release(old);
                            }
                        }
                        FromPhone::Input { pty, data } => {
                            let _ = phone.ptys.write(pty, data.as_bytes());
                        }
                        FromPhone::Ask { req, q } => {
                            let mut inner = phone.inner.lock().unwrap();
                            inner.next_ask += 1;
                            let id = inner.next_ask;
                            inner.asks.insert(id, (replies_tx.clone(), req));
                            drop(inner);
                            let _ = phone.app.emit("phone-ask", serde_json::json!({ "id": id, "q": q }));
                        }
                    }
                }
                Some(reply) = replies.recv() => {
                    if ws.send(reply).await.is_err() { break }
                }
                chunk = async {
                    match watching.as_mut() {
                        Some((_, rx)) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    let pty = watching.as_ref().map(|(p, _)| *p).unwrap_or_default();
                    match chunk {
                        Some(bytes) => if ws.send(output(pty, &bytes)).await.is_err() { break },
                        None => {
                            watching = None;
                            phone.release(pty);
                            if ws.send(text(serde_json::json!({ "t": "exit", "pty": pty }))).await.is_err() { break }
                        }
                    }
                }
                changed = snapshot.changed() => {
                    if changed.is_err() { break }
                    let data = snapshot.borrow_and_update().clone();
                    if ws.send(raw("snap", &data)).await.is_err() { break }
                }
                changed = tails.changed() => {
                    if changed.is_err() { break }
                    let data = tails.borrow_and_update().clone();
                    if ws.send(raw("tails", &data)).await.is_err() { break }
                }
                who = kick.recv() => {
                    match who {
                        Ok(Some(id)) if id != device => continue,
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Ok(Some(_)) => {
                            let _ = ws.send(text(serde_json::json!({ "t": "bye", "why": "forgotten" }))).await;
                            break;
                        }
                        _ => {
                            let _ = ws.send(text(serde_json::json!({ "t": "bye", "why": "stopped" }))).await;
                            break;
                        }
                    }
                }
            }
        }
    }
    if let Some((pty, _)) = watching {
        phone.release(pty);
    }
    // Questions still out for this socket have nowhere to go.
    phone.inner.lock().unwrap().asks.retain(|_, (tx, _)| !tx.same_channel(&replies_tx));
    phone.online(&device, -1);
}

// ---------- commands ----------

/// Start serving the way Settings › Remote says: listen, then make the address a phone uses.
async fn start(phone: Shared) -> Result<Status, String> {
    if phone.inner.lock().unwrap().running.is_some() {
        return Ok(phone.status());
    }
    let (reach, port, ts_port, address) = {
        let inner = phone.inner.lock().unwrap();
        let s = &inner.saved;
        (s.reach, s.port.unwrap_or(PORT), s.ts_port.unwrap_or(TS_PORT), s.address.clone().unwrap_or_default())
    };
    let host = if reach == Reach::Lan { std::net::Ipv4Addr::UNSPECIFIED } else { std::net::Ipv4Addr::LOCALHOST };
    let listener = tokio::net::TcpListener::bind((host, port)).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("Port {port} is in use by another program: pick another port below")
        } else {
            format!("couldn't listen on port {port}: {e}")
        }
    })?;
    let (tx, rx) = oneshot::channel::<()>();
    let app = router(Arc::clone(&phone));
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(async { let _ = rx.await; }).await;
    });
    let url = match reach {
        Reach::Tailscale => tauri::async_runtime::spawn_blocking(move || tailscale_on(port, ts_port)).await.map_err(|e| e.to_string()).and_then(|r| r),
        Reach::Lan => lan_ip().map(|ip| format!("http://{ip}:{port}")),
        Reach::Local => Ok(if address.is_empty() { format!("http://127.0.0.1:{port}") } else { address }),
    };
    match url {
        Ok(url) => {
            let mut inner = phone.inner.lock().unwrap();
            inner.running = Some(Running { url, shutdown: tx, ts_port: (reach == Reach::Tailscale).then_some(ts_port) });
            inner.saved.on = true;
            phone.save(&inner);
            drop(inner);
            phone.changed();
            Ok(phone.status())
        }
        Err(e) => {
            let _ = tx.send(());
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn phone_start(phone: tauri::State<'_, Arc<Phone>>) -> Result<Status, String> {
    start(Arc::clone(phone.inner())).await
}

/// Settings › Remote changed how phones reach it or its ports: save, and serve again that way if
/// it was serving.
#[tauri::command]
pub async fn phone_config(phone: tauri::State<'_, Arc<Phone>>, config: Config) -> Result<Status, String> {
    if config.port < 1024 {
        return Err("Pick a port from 1024 to 65535".to_string());
    }
    if config.ts_port == 0 {
        return Err("Pick a tailnet port from 1 to 65535".to_string());
    }
    let address = config.address.trim().trim_end_matches('/').to_string();
    if !address.is_empty() && !(address.starts_with("http://") || address.starts_with("https://")) {
        return Err("The address starts with https:// (or http://)".to_string());
    }
    let phone = Arc::clone(phone.inner());
    let serving = {
        let mut inner = phone.inner.lock().unwrap();
        let s = &mut inner.saved;
        s.reach = config.reach;
        s.port = (config.port != PORT).then_some(config.port);
        s.ts_port = (config.ts_port != TS_PORT).then_some(config.ts_port);
        s.address = (!address.is_empty()).then_some(address);
        inner.pairing = None;
        phone.save(&inner);
        inner.running.is_some()
    };
    phone.changed();
    if !serving {
        return Ok(phone.status());
    }
    let stopping = Arc::clone(&phone);
    tauri::async_runtime::spawn_blocking(move || stopping.stop()).await.map_err(|e| e.to_string())?;
    start(phone).await
}

#[tauri::command]
pub async fn phone_stop(phone: tauri::State<'_, Arc<Phone>>) -> Result<(), String> {
    let phone = Arc::clone(phone.inner());
    tauri::async_runtime::spawn_blocking(move || {
        phone.stop();
        let mut inner = phone.inner.lock().unwrap();
        inner.saved.on = false;
        phone.save(&inner);
        drop(inner);
        phone.changed();
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn phone_status(phone: tauri::State<'_, Arc<Phone>>) -> Status {
    phone.status()
}

/// A new pair code, with the link and its QR code (SVG).
#[tauri::command]
pub fn phone_pair(phone: tauri::State<'_, Arc<Phone>>) -> Result<PairInfo, String> {
    let mut inner = phone.inner.lock().unwrap();
    let base = inner.running.as_ref().map(|r| r.url.clone()).ok_or("Remote control is off")?;
    let code = pair_code();
    let url = format!("{base}/?pair={code}");
    let qr = qrcode::QrCode::new(url.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(180, 180)
        .quiet_zone(true)
        .build();
    inner.pairing = Some(Pairing { code: code.clone(), until: Instant::now() + PAIR_TTL, tries: 0 });
    Ok(PairInfo { code, url, qr, seconds: PAIR_TTL.as_secs() })
}

#[tauri::command]
pub fn phone_forget(phone: tauri::State<'_, Arc<Phone>>, id: String) {
    let mut inner = phone.inner.lock().unwrap();
    inner.saved.devices.retain(|d| d.id != id);
    phone.save(&inner);
    drop(inner);
    let _ = phone.kick.send(Some(id));
    phone.changed();
}

/// The frontend's snapshot of projects and windows, already JSON; phones get it as is.
#[tauri::command]
pub fn phone_snapshot(phone: tauri::State<'_, Arc<Phone>>, json: String) {
    if serde_json::from_str::<serde_json::Value>(&json).is_ok() {
        phone.snapshot.send_replace(json);
    }
}

/// The frontend's answer to a phone's question (`phone-ask`), already JSON.
#[tauri::command]
pub fn phone_reply(phone: tauri::State<'_, Arc<Phone>>, id: u64, json: String) {
    if serde_json::from_str::<serde_json::Value>(&json).is_err() {
        return;
    }
    if let Some((tx, req)) = phone.inner.lock().unwrap().asks.remove(&id) {
        let _ = tx.send(Message::Text(format!(r#"{{"t":"reply","req":{req},"data":{json}}}"#).into()));
    }
}

/// The last lines of each terminal's screen, already JSON; phones draw them in the window tiles.
#[tauri::command]
pub fn phone_tails(phone: tauri::State<'_, Arc<Phone>>, json: String) {
    if serde_json::from_str::<serde_json::Value>(&json).is_ok() {
        phone.tails.send_replace(json);
    }
}

/// Push a signal to every phone that allowed notifications. `tab` is what a tap opens. Fails with
/// the push services' answers when no phone took it.
#[tauri::command]
pub async fn phone_push(phone: tauri::State<'_, Arc<Phone>>, title: String, body: String, tab: String) -> Result<(), String> {
    let phone = Arc::clone(phone.inner());
    let (key, targets) = {
        let inner = phone.inner.lock().unwrap();
        if inner.running.is_none() {
            return Ok(());
        }
        let targets: Vec<_> = inner.saved.devices.iter().filter_map(|d| Some((d.id.clone(), d.push.clone()?))).collect();
        (inner.vapid.clone(), targets)
    };
    let payload = serde_json::json!({ "title": title, "body": body, "tab": tab }).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut gone = vec![];
        let mut errors = vec![];
        let mut sent = 0;
        for (id, sub) in targets {
            match push::send(&key, &sub, &payload) {
                Ok(()) => sent += 1,
                Err(PushError::Gone) => gone.push(id),
                Err(PushError::Other(e)) => errors.push(e),
            }
        }
        if !gone.is_empty() {
            let mut inner = phone.inner.lock().unwrap();
            for d in inner.saved.devices.iter_mut().filter(|d| gone.contains(&d.id)) {
                d.push = None;
            }
            phone.save(&inner);
            drop(inner);
            phone.changed();
        }
        if sent == 0 && !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
