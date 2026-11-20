//! Browser screenshots for Select element and Screenshot (pick.js): a native snapshot of a page's
//! visible area, as a PNG. pick.js asks for one by navigating to `tricode.invalid/capture` (it shows
//! the image frozen, to draw on, or as thumbnails), and sends crop rects with a `/pick` result; those
//! are cut from a snapshot taken then, with any marks drawn over the frozen image in it, and handed
//! to the frontend as PNGs to save where pasted images go.
//!
//! Each session started by browser_pick gets a token that captures must carry: any page can
//! navigate to tricode.invalid itself, and a snapshot shows cross-origin frames a page can't read.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use tauri::{AppHandle, Emitter, Webview};

use crate::browser::find;

/// How long a session's token works without being used to send.
const TOKEN_LIFE: Duration = Duration::from_secs(30 * 60);

fn tokens() -> MutexGuard<'static, HashMap<String, (String, Instant)>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    TOKENS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// A new session in page `label`: its token, replacing the one before.
pub fn new_token(label: &str) -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("no random source");
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    tokens().insert(label.to_string(), (token.clone(), Instant::now()));
    token
}

/// Whether `token` is page `label`'s live session.
fn valid(label: &str, token: &str) -> bool {
    tokens().get(label).is_some_and(|(t, at)| !token.is_empty() && t == token && at.elapsed() < TOKEN_LIFE)
}

pub fn forget(label: &str) {
    tokens().remove(label);
}

/// A rectangle in the page's CSS pixels, relative to the viewport.
#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq)]
pub struct Rect(pub f64, pub f64, pub f64, pub f64);

#[derive(Clone, serde::Serialize)]
pub struct PickPayload {
    pub label: String,
    /// The selection described for the agent, ready to type; `⟦shot N⟧` stands for image N's path.
    pub text: String,
    /// The agent window chosen in the composer (a tab id), or "" for the default.
    pub to: String,
    /// An agent to start first and type into ("claude", "pi"), or "".
    pub new: String,
    /// The screenshots, as base64 PNGs, in `⟦shot N⟧` order.
    pub images: Vec<String>,
    /// What the screenshot failed with, if it did.
    pub error: String,
    /// Copy the text instead of typing it into an agent.
    pub copy: bool,
    /// The composer's Screenshot switch, to remember for the project; None when not reported.
    pub shot: Option<bool>,
}

/// pick.js asked for a snapshot: give it one as base64, or the error.
pub fn on_capture(app: &AppHandle, label: &str, token: &str) {
    if !valid(label, token) {
        return;
    }
    let (app, label) = (app.clone(), label.to_string());
    tauri::async_runtime::spawn(async move {
        let Ok(webview) = find(&app, &label) else { return };
        let (image, error) = match capture(&webview).await {
            Ok(png) => (b64(&png), String::new()),
            Err(e) => (String::new(), e),
        };
        let js = format!(
            "window.__tricodeImage && window.__tricodeImage({}, {})",
            serde_json::to_string(&image).unwrap_or_default(),
            serde_json::to_string(&error).unwrap_or_default()
        );
        if let Err(e) = webview.eval(js) {
            eprintln!("browser capture reply failed: {e}");
        }
    });
}

/// A result with screenshots: take the snapshot now, cut `rects` from it (`vw` is the page's
/// viewport width in CSS pixels), report it all, then let pick.js take its overlay down.
pub fn on_send(app: &AppHandle, token: &str, rects: Vec<Rect>, vw: f64, mut payload: PickPayload) {
    let label = payload.label.clone();
    if !valid(&label, token) {
        return;
    }
    forget(&label);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(webview) = find(&app, &label) else { return };
        match capture(&webview).await.and_then(|png| crop(&png, &rects, vw)) {
            Ok(pngs) => payload.images = pngs.iter().map(|p| b64(p)).collect(),
            Err(e) => payload.error = e,
        }
        let _ = webview.eval("window.__tricodeDone && window.__tricodeDone()");
        // The frontend copies once the images are saved, and the clipboard only takes text from
        // a focused document: the app's, not the page's, whose session is over.
        if payload.copy {
            if let Some(main) = tauri::Manager::get_webview(&app, "main") {
                let _ = main.set_focus();
            }
        }
        let _ = app.emit("browser-pick", payload);
    });
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The page's visible area as a PNG, at device pixels. WebView2: the DevTools protocol.
#[cfg(windows)]
async fn capture(webview: &Webview) -> Result<Vec<u8>, String> {
    let params = r#"{"format":"png","captureBeyondViewport":false}"#.to_string();
    let json = crate::browser_debug::cdp_call(webview, "Page.captureScreenshot".into(), params).await?;
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let data = v["data"].as_str().ok_or("the screenshot came back empty")?;
    base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())
}

