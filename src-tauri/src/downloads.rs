//! Downloads in browser panes. A file a page downloads goes to the user's Downloads folder (a
//! free name, `report (1).pdf`), and each step is a `browser-download` event the window shows.
//!
//! Windows hooks WebView2's own DownloadStarting: it gives progress and Cancel, and marking the
//! download handled keeps WebView2's flyout away (a child webview draws it badly or not at all).
//! Elsewhere Tauri's on_download reports only the start and the end; WKWebView drops a download
//! when no handler is set.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum State {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Serialize)]
struct Download {
    id: u64,
    /// The browser webview it came from.
    label: String,
    url: String,
    /// The file's name in the Downloads folder.
    name: String,
    state: State,
    received: u64,
    /// 0 when unknown (the server sent no length, or macOS, which doesn't report progress).
    total: u64,
    /// Windows only: the download can be cancelled.
    cancellable: bool,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

/// Where each download of this run is (or will be) saved: open and reveal take an id, not a path.
static PATHS: Mutex<Option<HashMap<u64, PathBuf>>> = Mutex::new(None);

fn remember(id: u64, path: PathBuf) {
    PATHS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, path);
}

fn path_of(id: u64) -> Result<PathBuf, String> {
    PATHS.lock().unwrap().as_ref().and_then(|m| m.get(&id).cloned()).ok_or_else(|| "unknown download".into())
}

