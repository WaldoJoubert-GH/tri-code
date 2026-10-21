//! Per-environment ssh options and the PIN lock.
//!
//! The frontend owns both (`envSsh` and `envLocks` in state.json) and pushes them
//! here on load and on change, so every ssh call keeps passing just `host` and picks
//! up its key file and port from `args`. A locked host refuses every ssh call until
//! `env_unlock` is given the right PIN. This is a gate inside tri-code, not
//! encryption: the key file on disk is untouched.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, RwLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::spawn::expand_home;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvSsh {
    /// `-i`; `~` expands to the home folder.
    pub identity_file: Option<String>,
    /// `-p`
    pub port: Option<String>,
    /// Extra `-o` values, e.g. `StrictHostKeyChecking=accept-new`.
    #[serde(default)]
    pub options: Vec<String>,
}

static CONFIG: LazyLock<RwLock<HashMap<String, EnvSsh>>> = LazyLock::new(Default::default);
static LOCKED: LazyLock<RwLock<HashSet<String>>> = LazyLock::new(Default::default);

/// ssh arguments for `host`, to go before the destination.
pub fn args(host: &str) -> Vec<String> {
    let Some(c) = CONFIG.read().unwrap().get(host).cloned() else { return Vec::new() };
    let mut out = Vec::new();
    if let Some(key) = c.identity_file.filter(|k| !k.is_empty()) {
        // Only this key: with several in the agent the server can hit MaxAuthTries first.
        out.extend(["-i".into(), expand_home(&key), "-o".into(), "IdentitiesOnly=yes".into()]);
    }
    if let Some(port) = c.port.filter(|p| !p.is_empty()) {
        out.extend(["-p".into(), port]);
    }
    for o in c.options {
        out.extend(["-o".into(), o]);
    }
    out
}

/// Err while `host` is locked, so nothing reaches it until the PIN is entered.
pub fn check(host: &str) -> Result<(), String> {
    if LOCKED.read().unwrap().contains(host) {
        return Err(format!("{host} is locked: enter its PIN"));
    }
    Ok(())
}

#[tauri::command]
pub fn env_ssh_set(host: String, ssh: Option<EnvSsh>) {
    let mut map = CONFIG.write().unwrap();
    match ssh {
        Some(s) => map.insert(host, s),
        None => map.remove(&host),
    };
}

#[derive(Debug, Serialize, PartialEq)]
pub struct PinHash {
    pub salt: String,
    pub hash: String,
}

fn digest(salt: &str, pin: &str) -> String {
    // Stretched so a copied state.json costs a little more to brute-force. With
    // 4–8 digits it is still a gate, not a secret.
    let mut h = Sha256::digest(format!("{salt}:{pin}"));
    for _ in 0..50_000 {
        h = Sha256::digest(h);
    }
    h.iter().map(|b| format!("{b:02x}")).collect()
}

fn new_salt() -> String {
    use std::hash::{BuildHasher, RandomState};
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let a = RandomState::new().hash_one(nanos);
    let b = RandomState::new().hash_one(a);
    format!("{a:016x}{b:016x}")
}

fn valid_pin(pin: &str) -> bool {
    (4..=8).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

/// Salt and hash for a new PIN, to keep in `envLocks`.
#[tauri::command]
pub async fn env_pin_hash(pin: String) -> Result<PinHash, String> {
    if !valid_pin(&pin) {
        return Err("PIN must be 4–8 digits".into());
    }
    let salt = new_salt();
    let hash = tauri::async_runtime::spawn_blocking({
        let salt = salt.clone();
        move || digest(&salt, &pin)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(PinHash { salt, hash })
}

#[tauri::command]
pub fn env_lock(host: String) {
    LOCKED.write().unwrap().insert(host);
}

/// Unlock `host` when `pin` matches the stored salt and hash.
#[tauri::command]
pub async fn env_unlock(host: String, pin: String, salt: String, hash: String) -> Result<(), String> {
    let ok = tauri::async_runtime::spawn_blocking(move || digest(&salt, &pin) == hash)
        .await
        .map_err(|e| e.to_string())?;
    if !ok {
        return Err("Wrong PIN".into());
    }
    LOCKED.write().unwrap().remove(&host);
    Ok(())
}

/// Drop a host's options and lock, when its environment is removed or its PIN is.
#[tauri::command]
pub fn env_forget_lock(host: String) {
    LOCKED.write().unwrap().remove(&host);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_put_key_port_and_options_before_the_host() {
        env_ssh_set(
            "t@1.2.3.4".into(),
            Some(EnvSsh { identity_file: Some("/k/my key.pem".into()), port: Some("2222".into()), options: vec!["A=b".into()] }),
        );
        assert_eq!(args("t@1.2.3.4"), ["-i", "/k/my key.pem", "-o", "IdentitiesOnly=yes", "-p", "2222", "-o", "A=b"]);
        assert!(args("other").is_empty());
        env_ssh_set("t@1.2.3.4".into(), None);
        assert!(args("t@1.2.3.4").is_empty());
    }

    #[test]
    fn lock_blocks_until_the_right_pin() {
        let h = "locked-test";
        let salt = new_salt();
        let hash = digest(&salt, "1234");
        env_lock(h.into());
        assert!(check(h).is_err());
        let rt = tauri::async_runtime::block_on;
        assert!(rt(env_unlock(h.into(), "9999".into(), salt.clone(), hash.clone())).is_err());
        assert!(check(h).is_err());
        assert!(rt(env_unlock(h.into(), "1234".into(), salt, hash)).is_ok());
        assert!(check(h).is_ok());
    }

    #[test]
    fn pins_are_4_to_8_digits() {
        assert!(valid_pin("1234") && valid_pin("12345678"));
        assert!(!valid_pin("123") && !valid_pin("123456789") && !valid_pin("12a4"));
    }
}
