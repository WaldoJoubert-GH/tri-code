//! Environments and project icons: the ssh aliases offered by "New environment",
//! and the logo files a project folder already has (local or over ssh).

use std::collections::HashSet;

use base64::Engine;
use serde::Serialize;

use crate::remote;
use crate::spawn::{expand_home, remote_path, sq};

/// Concrete `Host` aliases from `~/.ssh/config`, in file order. Patterns with
/// wildcards or negation are skipped, and so are `Include`d files.
#[tauri::command]
pub async fn ssh_hosts() -> Vec<String> {
    let text = std::fs::read_to_string(expand_home("~/.ssh/config")).unwrap_or_default();
    parse_hosts(&text)
}

fn parse_hosts(text: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let (key, rest) = line.split_once(|c: char| c.is_whitespace() || c == '=').unwrap_or((line, ""));
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for h in rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=').split_whitespace() {
            if h.starts_with('#') {
                break;
            }
            if !h.contains(['*', '?', '!']) && !hosts.iter().any(|x| x == h) {
                hosts.push(h.to_string());
            }
        }
    }
    hosts
}

/// Where projects keep a logo, most specific first. The first hit is the auto icon.
const LOGO_FILES: &[&str] = &[
    // root
    "logo.svg", "logo.png", "icon.svg", "icon.png", "favicon.svg", "favicon.png", "favicon.ico",
    "apple-touch-icon.png", "apple-touch-icon-precomposed.png",
    // web static folders
    "public/logo.svg", "public/logo.png", "public/icon.svg", "public/icon.png",
    "public/favicon.svg", "public/favicon.png", "public/favicon.ico",
    "public/favicon-16x16.png", "public/favicon-32x32.png", "public/apple-touch-icon.png",
    "public/android-chrome-192x192.png", "public/android-chrome-512x512.png",
    "static/logo.svg", "static/logo.png", "static/icon.svg", "static/icon.png",
    "static/favicon.svg", "static/favicon.png", "static/favicon.ico",
    "www/logo.svg", "www/logo.png", "www/favicon.ico",
    // source assets
    "assets/logo.svg", "assets/logo.png", "assets/icon.svg", "assets/icon.png",
    "src/assets/logo.svg", "src/assets/logo.png", "src/assets/icon.svg", "src/assets/icon.png",
    // framework conventions
    "app/icon.svg", "app/icon.png", "app/favicon.ico", "app/apple-icon.png",
    "src/app/icon.svg", "src/app/icon.png", "src/app/favicon.ico", "src/app/apple-icon.png",
    "src/favicon.ico",
    // desktop shells
    "src-tauri/icons/icon.png", "src-tauri/icons/128x128.png",
    "resources/icon.png", "build/icon.png", "electron/icon.png", "main/icon.png",
    // docs
    ".github/logo.svg", ".github/logo.png", "docs/logo.svg", "docs/logo.png", "docs/icon.svg",
];

/// A file whose name contains one of these (and has a logo extension) is a logo too,
/// wherever it sits in the project. This is how an SVG logo or favicon outside the
/// curated list above is still picked up.
const LOGO_KEYS: &[&str] = &["favicon", "logo", "brand", "wordmark", "mark", "icon"];
/// Extensions a logo can have. SVG first: it stays sharp at any size.
const LOGO_EXTS: &[&str] = &["svg", "png", "ico", "webp", "jpg", "jpeg"];
/// Directories never worth walking into.
const NOISE_DIRS: &[&str] = &[
    "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", "coverage",
    ".next", ".nuxt", ".svelte-kit", "vendor", ".venv", "venv", "__pycache__", ".cache",
    ".turbo", ".parcel-cache", ".yarn",
];
/// How deep the generic walk goes below the project root.
const MAX_LOGO_DEPTH: usize = 4;
/// Most logos offered; the sort keeps the likely ones, so big repos stay small.
const MAX_LOGOS: usize = 60;
/// Generic matches fetched from a remote host (the curated list is always sent first).
const MAX_REMOTE_MATCHES: usize = 120;

/// Bigger files are skipped: an icon is drawn at 18px.
const MAX_LOGO_BYTES: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
pub struct Logo {
    /// Path relative to the project folder.
    pub file: String,
    pub data_url: String,
}

#[tauri::command]
pub async fn scan_logos(host: String, path: String) -> Result<Vec<Logo>, String> {
    tauri::async_runtime::spawn_blocking(move || match host.as_str() {
        "" | "local" => Ok(scan_local(&path)),
        _ => scan_remote(&host, &path),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn mime(file: &str) -> &'static str {
    match file.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "image/png",
    }
}

fn data_url(file: &str, b64: &str) -> String {
    format!("data:{};base64,{b64}", mime(file))
}

/// A filename looks like a logo when its extension is one of LOGO_EXTS and its stem
/// contains one of LOGO_KEYS.
fn is_logo_file(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    if !LOGO_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
        return false;
    }
    let stem = stem.to_ascii_lowercase();
    LOGO_KEYS.iter().any(|k| stem.contains(k))
}

