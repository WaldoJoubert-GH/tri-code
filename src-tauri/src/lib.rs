mod bg;
mod browser;
mod devfs;
mod dirs;
mod envs;
mod envssh;
mod folders;
mod fs;
mod git;
mod github;
mod passwords;
mod phone;
mod plane;
mod pty;
mod push;
mod remote;
mod spawn;
mod store;
mod tour;
mod usage;

use std::sync::Arc;

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{LogicalPosition, Manager, WebviewBuilder, WebviewUrl};

/// The macOS menu bar: About, Quit and the Edit items that copy and paste in the webview.
/// It replaces Tauri's default, whose Close Window (Cmd+W), Minimize (Cmd+M) and Hide (Cmd+H)
/// would take those chords from the window hotkeys when Settings makes Cmd their modifier.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                &app.package_info().name,
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu);
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(pty::Ptys::default()))
        .setup(|app| {
            let ptys = Arc::clone(app.state::<Arc<pty::Ptys>>().inner());
            app.manage(phone::Phone::new(app.handle().clone(), ptys));
            // The main window is built here rather than in tauri.conf.json: browser
            // panes are child webviews, and a plain Window with an auto-resizing
            // main webview is what lets children be positioned freely on every OS.
            let window = tauri::window::WindowBuilder::new(app, "main")
                .title(format!("tri-code v{}", app.package_info().version))
                .inner_size(1280.0, 800.0)
                .min_inner_size(640.0, 400.0)
                .build()?;
            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            window.add_child(
                // Without the native drop handler, HTML drag and drop works on Windows too: reordering
                // commands and favourites, dropping images on an issue.
                WebviewBuilder::new("main", WebviewUrl::App(Default::default())).auto_resize().disable_drag_drop_handler(),
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
            folders::folder_repos,
            folders::folder_copy,
            folders::folder_changes,
            folders::folder_finish,
            envs::ssh_hosts,
            envs::scan_logos,
            envssh::env_ssh_set,
            envssh::env_pin_hash,
            envssh::env_lock,
            envssh::env_unlock,
            envssh::env_forget_lock,
            fs::list_files,
            fs::read_file,
            fs::read_image,
            fs::read_media,
            fs::write_file,
            fs::create_file,
            fs::delete_path,
            fs::rename_path,
            fs::stamps,
            git::git_status,
            git::folder_status,
            git::git_diff,
            git::git_is_repo,
            git::git_head_text,
            git::git_range,
            git::git_show,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_push,
            git::gh_pr_view,
            git::gh_pr_create,
            git::gh_pr_merge,
            git::git_worktrees,
            git::git_branches,
            git::git_fetch,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_branch_delete,
            git::git_push_delete,
            git::claude_draft,
            git::project_files,
            devfs::dev_read,
            devfs::dev_write,
            devfs::save_pasted_image,
            plane::plane_sync,
            plane::plane_set_state,
            plane::plane_set_labels,
            plane::plane_create_issue,
            plane::plane_comments,
            plane::plane_add_comment,
            plane::plane_upload_asset,
            plane::plane_check_token,
            github::gh_repo,
            github::gh_issues_sync,
            github::gh_issue_create,
            github::gh_issue_set_state,
            github::gh_issue_labels,
            github::gh_issue_comments,
            github::gh_issue_comment,
            github::gh_feedback,
            store::state_load,
            store::state_save,
            tour::tour_folder,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_close,
            browser::browser_close_all,
            browser::browser_navigate,
            browser::browser_autofill,
            browser::browser_profile_erase,
            browser::browser_profiles_supported,
            passwords::browser_password_answer,
            passwords::browser_passwords,
            passwords::browser_password_forget,
            browser::browser_pick,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            bg::bg_save,
            bg::bg_load,
            bg::bg_delete,
            bg::icon_save,
            bg::icon_load,
            bg::icon_delete,
            bg::sound_save,
            bg::sound_load,
            bg::sound_delete,
            usage::claude_usage,
            usage::command_code_usage,
            phone::phone_start,
            phone::phone_stop,
            phone::phone_status,
            phone::phone_pair,
            phone::phone_forget,
            phone::phone_agents,
            phone::phone_push,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Arc<phone::Phone>>().shutdown();
                app.state::<Arc<pty::Ptys>>().kill_all();
            }
        });
}
