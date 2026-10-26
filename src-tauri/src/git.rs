//! The git window's commands: git and gh in the project folder, locally or over ssh, plus
//! the ✦ drafts' commands (Settings › Git). Remote calls that need several git commands run them in one
//! ssh round trip (see `multi`).

use std::io::Write;
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::remote;
use crate::spawn::{expand_home, remote_path, sq};

#[derive(Debug, Serialize, PartialEq)]
pub struct Change {
    pub path: String,
    /// Index (staged) status: `.` unchanged, `M` `A` `D` `R` `C` `T`, `U` conflict, `?` untracked.
    pub x: String,
    /// Worktree (unstaged) status, same letters.
    pub y: String,
    /// Lines added and removed in the index (staged) and in the worktree, from `diff --numstat`.
    /// None for an untracked or binary file, or no change on that side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<(u32, u32)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<(u32, u32)>,
    /// A rename's or copy's original path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    /// Relative commit date, as git prints it ("2 hours ago").
    pub when: String,
    /// Reachable from a remote-tracking branch.
    pub pushed: bool,
}

#[derive(Debug, Serialize, Default)]
pub struct Status {
    /// None when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The remote's default branch (origin/HEAD), "main" if unknown.
    pub base: String,
    pub files: Vec<Change>,
    /// The last few commits on HEAD, newest first.
    pub commits: Vec<Commit>,
}

#[derive(Debug, Serialize)]
pub struct Range {
    /// One subject per line, oldest first.
    pub subjects: String,
    pub diff: String,
}

#[derive(Debug, Serialize)]
pub struct CommitDetail {
    pub sha: String,
    pub author: String,
    /// Relative commit date, as git prints it.
    pub when: String,
    /// Subject, then the body.
    pub message: String,
    /// The diffstat, as git prints it.
    pub stat: String,
    pub diff: String,
}

/// git and gh are fast and on every PATH; claude (and gh on some machines) live in a
/// prefix only the login shell adds, so those go through it.
fn needs_login(program: &str) -> bool {
    program != "git"
}

fn line(program: &str, args: &[&str]) -> String {
    std::iter::once(program).chain(args.iter().copied()).map(sq).collect::<Vec<_>>().join(" ")
}

/// `program args` in `path` on `host`. Err while the host is locked.
fn command(host: &str, path: &str, program: &str, args: &[&str]) -> Result<Command, String> {
    if !matches!(host, "" | "local") {
        crate::envssh::check(host)?;
        let inner = format!("cd {} && {}", remote_path(path), line(program, args));
        let script = if needs_login(program) { format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", sq(&inner)) } else { inner };
        return Ok(remote::command(host, &script));
    }
    let mut cmd = if cfg!(windows) {
        // claude is a .cmd shim on Windows; git and gh are real executables.
        let mut c = Command::new(if program == "git" || program == "gh" { program } else { "cmd.exe" });
        if program != "git" && program != "gh" {
            c.args(["/d", "/c", program]);
        }
        c.args(args);
        c
    } else if needs_login(program) {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = Command::new(shell);
        c.args(["-lc", &line(program, args)]);
        c
    } else {
        let mut c = Command::new(program);
        c.args(args);
        c
    };
    cmd.current_dir(expand_home(path));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// Run to completion, feeding `input` on stdin. Exit codes in `also_ok` count as success
/// (`git diff --no-index` exits 1 when the files differ). Errors carry stderr.
fn run(mut cmd: Command, input: Option<String>, also_ok: &[i32]) -> Result<String, String> {
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // Write from a thread so a large stdout cannot deadlock against a large stdin.
    let writer = input.map(|text| {
        let mut stdin = child.stdin.take().expect("stdin is piped");
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        })
    });
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    let code = out.status.code().unwrap_or(-1);
    if code == 0 || also_ok.contains(&code) {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let err = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
    Err(if err.is_empty() { format!("exit code {code}") } else { err })
}

pub(crate) fn exec(host: &str, path: &str, program: &str, args: &[&str], input: Option<String>) -> Result<String, String> {
    run(command(host, path, program, args)?, input, &[])
}

/// Several read-only git commands. Locally each is its own process; remotely they share one
/// ssh call, each followed by `RS <exit code> RS` so the outputs can be split apart again.
fn multi(host: &str, path: &str, cmds: &[&[&str]]) -> Result<Vec<Result<String, i32>>, String> {
    if matches!(host, "" | "local") {
        return Ok(cmds
            .iter()
            .map(|args| command(host, path, "git", args).and_then(|c| run(c, None, &[])).map_err(|_| 1))
            .collect());
    }
    Ok(split_multi(&remote::run(host, &multi_script(path, cmds))?))
}

fn multi_script(path: &str, cmds: &[&[&str]]) -> String {
    let body: Vec<String> = cmds.iter().map(|args| format!("{} 2>/dev/null; printf '\\036%d\\036' $?", line("git", args))).collect();
    format!("cd {} || exit 1; {}", remote_path(path), body.join("; "))
}

fn split_multi(out: &str) -> Vec<Result<String, i32>> {
    let parts: Vec<&str> = out.split('\u{1e}').collect();
    parts
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| match c[1].trim().parse::<i32>() {
            Ok(0) => Ok(c[0].to_string()),
            Ok(code) => Err(code),
            Err(_) => Err(-1),
        })
        .collect()
}

