//! Environments and project icons: the ssh aliases offered by "New environment",
//! and the logo files a project folder already has (local or over ssh).

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
    "logo.svg", "logo.png", "icon.svg", "icon.png", "favicon.svg", "favicon.png", "favicon.ico",
    "public/logo.svg", "public/logo.png", "public/icon.svg", "public/icon.png",
    "public/favicon.svg", "public/favicon.png", "public/favicon.ico",
    "static/logo.svg", "static/favicon.svg", "static/favicon.png", "static/favicon.ico",
    "assets/logo.svg", "assets/logo.png", "assets/icon.svg", "assets/icon.png",
    "src/assets/logo.svg", "src/assets/logo.png",
    "app/icon.svg", "app/icon.png", "app/favicon.ico",
    "src/app/icon.svg", "src/app/icon.png", "src/app/favicon.ico",
    "src-tauri/icons/icon.png", "src-tauri/icons/128x128.png",
    ".github/logo.svg", ".github/logo.png", "docs/logo.svg", "docs/logo.png",
];

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
    match file.rsplit('.').next().unwrap_or("") {
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "image/png",
    }
}

fn data_url(file: &str, b64: &str) -> String {
    format!("data:{};base64,{b64}", mime(file))
}

fn scan_local(path: &str) -> Vec<Logo> {
    let root = std::path::PathBuf::from(expand_home(path));
    LOGO_FILES
        .iter()
        .filter_map(|f| {
            let p = root.join(f);
            let meta = std::fs::metadata(&p).ok()?;
            if !meta.is_file() || meta.len() > MAX_LOGO_BYTES {
                return None;
            }
            let bytes = std::fs::read(&p).ok()?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            Some(Logo { file: f.to_string(), data_url: data_url(f, &b64) })
        })
        .collect()
}

/// Remote script: for each logo file that exists, print `==<file>` then the file as base64.
fn remote_script(path: &str) -> String {
    let files = LOGO_FILES.iter().map(|f| sq(f)).collect::<Vec<_>>().join(" ");
    let inner = format!(
        "cd {} || exit 1; for f in {files}; do [ -f \"$f\" ] || continue; s=$(wc -c < \"$f\"); [ $s -le {MAX_LOGO_BYTES} ] || continue; printf '==%s\\n' \"$f\"; base64 < \"$f\"; done; true",
        remote_path(path)
    );
    format!("sh -c {}", sq(&inner))
}

fn parse_remote(text: &str) -> Vec<Logo> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        match line.strip_prefix("==") {
            Some(file) => out.push((file.to_string(), String::new())),
            None => {
                if let Some((_, b64)) = out.last_mut() {
                    b64.extend(line.chars().filter(|c| !c.is_whitespace()));
                }
            }
        }
    }
    out.into_iter()
        .filter(|(_, b64)| base64::engine::general_purpose::STANDARD.decode(b64).is_ok())
        .map(|(file, b64)| Logo { data_url: data_url(&file, &b64), file })
        .collect()
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
        std::fs::write(root.join("src-tauri/icons/icon.png"), vec![7u8; 200]).unwrap();
        std::fs::write(root.join("favicon.svg"), "<svg/>").unwrap();
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(remote_script(&root.to_string_lossy()))
            .output()
            .unwrap();
        std::fs::remove_dir_all(&root).ok();
        let logos = parse_remote(&String::from_utf8_lossy(&out.stdout));
        let files: Vec<_> = logos.iter().map(|l| l.file.as_str()).collect();
        assert_eq!(files, ["favicon.svg", "src-tauri/icons/icon.png"], "{out:?}");
        assert_eq!(logos[0].data_url, "data:image/svg+xml;base64,PHN2Zy8+");
        // 200 bytes wrap across lines in `base64` output; the parser joins them.
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(logos[1].data_url.split(',').nth(1).unwrap()).unwrap(), vec![7u8; 200]);
    }
}
