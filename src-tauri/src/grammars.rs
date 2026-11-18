//! Installed editor grammars (src/langs.ts): TextMate grammar files from the tm-grammars package,
//! one `<name>.json` per grammar in `<app_local_data_dir>/grammars`. Downloaded once from a CDN at
//! the version the frontend's Grammar Catalog was made from, and checked against the catalog's
//! SHA-256 before it is kept; after that the editor reads them offline.

use std::path::PathBuf;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// Where the package's files are served; the first that answers with the right file wins.
const MIRRORS: &[&str] = &["https://cdn.jsdelivr.net/npm/tm-grammars@{v}/grammars/{n}.json", "https://unpkg.com/tm-grammars@{v}/grammars/{n}.json"];

/// The largest grammar in the package is about 1 MB.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("grammars"))
}

/// A grammar name as tm-grammars spells them (`zig`, `objective-cpp`); anything else could leave the folder.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !name.starts_with('-')
}

fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("not a grammar name: {name}"));
    }
    Ok(dir(app)?.join(format!("{name}.json")))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The names of the installed grammars.
#[tauri::command]
pub fn grammar_list(app: AppHandle) -> Result<Vec<String>, String> {
    let entries = match std::fs::read_dir(dir(&app)?) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter_map(|n| n.strip_suffix(".json").map(str::to_owned))
        .filter(|n| valid_name(n))
        .collect();
    out.sort();
    Ok(out)
}

/// An installed grammar's text.
#[tauri::command]
pub fn grammar_read(app: AppHandle, name: String) -> Result<String, String> {
    std::fs::read_to_string(file(&app, &name)?).map_err(|e| format!("{name}: {e}"))
}

fn fetch(version: &str, name: &str, sha256: &str) -> Result<Vec<u8>, String> {
    let config = ureq::config::Config::builder().timeout_global(Some(Duration::from_secs(60))).build();
    let agent = ureq::Agent::new_with_config(config);
    let mut errors = vec![];
    for m in MIRRORS {
        let url = m.replace("{v}", version).replace("{n}", name);
        let body = agent
            .get(&url)
            .call()
            .map_err(|e| e.to_string())
            .and_then(|r| r.into_body().with_config().limit(MAX_BYTES).read_to_vec().map_err(|e| e.to_string()));
        match body {
            Ok(b) if hex(&Sha256::digest(&b)) == sha256 => return Ok(b),
            Ok(_) => errors.push(format!("{url}: not the expected file")),
            Err(e) => errors.push(format!("{url}: {e}")),
        }
    }
    Err(format!("Couldn't download the {name} grammar.\n{}", errors.join("\n")))
}

/// Download one grammar of tm-grammars `version` and keep it if its SHA-256 (hex) matches.
#[tauri::command]
pub async fn grammar_install(app: AppHandle, version: String, name: String, sha256: String) -> Result<(), String> {
    if !valid_version(&version) {
        return Err(format!("not a version: {version}"));
    }
    let path = file(&app, &name)?;
    let sha = sha256.to_ascii_lowercase();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fetch(&version, &name, &sha)?;
        let parent = path.parent().ok_or("no grammars folder")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        // Written aside then renamed, so a grammar is never read half-written.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete installed grammars; one that isn't there is already gone.
#[tauri::command]
pub fn grammar_remove(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    for n in names {
        match std::fs::remove_file(file(&app, &n)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("{n}: {e}")),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_in_the_folder() {
        assert!(valid_name("zig"));
        assert!(valid_name("objective-cpp"));
        assert!(valid_name("actionscript-3"));
        assert!(!valid_name(""));
        assert!(!valid_name("../state"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("Zig"));
        assert!(!valid_name("-x"));
    }

    #[test]
    fn versions_are_exact() {
        assert!(valid_version("1.32.22"));
        assert!(!valid_version("1.32"));
        assert!(!valid_version("latest"));
        assert!(!valid_version("1.32.x"));
        assert!(!valid_version("1..2"));
    }

    #[test]
    fn hex_is_lowercase() {
        assert_eq!(hex(&[0x0a, 0xff]), "0aff");
    }
}
