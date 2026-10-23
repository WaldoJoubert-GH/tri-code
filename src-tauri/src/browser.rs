//! Native browser panes: child webviews embedded in the main window and tiled
//! by the frontend. Coordinates are logical pixels relative to the main window.

use std::path::PathBuf;

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl};

#[derive(Clone, Serialize)]
struct NavPayload {
    label: String,
    url: String,
    loading: bool,
}

#[derive(Clone, Serialize)]
struct OpenPayload {
    label: String,
    url: String,
    /// Ctrl/Cmd+click or middle-click: open behind the current page.
    background: bool,
}

#[derive(Clone, Serialize)]
struct PickPayload {
    label: String,
    /// The selection described for the agent, ready to type.
    text: String,
    /// Ctrl+Enter: type and submit.
    send: bool,
}

#[derive(Clone, Serialize)]
struct TitlePayload {
    label: String,
    title: String,
}

/// Ctrl/Cmd+click and middle-click reach on_new_window looking the same as target=_blank, so
/// the page reports them as a navigation to this host instead, which on_navigation cancels:
/// `/open?u=` for a background page, `/pick?send=&d=` for a Select element result.
const BG_HOST: &str = "tricode.invalid";

/// Select element: dormant until browser_pick starts it.
const PICK_SCRIPT: &str = include_str!("pick.js");

/// Injected into every page: turns a modified or middle click on a link into a BG_HOST navigation.
const LINK_SCRIPT: &str = r#"(() => {
  const open = (e) => {
    if (!(e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey)))) return;
    const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement);
    if (!a || !/^https?:/.test(a.href) || a.hasAttribute("download")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.href = "https://tricode.invalid/open?u=" + encodeURIComponent(a.href);
  };
  addEventListener("click", open, true);
  addEventListener("auxclick", open, true);
})();"#;

fn is_web(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// Parses a URL; an empty string means `about:blank`.
fn parse_url(url: &str) -> Result<Url, String> {
    let url = url.trim();
    let url = if url.is_empty() { "about:blank" } else { url };
    Url::parse(url).map_err(|e| format!("invalid url {url}: {e}"))
}

fn find(app: &AppHandle, label: &str) -> Result<Webview, String> {
    app.get_webview(label).ok_or_else(|| format!("no browser {label}"))
}

fn set_bounds(webview: &Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    webview.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    webview.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

/// The Browser Profile that keeps the app's own webview data, so nobody is signed out by profiles.
const DEFAULT_PROFILE: &str = "default";

/// A Browser Profile's data folder (cookies, storage, history, saved passwords, autofill):
/// `<app_local_data_dir>/profiles/<id>`, or None for the default profile.
fn profile_dir(app: &AppHandle, profile: &str) -> Result<Option<PathBuf>, String> {
    if profile.is_empty() || profile == DEFAULT_PROFILE {
        return Ok(None);
    }
    if !profile.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid profile id {profile}"));
    }
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(Some(dir.join("profiles").join(profile)))
}

/// WKWebView keeps a profile's data in a store named by 16 bytes rather than a folder.
#[cfg(target_os = "macos")]
fn store_id(profile: &str) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let mut id = [0u8; 16];
    id.copy_from_slice(&Sha256::digest(format!("tri-code profile {profile}"))[..16]);
    id
}

/// WKWebView keeps separate data stores only from macOS 14. Before that wry quietly falls back to
/// the shared store, so profiles other than the default are refused there rather than mixing sign-ins.
#[cfg(target_os = "macos")]
fn stores_supported() -> bool {
    static OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OK.get_or_init(|| {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|v| v.trim().split('.').next()?.parse::<u32>().ok())
            .is_some_and(|major| major >= 14)
    })
}

#[cfg(not(target_os = "macos"))]
fn stores_supported() -> bool {
    true
}

/// Whether this system can keep Browser Profiles apart (false before macOS 14).
#[tauri::command]
pub fn browser_profiles_supported() -> bool {
    stores_supported()
}

