//! GitHub Issues for the issues panel, through `gh` on the project's host. tri-code holds no
//! GitHub token: gh uses whatever login the host already has, the same as the git window.
//! Like `plane.rs`, these return data; TypeScript writes it into `.dev/`.

use serde::Serialize;
use serde_json::Value;

use crate::git::{blocking, exec};

const ISSUE_FIELDS: &str = "number,title,body,state,stateReason,labels,url,updatedAt,author";

#[derive(Debug, Serialize)]
pub struct GhIssue {
    pub source: &'static str,
    pub number: u64,
    pub title: String,
    pub description: String,
    /// `open` or `closed`.
    pub state: String,
    /// `completed`, `not_planned`, or null.
    pub state_reason: Option<String>,
    pub labels: Vec<String>,
    pub author: String,
    pub link: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct GhLabel {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize)]
pub struct GhSync {
    pub issues: Vec<GhIssue>,
    pub labels: Vec<GhLabel>,
}

#[derive(Debug, Serialize)]
pub struct GhComment {
    pub id: String,
    pub author: String,
    pub created_at: String,
    pub text: String,
    pub html: String,
    pub images: Vec<Value>,
}

fn gh(host: &str, path: &str, args: &[&str], input: Option<String>) -> Result<String, String> {
    exec(host, path, "gh", args, input)
}

fn json(out: &str) -> Result<Value, String> {
    serde_json::from_str(out).map_err(|e| format!("gh returned something that isn't JSON: {e}"))
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn issue(v: &Value) -> GhIssue {
    let reason = str_of(v, "stateReason").to_lowercase();
    GhIssue {
        source: "github",
        number: v.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: str_of(v, "title"),
        description: str_of(v, "body"),
        state: str_of(v, "state").to_lowercase(),
        state_reason: matches!(reason.as_str(), "completed" | "not_planned").then_some(reason),
        labels: v
            .get("labels")
            .and_then(Value::as_array)
            .map(|ls| ls.iter().map(|l| str_of(l, "name")).collect())
            .unwrap_or_default(),
        author: v.get("author").map(|a| str_of(a, "login")).unwrap_or_default(),
        link: str_of(v, "url"),
        updated_at: str_of(v, "updatedAt"),
    }
}

/// `owner/name` of the repo gh sees in `path`, to prefill the setup form.
#[tauri::command]
pub async fn gh_repo(host: String, path: String) -> Result<String, String> {
    blocking(move || {
        let out = gh(&host, &path, &["repo", "view", "--json", "nameWithOwner"], None)?;
        Ok(str_of(&json(&out)?, "nameWithOwner"))
    })
    .await
}

/// The repo's most recent issues (open and closed) and its labels.
#[tauri::command]
pub async fn gh_issues_sync(host: String, path: String, repo: String) -> Result<GhSync, String> {
    blocking(move || {
        let out = gh(&host, &path, &["issue", "list", "-R", &repo, "--state", "all", "--limit", "300", "--json", ISSUE_FIELDS], None)?;
        let issues = json(&out)?.as_array().map(|a| a.iter().map(issue).collect()).unwrap_or_default();
        let out = gh(&host, &path, &["label", "list", "-R", &repo, "--limit", "200", "--json", "name,color"], None)?;
        let labels = json(&out)?
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|l| GhLabel { id: str_of(l, "name"), name: str_of(l, "name"), color: format!("#{}", str_of(l, "color")) })
                    .collect()
            })
            .unwrap_or_default();
        Ok(GhSync { issues, labels })
    })
    .await
}

/// Create an issue and return it as `gh issue view` sees it.
#[tauri::command]
pub async fn gh_issue_create(host: String, path: String, repo: String, title: String) -> Result<GhIssue, String> {
    blocking(move || {
        let url = gh(&host, &path, &["issue", "create", "-R", &repo, "--title", &title, "--body", ""], None)?;
        let url = url.trim().to_string();
        let out = gh(&host, &path, &["issue", "view", &url, "-R", &repo, "--json", ISSUE_FIELDS], None)?;
        Ok(issue(&json(&out)?))
    })
    .await
}

