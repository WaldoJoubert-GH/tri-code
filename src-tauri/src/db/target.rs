//! Where a Connection points: a `.env` variable, a URL with its password kept on the host,
//! or a SQLite file. Also the URL surgery a tunnel needs (point at 127.0.0.1:port).

use std::collections::BTreeMap;

use serde::Serialize;

use super::{Connection, Target};
use crate::devfs;

/// Passwords of URL Connections, on the project's host and out of `.dev/` (which other Dev
/// Clients read). Keyed by `<project path>#<connection id>`.
const SECRETS: &str = "~/.tri-code/secrets/databases.json";

/// The URL (or file path) to open, read on the project's host at connect time.
pub async fn resolve(host: &str, root: &str, conn: &Connection) -> Result<String, String> {
    let (host, root, conn) = (host.to_string(), root.to_string(), conn.clone());
    tauri::async_runtime::spawn_blocking(move || match &conn.target {
        Target::Env(key) => read_env(&host, &root)?
            .remove(key)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("{key} isn't set in the project's .env or .env.local")),
        Target::Url(url) => Ok(match secret(&host, &root, &conn.id)? {
            Some(pw) => with_password(url, &pw),
            None => url.clone(),
        }),
        Target::File(path) => Ok(path.clone()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct EnvVar {
    key: String,
    /// `postgres`, `sqlite` or `mongo`.
    kind: &'static str,
}

pub async fn env_vars(host: &str, root: &str) -> Result<Vec<EnvVar>, String> {
    let (host, root) = (host.to_string(), root.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        Ok(read_env(&host, &root)?
            .into_iter()
            .filter_map(|(key, v)| kind_of(&v).map(|kind| EnvVar { key, kind }))
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn kind_of(url: &str) -> Option<&'static str> {
    let u = url.to_ascii_lowercase();
    if u.starts_with("postgres://") || u.starts_with("postgresql://") {
        Some("postgres")
    } else if u.starts_with("mongodb://") || u.starts_with("mongodb+srv://") {
        Some("mongo")
    } else if u.starts_with("file:") || u.starts_with("sqlite:") || u.ends_with(".db") || u.ends_with(".sqlite") || u.ends_with(".sqlite3") {
        Some("sqlite")
    } else {
        None
    }
}

/// `.env`, then `.env.local` over it.
fn read_env(host: &str, root: &str) -> Result<BTreeMap<String, String>, String> {
    let mut vars = BTreeMap::new();
    for name in [".env", ".env.local"] {
        if let Some(text) = devfs::read(host, &format!("{}/{name}", root.trim_end_matches('/')))? {
            vars.extend(parse_env(&text));
        }
    }
    Ok(vars)
}

fn parse_env(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line);
            if line.starts_with('#') {
                return None;
            }
            let (k, v) = line.split_once('=')?;
            let v = v.trim();
            let v = match v.chars().next() {
                Some(q @ ('"' | '\'')) => v[1..].split(q).next().unwrap_or(""),
                _ => v.split(" #").next().unwrap_or(v).trim(),
            };
            Some((k.trim().to_string(), v.to_string()))
        })
        .collect()
}

fn secrets(host: &str) -> Result<BTreeMap<String, String>, String> {
    Ok(devfs::read(host, SECRETS)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

fn secret(host: &str, root: &str, id: &str) -> Result<Option<String>, String> {
    Ok(secrets(host)?.remove(&format!("{root}#{id}")))
}

pub fn set_secret(host: &str, root: &str, id: &str, secret: Option<&str>) -> Result<(), String> {
    let mut all = secrets(host)?;
    let key = format!("{root}#{id}");
    match secret {
        Some(s) => all.insert(key, s.to_string()),
        None => all.remove(&key),
    };
    let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    devfs::write(host, SECRETS, text.as_bytes())?;
    match host {
        "" | "local" => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let path = crate::spawn::expand_home(SECRETS);
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            }
            Ok(())
        }
        _ => crate::remote::run(host, "chmod 600 ~/.tri-code/secrets/databases.json").map(|_| ()),
    }
}

/// `scheme://[userinfo@]hosts[/path][?query]`, split at the authority.
struct Parts<'a> {
    scheme: &'a str,
    user: Option<&'a str>,
    hosts: &'a str,
    rest: &'a str,
}

fn split(url: &str) -> Option<Parts<'_>> {
    let (scheme, after) = url.split_once("://")?;
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let (auth, rest) = after.split_at(end);
    let (user, hosts) = match auth.rfind('@') {
        Some(i) => (Some(&auth[..i]), &auth[i + 1..]),
        None => (None, auth),
    };
    Some(Parts { scheme, user, hosts, rest })
}

