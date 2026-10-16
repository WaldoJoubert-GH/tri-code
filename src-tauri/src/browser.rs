//! Native browser panes: child webviews embedded in the main window and tiled
//! by the frontend. Coordinates are logical pixels relative to the main window.

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl};

#[derive(Clone, Serialize)]
struct NavPayload {
    label: String,
    url: String,
    loading: bool,
}

#[derive(Clone, Serialize)]
struct TitlePayload {
    label: String,
    title: String,
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

/// Creates the browser webview, or navigates and repositions it if it exists.
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
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
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
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
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
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