/// Move an issue to one of the panel's GitHub States: `open`, `progress` (open with
/// `progress_label`), `closed` (completed) or `not_planned`.
#[tauri::command]
pub async fn gh_issue_set_state(
    host: String,
    path: String,
    repo: String,
    number: u64,
    state: String,
    progress_label: String,
    was_closed: bool,
    had_label: bool,
) -> Result<(), String> {
    blocking(move || {
        let n = number.to_string();
        let run = |args: &[&str]| gh(&host, &path, args, None).map(|_| ());
        let open = matches!(state.as_str(), "open" | "progress");
        if open && was_closed {
            run(&["issue", "reopen", &n, "-R", &repo])?;
        }
        match state.as_str() {
            "closed" => run(&["issue", "close", &n, "-R", &repo, "--reason", "completed"])?,
            "not_planned" => run(&["issue", "close", &n, "-R", &repo, "--reason", "not planned"])?,
            _ => {}
        }
        if state == "progress" && !had_label {
            let add = ["issue", "edit", &n, "-R", &repo, "--add-label", &progress_label];
            if run(&add).is_err() {
                // The label doesn't exist in the repo yet.
                run(&["label", "create", &progress_label, "-R", &repo, "--color", "BF8700", "--description", "Being worked on", "--force"])?;
                run(&add)?;
            }
        } else if state != "progress" && had_label {
            run(&["issue", "edit", &n, "-R", &repo, "--remove-label", &progress_label])?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn gh_issue_labels(host: String, path: String, repo: String, number: u64, add: Vec<String>, remove: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let n = number.to_string();
        let mut args: Vec<&str> = vec!["issue", "edit", &n, "-R", &repo];
        for l in &add {
            args.extend(["--add-label", l]);
        }
        for l in &remove {
            args.extend(["--remove-label", l]);
        }
        gh(&host, &path, &args, None).map(|_| ())
    })
    .await
}

fn comment(v: &Value) -> GhComment {
    let text = str_of(v, "body");
    GhComment {
        id: str_of(v, "id"),
        author: v.get("author").map(|a| str_of(a, "login")).unwrap_or_default(),
        created_at: str_of(v, "createdAt"),
        html: String::new(),
        text,
        images: Vec::new(),
    }
}

#[tauri::command]
pub async fn gh_issue_comments(host: String, path: String, repo: String, number: u64) -> Result<Vec<GhComment>, String> {
    blocking(move || {
        let out = gh(&host, &path, &["issue", "view", &number.to_string(), "-R", &repo, "--json", "comments"], None)?;
        Ok(json(&out)?
            .get("comments")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(comment).collect())
            .unwrap_or_default())
    })
    .await
}

/// Post `body` (Markdown) as a comment; the body goes on stdin so its length and quoting don't matter.
#[tauri::command]
pub async fn gh_issue_comment(host: String, path: String, repo: String, number: u64, body: String) -> Result<(), String> {
    blocking(move || gh(&host, &path, &["issue", "comment", &number.to_string(), "-R", &repo, "--body-file", "-"], Some(body)).map(|_| ())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_reads_gh_json() {
        let v: Value = serde_json::from_str(
            r#"{"number":231,"title":"t","body":"b","state":"CLOSED","stateReason":"NOT_PLANNED",
                "labels":[{"name":"bug","color":"d73a4a"}],"url":"https://github.com/o/r/issues/231",
                "updatedAt":"2026-10-21T10:00:00Z","author":{"login":"wj"}}"#,
        )
        .unwrap();
        let i = issue(&v);
        assert_eq!((i.number, i.state.as_str(), i.state_reason.as_deref()), (231, "closed", Some("not_planned")));
        assert_eq!(i.labels, vec!["bug"]);
        assert_eq!(i.author, "wj");
    }

    #[test]
    fn reopened_is_not_a_close_reason() {
        let v: Value = serde_json::from_str(r#"{"number":1,"state":"OPEN","stateReason":"REOPENED"}"#).unwrap();
        assert_eq!(issue(&v).state_reason, None);
    }
}