/// Parse `git status --porcelain=v2 --branch -z`.
fn parse_status(out: &str, s: &mut Status) {
    let mut it = out.split('\0');
    while let Some(rec) = it.next() {
        if let Some(h) = rec.strip_prefix("# branch.head ") {
            s.branch = (h != "(detached)").then(|| h.to_string());
        } else if let Some(u) = rec.strip_prefix("# branch.upstream ") {
            s.upstream = Some(u.to_string());
        } else if let Some(ab) = rec.strip_prefix("# branch.ab ") {
            for part in ab.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    s.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    s.behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(p) = rec.strip_prefix("? ") {
            s.files.push(Change { path: p.into(), x: "?".into(), y: "?".into(), index: None, work: None, orig: None });
        } else if rec.starts_with("1 ") || rec.starts_with("2 ") || rec.starts_with("u ") {
            // 1 XY sub mH mI mW hH hI path / 2 … X<score> path NUL orig / u XY sub m1 m2 m3 mW h1 h2 h3 path
            let fields = match &rec[..1] { "1" => 9, "2" => 10, _ => 11 };
            let parts: Vec<&str> = rec.splitn(fields, ' ').collect();
            if parts.len() < fields {
                continue;
            }
            let xy: Vec<char> = parts[1].chars().collect();
            let (x, y) = if rec.starts_with('u') { ('U', 'U') } else { (xy[0], xy[1]) };
            let orig = if rec.starts_with('2') { it.next().map(String::from) } else { None };
            s.files.push(Change { path: parts[fields - 1].into(), x: x.into(), y: y.into(), index: None, work: None, orig });
        }
    }
}

/// Parse `git diff --numstat -z`: `added TAB removed TAB path NUL`, or for a rename an empty
/// path then `old NUL new NUL`. A binary file prints `-` for both counts and is left out.
fn parse_numstat(out: &str) -> std::collections::HashMap<String, (u32, u32)> {
    let mut map = std::collections::HashMap::new();
    let mut it = out.split('\0');
    while let Some(rec) = it.next() {
        let mut f = rec.trim_start_matches('\n').splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (f.next(), f.next(), f.next()) else { continue };
        let path = if p.is_empty() {
            it.next();
            match it.next() {
                Some(new) => new,
                None => break,
            }
        } else {
            p
        };
        if let (Ok(a), Ok(d)) = (a.parse(), d.parse()) {
            map.insert(path.to_string(), (a, d));
        }
    }
    map
}

fn parse_log(out: &str, unpushed: &str) -> Vec<Commit> {
    let local: std::collections::HashSet<&str> = unpushed.lines().map(str::trim).collect();
    out.lines()
        .filter_map(|l| {
            let mut f = l.split('\u{1f}');
            let (sha, subject, when) = (f.next()?, f.next()?, f.next()?);
            Some(Commit { sha: sha.into(), subject: subject.into(), when: when.into(), pushed: !local.contains(sha) })
        })
        .collect()
}

/// Run `f` off the async runtime: every command here waits on a child process.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

const STATUS_CMDS: &[&[&str]] = &[
    &["status", "--porcelain=v2", "--branch", "-z"],
    &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    &["log", "-n", "12", "--format=%H%x1f%s%x1f%cr"],
    &["rev-list", "HEAD", "--not", "--remotes", "-n", "200"],
    &["diff", "--numstat", "-z", "--cached"],
    &["diff", "--numstat", "-z"],
];

/// Parse one repo's status outputs (the commands in STATUS_CMDS).
fn status_from(r: &[Result<String, i32>]) -> Result<Status, String> {
    let status = match r.first() {
        Some(Ok(s)) => s,
        _ => return Err("not a git repository".into()),
    };
    let mut s = Status::default();
    parse_status(status, &mut s);
    let base = r.get(1).and_then(|x| x.as_ref().ok()).map(|b| b.trim().to_string()).unwrap_or_default();
    s.base = base.split_once('/').map(|(_, b)| b.to_string()).filter(|b| !b.is_empty()).unwrap_or_else(|| "main".into());
    let ok = |i: usize| r.get(i).and_then(|x| x.as_ref().ok()).map(String::as_str).unwrap_or("");
    s.commits = parse_log(ok(2), ok(3));
    let (index, work) = (parse_numstat(ok(4)), parse_numstat(ok(5)));
    for c in &mut s.files {
        c.index = index.get(&c.path).copied();
        c.work = work.get(&c.path).copied();
    }
    Ok(s)
}

#[tauri::command]
pub async fn git_status(host: String, path: String) -> Result<Status, String> {
    blocking(move || {
        let r = multi(&host, &path, STATUS_CMDS)?;
        status_from(&r).map_err(|_| format!("{path} is not a git repository"))
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct RepoStatus {
    /// The repo's path relative to the project folder.
    pub repo: String,
    pub status: Option<Status>,
    pub error: Option<String>,
}

/// The status of every repo nested in a folder, in one batch (one ssh round trip when remote).
/// A repo that cannot be read gets its own error; the others still load.
#[tauri::command]
pub async fn folder_status(host: String, path: String) -> Result<Vec<RepoStatus>, String> {
    blocking(move || folder_statuses(&host, &path)).await
}

fn folder_statuses(host: &str, path: &str) -> Result<Vec<RepoStatus>, String> {
    let repos = crate::folders::repos_in(host, path)?;
    if repos.is_empty() {
        return Ok(Vec::new());
    }
    let n = STATUS_CMDS.len();
    let outs = if matches!(host, "" | "local") {
        // Locally each command is a process: run the repos side by side, a few at a time.
        let base = std::path::PathBuf::from(expand_home(path));
        let mut outs = Vec::with_capacity(repos.len() * n);
        for chunk in repos.chunks(6) {
            let done: Vec<Vec<Result<String, i32>>> = std::thread::scope(|sc| {
                let jobs: Vec<_> = chunk
                    .iter()
                    .map(|r| {
                        let dir = base.join(r).to_string_lossy().into_owned();
                        sc.spawn(move || multi("local", &dir, STATUS_CMDS).unwrap_or_default())
                    })
                    .collect();
                jobs.into_iter().map(|j| j.join().unwrap_or_default()).collect()
            });
            for mut r in done {
                r.resize_with(n, || Err(-1));
                outs.extend(r);
            }
        }
        outs
    } else {
        let mut sets: Vec<Vec<&str>> = Vec::with_capacity(repos.len() * n);
        for r in &repos {
            for cmd in STATUS_CMDS {
                let mut args: Vec<&str> = vec!["-C", r.as_str()];
                args.extend(cmd.iter().copied());
                sets.push(args);
            }
        }
        let cmds: Vec<&[&str]> = sets.iter().map(|v| v.as_slice()).collect();
        multi(host, path, &cmds)?
    };
    Ok(repos.iter().enumerate().map(|(i, repo)| {
        let slice = outs.get(i * n..(i + 1) * n).unwrap_or(&[]);
        match status_from(slice) {
            Ok(status) => RepoStatus { repo: repo.clone(), status: Some(status), error: None },
            Err(e) => RepoStatus { repo: repo.clone(), status: None, error: Some(e) },
        }
    }).collect())
}

#[derive(Debug, Serialize)]
pub struct FileIndex {
    /// Relative, `/`-separated paths.
    pub files: Vec<String>,
    /// From `git ls-files`; false when the folder is not a repo and was walked instead.
    pub git: bool,
    /// More files exist than `INDEX_LIMIT`.
    pub truncated: bool,
}

const INDEX_LIMIT: usize = 50_000;

/// Go to File's index: tracked plus untracked files, ignored ones included (`.env`, a
/// gitignored `.todo/`), except inside the folders named in `skip` (Settings; unset is
/// `fs::SKIP`: `node_modules`, `.venv`, `target`…). A folder that is not a repo is walked.
#[tauri::command]
pub async fn project_files(host: String, path: String, skip: Option<Vec<String>>) -> Result<FileIndex, String> {
    let skip = skip.unwrap_or_else(|| crate::fs::SKIP.iter().map(|s| s.to_string()).collect());
    const CMDS: &[&[&str]] = &[
        &["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        // --directory folds a wholly ignored folder into one "dir/" entry, walked below
        &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    ];
    blocking(move || match multi(&host, &path, CMDS).ok().and_then(|r| r.into_iter().map(Result::ok).collect::<Option<Vec<_>>>()) {
        Some(outs) => {
            let mut files: Vec<String> = outs[0].split('\0').filter(|f| !f.is_empty()).map(String::from).collect();
            // a conflicted file is listed once per merge stage
            files.dedup();
            let (folded, ignored): (Vec<&str>, Vec<&str>) = outs[1].split('\0').filter(|f| !f.is_empty()).partition(|f| f.ends_with('/'));
            files.extend(ignored.into_iter().map(String::from));
            let walk: Vec<String> = folded
                .into_iter()
                .map(|d| d.trim_end_matches('/'))
                .filter(|d| !crate::fs::skipped(&skip, d.rsplit('/').next().unwrap_or(d)))
                .map(String::from)
                .collect();
            if !walk.is_empty() && files.len() <= INDEX_LIMIT {
                // Git for Windows can list a folded folder's files as well, so drop repeats
                let seen: std::collections::HashSet<String> = files.iter().cloned().collect();
                let (more, _) = crate::fs::walk_under(&host, &path, &walk, &skip, INDEX_LIMIT + 1 - files.len()).unwrap_or_default();
                files.extend(more.into_iter().filter(|f| !seen.contains(f)));
            }
            let truncated = files.len() > INDEX_LIMIT;
            files.truncate(INDEX_LIMIT);
            Ok(FileIndex { files, git: true, truncated })
        }
        None => {
            let (files, truncated) = crate::fs::walk(&host, &path, &skip, INDEX_LIMIT)?;
            Ok(FileIndex { files, git: false, truncated })
        }
    })
    .await
}

/// The diff of one file (or, with no `file`, of everything) in the index or the worktree.
/// An untracked file is diffed against nothing so it reads as all-added; a rename names its
/// `orig` path too, so git pairs the two instead of showing the new name as all-added.
#[tauri::command]
pub async fn git_diff(host: String, path: String, file: Option<String>, staged: bool, untracked: bool, orig: Option<String>) -> Result<String, String> {
    blocking(move || {
        if untracked {
            let f = file.unwrap_or_default();
            let args = ["diff", "--no-color", "--no-index", "--", "/dev/null", f.as_str()];
            return run(command(&host, &path, "git", &args)?, None, &[1]);
        }
        let mut args = vec!["diff", "--no-color"];
        if staged {
            args.push("--cached");
        }
        if let Some(f) = file.as_deref() {
            match orig.as_deref() {
                Some(o) => args.extend(["-M", "--", o, f]),
                None => args.extend(["--", f]),
            }
        }
        exec(&host, &path, "git", &args, None)
    })
    .await
}

/// Whether `path` sits inside a git work tree (a repo project, or a subfolder of one).
#[tauri::command]
pub async fn git_is_repo(host: String, path: String) -> Result<bool, String> {
    blocking(move || {
        Ok(exec(&host, &path, "git", &["rev-parse", "--is-inside-work-tree"], None)
            .map(|o| o.trim() == "true")
            .unwrap_or(false))
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct HeadFile {
    /// The file's text at HEAD; None when HEAD or the path does not exist yet (untracked, new file).
    pub text: Option<String>,
    /// For the target of a staged rename, the path HEAD has the file under (relative to `path`).
    pub from: Option<String>,
}

/// `git show HEAD:./file`: Some(text), None when HEAD or the path does not exist there yet.
fn show_head(host: &str, path: &str, file: &str) -> Result<Option<String>, String> {
    let spec = format!("HEAD:./{file}");
    match exec(host, path, "git", &["show", "--no-color", &spec], None) {
        Ok(text) => Ok(Some(text)),
        // A new file or an empty repo is all additions, not an error. Anything else
        // (an unreachable host, a broken worktree) must not look like a new file.
        Err(e)
            if e.contains("does not exist in")
                || e.contains("exists on disk, but not in")
                || e.contains("unknown revision")
                || e.contains("invalid object name")
                || e.contains("ambiguous argument") =>
        {
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// The source of a staged rename to `file`, from `diff --cached --name-status -z`
/// (`R<score> NUL old NUL new NUL`, other records `<status> NUL path NUL`).
fn renamed_from(name_status: &str, file: &str) -> Option<String> {
    let mut it = name_status.split('\0');
    while let Some(st) = it.next() {
        let st = st.trim_start_matches('\n');
        if st.starts_with('R') || st.starts_with('C') {
            let (old, new) = (it.next()?, it.next()?);
            if new == file && st.starts_with('R') {
                return Some(old.to_string());
            }
        } else if !st.is_empty() {
            it.next();
        }
    }
    None
}

/// The file's text at HEAD, for the editor's HEAD → buffer diff. `file` is relative to `path`,
/// so `HEAD:./file` resolves it from a subfolder as well as from the repo root.
#[tauri::command]
pub async fn git_head_text(host: String, path: String, file: String) -> Result<HeadFile, String> {
    blocking(move || {
        if let Some(text) = show_head(&host, &path, &file)? {
            return Ok(HeadFile { text: Some(text), from: None });
        }
        // Not at HEAD under this name: a staged rename diffs against the old one. `--relative`
        // keeps the paths relative to `path`, like `file`.
        let ns = exec(&host, &path, "git", &["diff", "--cached", "-M", "--name-status", "-z", "--relative"], None).unwrap_or_default();
        if let Some(old) = renamed_from(&ns, &file) {
            if let Some(text) = show_head(&host, &path, &old)? {
                return Ok(HeadFile { text: Some(text), from: Some(old) });
            }
        }
        Ok(HeadFile { text: None, from: None })
    })
    .await
}

/// Commit subjects and the merge-base diff from `base` to HEAD: the PR's content.
#[tauri::command]
pub async fn git_range(host: String, path: String, base: String) -> Result<Range, String> {
    blocking(move || {
        let range = format!("{base}..HEAD");
        let three = format!("{base}...HEAD");
        let r = multi(&host, &path, &[&["log", "--reverse", "--format=%s", &range], &["diff", "--no-color", &three]])?;
        let get = |i: usize| match r.get(i) {
            Some(Ok(s)) => Ok(s.clone()),
            _ => Err(format!("cannot compare with {base}")),
        };
        Ok(Range { subjects: get(0)?, diff: get(1)? })
    })
    .await
}

/// One commit: its message, author and full patch. Shown in the diff pane when a commit in
/// the Commits list is opened.
#[tauri::command]
pub async fn git_show(host: String, path: String, sha: String) -> Result<CommitDetail, String> {
    blocking(move || {
        let r = multi(&host, &path, &[
            &["show", "-s", "--no-color", "--format=%H%x1f%an%x1f%cr%x1f%B", &sha],
            &["show", "--no-color", "--format=", "--stat", &sha],
            &["show", "--no-color", "--format=", "--patch", &sha],
        ])?;
        let head = match r.first() {
            Some(Ok(s)) => s,
            _ => return Err(format!("cannot read commit {sha}")),
        };
        let mut f = head.splitn(4, '\u{1f}');
        let sha = f.next().unwrap_or_default().trim().to_string();
        let author = f.next().unwrap_or_default().to_string();
        let when = f.next().unwrap_or_default().to_string();
        let message = f.next().unwrap_or_default().trim_end().to_string();
        let get = |i: usize| r.get(i).and_then(|x| x.as_ref().ok()).cloned().unwrap_or_default();
        Ok(CommitDetail { sha, author, when, message, stat: get(1).trim().to_string(), diff: get(2) })
    })
    .await
}

#[tauri::command]
pub async fn git_stage(host: String, path: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["add", "-A", "--"];
        args.extend(files.iter().map(String::as_str));
        exec(&host, &path, "git", &args, None).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(host: String, path: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["reset", "-q", "HEAD", "--"];
        args.extend(files.iter().map(String::as_str));
        exec(&host, &path, "git", &args, None).map(|_| ())
    })
    .await
}

/// Commit the index. The message goes on stdin, so no quoting reaches a remote shell.
#[tauri::command]
pub async fn git_commit(host: String, path: String, message: String) -> Result<String, String> {
    blocking(move || exec(&host, &path, "git", &["commit", "-q", "-F", "-"], Some(message))).await
}

/// Push the branch; a branch with no upstream is pushed to origin and tracks it.
#[tauri::command]
pub async fn git_push(host: String, path: String, set_upstream: bool) -> Result<(), String> {
    blocking(move || {
        let args: &[&str] = if set_upstream { &["push", "-u", "origin", "HEAD"] } else { &["push"] };
        exec(&host, &path, "git", args, None).map(|_| ())
    })
    .await
}

const PR_FIELDS: &str = "number,title,body,state,url,isDraft,baseRefName,mergeable,statusCheckRollup";

/// The open (or last) PR for the current branch, as gh prints it. None when there is none.
#[tauri::command]
pub async fn gh_pr_view(host: String, path: String) -> Result<Option<serde_json::Value>, String> {
    blocking(move || match exec(&host, &path, "gh", &["pr", "view", "--json", PR_FIELDS], None) {
        Ok(json) => serde_json::from_str(&json).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.contains("no pull requests found") => Ok(None),
        Err(e) => Err(e),
    })
    .await
}

#[tauri::command]
pub async fn gh_pr_create(host: String, path: String, title: String, body: String, base: String, draft: bool) -> Result<String, String> {
    blocking(move || {
        let mut args = vec!["pr", "create", "--title", title.as_str(), "--base", base.as_str(), "--body-file", "-"];
        if draft {
            args.push("--draft");
        }
        exec(&host, &path, "gh", &args, Some(body)).map(|url| url.trim().to_string())
    })
    .await
}

/// Merge the branch's PR. `strategy` is squash, merge or rebase.
#[tauri::command]
pub async fn gh_pr_merge(host: String, path: String, strategy: String, delete_branch: bool) -> Result<(), String> {
    blocking(move || {
        let flag = match strategy.as_str() {
            "merge" => "--merge",
            "rebase" => "--rebase",
            _ => "--squash",
        };
        let mut args = vec!["pr", "merge", flag];
        if delete_branch {
            args.push("--delete-branch");
        }
        exec(&host, &path, "gh", &args, None).map(|_| ())
    })
    .await
}

// ── worktrees ───────────────────────────────────────────────────────

#[derive(Debug, Serialize, PartialEq)]
pub struct Worktree {
    /// As git prints it: absolute, `/`-separated.
    pub path: String,
    /// None when HEAD is detached.
    pub branch: Option<String>,
    /// The repo's own folder (the first entry), not an added worktree.
    pub main: bool,
}

/// Parse `git worktree list --porcelain`: blank-line separated records, the main one first.
fn parse_worktrees(out: &str) -> Vec<Worktree> {
    out.split("\n\n")
        .filter_map(|rec| {
            let mut path = None;
            let mut branch = None;
            for l in rec.lines() {
                if let Some(p) = l.strip_prefix("worktree ") {
                    path = Some(p.to_string());
                } else if let Some(b) = l.strip_prefix("branch ") {
                    branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                }
            }
            path.map(|path| Worktree { path, branch, main: false })
        })
        .enumerate()
        .map(|(i, w)| Worktree { main: i == 0, ..w })
        .collect()
}

/// git in `path` with some arguments that are paths: those keep a leading `~` expandable,
/// locally and over ssh, where every other argument is quoted.
fn exec_with_paths(host: &str, path: &str, args: &[&str], paths: &[usize]) -> Result<String, String> {
    if matches!(host, "" | "local") {
        let owned: Vec<String> = args.iter().enumerate().map(|(i, a)| if paths.contains(&i) { expand_home(a) } else { a.to_string() }).collect();
        let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
        return exec(host, path, "git", &refs, None);
    }
    let words: Vec<String> = args.iter().enumerate().map(|(i, a)| if paths.contains(&i) { remote_path(a) } else { sq(a) }).collect();
    remote::run(host, &format!("cd {} && git {}", remote_path(path), words.join(" ")))
}

#[tauri::command]
pub async fn git_worktrees(host: String, path: String) -> Result<Vec<Worktree>, String> {
    blocking(move || exec(&host, &path, "git", &["worktree", "list", "--porcelain"], None).map(|o| parse_worktrees(&o))).await
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Branch {
    /// Without `refs/heads/` or the remote's name.
    pub name: String,
    /// Only on a remote (`origin/<name>`) so far: checking it out makes a local branch tracking it.
    pub remote: Option<String>,
}

/// Parse `git for-each-ref --format=%(refname) refs/heads refs/remotes`: the local branches, then
/// the remote ones with no local branch of the same name (once, the first remote's).
fn parse_branches(out: &str) -> Vec<Branch> {
    let mut local: Vec<Branch> = Vec::new();
    let mut remote: Vec<Branch> = Vec::new();
    for r in out.lines().map(str::trim) {
        if let Some(name) = r.strip_prefix("refs/heads/") {
            local.push(Branch { name: name.to_string(), remote: None });
        } else if let Some((at, name)) = r.strip_prefix("refs/remotes/").and_then(|r| r.split_once('/')) {
            if name != "HEAD" && !remote.iter().any(|b| b.name == name) {
                remote.push(Branch { name: name.to_string(), remote: Some(at.to_string()) });
            }
        }
    }
    remote.retain(|b| !local.iter().any(|l| l.name == b.name));
    local.extend(remote);
    local
}

/// Fetch every remote, dropping branches deleted there, so New worktree lists what was pushed since.
#[tauri::command]
pub async fn git_fetch(host: String, path: String) -> Result<(), String> {
    blocking(move || exec(&host, &path, "git", &["fetch", "--all", "--prune", "--quiet"], None).map(|_| ())).await
}

/// The branches a Worktree could check out, local and remote.
#[tauri::command]
pub async fn git_branches(host: String, path: String) -> Result<Vec<Branch>, String> {
    blocking(move || exec(&host, &path, "git", &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], None).map(|o| parse_branches(&o))).await
}

/// Check out `branch` in a new folder `dir`. A branch only on a remote gets a local branch tracking
/// it; one that does not exist yet is made from `base` (from HEAD when there is no local `base` either).
#[tauri::command]
pub async fn git_worktree_add(host: String, path: String, dir: String, branch: String, base: String) -> Result<(), String> {
    blocking(move || {
        let has = |r: &str| exec(&host, &path, "git", &["rev-parse", "--verify", "--quiet", r], None).is_ok();
        if has(&format!("refs/heads/{branch}")) {
            return exec_with_paths(&host, &path, &["worktree", "add", &dir, &branch], &[2]).map(|_| ());
        }
        let refs = exec(&host, &path, "git", &["for-each-ref", "--format=%(refname)", "refs/remotes"], None).unwrap_or_default();
        let (start, tracks) = match parse_branches(&refs).into_iter().find(|b| b.name == branch).and_then(|b| b.remote) {
            Some(at) => (format!("{at}/{branch}"), true),
            None if has(&format!("refs/heads/{base}")) => (base, false),
            None => ("HEAD".to_string(), false),
        };
        let mut args = vec!["worktree", "add"];
        if tracks {
            args.push("--track");
        }
        args.extend(["-b", &branch, &dir, &start]);
        let at = args.len() - 2;
        exec_with_paths(&host, &path, &args, &[at]).map(|_| ())
    })
    .await
}

/// Remove the worktree at `dir`; `force` also throws away its uncommitted changes.
#[tauri::command]
pub async fn git_worktree_remove(host: String, path: String, dir: String, force: bool) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&dir);
        let at = args.len() - 1;
        exec_with_paths(&host, &path, &args, &[at]).map(|_| ())
    })
    .await
}

/// Delete a local branch; `force` also deletes one git thinks is unmerged (a squash-merged PR's).
#[tauri::command]
pub async fn git_branch_delete(host: String, path: String, branch: String, force: bool) -> Result<(), String> {
    blocking(move || exec(&host, &path, "git", &["branch", if force { "-D" } else { "-d" }, &branch], None).map(|_| ())).await
}

/// Fetch origin, then create `branch` from `origin/<base>` and switch to it in the repo at `path`.
/// Start next feature runs this in each nested repo of a copy, so they all start from the same place.
#[tauri::command]
pub async fn git_switch_create(host: String, path: String, branch: String, base: String) -> Result<(), String> {
    blocking(move || {
        exec(&host, &path, "git", &["fetch", "--quiet", "origin"], None)?;
        let start = format!("origin/{base}");
        exec(&host, &path, "git", &["switch", "-c", &branch, &start], None).map(|_| ())
    })
    .await
}

/// Delete the branch on origin (what `gh pr merge --delete-branch` does, which fails in a worktree).
#[tauri::command]
pub async fn git_push_delete(host: String, path: String, branch: String) -> Result<(), String> {
    blocking(move || exec(&host, &path, "git", &["push", "origin", "--delete", &branch], None).map(|_| ())).await
}

/// One ✦ draft: `prompt` on the stdin of `command`, a shell line the user set in Settings › Git
/// (`claude -p`, `pi -p --model ...`). It runs in the project folder on the project's host, through
/// the login shell as an agent's command does, so the user's own login and PATH apply.
#[tauri::command]
pub async fn git_draft(host: String, path: String, command: String, prompt: String) -> Result<String, String> {
    blocking(move || {
        let cmd = shell_line(&host, &path, &command)?;
        run(cmd, Some(prompt), &[]).map(|s| s.trim().to_string())
    })
    .await
}

/// `line` as a shell command in `path` on `host`: cmd.exe on Windows (the line passed verbatim),
/// else the login shell; over ssh, the same login shell on the remote.
fn shell_line(host: &str, path: &str, line: &str) -> Result<Command, String> {
    if !matches!(host, "" | "local") {
        crate::envssh::check(host)?;
        return Ok(remote::command(host, &remote_draft_script(path, line)));
    }
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new("cmd.exe");
        c.args(["/d", "/c"]).raw_arg(line).creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = Command::new(shell);
        c.args(["-lc", line]);
        c
    };
    cmd.current_dir(expand_home(path));
    Ok(cmd)
}

/// The script ssh runs for a remote draft: `line` in `path`, under the remote login shell.
fn remote_draft_script(path: &str, line: &str) -> String {
    let inner = format!("cd {} && {}", remote_path(path), line);
    format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", sq(&inner))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_draft_runs_the_line_in_the_folder_under_a_login_shell() {
        assert_eq!(
            remote_draft_script("~/my app", "pi -p --model x"),
            r#"exec "${SHELL:-/bin/sh}" -lc 'cd ~/'\''my app'\'' && pi -p --model x'"#
        );
    }

    #[test]
    fn status_parses_branch_and_every_record_kind() {
        let out = "# branch.oid abc\0# branch.head feat/x\0# branch.upstream origin/feat/x\0# branch.ab +2 -1\0\
                   1 M. N... 100644 100644 100644 a b src/a b.ts\0\
                   1 .M N... 100644 100644 100644 a b README.md\0\
                   2 R. N... 100644 100644 100644 a b R100 new.rs\0old.rs\0\
                   u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
                   ? notes.md\0";
        let mut s = Status::default();
        parse_status(out, &mut s);
        assert_eq!(s.branch.as_deref(), Some("feat/x"));
        assert_eq!(s.upstream.as_deref(), Some("origin/feat/x"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        let got: Vec<(&str, &str, &str)> = s.files.iter().map(|c| (c.path.as_str(), c.x.as_str(), c.y.as_str())).collect();
        assert_eq!(got, [
            ("src/a b.ts", "M", "."),
            ("README.md", ".", "M"),
            ("new.rs", "R", "."),
            ("conflict.txt", "U", "U"),
            ("notes.md", "?", "?"),
        ]);
    }

    #[test]
    fn status_keeps_a_renames_original_path() {
        let mut s = Status::default();
        parse_status("2 R. N... 100644 100644 100644 a b R100 new.rs\0old.rs\0", &mut s);
        assert_eq!(s.files[0].orig.as_deref(), Some("old.rs"));
    }

    #[test]
    fn numstat_reads_counts_renames_and_skips_binaries() {
        let m = parse_numstat(concat!("3\t1\tsrc/a b.ts\0", "-\t-\tlogo.png\0", "5\t0\t\0old.rs\0new.rs\0"));
        assert_eq!(m.get("src/a b.ts"), Some(&(3, 1)));
        assert_eq!(m.get("new.rs"), Some(&(5, 0)));
        assert_eq!(m.get("logo.png"), None);
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn rename_source_from_name_status() {
        let ns = "M\0a.ts\0R087\0src/old.ts\0src/new.ts\0A\0b.ts\0";
        assert_eq!(renamed_from(ns, "src/new.ts").as_deref(), Some("src/old.ts"));
        assert_eq!(renamed_from(ns, "b.ts"), None);
        assert_eq!(renamed_from("", "x"), None);
    }

    #[test]
    fn detached_head_has_no_branch() {
        let mut s = Status::default();
        parse_status("# branch.head (detached)\0", &mut s);
        assert_eq!(s.branch, None);
    }

    #[test]
    fn multi_output_splits_on_exit_markers() {
        let r = split_multi("a\0b\0\u{1e}0\u{1e}\u{1e}128\u{1e}x\ny\n\u{1e}0\u{1e}");
        assert_eq!(r, vec![Ok("a\0b\0".to_string()), Err(128), Ok("x\ny\n".to_string())]);
    }

    #[test]
    fn log_marks_commits_not_on_a_remote() {
        let c = parse_log("aaa\u{1f}One\u{1f}2 hours ago\nbbb\u{1f}Two\u{1f}3 days ago\n", "aaa\n");
        assert!(!c[0].pushed);
        assert!(c[1].pushed);
        assert_eq!(c[1].subject, "Two");
    }

    #[test]
    fn worktree_list_marks_the_main_one_and_detached_heads() {
        let w = parse_worktrees("worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r.worktrees/feat-x\nHEAD bbb\nbranch refs/heads/feat/x\n\nworktree /tmp/d\nHEAD ccc\ndetached\n\n");
        assert_eq!(w, vec![
            Worktree { path: "/r".into(), branch: Some("main".into()), main: true },
            Worktree { path: "/r.worktrees/feat-x".into(), branch: Some("feat/x".into()), main: false },
            Worktree { path: "/tmp/d".into(), branch: None, main: false },
        ]);
    }

    #[test]
    fn branches_list_local_then_remote_only_ones() {
        let b = parse_branches("refs/heads/main
refs/heads/feat/x
refs/remotes/origin/HEAD
refs/remotes/origin/main
refs/remotes/origin/agents-revamp
refs/remotes/fork/agents-revamp
");
        assert_eq!(b, vec![
            Branch { name: "main".into(), remote: None },
            Branch { name: "feat/x".into(), remote: None },
            Branch { name: "agents-revamp".into(), remote: Some("origin".into()) },
        ]);
    }

    #[cfg(unix)]
    #[test]
    fn worktree_add_list_and_remove_against_a_real_repo() {
        let dir = std::env::temp_dir().join(format!("tri-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("r")).unwrap();
        let p = dir.join("r");
        let p = p.to_str().unwrap();
        let git = |args: &[&str]| exec("local", p, "git", args, None).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "i"]);

        let wt = format!("{}/r.worktrees/tri-1-x", dir.to_str().unwrap());
        exec_with_paths("local", p, &["worktree", "add", "-b", "tri-1-x", &wt, "main"], &[4]).unwrap();
        // an existing branch is checked out instead of created
        git(&["branch", "old"]);
        let wt2 = format!("{}/r.worktrees/old", dir.to_str().unwrap());
        exec_with_paths("local", p, &["worktree", "add", &wt2, "old"], &[2]).unwrap();
        let list = parse_worktrees(&git(&["worktree", "list", "--porcelain"]));
        let mut branches: Vec<String> = list.iter().map(|w| w.branch.clone().unwrap()).collect();
        branches[1..].sort();
        assert_eq!(branches, ["main", "old", "tri-1-x"]);
        assert!(list[0].main && !list[1].main);

        std::fs::write(format!("{wt}/dirty.txt"), "x").unwrap();
        assert!(exec_with_paths("local", p, &["worktree", "remove", &wt], &[2]).is_err());
        exec_with_paths("local", p, &["worktree", "remove", "--force", &wt], &[3]).unwrap();
        git(&["branch", "-D", "tri-1-x"]);
        assert_eq!(parse_worktrees(&git(&["worktree", "list", "--porcelain"])).len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn stage_commit_and_status_against_a_real_repo() {
        let dir = std::env::temp_dir().join(format!("tri-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_str().unwrap();
        let git = |args: &[&str]| exec("local", p, "git", args, None).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(dir.join("it's.txt"), "hi\n").unwrap();

        let r = multi("local", p, &[&["status", "--porcelain=v2", "--branch", "-z"]]).unwrap();
        let mut s = Status::default();
        parse_status(r[0].as_ref().unwrap(), &mut s);
        assert_eq!(s.files, vec![Change { path: "it's.txt".into(), x: "?".into(), y: "?".into(), index: None, work: None, orig: None }]);

        let diff = run(command("local", p, "git", &["diff", "--no-color", "--no-index", "--", "/dev/null", "it's.txt"]).unwrap(), None, &[1]).unwrap();
        assert!(diff.contains("+hi"));

        // Go to File's index: untracked files count, ignored ones do not
        std::fs::write(dir.join(".gitignore"), "skip/\n").unwrap();
        std::fs::create_dir_all(dir.join("skip")).unwrap();
        std::fs::write(dir.join("skip/x.txt"), "").unwrap();
        let mut idx: Vec<String> = exec("local", p, "git", &["ls-files", "-z", "--cached", "--others", "--exclude-standard"], None)
            .unwrap().split('\0').filter(|f| !f.is_empty()).map(String::from).collect();
        idx.sort();
        assert_eq!(idx, [".gitignore", "it's.txt"]);
        std::fs::remove_file(dir.join(".gitignore")).unwrap();

        git(&["add", "-A", "--", "it's.txt"]);
        exec("local", p, "git", &["commit", "-q", "-F", "-"], Some("Add a file\n\nWith a body.\n".into())).unwrap();
        let log = git(&["log", "--format=%s%n%b"]);
        assert_eq!(log.trim(), "Add a file\nWith a body.");

        // What git_show reads back: the header fields and the patch.
        let r = multi("local", p, &[
            &["show", "-s", "--no-color", "--format=%H%x1f%an%x1f%cr%x1f%B", "HEAD"],
            &["show", "--no-color", "--format=", "--stat", "HEAD"],
            &["show", "--no-color", "--format=", "--patch", "HEAD"],
        ])
        .unwrap();
        let head = r[0].as_ref().unwrap();
        let mut f = head.splitn(4, '\u{1f}');
        let (sha, author, _when, message) = (f.next().unwrap(), f.next().unwrap(), f.next().unwrap(), f.next().unwrap());
        assert_eq!(sha.trim().len(), 40);
        assert_eq!(author, "T");
        assert_eq!(message.trim_end(), "Add a file\n\nWith a body.");
        assert!(r[1].as_ref().unwrap().contains("1 file changed"));
        assert!(r[2].as_ref().unwrap().contains("+hi"));

        // The script a remote project runs over ssh, run here by a real shell.
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(multi_script(p, &[&["status", "--porcelain=v2", "--branch", "-z"], &["rev-parse", "--verify", "nope"], &["log", "--format=%s"]]))
            .output()
            .unwrap();
        std::fs::remove_dir_all(&dir).ok();
        let r = split_multi(&String::from_utf8_lossy(&out.stdout));
        assert!(r[0].as_ref().unwrap().contains("# branch.head main"));
        assert!(r[1].is_err());
        assert_eq!(r[2].as_deref(), Ok("Add a file\n"));
    }
    #[cfg(unix)]
    #[test]
    fn folder_status_reads_each_nested_repo_with_line_counts() {
        let dir = std::env::temp_dir().join(format!("tri-folder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for r in ["api", "web/app"] {
            let p = dir.join(r);
            std::fs::create_dir_all(&p).unwrap();
            let p = p.to_str().unwrap();
            let git = |args: &[&str]| exec("local", p, "git", args, None).unwrap();
            git(&["init", "-q", "-b", "main"]);
            git(&["config", "user.email", "t@example.com"]);
            git(&["config", "user.name", "T"]);
            std::fs::write(format!("{p}/a.txt"), "one\ntwo\n").unwrap();
            git(&["add", "a.txt"]);
            git(&["commit", "-q", "-m", "first"]);
        }
        std::fs::write(dir.join("api/a.txt"), "one\nTWO\nthree\n").unwrap();
        exec("local", dir.join("web/app").to_str().unwrap(), "git", &["mv", "a.txt", "b.txt"], None).unwrap();
        std::fs::write(dir.join("notes.md"), "not in a repo").unwrap();

        let mut got = folder_statuses("local", dir.to_str().unwrap()).unwrap();
        got.sort_by(|a, b| a.repo.cmp(&b.repo));
        assert_eq!(got.iter().map(|r| r.repo.as_str()).collect::<Vec<_>>(), ["api", "web/app"]);
        let api = got[0].status.as_ref().unwrap();
        assert_eq!(api.branch.as_deref(), Some("main"));
        assert_eq!(api.commits.len(), 1);
        assert_eq!((api.files[0].path.as_str(), api.files[0].work, api.files[0].index), ("a.txt", Some((2, 1)), None));
        let web = got[1].status.as_ref().unwrap();
        assert_eq!((web.files[0].path.as_str(), web.files[0].orig.as_deref(), web.files[0].index), ("b.txt", Some("a.txt"), Some((0, 0))));

        // The rename's target reads its HEAD text under the old name.
        let w = dir.join("web/app");
        let ns = exec("local", w.to_str().unwrap(), "git", &["diff", "--cached", "-M", "--name-status", "-z", "--relative"], None).unwrap();
        assert_eq!(renamed_from(&ns, "b.txt").as_deref(), Some("a.txt"));
        assert_eq!(show_head("local", w.to_str().unwrap(), "a.txt").unwrap().as_deref(), Some("one\ntwo\n"));
        assert_eq!(show_head("local", w.to_str().unwrap(), "b.txt").unwrap(), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
