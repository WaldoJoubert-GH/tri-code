mod bg;
mod browser;
mod dirs;
mod pty;
mod spawn;
mod store;
mod usage;

use std::sync::Arc;

use tauri::{LogicalPosition, Manager, WebviewBuilder, WebviewUrl};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(pty::Ptys::default()))
        .setup(|app| {
            // The main window is built here rather than in tauri.conf.json: browser
            // panes are child webviews, and a plain Window with an auto-resizing
            // main webview is what lets children be positioned freely on every OS.
            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("tri-code")
                .inner_size(1280.0, 800.0)
                .min_inner_size(640.0, 400.0)
                .build()?;
            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            window.add_child(
                WebviewBuilder::new("main", WebviewUrl::App(Default::default())).auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                size,
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::remote_kill_session,
            dirs::list_dirs,
            store::state_load,
            store::state_save,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_close,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            bg::bg_save,
            bg::bg_load,
            bg::bg_delete,
            usage::claude_usage,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Arc<pty::Ptys>>().kill_all();
            }
        });
}