fn name_of(path: &std::path::Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn emit(app: &AppHandle, dl: &Download) {
    let _ = app.emit("browser-download", dl);
}

/// Opens a finished download with its default app.
#[tauri::command]
pub fn download_open(app: AppHandle, id: u64) -> Result<(), String> {
    let path = path_of(id)?;
    if !path.exists() {
        return Err(format!("{} is no longer there", name_of(&path)));
    }
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Shows a download in Explorer or Finder, selected.
#[tauri::command]
pub fn download_reveal(app: AppHandle, id: u64) -> Result<(), String> {
    let path = path_of(id)?;
    if !path.exists() {
        return Err(format!("{} is no longer there", name_of(&path)));
    }
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// Opens the folder downloads are saved to.
#[tauri::command]
pub fn downloads_folder(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Cancels a running download. One that already ended is not an error.
#[tauri::command]
pub fn download_cancel(app: AppHandle, id: u64) -> Result<(), String> {
    cancel(app, id)
}

#[cfg(windows)]
pub use windows_impl::watch;
#[cfg(windows)]
use windows_impl::cancel;

#[cfg(windows)]
mod windows_impl {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Webview};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON, COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED,
        COREWEBVIEW2_DOWNLOAD_STATE, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
        ICoreWebView2_4, ICoreWebView2DownloadOperation,
    };
    use webview2_com::{BytesReceivedChangedEventHandler, DownloadStartingEventHandler, StateChangedEventHandler, take_pwstr};
    use windows_core::{Interface, PWSTR};

    use super::{Download, NEXT, Ordering, State, emit, name_of, remember};

    /// How often a running download reports progress.
    const TICK: Duration = Duration::from_millis(250);

    thread_local! {
        /// Running downloads, for Cancel. WebView2 objects live on the main thread, as does this.
        static OPS: RefCell<HashMap<u64, ICoreWebView2DownloadOperation>> = RefCell::new(HashMap::new());
    }

    /// Reports the webview's downloads as `browser-download` events.
    pub fn watch(app: &AppHandle, webview: &Webview, label: &str) -> Result<(), String> {
        let (app, label) = (app.clone(), label.to_string());
        webview
            .with_webview(move |pw| {
                // SAFETY: COM calls on the webview's own controller, on the thread with_webview runs us on.
                if let Err(e) = unsafe { hook(&pw.controller(), app, label) } {
                    eprintln!("browser downloads hook failed: {e}");
                }
            })
            .map_err(|e| e.to_string())
    }

    unsafe fn hook(
        controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
        app: AppHandle,
        label: String,
    ) -> windows_core::Result<()> {
        let webview: ICoreWebView2_4 = unsafe { controller.CoreWebView2()?.cast()? };
        let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            unsafe {
                args.SetHandled(true)?; // no WebView2 flyout
                let op = args.DownloadOperation()?;
                let mut path = PWSTR::null();
                args.ResultFilePath(&mut path)?;
                let path = PathBuf::from(take_pwstr(path));
                let mut uri = PWSTR::null();
                op.Uri(&mut uri)?;
                let mut total = 0i64;
                op.TotalBytesToReceive(&mut total)?;
                let id = NEXT.fetch_add(1, Ordering::Relaxed);
                let dl = Download {
                    id,
                    label: label.clone(),
                    url: take_pwstr(uri),
                    name: name_of(&path),
                    state: State::Running,
                    received: 0,
                    total: total.max(0) as u64,
                    cancellable: true,
                };
                remember(id, path);
                emit(&app, &dl);
                OPS.with(|ops| ops.borrow_mut().insert(id, op.clone()));
                let shared = Rc::new(RefCell::new((dl, Instant::now())));

                let (progress, progress_app) = (shared.clone(), app.clone());
                let mut token = 0i64;
                op.add_BytesReceivedChanged(
                    &BytesReceivedChangedEventHandler::create(Box::new(move |op, _| {
                        let Some(op) = op else { return Ok(()) };
                        let mut s = progress.borrow_mut();
                        if s.1.elapsed() < TICK || s.0.state != State::Running {
                            return Ok(());
                        }
                        let (mut received, mut total) = (0i64, 0i64);
                        op.BytesReceived(&mut received)?;
                        op.TotalBytesToReceive(&mut total)?;
                        s.0.received = received.max(0) as u64;
                        s.0.total = total.max(0) as u64;
                        s.1 = Instant::now();
                        emit(&progress_app, &s.0);
                        Ok(())
                    })),
                    &mut token,
                )?;

                let (ended, end_app) = (shared, app.clone());
                op.add_StateChanged(
                    &StateChangedEventHandler::create(Box::new(move |op, _| {
                        let Some(op) = op else { return Ok(()) };
                        let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                        op.State(&mut state)?;
                        if state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                            return Ok(()); // resumed after a pause
                        }
                        let mut s = ended.borrow_mut();
                        let mut received = 0i64;
                        op.BytesReceived(&mut received)?;
                        s.0.received = received.max(0) as u64;
                        s.0.cancellable = false;
                        s.0.state = if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                            let mut path = PWSTR::null();
                            op.ResultFilePath(&mut path)?;
                            let path = PathBuf::from(take_pwstr(path));
                            s.0.name = name_of(&path);
                            s.0.total = s.0.received;
                            remember(s.0.id, path);
                            State::Done
                        } else {
                            let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
                            op.InterruptReason(&mut reason)?;
                            if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED { State::Cancelled } else { State::Failed }
                        };
                        OPS.with(|ops| ops.borrow_mut().remove(&s.0.id));
                        emit(&end_app, &s.0);
                        Ok(())
                    })),
                    &mut token,
                )?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        unsafe { webview.add_DownloadStarting(&handler, &mut token) }
    }

    pub fn cancel(app: AppHandle, id: u64) -> Result<(), String> {
        app.run_on_main_thread(move || {
            let op = OPS.with(|ops| ops.borrow().get(&id).cloned());
            if let Some(op) = op {
                // SAFETY: on the main thread, where WebView2 made the operation.
                if let Err(e) = unsafe { op.Cancel() } {
                    eprintln!("download cancel failed: {e}");
                }
            }
        })
        .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
pub use other_impl::watch;
#[cfg(not(windows))]
use other_impl::cancel;

#[cfg(not(windows))]
mod other_impl {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use tauri::webview::DownloadEvent;
    use tauri::{AppHandle, Url, WebviewBuilder, Wry};

    use super::{Download, NEXT, Ordering, State, emit, name_of, remember};

    /// Started downloads: the end only reports the URL, so it is matched to the oldest of these.
    static PENDING: Mutex<Vec<Download>> = Mutex::new(Vec::new());

    /// Reports the webview's downloads as `browser-download` events. The destination is the free
    /// name in Downloads that wry picks.
    pub fn watch(builder: WebviewBuilder<Wry>, app: &AppHandle, label: &str) -> WebviewBuilder<Wry> {
        let (app, label) = (app.clone(), label.to_string());
        builder.on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => started(&app, &label, url, destination.clone()),
                DownloadEvent::Finished { url, path, success } => finished(&app, &label, url, path, success),
                _ => {}
            }
            true
        })
    }

    fn started(app: &AppHandle, label: &str, url: Url, path: PathBuf) {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let dl = Download {
            id,
            label: label.to_string(),
            url: url.to_string(),
            name: name_of(&path),
            state: State::Running,
            received: 0,
            total: 0,
            cancellable: false,
        };
        remember(id, path);
        emit(app, &dl);
        PENDING.lock().unwrap().push(dl);
    }

    fn finished(app: &AppHandle, label: &str, url: Url, path: Option<PathBuf>, success: bool) {
        let url = url.to_string();
        let mut pending = PENDING.lock().unwrap();
        let Some(i) = pending.iter().position(|d| d.label == label && d.url == url) else { return };
        let mut dl = pending.remove(i);
        drop(pending);
        if let Some(path) = path {
            dl.name = name_of(&path);
            remember(dl.id, path);
        }
        dl.state = if success { State::Done } else { State::Failed };
        emit(app, &dl);
    }

    /// Only WebView2 can cancel a download.
    pub fn cancel(_app: AppHandle, _id: u64) -> Result<(), String> {
        Err("downloads can't be cancelled here".into())
    }
}
