//! The ignored files New worktree can copy into a new checkout: what git leaves behind because
//! `.gitignore` keeps it out (`.env*`, local databases, `.dev/*.conf.json`, data files), listed
//! from the repo's own folder with sizes. Chosen from design/worktree-gitignore.html (variant B).
//! Local paths use `std::fs`; remote ones run one `sh` script over ssh, like `folders.rs`.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::folders::HEAVY;
use crate::remote;
use crate::spawn::{expand_home, remote_path, sq};

/// What is offered, as git pathspecs from the repo's root.
const WANTED: &[&str] = &[
    "**/.env*",
    "**/*.db",
    "**/*.sqlite",
    "**/*.sqlite3",
    ".dev/*.conf.json",
    "**/*.csv",
    "**/*.tsv",
    "**/*.parquet",
    "**/*.jsonl",
    "**/*.ndjson",
    "**/*.xlsx",
    "**/data/**",
];
/// Build output on top of `folders::HEAVY`, never offered even when a pattern matches inside it.
const BUILD: &[&str] = &["dist", "build", "out", ".cache"];
/// More than this many is a folder of generated files, not something to tick through.
const MAX: usize = 500;

#[derive(Debug, Serialize, PartialEq)]
pub struct IgnoredFile {
    /// Relative to the repo, `/`-separated.
    pub path: String,
    pub size: u64,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn is_local(host: &str) -> bool {
    matches!(host, "" | "local")
}

/// `git ls-files` arguments listing the ignored files that match WANTED, outside build folders.
fn ls_args() -> Vec<String> {
    let mut a: Vec<String> = ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--"].map(String::from).to_vec();
    a.extend(WANTED.iter().map(|p| format!(":(glob){p}")));
    a.extend(HEAVY.iter().chain(BUILD).filter(|h| **h != ".git").map(|h| format!(":(exclude,glob)**/{h}/**")));
    a
}

/// Prints `<size>\t<path>` per file. `wc -c` and `xargs -0` are in every POSIX toolbox.
fn list_script(path: &str) -> String {
    let git = std::iter::once("git".to_string()).chain(ls_args()).map(|a| sq(&a)).collect::<Vec<_>>().join(" ");
    let each = r#"for f; do [ -f "$f" ] && printf '%s\t%s\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; done"#;
    format!("cd {} || exit 1; {git} | xargs -0 sh -c {} sh", remote_path(path), sq(each))
}

fn parse_list(out: &str) -> Vec<IgnoredFile> {
    out.lines()
        .filter_map(|l| {
            let (size, path) = l.split_once('\t')?;
            Some(IgnoredFile { path: path.to_string(), size: size.trim().parse().ok()? })
        })
        .collect()
}

fn finish(mut files: Vec<IgnoredFile>) -> Vec<IgnoredFile> {
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.truncate(MAX);
    files
}

/// The ignored files in the repo at `path` that New worktree offers to copy.
#[tauri::command]
pub async fn ignored_files(host: String, path: String) -> Result<Vec<IgnoredFile>, String> {
    blocking(move || {
        if !is_local(&host) {
            return Ok(finish(parse_list(&remote::run(&host, &format!("sh -c {}", sq(&list_script(&path))))?)));
        }
        let args = ls_args();
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = crate::git::exec(&host, &path, "git", &refs, None)?;
        let root = PathBuf::from(expand_home(&path));
        Ok(finish(
            out.split('\0')
                .filter(|p| !p.is_empty())
                .filter_map(|p| {
                    let meta = std::fs::metadata(root.join(p)).ok().filter(|m| m.is_file())?;
                    Some(IgnoredFile { path: p.replace('\\', "/"), size: meta.len() })
                })
                .collect(),
        ))
    })
    .await
}

fn leaves(rel: &str) -> bool {
    rel.is_empty() || rel.starts_with('/') || rel.starts_with('\\') || rel.contains(':') || rel.split(['/', '\\']).any(|p| p == "..")
}

fn copy_script(src: &str, dest: &str, files: &[String]) -> String {
    let (s, d) = (remote_path(src), remote_path(dest));
    let mut lines = vec!["set -e".to_string()];
    for f in files {
        let q = sq(f);
        lines.push(format!("if [ -f {s}/{q} ]; then mkdir -p \"$(dirname {d}/{q})\" && cp -p {s}/{q} {d}/{q}; fi"));
    }
    lines.join("\n")
}

/// Copy `files` (relative paths) from the repo at `src` into the new checkout `dest`, keeping their
/// folders; one that is gone since it was listed is skipped. Run before the setup, so it can rely on them.
#[tauri::command]
pub async fn ignored_copy(host: String, src: String, dest: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || {
        if let Some(f) = files.iter().find(|f| leaves(f)) {
            return Err(format!("{f} is not inside the repo"));
        }
        if !is_local(&host) {
            return remote::run(&host, &format!("sh -c {}", sq(&copy_script(&src, &dest, &files)))).map(|_| ());
        }
        let (src, dest) = (PathBuf::from(expand_home(&src)), PathBuf::from(expand_home(&dest)));
        copy_local(&src, &dest, &files)
    })
    .await
}

