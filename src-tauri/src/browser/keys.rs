//! Keys pressed in a browser page go to that page's webview, so hotkeys.ts never saw them: tri-code's
//! hotkeys and the browser keys (Ctrl+L, Ctrl+T, Ctrl+W, ...) did nothing while a page had focus.
//! The frontend lists the chords it wants (`browser_keys`); a listed one pressed in a page is taken
//! from the page and emitted as `browser-key`, which hotkeys.ts runs as a keydown. Everything else
//! stays the page's.
//!
//! Windows: WebView2 offers every Ctrl / Alt chord to the host before the page (AcceleratorKeyPressed).
//! macOS: an NSEvent local monitor sees every key the app gets before any view does, Cmd chords
//! included, and takes the ones pressed while a page's WKWebView has the keyboard.
//! Linux: not yet.

use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Webview};

/// A key press as the frontend matches it: KeyboardEvent.code and the modifiers held.
#[derive(Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Chord {
    code: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

/// What `browser-key` carries: the chord, the page it was pressed in and whether it is a repeat.
#[derive(Clone, Serialize)]
struct KeyPayload {
    label: String,
    #[serde(flatten)]
    chord: Chord,
    repeat: bool,
}

/// The chords taken from pages, as the frontend last listed them.
static KEYS: RwLock<Vec<Chord>> = RwLock::new(Vec::new());

fn wanted(chord: &Chord) -> bool {
    KEYS.read().is_ok_and(|k| k.contains(chord))
}

/// The chords to take from browser pages: every hotkey, the Commands' and the browser keys.
#[tauri::command]
pub fn browser_keys(keys: Vec<Chord>) {
    if let Ok(mut k) = KEYS.write() {
        *k = keys;
    }
}

#[cfg(windows)]
pub use win::watch;

#[cfg(target_os = "macos")]
pub use mac::watch;

