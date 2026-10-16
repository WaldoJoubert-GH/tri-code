//! Plane.so REST calls for the issues panel.
//!
//! The HTTP runs on this machine — the webview's `fetch` would hit CORS — but
//! the token and the project's `.dev/` live on the project's host: the local
//! filesystem, or ssh for a remote project. Everything here is blocking and is
//! wrapped in `spawn_blocking` by the command layer.
//!
//! The `.dev/` files are written by the TypeScript store through `devfs`, not
//! here: these commands return data and only mutate Plane itself.

use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::devfs;

const API_BASE: &str = "https://api.plane.so";
const APP_BASE: &str = "https://app.plane.so";
const API_V1: &str = "https://api.plane.so/api/v1";
const SECRETS: &str = "~/.pi/agent/secrets/plane.json";

// ── wire types ──────────────────────────────────────────────────────

/// One Plane work item as `issues.json` stores it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaneIssue {
    pub source: String,
    pub id: String,
    pub sequence_id: Option<u64>,
    pub title: String,
    pub description: String,
    pub state_id: Option<String>,
    pub state_name: Option<String>,
    pub state_group: Option<String>,
    pub state_hex: Option<String>,
    pub priority: String,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub link: String,
    pub updated_at: String,
}

/// A workspace State, as `plane-states.json` stores it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaneState {
    pub id: String,
    pub name: String,
    pub color: String,
    pub group: String,
}

/// A workspace Label, as `plane-labels.json` stores it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaneLabel {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize)]
pub struct PlaneSync {
    pub last_synced: String,
    pub project_identifier: Option<String>,
    pub issues: Vec<PlaneIssue>,
    pub states: Vec<PlaneState>,
    pub labels: Vec<PlaneLabel>,
}

