//! The Debug Menu's native half: DevTools, DevTools-protocol calls (cache, throttling, site data,
//! hard reload), console errors reported as `browser-console` events, and the remote debugging
//! port a Browser Profile can open for agents. The protocol is WebView2's; WKWebView has none, so
//! macOS offers DevTools (Web Inspector) only. Linux shows pages in an iframe and offers nothing.

use serde::Serialize;
use tauri::AppHandle;

use crate::browser::find;

/// Opens DevTools for a page, in its own window.
#[tauri::command]
pub async fn browser_devtools(app: AppHandle, label: String) -> Result<(), String> {
    find(&app, &label)?.open_devtools();
    Ok(())
}

/// Calls a DevTools protocol method on a page and returns its result.
#[tauri::command]
pub async fn browser_cdp(app: AppHandle, label: String, method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        let webview = find(&app, &label)?;
        let params = if params.is_null() { "{}".to_string() } else { params.to_string() };
        let json = win::call(&webview, method, params).await?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, label, method, params);
        Err("the DevTools protocol is only on Windows".into())
    }
}

/// The browser arguments of every webview in a profile with remote debugging on. WebView2 runs one
/// browser process per data folder and refuses a webview whose arguments differ from those it was
/// started with, so these are wry's defaults (wry 0.57, autoplay on as Tauri leaves it) plus the
/// port, and every page of the profile has to close before the port can change.
#[cfg(windows)]
pub fn browser_args(port: u16) -> String {
    format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --remote-debugging-port={port}")
}

#[derive(Clone, Serialize)]
struct ConsolePayload {
    label: String,
    text: String,
}

/// Longest error text kept; a minified stack can run to megabytes.
const MAX_TEXT: usize = 2000;

fn clip(mut s: String) -> String {
    if s.len() > MAX_TEXT {
        let mut end = MAX_TEXT;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push('…');
    }
    s
}

/// `url:line` for a protocol location (lines count from 0 there).
fn at(url: Option<&str>, line: Option<i64>) -> String {
    match (url.filter(|u| !u.is_empty()), line) {
        (Some(u), Some(l)) => format!(" ({u}:{})", l + 1),
        (Some(u), None) => format!(" ({u})"),
        _ => String::new(),
    }
}

/// The text of an error-level protocol event, or None for anything quieter.
pub fn describe(event: &str, json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let s = |v: &serde_json::Value| v.as_str().map(str::to_string);
    let text = match event {
        "Runtime.exceptionThrown" => {
            let d = &v["exceptionDetails"];
            // The description carries the stack, which already says where.
            match s(&d["exception"]["description"]) {
                Some(desc) => desc,
                None => format!("{}{}", s(&d["text"]).unwrap_or_else(|| "Uncaught exception".into()), at(d["url"].as_str(), d["lineNumber"].as_i64())),
            }
        }
        "Runtime.consoleAPICalled" => {
            let kind = v["type"].as_str()?;
            if kind != "error" && kind != "assert" {
                return None;
            }
            let args = v["args"].as_array().map(Vec::as_slice).unwrap_or_default();
            let parts: Vec<String> = args
                .iter()
                .map(|a| s(&a["value"]).or_else(|| s(&a["description"])).unwrap_or_else(|| a["value"].to_string()))
                .collect();
            let frame = &v["stackTrace"]["callFrames"][0];
            let msg = if parts.is_empty() { "console.assert failed".to_string() } else { parts.join(" ") };
            format!("{msg}{}", at(frame["url"].as_str(), frame["lineNumber"].as_i64()))
        }
        "Log.entryAdded" => {
            let e = &v["entry"];
            if e["level"].as_str()? != "error" {
                return None;
            }
            format!("{}{}", s(&e["text"])?, at(e["url"].as_str(), e["lineNumber"].as_i64()))
        }
        _ => return None,
    };
    Some(clip(text))
}

#[cfg(windows)]
pub use win::watch_console;

/// A DevTools protocol call on a page, for screenshots (shot.rs).
#[cfg(windows)]
pub(crate) use win::call as cdp_call;