/// WKWebView: takeSnapshot, its NSImage turned into a PNG.
#[cfg(target_os = "macos")]
async fn capture(webview: &Webview) -> Result<Vec<u8>, String> {
    use std::cell::Cell;

    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    webview
        .with_webview(move |pw| {
            let tx = Cell::new(Some(tx));
            let done = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let Some(tx) = tx.take() else { return };
                // SAFETY: WebKit passes a live image or error (or null) for the duration of the call.
                let result = unsafe {
                    match (image.as_ref(), error.as_ref()) {
                        (Some(image), _) => image
                            .TIFFRepresentation()
                            .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                            .and_then(|rep| rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()))
                            .map(|png| png.to_vec())
                            .ok_or_else(|| "the screenshot couldn't be turned into a PNG".to_string()),
                        (None, Some(e)) => Err(e.localizedDescription().to_string()),
                        (None, None) => Err("the screenshot came back empty".to_string()),
                    }
                };
                let _ = tx.send(result);
            });
            // SAFETY: inner() is the live WKWebView, and with_webview runs us on the main thread.
            unsafe {
                let view = &*(pw.inner() as *const WKWebView);
                view.takeSnapshotWithConfiguration_completionHandler(None, &done);
            }
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "the screenshot was dropped".to_string())?
}

/// WebKitGTK: a snapshot of the visible region, as a cairo surface.
#[cfg(target_os = "linux")]
async fn capture(webview: &Webview) -> Result<Vec<u8>, String> {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    webview
        .with_webview(move |pw| {
            pw.inner().snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gtk::gio::Cancellable>, move |r| {
                let _ = tx.send(r.map_err(|e| e.to_string()).and_then(surface_png));
            });
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "the screenshot was dropped".to_string())?
}

#[cfg(target_os = "linux")]
fn surface_png(surface: gtk::cairo::Surface) -> Result<Vec<u8>, String> {
    use gtk::cairo::{Context, Format, ImageSurface};

    let src = ImageSurface::try_from(surface).map_err(|_| "the screenshot isn't an image".to_string())?;
    let (w, h) = (src.width(), src.height());
    // Painted into a surface of our own, at the source's scale, so its pixels can be read.
    let out = ImageSurface::create(Format::ARgb32, w, h).map_err(|e| e.to_string())?;
    let (sx, sy) = src.device_scale();
    out.set_device_scale(sx, sy);
    {
        let cr = Context::new(&out).map_err(|e| e.to_string())?;
        cr.set_source_surface(&src, 0.0, 0.0).map_err(|e| e.to_string())?;
        cr.paint().map_err(|e| e.to_string())?;
    }
    drop(src);
    let stride = out.stride() as usize;
    let data = out.take_data().map_err(|e| e.to_string())?;
    let (w, h) = (w as usize, h as usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    for row in data.chunks(stride).take(h) {
        for px in row[..w * 4].chunks_exact(4) {
            // ARGB32 is a native-endian u32 with premultiplied alpha.
            let v = u32::from_ne_bytes([px[0], px[1], px[2], px[3]]);
            let a = (v >> 24) as u8;
            let un = |c: u32| if a == 0 { 0 } else { ((c & 0xff) * 255 / a as u32).min(255) as u8 };
            rgba.extend_from_slice(&[un(v >> 16), un(v >> 8), un(v), a]);
        }
    }
    encode(w as u32, h as u32, &rgba)
}

/// An RGBA image: its size and pixels.
struct Pixels {
    w: u32,
    h: u32,
    rgba: Vec<u8>,
}

fn decode(png: &[u8]) -> Result<Pixels, String> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(png));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = dec.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => buf.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("unexpected indexed PNG".into()),
    };
    Ok(Pixels { w: info.width, h: info.height, rgba })
}