/// Sort key for a logo: the curated list first, then by name and extension, shallow
/// files before deep ones. SVG and favicon/logo names win.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Rank(u8, usize, u8, usize, String);

fn rank(file: &str) -> Rank {
    if let Some(i) = LOGO_FILES.iter().position(|f| *f == file) {
        return Rank(0, i, 0, 0, file.to_string());
    }
    let name = file.rsplit('/').next().unwrap_or(file);
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    let stem = stem.to_ascii_lowercase();
    let key = LOGO_KEYS.iter().position(|k| stem.contains(k)).unwrap_or(LOGO_KEYS.len());
    let ext = LOGO_EXTS.iter().position(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(LOGO_EXTS.len());
    Rank(1, key, ext as u8, file.matches('/').count(), file.to_string())
}

/// Order, dedupe and cap a set of found paths.
fn order(paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut paths: Vec<String> = paths.into_iter().filter(|p| seen.insert(p.clone())).collect();
    paths.sort_by_key(|p| rank(p));
    paths.truncate(MAX_LOGOS);
    paths
}

fn read_logo(root: &std::path::Path, file: &str) -> Option<Logo> {
    let p = root.join(file);
    let meta = std::fs::metadata(&p).ok()?;
    if !meta.is_file() || meta.len() > MAX_LOGO_BYTES {
        return None;
    }
    let bytes = std::fs::read(&p).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(Logo { file: file.to_string(), data_url: data_url(file, &b64) })
}

/// Collect logo-named files below `rel`, skipping NOISE_DIRS and stopping at
/// MAX_LOGO_DEPTH.
fn walk_logos(root: &std::path::Path, rel: &std::path::Path, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_LOGO_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root.join(rel)) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = rel.join(&name);
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if !NOISE_DIRS.contains(&name.as_str()) {
                walk_logos(root, &child, depth + 1, out);
            }
        } else if kind.is_file() && is_logo_file(&name) {
            out.push(child.to_string_lossy().replace('\\', "/"));
        }
    }
}

fn scan_local(path: &str) -> Vec<Logo> {
    let root = std::path::PathBuf::from(expand_home(path));
    let mut files: Vec<String> = LOGO_FILES
        .iter()
        .filter(|f| root.join(f).is_file())
        .map(|f| f.to_string())
        .collect();
    walk_logos(&root, std::path::Path::new(""), 0, &mut files);
    order(files).iter().filter_map(|f| read_logo(&root, f)).collect()
}

/// Remote script: the curated list first, then a filtered `find` for SVG logos and
/// favicons elsewhere. Each match prints `==<file>` then the file as base64.
fn remote_script(path: &str) -> String {
    let files = LOGO_FILES.iter().map(|f| sq(f)).collect::<Vec<_>>().join(" ");
    let prune = NOISE_DIRS.iter().map(|d| format!("-name {}", sq(d))).collect::<Vec<_>>().join(" -o ");
    let exts = LOGO_EXTS
        .iter()
        .map(|e| format!("*.{e}|*.{}", e.to_ascii_uppercase()))
        .collect::<Vec<_>>()
        .join("|");
    let keys = LOGO_KEYS.iter().map(|k| format!("*{k}*")).collect::<Vec<_>>().join("|");
    let inner = format!(
        "cd {root} || exit 1; \
         for f in {files}; do [ -f \"$f\" ] || continue; s=$(wc -c < \"$f\"); [ $s -le {max} ] || continue; printf '==%s\\n' \"$f\"; base64 < \"$f\"; done; \
         find . \\( {prune} \\) -prune -o -type f -print | sort | while IFS= read -r f; do \
           case \"$f\" in {exts}) ;; *) continue;; esac; \
           b=${{f##*/}}; lc=$(printf '%s' \"$b\" | tr '[:upper:]' '[:lower:]'); \
           case \"$lc\" in {keys}) ;; *) continue;; esac; \
           n=$((n+1)); [ $n -le {cap} ] || break; \
           s=$(wc -c < \"$f\"); [ $s -le {max} ] || continue; \
           printf '==%s\\n' \"${{f#./}}\"; base64 < \"$f\"; \
         done; true",
        root = remote_path(path),
        max = MAX_LOGO_BYTES,
        cap = MAX_REMOTE_MATCHES,
    );
    format!("sh -c {}", sq(&inner))
}