#[cfg(windows)]
mod win {
    use tauri::{AppHandle, Emitter, Webview};
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler, take_pwstr};
    use windows_core::{HSTRING, PWSTR};

    use super::{ConsolePayload, describe};

    /// The events console errors come from: uncaught exceptions, console.error and console.assert,
    /// and the browser's own (a failed request, a blocked script).
    const EVENTS: [&str; 3] = ["Runtime.exceptionThrown", "Runtime.consoleAPICalled", "Log.entryAdded"];

    pub async fn call(webview: &Webview, method: String, params: String) -> Result<String, String> {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
        let name = method.clone();
        webview
            .with_webview(move |pw| {
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |done, json| {
                    let _ = tx.send(done.map(|_| json).map_err(|e| e.message()));
                    Ok(())
                }));
                // SAFETY: COM calls on the webview's own controller, on the thread with_webview runs us on.
                let sent = unsafe {
                    pw.controller()
                        .CoreWebView2()
                        .and_then(|core| core.CallDevToolsProtocolMethod(&HSTRING::from(&method), &HSTRING::from(&params), &handler))
                };
                // A call that never went out drops the handler, and with it the sender.
                if let Err(e) = sent {
                    eprintln!("{method} failed: {e}");
                }
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| format!("{name} wasn't sent"))?.map_err(|e| format!("{name}: {e}"))
    }

    /// Reports a page's console errors as `browser-console` events, for the Debug Menu's count.
    pub fn watch_console(app: &AppHandle, webview: &Webview, label: &str) -> Result<(), String> {
        let (app, label) = (app.clone(), label.to_string());
        webview
            .with_webview(move |pw| {
                // SAFETY: COM calls on the webview's own controller, on the thread with_webview runs us on.
                if let Err(e) = unsafe { hook(&pw.controller(), app, label) } {
                    eprintln!("browser console hook failed: {e}");
                }
            })
            .map_err(|e| e.to_string())
    }

    unsafe fn hook(controller: &ICoreWebView2Controller, app: AppHandle, label: String) -> windows_core::Result<()> {
        let core = unsafe { controller.CoreWebView2()? };
        // Listen first: enabling a domain replays what it has buffered.
        for event in EVENTS {
            let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event))? };
            let (app, label) = (app.clone(), label.clone());
            let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut json = PWSTR::null();
                unsafe { args.ParameterObjectAsJson(&mut json)? };
                if let Some(text) = describe(event, &take_pwstr(json)) {
                    let _ = app.emit("browser-console", ConsolePayload { label: label.clone(), text });
                }
                Ok(())
            }));
            let mut token = 0i64;
            unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)? };
        }
        for method in ["Runtime.enable", "Log.enable"] {
            let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |r, _| {
                if let Err(e) = r {
                    eprintln!("{method} failed: {e}");
                }
                Ok(())
            }));
            unsafe { core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from("{}"), &done)? };
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::describe;

    #[test]
    fn exceptions_keep_their_stack() {
        let j = r#"{"exceptionDetails":{"text":"Uncaught","lineNumber":3,"url":"http://x/a.js","exception":{"description":"TypeError: x is undefined\n    at f (a.js:4)"}}}"#;
        assert_eq!(describe("Runtime.exceptionThrown", j).unwrap(), "TypeError: x is undefined\n    at f (a.js:4)");
        let j = r#"{"exceptionDetails":{"text":"Uncaught 1","lineNumber":3,"url":"http://x/a.js"}}"#;
        assert_eq!(describe("Runtime.exceptionThrown", j).unwrap(), "Uncaught 1 (http://x/a.js:4)");
    }

    #[test]
    fn only_console_errors_count() {
        let j = r#"{"type":"error","args":[{"type":"string","value":"boom"},{"type":"object","description":"Object"}],"stackTrace":{"callFrames":[{"url":"http://x/b.js","lineNumber":9}]}}"#;
        assert_eq!(describe("Runtime.consoleAPICalled", j).unwrap(), "boom Object (http://x/b.js:10)");
        let j = r#"{"type":"log","args":[{"type":"string","value":"hi"}]}"#;
        assert_eq!(describe("Runtime.consoleAPICalled", j), None);
        let j = r#"{"entry":{"level":"error","text":"Failed to load resource: 500","url":"http://x/api"}}"#;
        assert_eq!(describe("Log.entryAdded", j).unwrap(), "Failed to load resource: 500 (http://x/api)");
        let j = r#"{"entry":{"level":"warning","text":"meh"}}"#;
        assert_eq!(describe("Log.entryAdded", j), None);
    }

    #[test]
    fn long_text_is_clipped_on_a_char_boundary() {
        let long = "é".repeat(3000);
        let j = format!(r#"{{"type":"error","args":[{{"type":"string","value":"{long}"}}]}}"#);
        let t = describe("Runtime.consoleAPICalled", &j).unwrap();
        assert!(t.len() <= super::MAX_TEXT + 3 && t.ends_with('…'));
    }
}