fn encode(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// A CSS-pixel rect as whole image pixels, clipped to the image; None when nothing is left.
fn to_pixels(r: Rect, scale: f64, w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
    let x0 = (r.0 * scale).floor().clamp(0.0, w as f64) as u32;
    let y0 = (r.1 * scale).floor().clamp(0.0, h as f64) as u32;
    let x1 = ((r.0 + r.2) * scale).ceil().clamp(0.0, w as f64) as u32;
    let y1 = ((r.1 + r.3) * scale).ceil().clamp(0.0, h as f64) as u32;
    (x1 > x0 && y1 > y0).then(|| (x0, y0, x1 - x0, y1 - y0))
}

/// Cuts each rect out of a snapshot. The image is in device pixels and the rects in CSS pixels,
/// so the scale is the image's width over the viewport's (`vw`). A rect covering it all is the
/// snapshot as it came.
fn crop(png: &[u8], rects: &[Rect], vw: f64) -> Result<Vec<Vec<u8>>, String> {
    let img = decode(png)?;
    let scale = if vw > 0.0 { img.w as f64 / vw } else { 1.0 };
    rects
        .iter()
        .map(|&r| {
            let (x, y, w, h) = to_pixels(r, scale, img.w, img.h).ok_or("the area to capture is off the screen")?;
            if (x, y, w, h) == (0, 0, img.w, img.h) {
                return Ok(png.to_vec());
            }
            let row = img.w as usize * 4;
            let mut out = Vec::with_capacity(w as usize * h as usize * 4);
            for line in y..y + h {
                let start = line as usize * row + x as usize * 4;
                out.extend_from_slice(&img.rgba[start..start + w as usize * 4]);
            }
            encode(w, h, &out)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A w×h image whose pixel (x, y) is [x, y, 7, 255].
    fn sample(w: u32, h: u32) -> Vec<u8> {
        let rgba: Vec<u8> = (0..h).flat_map(|y| (0..w).flat_map(move |x| [x as u8, y as u8, 7, 255])).collect();
        encode(w, h, &rgba).unwrap()
    }

    #[test]
    fn crops_at_the_device_scale() {
        // A 20×10 snapshot of a 10 CSS px wide viewport: 2 device px per CSS px.
        let out = crop(&sample(20, 10), &[Rect(2.0, 1.0, 3.0, 2.0)], 10.0).unwrap();
        let img = decode(&out[0]).unwrap();
        assert_eq!((img.w, img.h), (6, 4));
        assert_eq!(&img.rgba[..4], &[4, 2, 7, 255]);
    }

    #[test]
    fn clips_to_the_image_and_refuses_what_is_off_it() {
        let png = sample(10, 10);
        let img = decode(&crop(&png, &[Rect(-5.0, 8.0, 10.0, 10.0)], 10.0).unwrap()[0]).unwrap();
        assert_eq!((img.w, img.h), (5, 2));
        assert!(crop(&png, &[Rect(20.0, 0.0, 5.0, 5.0)], 10.0).is_err());
    }

    #[test]
    fn the_whole_snapshot_comes_back_as_it_was() {
        let png = sample(8, 6);
        assert_eq!(crop(&png, &[Rect(0.0, 0.0, 8.0, 6.0)], 8.0).unwrap()[0], png);
    }

    #[test]
    fn tokens_belong_to_their_page() {
        let t = new_token("browser-test-a");
        assert!(valid("browser-test-a", &t));
        assert!(!valid("browser-test-b", &t));
        assert!(!valid("browser-test-a", ""));
        new_token("browser-test-a");
        assert!(!valid("browser-test-a", &t), "a new session replaces the old token");
        forget("browser-test-a");
    }
}