/// Waits off the async runtime's threads (tokio here has no timer).
async fn pause(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

/// Form autofill and password saving. WebView2 only: the builder can turn off form autofill,
/// but password saving (off by default) is only reachable through the WebView2 settings.
#[cfg(windows)]
fn set_autofill(webview: &Webview, autofill: bool, passwords: bool) -> Result<(), String> {
    webview
        .with_webview(move |pw| {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
            use windows_core::Interface;
            let set = || -> windows_core::Result<()> {
                // SAFETY: COM calls on the webview's own controller, on the thread with_webview runs us on.
                unsafe {
                    let settings = pw.controller().CoreWebView2()?.Settings()?.cast::<ICoreWebView2Settings4>()?;
                    settings.SetIsGeneralAutofillEnabled(autofill)?;
                    settings.SetIsPasswordAutosaveEnabled(passwords)
                }
            };
            if let Err(e) = set() {
                eprintln!("browser autofill settings failed: {e}");
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn set_autofill(_webview: &Webview, _autofill: bool, _passwords: bool) -> Result<(), String> {
    Ok(())
}

/// Creates the browser webview, or navigates and repositions it if it exists. A `hidden` one
/// loads behind the shown page (a background tab). `profile` is the Browser Profile whose data
/// it uses (unset: the default); `autofill` and `passwords` are that profile's switches.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    hidden: Option<bool>,
    profile: Option<String>,
    autofill: Option<bool>,
    passwords: Option<bool>,
) -> Result<(), String> {
    let url = parse_url(&url)?;
    if let Some(webview) = app.get_webview(&label) {
        webview.navigate(url).map_err(|e| e.to_string())?;
        set_bounds(&webview, x, y, width, height)?;
        let shown = if hidden == Some(true) { webview.hide() } else { webview.show() };
        return shown.map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let nav_app = app.clone();
    let title_app = app.clone();
    let nav_label = label.clone();
    let title_label = label.clone();
    let (bg_app, bg_label) = (app.clone(), label.clone());
    let (new_app, new_label) = (app.clone(), label.clone());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .initialization_script(LINK_SCRIPT)
        .initialization_script(PICK_SCRIPT)
        .on_navigation(move |url| {
            if url.host_str() != Some(BG_HOST) {
                return true;
            }
            let param = |name: &str| {
                url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
            };
            if url.path() == "/pick" {
                let _ = bg_app.emit(
                    "browser-pick",
                    PickPayload {
                        label: bg_label.clone(),
                        text: param("d").unwrap_or_default(),
                        send: param("send").as_deref() == Some("1"),
                    },
                );
                return false;
            }
            let target = param("u").and_then(|u| Url::parse(&u).ok());
            if let Some(target) = target.filter(is_web) {
                let _ = bg_app.emit(
                    "browser-open",
                    OpenPayload {
                        label: bg_label.clone(),
                        url: target.to_string(),
                        background: true,
                    },
                );
            }
            false
        })
        .on_new_window(move |url, features| {
            // Sized popups (OAuth, payments) talk back through window.opener: a real window.
            if features.size().is_some() {
                return NewWindowResponse::Allow;
            }
            if is_web(&url) {
                let _ = new_app.emit(
                    "browser-open",
                    OpenPayload {
                        label: new_label.clone(),
                        url: url.to_string(),
                        background: false,
                    },
                );
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            #[cfg(target_os = "macos")]
            if payload.event() == PageLoadEvent::Finished {
                crate::passwords::page_loaded(&webview, &nav_label, payload.url());
            }
            #[cfg(not(target_os = "macos"))]
            let _ = &webview;
            let _ = nav_app.emit(
                "browser-nav",
                NavPayload {
                    label: nav_label.clone(),
                    url: payload.url().to_string(),
                    loading: payload.event() == PageLoadEvent::Started,
                },
            );
        })
        .on_document_title_changed(move |_webview, title| {
            let _ = title_app.emit("browser-title", TitlePayload { label: title_label.clone(), title });
        });
    let profile = profile.unwrap_or_default();
    let (autofill, passwords) = (autofill.unwrap_or(true), passwords.unwrap_or(true));
    let builder = builder.general_autofill_enabled(autofill);
    let builder = match profile_dir(&app, &profile)? {
        Some(_) if !stores_supported() => return Err("browser profiles need macOS 14 or later".into()),
        #[cfg(target_os = "macos")]
        Some(_) => builder.data_store_identifier(store_id(&profile)),
        #[cfg(not(target_os = "macos"))]
        Some(dir) => builder.data_directory(dir),
        None => builder,
    };
    let webview = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    set_autofill(&webview, autofill, passwords)?;
    #[cfg(target_os = "macos")]
    crate::passwords::install(&app, &webview, &label, &profile, passwords)?;
    if hidden == Some(true) {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Moves and resizes a browser webview (logical pixels).
#[tauri::command]
pub async fn browser_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    set_bounds(&find(&app, &label)?, x, y, width, height)
}

#[tauri::command]
pub async fn browser_show(app: AppHandle, label: String) -> Result<(), String> {
    find(&app, &label)?.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_hide(app: AppHandle, label: String) -> Result<(), String> {
    find(&app, &label)?.hide().map_err(|e| e.to_string())
}

/// Closes a browser webview. A missing one is not an error.
#[tauri::command]
pub async fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    crate::passwords::unwatch(&label);
    match app.get_webview(&label) {
        Some(webview) => webview.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Closes every browser webview. Called by the frontend on load: after a webview reload it no
/// longer knows the old ones, which would stay drawn over the canvas.
#[tauri::command]
pub async fn browser_close_all(app: AppHandle) -> Result<(), String> {
    for (label, webview) in app.webviews() {
        if label.starts_with("browser-") {
            #[cfg(target_os = "macos")]
            crate::passwords::unwatch(&label);
            webview.close().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// A profile's autofill switches changed: apply them to one of its open webviews.
#[tauri::command]
pub async fn browser_autofill(app: AppHandle, label: String, autofill: bool, passwords: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    crate::passwords::set_enabled(&label, passwords);
    set_autofill(&find(&app, &label)?, autofill, passwords)
}

/// Deletes a Browser Profile's data: its folder, or on macOS its WKWebView data store and its
/// saved passwords in the Keychain. Its
/// webviews must be closed first; they let go of the data a moment later, so this retries for a
/// few seconds.
#[tauri::command]
pub async fn browser_profile_erase(app: AppHandle, profile: String) -> Result<(), String> {
    let Some(dir) = profile_dir(&app, &profile)? else {
        return Err("the default profile's data can't be erased".into());
    };
    let mut tries = 0;
    loop {
        match erase(&app, &profile, &dir).await {
            Ok(()) => return Ok(()),
            Err(e) if tries >= 20 => return Err(format!("couldn't erase {profile}'s data: {e}")),
            Err(_) => {
                tries += 1;
                pause(250).await;
            }
        }
    }
}

#[cfg(target_os = "macos")]
async fn erase(app: &AppHandle, profile: &str, _dir: &std::path::Path) -> Result<(), String> {
    crate::passwords::erase(profile)?;
    if !stores_supported() {
        return Ok(()); // no store was ever made
    }
    let id = store_id(profile);
    let stores = app.fetch_data_store_identifiers().await.map_err(|e| e.to_string())?;
    if !stores.contains(&id) {
        return Ok(()); // never opened a page
    }
    app.remove_data_store(id).await.map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
async fn erase(_app: &AppHandle, _profile: &str, dir: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let url = parse_url(&url)?;
    find(&app, &label)?.navigate(url).map_err(|e| e.to_string())
}

/// Starts Select element in a page and gives it the keyboard. `agent` names the window the
/// result is typed into ("" when there is none); `accent` colours the overlay.
#[tauri::command]
pub async fn browser_pick(
    app: AppHandle,
    label: String,
    agent: String,
    accent: String,
) -> Result<(), String> {
    let webview = find(&app, &label)?;
    let opts = serde_json::json!({ "agent": agent, "accent": accent });
    webview
        .eval(format!("window.__tricodePick && window.__tricodePick({opts})"))
        .map_err(|e| e.to_string())?;
    webview.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_back(app: AppHandle, label: String) -> Result<(), String> {
    find(&app, &label)?.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, label: String) -> Result<(), String> {
    find(&app, &label)?.eval("history.forward()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, label: String) -> Result<(), String> {
    find(&app, &label)?.eval("location.reload()").map_err(|e| e.to_string())
}
