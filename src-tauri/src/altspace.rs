//! Alt+Space is a tri-code hotkey like any other Alt chord, but on Windows it is the system key
//! for the window menu (Restore, Move, Size, ...). WebView2 hands it to the host as a system key
//! instead of giving the page a keydown, so hotkeys.ts and Settings › Hotkeys never saw it. Here the
//! main webview takes it (`forward`) and emits `alt-space`, which hotkeys.ts replays as a keydown;
//! and the window drops the menu command (`install`) in case one gets through anyway.

use tauri::{AppHandle, Emitter, Webview};
use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    ICoreWebView2Controller,
};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_SHIFT, VK_SPACE};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{SC_KEYMENU, WM_SYSCOMMAND};

/// Any number, as long as no other subclass of the main window uses it.
const ID: usize = 0x7472_6941;

/// What `alt-space` carries: the other modifiers held with it.
#[derive(Clone, serde::Serialize)]
struct AltSpace {
    shift: bool,
    ctrl: bool,
}

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

/// Take Alt+Space from the main webview and hand it to the page as an `alt-space` event.
pub fn forward(app: &AppHandle, webview: &Webview) {
    let app = app.clone();
    let res = webview.with_webview(move |pw| {
        // SAFETY: COM calls on the webview's own controller, on the thread with_webview runs us on.
        if let Err(e) = unsafe { hook(&pw.controller(), app) } {
            eprintln!("Alt+Space won't reach the page: {e}");
        }
    });
    if let Err(e) = res {
        eprintln!("Alt+Space won't reach the page: {e}");
    }
}

unsafe fn hook(controller: &ICoreWebView2Controller, app: AppHandle) -> windows_core::Result<()> {
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        // SAFETY: the event's own arguments, read on the thread that raised it.
        unsafe {
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.KeyEventKind(&mut kind)?;
            let mut vk = 0u32;
            args.VirtualKey(&mut vk)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN || vk != VK_SPACE.0 as u32 {
                return Ok(());
            }
            args.SetHandled(true)?;
            let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
            args.PhysicalKeyStatus(&mut status)?;
            // Held down, it repeats: a hotkey runs once per press, like the others.
            if status.WasKeyDown.as_bool() {
                return Ok(());
            }
            let down = |k: i32| GetKeyState(k) < 0;
            let _ = app.emit("alt-space", AltSpace { shift: down(VK_SHIFT.0 as i32), ctrl: down(VK_CONTROL.0 as i32) });
        }
        Ok(())
    }));
    let mut token = 0i64;
    unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) }
}