#[derive(Debug, Serialize)]
pub struct CreatedIssue {
    pub id: String,
    pub sequence_id: Option<u64>,
    pub title: String,
    pub priority: String,
    pub link: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommentImage {
    pub name: String,
    /// A `data:` URL: the asset needs the token, so it is inlined for the panel.
    pub src: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaneComment {
    pub id: String,
    pub author: String,
    pub created_at: String,
    pub text: String,
    pub html: String,
    pub images: Vec<CommentImage>,
}

// ── raw API shapes (only the fields we read) ────────────────────────

#[derive(Deserialize)]
struct RawIssue {
    id: String,
    #[serde(default)]
    name: String,
    sequence_id: Option<u64>,
    state: Option<String>,
    priority: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    description_stripped: Option<String>,
    description_html: Option<String>,
    // Plane returns label UUIDs; accept objects too so an API change cannot
    // break the whole sync.
    #[serde(default)]
    labels: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawState {
    id: String,
    name: String,
    group: String,
    #[serde(default)]
    color: String,
}

#[derive(Deserialize)]
struct RawLabel {
    id: String,
    name: String,
    #[serde(default)]
    color: String,
}

#[derive(Deserialize)]
struct RawProject {
    identifier: Option<String>,
}

#[derive(Deserialize)]
struct Secrets {
    token: Option<String>,
}

// ── token + client ──────────────────────────────────────────────────

fn is_remote(host: &str) -> bool {
    !matches!(host, "" | "local")
}

/// Read `~/.pi/agent/secrets/plane.json` on the project's host.
fn read_token(host: &str) -> Result<String, String> {
    let raw = devfs::read(host, SECRETS)?.ok_or_else(|| {
        let where_ = if is_remote(host) { format!(" on {host}") } else { String::new() };
        format!("no Plane token at {SECRETS}{where_}")
    })?;
    let s: Secrets = serde_json::from_str(&raw).map_err(|e| format!("{SECRETS}: {e}"))?;
    match s.token {
        Some(t) if !t.is_empty() => Ok(t),
        _ => Err(format!("{SECRETS} has no token")),
    }
}

struct Api {
    agent: ureq::Agent,
    token: String,
}

impl Api {
    fn new(token: String) -> Self {
        let config = ureq::config::Config::builder()
            .timeout_global(Some(Duration::from_secs(30)))
            // Read the body of a 4xx/5xx so the error message is useful.
            .http_status_as_error(false)
            .build();
        Self { agent: ureq::Agent::new_with_config(config), token }
    }

    fn send(
        &self,
        method: &str,
        url: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<ureq::http::Response<ureq::Body>, String> {
        let res = match method {
            "GET" => self.agent.get(url).header("X-Api-Key", &self.token).call(),
            "POST" => match body {
                Some(b) => self.agent.post(url).header("X-Api-Key", &self.token).send_json(b),
                None => self.agent.post(url).header("X-Api-Key", &self.token).send_empty(),
            },
            "PATCH" => match body {
                Some(b) => self.agent.patch(url).header("X-Api-Key", &self.token).send_json(b),
                None => self.agent.patch(url).header("X-Api-Key", &self.token).send_empty(),
            },
            m => return Err(format!("unsupported method {m}")),
        };
        res.map_err(|e| format!("Plane request failed: {e}"))
    }

    fn json(&self, method: &str, url: &str, body: Option<&serde_json::Value>) -> Result<serde_json::Value, String> {
        let mut res = self.send(method, url, body)?;
        let status = res.status();
        let text = res.body_mut().read_to_string().unwrap_or_default();
        if !status.is_success() {
            let body: String = text.trim().chars().take(300).collect();
            return Err(format!("Plane API {status}: {body}"));
        }
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| format!("Plane returned invalid JSON: {e}"))
    }

    /// GET a binary asset with the token, returning its mime type and bytes.
    fn bytes(&self, url: &str) -> Result<(String, Vec<u8>), String> {
        let mut res = self
            .agent
            .get(url)
            .header("X-Api-Key", &self.token)
            .call()
            .map_err(|e| format!("Plane request failed: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("Plane API {} fetching an asset", res.status()));
        }
        let mime = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("application/octet-stream")
            .to_string();
        let data = res.body_mut().read_to_vec().map_err(|e| e.to_string())?;
        Ok((mime, data))
    }
}

fn page<T: serde::de::DeserializeOwned>(api: &Api, url: &str) -> Result<Vec<T>, String> {
    let v = api.json("GET", url, None)?;
    let results = v.get("results").cloned().unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    serde_json::from_value(results).map_err(|e| format!("{url}: {e}"))
}

fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

/// Pull `src="..."` values out of `html` (both `<img>` and Plane's
/// `<image-component>` use it). No HTML parser: the values are plain URLs.
fn image_srcs(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find("src=\"") {
        rest = &rest[i + 5..];
        if let Some(end) = rest.find('"') {
            out.push(rest[..end].to_string());
            rest = &rest[end + 1..];
        }
    }
    out
}

fn asset_url(src: &str) -> String {
    if src.starts_with("http://") || src.starts_with("https://") || src.starts_with("data:") {
        src.to_string()
    } else if src.starts_with('/') {
        format!("{API_BASE}{src}")
    } else {
        format!("{API_BASE}/{src}")
    }
}

// ── sync ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn plane_sync(host: String, workspace_slug: String, project_id: String) -> Result<PlaneSync, String> {
    tauri::async_runtime::spawn_blocking(move || sync(&host, &workspace_slug, &project_id))
        .await
        .map_err(|e| e.to_string())?
}

fn sync(host: &str, workspace_slug: &str, project_id: &str) -> Result<PlaneSync, String> {
    let api = Api::new(read_token(host)?);
    let base = format!("{API_V1}/workspaces/{workspace_slug}/projects/{project_id}");

    let raw_states: Vec<RawState> = page(&api, &format!("{base}/states/?per_page=1000"))?;
    let raw_labels: Vec<RawLabel> = page(&api, &format!("{base}/labels/?per_page=1000"))?;
    let raw_issues: Vec<RawIssue> = page(&api, &format!("{base}/issues/?per_page=1000"))?;

    let states: Vec<PlaneState> = raw_states
        .iter()
        .map(|s| PlaneState {
            id: s.id.clone(),
            name: s.name.clone(),
            color: if s.color.is_empty() { "#808080".into() } else { s.color.clone() },
            group: s.group.clone(),
        })
        .collect();
    let labels: Vec<PlaneLabel> = raw_labels
        .iter()
        .map(|l| PlaneLabel {
            id: l.id.clone(),
            name: l.name.clone(),
            color: if l.color.is_empty() { "#808080".into() } else { l.color.clone() },
        })
        .collect();

    let state_of = |id: &Option<String>| states.iter().find(|s| Some(&s.id) == id.as_ref());
    let label_ids = |labels: &[serde_json::Value]| -> Vec<String> {
        labels
            .iter()
            .filter_map(|l| {
                l.as_str()
                    .map(String::from)
                    .or_else(|| l.get("id").and_then(|x| x.as_str()).map(String::from))
            })
            .collect()
    };
    let now = now_iso();
    let mut issues: Vec<PlaneIssue> = raw_issues
        .into_iter()
        .map(|raw| {
            let state = state_of(&raw.state);
            let (state_name, state_group, state_hex) = match state {
                Some(s) => (Some(s.name.clone()), Some(s.group.clone()), Some(s.color.clone())),
                None => (None, None, None),
            };
            let description = raw
                .description_stripped
                .clone()
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| strip_html(raw.description_html.as_deref().unwrap_or("")));
            PlaneIssue {
                source: "plane".into(),
                link: format!("{APP_BASE}/{workspace_slug}/projects/{project_id}/issues/{}", raw.id),
                id: raw.id,
                sequence_id: raw.sequence_id,
                title: raw.name,
                description,
                state_id: raw.state,
                state_name,
                state_group,
                state_hex,
                priority: raw.priority.unwrap_or_else(|| "none".into()),
                start_date: raw.start_date,
                target_date: raw.target_date,
                labels: label_ids(&raw.labels),
                updated_at: now.clone(),
            }
        })
        .collect();

    // priority → state group → title, the same order pi-todos writes.
    issues.sort_by(|a, b| {
        priority_rank(&a.priority)
            .cmp(&priority_rank(&b.priority))
            .then(group_rank(a.state_group.as_deref()).cmp(&group_rank(b.state_group.as_deref())))
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });

    let project: Option<RawProject> = api
        .json("GET", &format!("{base}/"), None)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok());

    Ok(PlaneSync {
        last_synced: now_iso(),
        project_identifier: project.and_then(|p| p.identifier),
        issues,
        states,
        labels,
    })
}

fn priority_rank(p: &str) -> u8 {
    match p {
        "urgent" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 4,
    }
}

fn group_rank(g: Option<&str>) -> u8 {
    match g {
        Some("backlog") => 0,
        Some("unstarted") => 1,
        Some("started") => 2,
        Some("triage") => 3,
        Some("cancelled") => 4,
        _ => 9,
    }
}

fn now_iso() -> String {
    // The panel only needs a parsable timestamp for "synced Xm ago", so format
    // the Unix epoch directly (civil-from-days) instead of pulling in a date crate.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ── mutations ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn plane_set_state(
    host: String,
    workspace_slug: String,
    project_id: String,
    issue_id: String,
    state_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = Api::new(read_token(&host)?);
        let url = format!("{API_V1}/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/");
        api.json("PATCH", &url, Some(&serde_json::json!({ "state": state_id }))).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plane_set_labels(
    host: String,
    workspace_slug: String,
    project_id: String,
    issue_id: String,
    labels: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = Api::new(read_token(&host)?);
        let url = format!("{API_V1}/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/");
        api.json("PATCH", &url, Some(&serde_json::json!({ "labels": labels }))).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plane_create_issue(
    host: String,
    workspace_slug: String,
    project_id: String,
    title: String,
    state_id: Option<String>,
) -> Result<CreatedIssue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = Api::new(read_token(&host)?);
        let url = format!("{API_V1}/workspaces/{workspace_slug}/projects/{project_id}/issues/");
        let mut body = serde_json::json!({ "name": title, "project": project_id });
        if let Some(s) = &state_id {
            body["state"] = serde_json::Value::String(s.clone());
        }
        let v = api.json("POST", &url, Some(&body))?;
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        Ok(CreatedIssue {
            link: format!("{APP_BASE}/{workspace_slug}/projects/{project_id}/issues/{id}"),
            id,
            sequence_id: v.get("sequence_id").and_then(|x| x.as_u64()),
            title: v.get("name").and_then(|x| x.as_str()).unwrap_or(&title).to_string(),
            priority: v.get("priority").and_then(|x| x.as_str()).unwrap_or("none").to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── comments ────────────────────────────────────────────────────────

/// Read a work item's comments, inlining each image as a `data:` URL so the
/// webview can render it without the Plane token.
#[tauri::command]
pub async fn plane_comments(
    host: String,
    workspace_slug: String,
    project_id: String,
    issue_id: String,
) -> Result<Vec<PlaneComment>, String> {
    tauri::async_runtime::spawn_blocking(move || comments(&host, &workspace_slug, &project_id, &issue_id))
        .await
        .map_err(|e| e.to_string())?
}

fn comments(host: &str, workspace_slug: &str, project_id: &str, issue_id: &str) -> Result<Vec<PlaneComment>, String> {
    let api = Api::new(read_token(host)?);
    let url = format!(
        "{API_V1}/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/comments/?per_page=100"
    );
    let v = api.json("GET", &url, None)?;
    let raw = v.get("results").cloned().unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    let raw: Vec<serde_json::Value> = serde_json::from_value(raw).map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(raw.len());
    for c in raw {
        let html = c.get("comment_html").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let text = c
            .get("comment_stripped")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_else(|| strip_html(&html));
        let author = c
            .get("actor")
            .or_else(|| c.get("actor_detail"))
            .and_then(|a| a.get("display_name").or_else(|| a.get("first_name")))
            .and_then(|x| x.as_str())
            .unwrap_or("Someone")
            .to_string();
        let mut images = Vec::new();
        for src in image_srcs(&html) {
            let full = asset_url(&src);
            if let Ok((mime, bytes)) = api.bytes(&full) {
                let name = full.rsplit('/').find(|s| !s.is_empty()).unwrap_or("image").to_string();
                let src = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
                images.push(CommentImage { name, src });
            }
        }
        out.push(PlaneComment {
            id: c.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            author,
            created_at: c.get("created_at").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            text,
            html,
            images,
        });
    }
    Ok(out)
}

/// Post a comment. `comment_html` references already-uploaded assets.
#[tauri::command]
pub async fn plane_add_comment(
    host: String,
    workspace_slug: String,
    project_id: String,
    issue_id: String,
    comment_html: String,
) -> Result<PlaneComment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = Api::new(read_token(&host)?);
        let url = format!(
            "{API_V1}/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/comments/"
        );
        let v = api.json("POST", &url, Some(&serde_json::json!({ "comment_html": comment_html })))?;
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let at = v.get("created_at").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        Ok(PlaneComment {
            id,
            author: "You".into(),
            created_at: at,
            text: strip_html(&comment_html),
            html: comment_html,
            images: Vec::new(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Upload one image and return the asset URL to reference from `comment_html`.
#[tauri::command]
pub async fn plane_upload_asset(
    host: String,
    workspace_slug: String,
    project_id: String,
    name: String,
    data_url: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || upload_asset(&host, &workspace_slug, &project_id, &name, &data_url))
        .await
        .map_err(|e| e.to_string())?
}

fn decode_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let rest = data_url.strip_prefix("data:").ok_or("not a data URL")?;
    let (meta, data) = rest.split_once(',').ok_or("malformed data URL")?;
    let mime = meta.split(';').next().filter(|m| !m.is_empty()).unwrap_or("application/octet-stream").to_string();
    if !meta.contains("base64") {
        return Err("only base64 data URLs are supported".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("bad base64: {e}"))?;
    Ok((mime, bytes))
}

fn upload_asset(
    host: &str,
    workspace_slug: &str,
    project_id: &str,
    name: &str,
    data_url: &str,
) -> Result<String, String> {
    let (mime, bytes) = decode_data_url(data_url)?;
    let api = Api::new(read_token(host)?);
    let create = format!("{API_V1}/workspaces/{workspace_slug}/assets/");
    let body = serde_json::json!({
        "name": name,
        "type": mime,
        "size": bytes.len(),
        "project_id": project_id,
    });
    let v = api.json("POST", &create, Some(&body))?;
    let asset_url = v.get("asset_url").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let upload = v.get("upload_data").ok_or("Plane did not return upload data")?;
    let url = upload.get("url").and_then(|x| x.as_str()).ok_or("Plane did not return an upload URL")?;

    let mut fields: Vec<(String, String)> = Vec::new();
    if let Some(map) = upload.get("fields").and_then(|f| f.as_object()) {
        for (k, val) in map {
            fields.push((k.clone(), val.as_str().unwrap_or_default().to_string()));
        }
    }

    let mut form = ureq::unversioned::multipart::Form::new();
    for (k, val) in &fields {
        form = form.text(k, val);
    }
    let part = ureq::unversioned::multipart::Part::bytes(&bytes)
        .file_name(name)
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    form = form.part("file", part);

    let res = api
        .agent
        .post(url)
        .send(form)
        .map_err(|e| format!("asset upload failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("asset upload rejected: {}", res.status()));
    }
    Ok(asset_url)
}

/// Does the project's host have a Plane token? Used by the setup form.
#[tauri::command]
pub async fn plane_check_token(host: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(read_token(&host).is_ok()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_html_removes_tags_and_unescapes() {
        assert_eq!(strip_html("<p>Hi &amp; <b>bye</b></p>"), "Hi & bye");
    }

    #[test]
    fn image_srcs_finds_img_and_image_component() {
        let html = r#"<p>x</p><img src="/a/1.png"><image-component src="https://x/2.png"/>"#;
        assert_eq!(image_srcs(html), ["/a/1.png", "https://x/2.png"]);
    }

    #[test]
    fn asset_urls_are_absolute() {
        assert_eq!(asset_url("/api/v1/a/"), "https://api.plane.so/api/v1/a/");
        assert_eq!(asset_url("https://x/y"), "https://x/y");
        assert_eq!(asset_url("data:image/png;base64,AA"), "data:image/png;base64,AA");
    }

    #[test]
    fn data_urls_decode() {
        let (mime, bytes) = decode_data_url("data:image/png;base64,aGk=").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"hi");
        assert!(decode_data_url("https://x/y").is_err());
    }

    #[test]
    fn synced_issue_order_is_priority_then_group() {
        assert!(priority_rank("urgent") < priority_rank("low"));
        assert!(group_rank(Some("backlog")) < group_rank(Some("started")));
    }
}
