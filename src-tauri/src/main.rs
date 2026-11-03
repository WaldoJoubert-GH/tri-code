// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The same executable is also the terminal host, started by the app (ptyd.rs).
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() == Some(std::ffi::OsStr::new("--pty-daemon")) {
        if let Some(info_file) = args.next() {
            tri_code_lib::ptyd::run_daemon(std::path::Path::new(&info_file));
        }
        return;
    }
    tri_code_lib::run()
}