#[cfg(not(any(windows, target_os = "macos")))]
pub fn watch(_app: &AppHandle, _webview: &Webview, _label: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
mod win {
    use tauri::Emitter;
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
        COREWEBVIEW2_PHYSICAL_KEY_STATUS, ICoreWebView2Controller,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};

    use super::{AppHandle, Chord, KeyPayload, Webview, wanted};

    /// Take the listed chords from a browser page's webview and emit them as `browser-key`.
    pub fn watch(app: &AppHandle, webview: &Webview, label: &str) -> Result<(), String> {
        let (app, label) = (app.clone(), label.to_string());
        webview
            .with_webview(move |pw| {
                // SAFETY: COM calls on the webview's own controller, on the thread with_webview runs us on.
                if let Err(e) = unsafe { hook(&pw.controller(), app, label) } {
                    eprintln!("hotkeys won't work in this page: {e}");
                }
            })
            .map_err(|e| e.to_string())
    }

    unsafe fn hook(controller: &ICoreWebView2Controller, app: AppHandle, label: String) -> windows_core::Result<()> {
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            // SAFETY: the event's own arguments, read on the thread that raised it.
            unsafe {
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                args.KeyEventKind(&mut kind)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                    return Ok(());
                }
                let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                args.PhysicalKeyStatus(&mut status)?;
                let Some(code) = code_of(status.ScanCode, status.IsExtendedKey.as_bool()) else { return Ok(()) };
                let down = |k: u16| GetKeyState(k as i32) < 0;
                let chord = Chord {
                    code: code.to_string(),
                    ctrl: down(VK_CONTROL.0),
                    alt: down(VK_MENU.0),
                    shift: down(VK_SHIFT.0),
                    meta: down(VK_LWIN.0) || down(VK_RWIN.0),
                };
                // Only chords tri-code uses are taken; AltGr (Ctrl+Alt) typing goes on to the page.
                if !wanted(&chord) {
                    return Ok(());
                }
                args.SetHandled(true)?;
                let repeat = status.WasKeyDown.as_bool();
                let _ = app.emit("browser-key", KeyPayload { label: label.clone(), chord, repeat });
            }
            Ok(())
        }));
        let mut token = 0i64;
        unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) }
    }

    /// KeyboardEvent.code for a set-1 scan code (the physical key, whatever the layout), for the
    /// keys a chord can use.
    pub(super) fn code_of(scan: u32, extended: bool) -> Option<&'static str> {
        const LETTERS: &[(u32, &str)] = &[
            (0x10, "KeyQ"), (0x11, "KeyW"), (0x12, "KeyE"), (0x13, "KeyR"), (0x14, "KeyT"), (0x15, "KeyY"), (0x16, "KeyU"),
            (0x17, "KeyI"), (0x18, "KeyO"), (0x19, "KeyP"), (0x1E, "KeyA"), (0x1F, "KeyS"), (0x20, "KeyD"), (0x21, "KeyF"),
            (0x22, "KeyG"), (0x23, "KeyH"), (0x24, "KeyJ"), (0x25, "KeyK"), (0x26, "KeyL"), (0x2C, "KeyZ"), (0x2D, "KeyX"),
            (0x2E, "KeyC"), (0x2F, "KeyV"), (0x30, "KeyB"), (0x31, "KeyN"), (0x32, "KeyM"),
        ];
        const MAIN: &[(u32, &str)] = &[
            (0x01, "Escape"), (0x02, "Digit1"), (0x03, "Digit2"), (0x04, "Digit3"), (0x05, "Digit4"), (0x06, "Digit5"),
            (0x07, "Digit6"), (0x08, "Digit7"), (0x09, "Digit8"), (0x0A, "Digit9"), (0x0B, "Digit0"), (0x0C, "Minus"),
            (0x0D, "Equal"), (0x0E, "Backspace"), (0x0F, "Tab"), (0x1A, "BracketLeft"), (0x1B, "BracketRight"),
            (0x1C, "Enter"), (0x27, "Semicolon"), (0x28, "Quote"), (0x29, "Backquote"), (0x2B, "Backslash"),
            (0x33, "Comma"), (0x34, "Period"), (0x35, "Slash"), (0x37, "NumpadMultiply"), (0x39, "Space"),
            (0x3B, "F1"), (0x3C, "F2"), (0x3D, "F3"), (0x3E, "F4"), (0x3F, "F5"), (0x40, "F6"), (0x41, "F7"),
            (0x42, "F8"), (0x43, "F9"), (0x44, "F10"), (0x57, "F11"), (0x58, "F12"), (0x56, "IntlBackslash"),
            (0x47, "Numpad7"), (0x48, "Numpad8"), (0x49, "Numpad9"), (0x4A, "NumpadSubtract"), (0x4B, "Numpad4"),
            (0x4C, "Numpad5"), (0x4D, "Numpad6"), (0x4E, "NumpadAdd"), (0x4F, "Numpad1"), (0x50, "Numpad2"),
            (0x51, "Numpad3"), (0x52, "Numpad0"), (0x53, "NumpadDecimal"),
        ];
        const EXTENDED: &[(u32, &str)] = &[
            (0x1C, "NumpadEnter"), (0x35, "NumpadDivide"), (0x47, "Home"), (0x48, "ArrowUp"), (0x49, "PageUp"),
            (0x4B, "ArrowLeft"), (0x4D, "ArrowRight"), (0x4F, "End"), (0x50, "ArrowDown"), (0x51, "PageDown"),
            (0x52, "Insert"), (0x53, "Delete"),
        ];
        let find = |t: &[(u32, &'static str)]| t.iter().find(|(s, _)| *s == scan).map(|(_, c)| *c);
        if extended { find(EXTENDED) } else { find(LETTERS).or_else(|| find(MAIN)) }
    }

    #[cfg(test)]
    mod tests {
        use super::code_of;

        #[test]
        fn scan_codes_are_physical_keys() {
            assert_eq!(code_of(0x23, false), Some("KeyH"));
            assert_eq!(code_of(0x1C, false), Some("Enter"));
            assert_eq!(code_of(0x1C, true), Some("NumpadEnter"));
            assert_eq!(code_of(0x4B, true), Some("ArrowLeft"));
            assert_eq!(code_of(0x4B, false), Some("Numpad4"));
            assert_eq!(code_of(0x1D, false), None); // Ctrl alone
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2::rc::{Retained, Weak};
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSView};
    use objc2_web_kit::WKWebView;
    use tauri::Emitter;

    use super::{AppHandle, Chord, KeyPayload, Webview, wanted};

    thread_local! {
        /// The browser pages' views and their labels: a key goes to the one holding the keyboard.
        static VIEWS: RefCell<Vec<(Weak<WKWebView>, String)>> = const { RefCell::new(Vec::new()) };
        /// The key monitor, installed with the first page and kept for the app's life.
        static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    /// Take the listed chords from a browser page's WKWebView and emit them as `browser-key`.
    pub fn watch(app: &AppHandle, webview: &Webview, label: &str) -> Result<(), String> {
        let (app, label) = (app.clone(), label.to_string());
        webview
            .with_webview(move |pw| {
                let Some(mtm) = MainThreadMarker::new() else { return };
                // SAFETY: inner() is the live WKWebView, and with_webview runs us on the main thread.
                let view = unsafe { &*(pw.inner() as *const WKWebView) };
                VIEWS.with_borrow_mut(|v| {
                    v.retain(|(w, l)| w.load().is_some() && *l != label);
                    v.push((Weak::new(view), label));
                });
                MONITOR.with_borrow_mut(|m| {
                    if m.is_none() {
                        *m = install(app, mtm);
                        if m.is_none() {
                            eprintln!("hotkeys won't work in browser pages: no key monitor");
                        }
                    }
                });
            })
            .map_err(|e| e.to_string())
    }

    fn install(app: AppHandle, mtm: MainThreadMarker) -> Option<Retained<AnyObject>> {
        let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit hands the monitor a live event for the length of the call.
            let e = unsafe { event.as_ref() };
            match page_key(e, mtm) {
                Some(payload) => {
                    let _ = app.emit("browser-key", payload);
                    std::ptr::null_mut() // taken: the page never sees it
                }
                None => event.as_ptr(),
            }
        });
        // SAFETY: on the main thread; the block lives as long as the monitor (AppKit copies it).
        unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block) }
    }

    /// A listed chord pressed while a page's view has the keyboard: what to emit for it.
    fn page_key(e: &NSEvent, mtm: MainThreadMarker) -> Option<KeyPayload> {
        let code = code_of(e.keyCode())?;
        let flags = e.modifierFlags();
        let chord = Chord {
            code: code.to_string(),
            ctrl: flags.contains(NSEventModifierFlags::Control),
            alt: flags.contains(NSEventModifierFlags::Option),
            shift: flags.contains(NSEventModifierFlags::Shift),
            meta: flags.contains(NSEventModifierFlags::Command),
        };
        if !wanted(&chord) {
            return None;
        }
        let focus = e.window(mtm)?.firstResponder()?.downcast::<NSView>().ok()?;
        let label = VIEWS.with_borrow(|v| {
            v.iter().find_map(|(w, l)| w.load().filter(|page| focus.isDescendantOf(page)).map(|_| l.clone()))
        })?;
        Some(KeyPayload { label, chord, repeat: e.isARepeat() })
    }

    /// KeyboardEvent.code for a Mac virtual key code (kVK_*, the physical key whatever the
    /// layout), for the keys a chord can use.
    pub(super) fn code_of(key: u16) -> Option<&'static str> {
        const CODES: &[(u16, &str)] = &[
            (0x00, "KeyA"), (0x01, "KeyS"), (0x02, "KeyD"), (0x03, "KeyF"), (0x04, "KeyH"), (0x05, "KeyG"), (0x06, "KeyZ"),
            (0x07, "KeyX"), (0x08, "KeyC"), (0x09, "KeyV"), (0x0A, "IntlBackslash"), (0x0B, "KeyB"), (0x0C, "KeyQ"),
            (0x0D, "KeyW"), (0x0E, "KeyE"), (0x0F, "KeyR"), (0x10, "KeyY"), (0x11, "KeyT"), (0x12, "Digit1"),
            (0x13, "Digit2"), (0x14, "Digit3"), (0x15, "Digit4"), (0x16, "Digit6"), (0x17, "Digit5"), (0x18, "Equal"),
            (0x19, "Digit9"), (0x1A, "Digit7"), (0x1B, "Minus"), (0x1C, "Digit8"), (0x1D, "Digit0"),
            (0x1E, "BracketRight"), (0x1F, "KeyO"), (0x20, "KeyU"), (0x21, "BracketLeft"), (0x22, "KeyI"), (0x23, "KeyP"),
            (0x24, "Enter"), (0x25, "KeyL"), (0x26, "KeyJ"), (0x27, "Quote"), (0x28, "KeyK"), (0x29, "Semicolon"),
            (0x2A, "Backslash"), (0x2B, "Comma"), (0x2C, "Slash"), (0x2D, "KeyN"), (0x2E, "KeyM"), (0x2F, "Period"),
            (0x30, "Tab"), (0x31, "Space"), (0x32, "Backquote"), (0x33, "Backspace"), (0x35, "Escape"),
            (0x41, "NumpadDecimal"), (0x43, "NumpadMultiply"), (0x45, "NumpadAdd"), (0x4B, "NumpadDivide"),
            (0x4C, "NumpadEnter"), (0x4E, "NumpadSubtract"), (0x52, "Numpad0"), (0x53, "Numpad1"), (0x54, "Numpad2"),
            (0x55, "Numpad3"), (0x56, "Numpad4"), (0x57, "Numpad5"), (0x58, "Numpad6"), (0x59, "Numpad7"),
            (0x5B, "Numpad8"), (0x5C, "Numpad9"), (0x60, "F5"), (0x61, "F6"), (0x62, "F7"), (0x63, "F3"), (0x64, "F8"),
            (0x65, "F9"), (0x67, "F11"), (0x6D, "F10"), (0x6F, "F12"), (0x73, "Home"), (0x74, "PageUp"),
            (0x75, "Delete"), (0x76, "F4"), (0x77, "End"), (0x78, "F2"), (0x79, "PageDown"), (0x7A, "F1"),
            (0x7B, "ArrowLeft"), (0x7C, "ArrowRight"), (0x7D, "ArrowDown"), (0x7E, "ArrowUp"),
        ];
        CODES.iter().find(|(k, _)| *k == key).map(|(_, c)| *c)
    }

    #[cfg(test)]
    mod tests {
        use super::code_of;

        #[test]
        fn key_codes_are_physical_keys() {
            assert_eq!(code_of(0x04), Some("KeyH"));
            assert_eq!(code_of(0x25), Some("KeyL"));
            assert_eq!(code_of(0x30), Some("Tab"));
            assert_eq!(code_of(0x7B), Some("ArrowLeft"));
            assert_eq!(code_of(0x37), None); // Cmd alone
        }
    }
}
