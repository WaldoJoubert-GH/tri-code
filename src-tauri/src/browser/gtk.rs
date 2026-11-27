//! Linux browser panes. Tauri packs every child webview into the window's vertical GtkBox, where
//! they are stacked and stretched and their bounds are ignored. So the main webview is moved into
//! a GtkOverlay once (`install`), and each browser pane's webview is moved from the box onto that
//! overlay (`adopt`), whose `get-child-position` places it at the bounds the frontend last asked
//! for (`place`). Tauri still owns the webviews (events, navigation, show/hide, close); only where
//! they are drawn changes here. Each overlay child gets a window of its own size, so clicks outside
//! the panes still reach the main webview.
//!
//! All GTK calls run on the main thread inside `with_webview`, which keeps them in the order they
//! were made relative to Tauri's own webview calls (create, show, hide, close).
//!
//! `TRICODE_FRAMED_BROWSERS=1` turns this off and puts the frontend back on iframes.

use std::cell::RefCell;

use gtk::prelude::*;
use tauri::Webview;

/// A pane's bounds in logical pixels relative to the main webview: x, y, width, height.
type Bounds = (i32, i32, i32, i32);

/// The widget data key holding a pane's `Bounds`.
const BOUNDS: &str = "tricode-bounds";

thread_local! {
    /// The overlay `install` put the main webview in. Main thread only.
    static LAYER: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
}

/// Whether browser panes fall back to iframes in the frontend.
pub fn framed() -> bool {
    std::env::var_os("TRICODE_FRAMED_BROWSERS").is_some_and(|v| !v.is_empty() && v != "0")
}

fn bounds(x: f64, y: f64, width: f64, height: f64) -> Bounds {
    (x.round() as i32, y.round() as i32, width.round().max(1.0) as i32, height.round().max(1.0) as i32)
}

/// Moves the main webview into the overlay browser panes are drawn on. Once, right after the main
/// webview is made.
pub fn install(main: &Webview) -> Result<(), String> {
    main.with_webview(|pw| {
        let main: gtk::Widget = pw.inner().upcast();
        let Some(parent) = main.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else {
            eprintln!("browser panes: the main webview isn't in a GtkBox, so pages can't be placed");
            return;
        };
        let at = parent.children().iter().position(|c| *c == main).unwrap_or(0) as i32;
        let overlay = gtk::Overlay::new();
        overlay.connect_get_child_position(|_, child| {
            // SAFETY: BOUNDS is only ever set to a `Bounds`, by `adopt` and `place`.
            let (x, y, width, height) = unsafe { *child.data::<Bounds>(BOUNDS)?.as_ref() };
            Some(gtk::Rectangle::new(x, y, width, height))
        });
        // `main` holds a reference, so the webview survives leaving the box.
        parent.remove(&main);
        overlay.add(&main);
        parent.pack_start(&overlay, true, true, 0);
        parent.reorder_child(&overlay, at);
        overlay.show();
        main.grab_focus();
        LAYER.with(|l| *l.borrow_mut() = Some(overlay));
    })
    .map_err(|e| e.to_string())
}

/// Moves a newly made browser pane from the window's box onto the overlay, at these bounds.
pub fn adopt(webview: &Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let b = bounds(x, y, width, height);
    webview
        .with_webview(move |pw| {
            let pane: gtk::Widget = pw.inner().upcast();
            // SAFETY: see `install`.
            unsafe { pane.set_data(BOUNDS, b) };
            let Some(overlay) = LAYER.with(|l| l.borrow().clone()) else {
                eprintln!("browser panes: no overlay to place pages on");
                return;
            };
            if let Some(parent) = pane.parent() {
                if parent == *overlay.upcast_ref::<gtk::Widget>() {
                    return;
                }
                if let Ok(parent) = parent.downcast::<gtk::Container>() {
                    parent.remove(&pane);
                }
            }
            overlay.add_overlay(&pane);
        })
        .map_err(|e| e.to_string())
}

/// Moves and resizes a browser pane (logical pixels relative to the main webview).
pub fn place(webview: &Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let b = bounds(x, y, width, height);
    webview
        .with_webview(move |pw| {
            let pane: gtk::Widget = pw.inner().upcast();
            // SAFETY: see `install`.
            unsafe { pane.set_data(BOUNDS, b) };
            pane.queue_resize();
        })
        .map_err(|e| e.to_string())
}
