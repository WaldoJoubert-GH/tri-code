//! Alt+Space is a tri-code hotkey like any other Alt chord, but Windows opens the window menu
//! (Restore, Move, Size, ...) for it once the webview passes the key on, and that menu takes the
//! keyboard. The page still gets the keydown first, so dropping the menu command here leaves the
//! chord to hotkeys.ts and to Settings › Hotkeys, which records it.

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{SC_KEYMENU, WM_SYSCOMMAND};

/// Any number, as long as no other subclass of the main window uses it.
const ID: usize = 0x7472_6941;

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _: usize, _: usize) -> LRESULT {
    // SC_KEYMENU's lParam is the character pressed with Alt: a space opens the window menu.
    if msg == WM_SYSCOMMAND && (wp.0 & 0xFFF0) as u32 == SC_KEYMENU && lp.0 == ' ' as isize {
        return LRESULT(0);
    }
    // SAFETY: passes the message on to the next subclass, as every subclass procedure must.
    unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
}

/// Keep Alt+Space from opening `window`'s window menu.
pub fn install(window: &tauri::Window) {
    match window.hwnd() {
        // SAFETY: the window's own HWND, subclassed on the main thread that created it (setup).
        Ok(hwnd) => unsafe {
            if !SetWindowSubclass(hwnd, Some(proc), ID, 0).as_bool() {
                eprintln!("Alt+Space will open the window menu: SetWindowSubclass failed");
            }
        },
        Err(e) => eprintln!("Alt+Space will open the window menu: {e}"),
    }
}