fn join(p: &Parts, user: Option<&str>, hosts: &str) -> String {
    match user {
        Some(u) => format!("{}://{u}@{hosts}{}", p.scheme, p.rest),
        None => format!("{}://{hosts}{}", p.scheme, p.rest),
    }
}

fn with_password(url: &str, pw: &str) -> String {
    match split(url) {
        Some(p) if p.user.is_some_and(|u| !u.contains(':')) => {
            let user = format!("{}:{}", p.user.unwrap(), encode(pw));
            join(&p, Some(&user), p.hosts)
        }
        _ => url.to_string(),
    }
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The first host of the URL and its port, e.g. `db.internal:5432`.
pub fn first_host(url: &str, default_port: u16) -> Option<(String, u16)> {
    let first = split(url)?.hosts.split(',').next()?;
    let (h, port) = if let Some(rest) = first.strip_prefix('[') {
        let (h, tail) = rest.split_once(']')?;
        (h, tail.strip_prefix(':'))
    } else {
        match first.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (first, None),
        }
    };
    let port = match port {
        Some(p) => p.parse().ok()?,
        None => default_port,
    };
    (!h.is_empty()).then(|| (h.to_string(), port))
}

/// The same URL with its hosts replaced by `host:port`.
pub fn point_at(url: &str, host: &str, port: u16) -> String {
    match split(url) {
        Some(p) => join(&p, p.user, &format!("{host}:{port}")),
        None => url.to_string(),
    }
}

/// Add `key=value` to the URL's query unless the key is there already.
pub fn with_param(url: &str, key: &str, value: &str) -> String {
    let Some(p) = split(url) else { return url.to_string() };
    if p.rest.contains(&format!("{key}=")) {
        return url.to_string();
    }
    let (base, frag) = url.split_once('#').map_or((url, ""), |(b, f)| (b, f));
    let sep = if p.rest.contains('?') { "&" } else if p.rest.is_empty() { "/?" } else { "?" };
    let frag = if frag.is_empty() { String::new() } else { format!("#{frag}") };
    format!("{base}{sep}{key}={value}{frag}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_lines() {
        let vars = parse_env("# c\nexport DATABASE_URL=\"postgres://a@b/c\"\nMONGO_URL=mongodb://x # local\nEMPTY=\n");
        assert_eq!(vars[0], ("DATABASE_URL".into(), "postgres://a@b/c".into()));
        assert_eq!(vars[1], ("MONGO_URL".into(), "mongodb://x".into()));
        assert_eq!(vars[2].1, "");
    }

    #[test]
    fn password_goes_into_userinfo() {
        assert_eq!(with_password("postgres://app@db:5432/app", "p@ss w"), "postgres://app:p%40ss%20w@db:5432/app");
        assert_eq!(with_password("postgres://app:x@db/app", "y"), "postgres://app:x@db/app");
    }

    #[test]
    fn hosts_and_tunnels() {
        assert_eq!(first_host("postgres://u:p@db.internal/app", 5432), Some(("db.internal".into(), 5432)));
        assert_eq!(first_host("mongodb://m1:27018,m2:27019/x", 27017), Some(("m1".into(), 27018)));
        assert_eq!(first_host("postgres://[::1]:6000/x", 5432), Some(("::1".into(), 6000)));
        assert_eq!(point_at("postgres://u:p@db:5432/app?sslmode=require", "127.0.0.1", 54012), "postgres://u:p@127.0.0.1:54012/app?sslmode=require");
        assert_eq!(with_param("mongodb://u@127.0.0.1:1/db", "directConnection", "true"), "mongodb://u@127.0.0.1:1/db?directConnection=true");
        assert_eq!(with_param("mongodb://127.0.0.1:1", "directConnection", "true"), "mongodb://127.0.0.1:1/?directConnection=true");
        assert_eq!(with_param("mongodb://h/db?a=1", "directConnection", "true"), "mongodb://h/db?a=1&directConnection=true");
    }
}
