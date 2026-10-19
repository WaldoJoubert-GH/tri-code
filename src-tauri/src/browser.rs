//! Native browser panes: child webviews embedded in the main window and tiled
//! by the frontend. Coordinates are logical pixels relative to the main window.

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
struct TitlePayload {
    label: String,
    title: String,
}

/// Ctrl/Cmd+click and middle-click reach on_new_window looking the same as target=_blank, so
/// the page reports them as a navigation to this host instead, which on_navigation cancels.
const BG_HOST: &str = "tricode.invalid";

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

/// Creates the browser webview, or navigates and repositions it if it exists. A `hidden` one
/// loads behind the shown page (a background tab).
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
) -> Result<(), String> {
    let url = parse_url(&url)?;
    if let Some(webview) = app.get_webview(&label) {
        webview.navigate(url).map_err(|e| e.to_string())?;
        return set_bounds(&webview, x, y, width, height);
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
        .on_navigation(move |url| {
            if url.host_str() != Some(BG_HOST) {
                return true;
            }
            let target = url
                .query_pairs()
                .find(|(k, _)| k == "u")
                .and_then(|(_, u)| Url::parse(&u).ok());
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
        .on_page_load(move |_webview, payload| {
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
    let webview = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
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
    match app.get_webview(&label) {
        Some(webview) => webview.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let url = parse_url(&url)?;
    find(&app, &label)?.navigate(url).map_err(|e| e.to_string())
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
