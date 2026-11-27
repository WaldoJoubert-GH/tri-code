//! Export PDF of a Markdown file (mdexport.ts): the frontend hands over a finished HTML page (the
//! rendered Markdown, its images inlined, tri-code's print CSS and the project's), and a hidden
//! window prints it. On Windows that is WebView2's DevTools protocol (`Page.printToPDF`), straight to
//! the file the user picked. WKWebView and WebKitGTK have no such call here, so there the window
//! shows the page and opens the system print dialog, whose Save as PDF does the rest.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// How long the page may take to load its images before printing goes ahead anyway.
#[cfg_attr(not(windows), allow(dead_code))]
const LOAD_LIMIT: Duration = Duration::from_secs(20);

/// The PDFs this run wrote, which md_pdf_open may open or show.
fn written() -> std::sync::MutexGuard<'static, HashSet<String>> {
    static WRITTEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    WRITTEN.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// A script that replaces the blank page with `html` and resolves once its images and fonts are in.
fn write_script(html: &str) -> String {
    format!(
        "(async () => {{ document.open(); document.write({}); document.close();
  await Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => {{ i.onload = i.onerror = r; }})));
  await document.fonts.ready; return true; }})()",
        serde_json::to_string(html).unwrap_or_default()
    )
}

/// A blank window for one export, and a receiver that fires once its blank page has loaded.
fn blank_window(app: &AppHandle, visible: bool) -> Result<(WebviewWindow, tokio::sync::oneshot::Receiver<()>), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let label = format!("mdpdf-{}", SEQ.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    let url = "about:blank".parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Export PDF")
        .inner_size(860.0, 1000.0)
        .visible(visible)
        .skip_taskbar(!visible)
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished
                && let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take()
            {
                let _ = tx.send(());
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok((window, rx))
}

/// Prints `html` to the PDF at `path` (Windows), or opens the print dialog for it (`path` None,
/// elsewhere). Returns whether the file was written.
#[tauri::command]
pub async fn md_pdf(app: AppHandle, html: String, path: Option<String>) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let path = path.ok_or("no file to save the PDF to")?;
        let (window, loaded) = blank_window(&app, false)?;
        let result = print_to_file(&window, loaded, &html, &path).await;
        let _ = window.destroy();
        result?;
        written().insert(path);
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        let (window, loaded) = blank_window(&app, true)?;
        let _ = tokio::time::timeout(Duration::from_secs(5), loaded).await;
        window.eval(format!("{}.then(() => 0)", write_script(&html))).map_err(|e| e.to_string())?;
        // eval can't report back, so give the page a moment for its images.
        tokio::time::sleep(Duration::from_millis(800)).await;
        window.print().map_err(|e| e.to_string())?;
        Ok(false)
    }
}

#[cfg(windows)]
async fn print_to_file(window: &WebviewWindow, loaded: tokio::sync::oneshot::Receiver<()>, html: &str, path: &str) -> Result<(), String> {
    use base64::Engine as _;

    use crate::browser::debug::cdp_call;

    let webview = window.as_ref();
    // Writing before about:blank has loaded would be undone by it.
    let _ = tokio::time::timeout(Duration::from_secs(10), loaded).await;
    let params = serde_json::json!({ "expression": write_script(html), "awaitPromise": true, "returnByValue": true }).to_string();
    match tokio::time::timeout(LOAD_LIMIT, cdp_call(webview, "Runtime.evaluate".into(), params)).await {
        Ok(r) => {
            let v: serde_json::Value = serde_json::from_str(&r?).map_err(|e| e.to_string())?;
            if let Some(e) = v.get("exceptionDetails") {
                return Err(format!("the page failed: {}", e["exception"]["description"].as_str().unwrap_or("unknown error")));
            }
        }
        Err(_) => eprintln!("md_pdf: images still loading after {LOAD_LIMIT:?}, printing anyway"),
    }
    let params = r#"{"printBackground":true,"preferCSSPageSize":true,"generateDocumentOutline":true,"generateTaggedPDF":true}"#;
    let json = cdp_call(webview, "Page.printToPDF".into(), params.into()).await?;
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let data = v["data"].as_str().ok_or("the PDF came back empty")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| format!("couldn't write {path}: {e}"))
}

/// Opens a PDF this run exported, or shows it in its folder.
#[tauri::command]
pub fn md_pdf_open(app: AppHandle, path: String, reveal: bool) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    if !written().contains(&path) {
        return Err("that file wasn't exported here".into());
    }
    if reveal {
        app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
    } else {
        app.opener().open_path(&path, None::<&str>).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::write_script;

    #[test]
    fn the_page_goes_in_as_a_string() {
        let s = write_script("<p>\"hi\"</p>\n</script>");
        assert!(s.contains(r#"document.write("<p>\"hi\"</p>\n</script>")"#));
    }
}