fn copy_local(src: &Path, dest: &Path, files: &[String]) -> Result<(), String> {
    for f in files {
        if !src.join(f).is_file() {
            continue;
        }
        let to = dest.join(f);
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::copy(src.join(f), &to).map_err(|e| format!("{f}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_that_leave_the_repo_are_refused() {
        for bad in ["", "../x", "a/../../x", "/etc/passwd", "C:\\x", "a\\..\\..\\x"] {
            assert!(leaves(bad), "{bad}");
        }
        for ok in [".env", "apps/web/.env.local", ".dev/plane.conf.json"] {
            assert!(!leaves(ok), "{ok}");
        }
    }

    #[test]
    fn parses_sizes_and_skips_junk() {
        let files = parse_list("412\t.env\n  18200\tapps/my db.sqlite\nnope\n");
        assert_eq!(files, vec![IgnoredFile { path: ".env".into(), size: 412 }, IgnoredFile { path: "apps/my db.sqlite".into(), size: 18200 }]);
    }

    fn repo(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("tri-ignored-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["apps/web", "node_modules/x", ".dev", "data", "dist", "src"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let files = [
            (".gitignore", ".env*\n*.db\nnode_modules/\n.dev/\ndata/\ndist/\n"),
            (".env", "A=1"),
            ("apps/web/.env.local", "B=2"),
            ("node_modules/x/.env", "no"),
            ("dist/cache.db", "no"),
            ("dev.db", "db"),
            (".dev/plane.conf.json", "{}"),
            (".dev/issues.json", "[]"),
            ("data/rows.bin", "1234"),
            ("src/main.ts", "tracked"),
        ];
        for (f, body) in files {
            std::fs::write(root.join(f), body).unwrap();
        }
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&root).output().unwrap().status.success());
        git(&["init", "-q"]);
        git(&["add", ".gitignore", "src"]);
        root
    }

    const EXPECTED: [&str; 5] = [".dev/plane.conf.json", ".env", "apps/web/.env.local", "data/rows.bin", "dev.db"];

    #[test]
    fn lists_wanted_ignored_files_outside_build_folders_then_copies_them() {
        let root = repo("local");
        let files = tauri::async_runtime::block_on(ignored_files("local".into(), root.to_string_lossy().into())).unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), EXPECTED);
        assert_eq!(files.iter().find(|f| f.path == "data/rows.bin").unwrap().size, 4);

        let dest = root.with_extension("worktrees").join("f");
        copy_local(&root, &dest, &[".env".into(), "apps/web/.env.local".into(), "gone.db".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("apps/web/.env.local")).unwrap(), "B=2");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(root.with_extension("worktrees")).ok();
    }

    // Runs the scripts with /bin/sh, which Windows doesn't have.
    #[cfg(unix)]
    #[test]
    fn remote_scripts_run_in_a_real_shell() {
        let root = repo("remote");
        let sh = |script: String| {
            let out = std::process::Command::new("/bin/sh").arg("-c").arg(script).output().unwrap();
            assert!(out.status.success(), "{out:?}");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let s = root.to_string_lossy().to_string();
        let files = finish(parse_list(&sh(list_script(&s))));
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), EXPECTED);
        let d = root.with_extension("worktrees").join("it's f").to_string_lossy().to_string();
        sh(copy_script(&s, &d, &[".env".into(), "apps/web/.env.local".into(), "gone.db".into()]));
        assert_eq!(std::fs::read_to_string(Path::new(&d).join("apps/web/.env.local")).unwrap(), "B=2");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(root.with_extension("worktrees")).ok();
    }
}