fn parse_remote(text: &str) -> Vec<Logo> {
    let mut raw: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        match line.strip_prefix("==") {
            Some(file) => raw.push((file.to_string(), String::new())),
            None => {
                if let Some((_, b64)) = raw.last_mut() {
                    b64.extend(line.chars().filter(|c| !c.is_whitespace()));
                }
            }
        }
    }
    let mut seen = HashSet::new();
    let mut logos: Vec<Logo> = raw
        .into_iter()
        .filter(|(file, b64)| {
            seen.insert(file.clone())
                && base64::engine::general_purpose::STANDARD.decode(b64).is_ok()
        })
        .map(|(file, b64)| Logo { data_url: data_url(&file, &b64), file })
        .collect();
    logos.sort_by_key(|l| rank(&l.file));
    logos.truncate(MAX_LOGOS);
    logos
}

fn scan_remote(host: &str, path: &str) -> Result<Vec<Logo>, String> {
    Ok(parse_remote(&remote::run(host, &remote_script(path))?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_skip_patterns_and_keep_order() {
        let cfg = "Host *\n  ServerAliveInterval 30\nHost devbox pi\n  HostName 10.0.0.2\nhost=gpu-box # note\nHost *.lan !bad nas\nMatch host x\nHost devbox\n";
        assert_eq!(parse_hosts(cfg), ["devbox", "pi", "gpu-box", "nas"]);
    }

    #[test]
    fn local_scan_picks_up_svg_logos_and_favicons() {
        let root = std::env::temp_dir().join(format!("tri-logos-extra-{}", std::process::id()));
        for d in ["app/assets/brand", "src/assets/icons", "node_modules/pkg", "public"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("app/assets/brand/mark.svg"), "<svg/>").unwrap();
        std::fs::write(root.join("src/assets/icons/close.svg"), "<svg/>").unwrap();
        std::fs::write(root.join("public/favicon-32x32.png"), [0u8; 16]).unwrap();
        std::fs::write(root.join("node_modules/pkg/logo.svg"), "<svg/>").unwrap();
        let logos = scan_local(&root.to_string_lossy());
        std::fs::remove_dir_all(&root).ok();
        let files: Vec<_> = logos.iter().map(|l| l.file.as_str()).collect();
        assert!(files.contains(&"app/assets/brand/mark.svg"), "{files:?}");
        assert!(files.contains(&"public/favicon-32x32.png"), "{files:?}");
        assert!(!files.contains(&"src/assets/icons/close.svg"), "{files:?}");
        assert!(!files.contains(&"node_modules/pkg/logo.svg"), "{files:?}");
        assert!(logos.iter().any(|l| l.file == "app/assets/brand/mark.svg" && l.data_url.starts_with("data:image/svg+xml")));
    }

    #[test]
    fn local_scan_finds_logos_in_priority_order() {
        let root = std::env::temp_dir().join(format!("tri-logos-{}", std::process::id()));
        std::fs::create_dir_all(root.join("public")).unwrap();
        std::fs::write(root.join("public/favicon.ico"), [0u8, 0, 1, 0]).unwrap();
        std::fs::write(root.join("logo.svg"), "<svg/>").unwrap();
        std::fs::write(root.join("icon.png"), vec![0u8; (MAX_LOGO_BYTES + 1) as usize]).unwrap();
        let logos = scan_local(&root.to_string_lossy());
        std::fs::remove_dir_all(&root).ok();
        let files: Vec<_> = logos.iter().map(|l| l.file.as_str()).collect();
        assert_eq!(files, ["logo.svg", "public/favicon.ico"]);
        assert_eq!(logos[0].data_url, "data:image/svg+xml;base64,PHN2Zy8+");
    }

    #[cfg(unix)]
    #[test]
    fn remote_script_runs_in_a_real_shell() {
        let root = std::env::temp_dir().join(format!("tri-rlogos-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src-tauri/icons")).unwrap();
        std::fs::create_dir_all(root.join("app/assets/brand")).unwrap();
        std::fs::write(root.join("src-tauri/icons/icon.png"), vec![7u8; 200]).unwrap();
        std::fs::write(root.join("favicon.svg"), "<svg/>").unwrap();
        std::fs::write(root.join("app/assets/brand/mark.svg"), "<svg/>").unwrap();
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(remote_script(&root.to_string_lossy()))
            .output()
            .unwrap();
        std::fs::remove_dir_all(&root).ok();
        let logos = parse_remote(&String::from_utf8_lossy(&out.stdout));
        let files: Vec<_> = logos.iter().map(|l| l.file.as_str()).collect();
        // The curated list first, then the SVG logo the `find` pass picked up.
        assert_eq!(files, ["favicon.svg", "src-tauri/icons/icon.png", "app/assets/brand/mark.svg"], "{out:?}");
        assert_eq!(logos[0].data_url, "data:image/svg+xml;base64,PHN2Zy8+");
        // 200 bytes wrap across lines in `base64` output; the parser joins them.
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(logos[1].data_url.split(',').nth(1).unwrap()).unwrap(), vec![7u8; 200]);
    }
}
