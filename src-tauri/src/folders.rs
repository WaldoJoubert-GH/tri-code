//! Worktrees for a folder that is not a git repo: a copy of it in `<folder>.worktrees/<name>`.
//!
//! The repos nested in the folder are left out of the copy (the frontend adds each back as a
//! `git worktree` on the feature branch), and so are rebuildable folders like `node_modules`.
//! When the copy is made, a snapshot of every other file's hash goes in a sidecar next to it
//! (`<folder>.worktrees/.<name>.copy.json`). Finishing compares the copy and the folder with
//! that snapshot: what changed only in the copy goes back, what changed in both is a conflict.
//! Local paths use `std::fs`; remote ones run one `sh` script over ssh, like `dirs.rs`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::remote;
use crate::spawn::{expand_home, remote_path, sq};

/// Folders a copy skips wherever they are: dependencies and build output, rebuilt in the copy.
const HEAVY: &[&str] = &["node_modules", "target", ".venv", "venv", "__pycache__", ".next", ".turbo", ".gradle", ".git"];
/// How deep `folder_repos` looks for nested repos.
const REPO_DEPTH: usize = 4;

/// Relative path → content hash, for every file a copy carries.
type Manifest = BTreeMap<String, String>;

#[derive(Debug, Serialize, PartialEq)]
pub struct Changes {
    /// Changed or added in the copy only: copied back on finish.
    pub changed: Vec<String>,
    /// Deleted in the copy only: deleted in the folder on finish.
    pub deleted: Vec<String>,
    /// Changed in both the copy and the folder since the copy was made, differently.
    pub conflicts: Vec<String>,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn is_local(host: &str) -> bool {
    matches!(host, "" | "local")
}

/// The repos nested in `path` (relative, `/`-separated, outermost only), not counting `path` itself.
#[tauri::command]
pub async fn folder_repos(host: String, path: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let found = if is_local(&host) { repos_local(Path::new(&expand_home(&path))) } else { repos_remote(&host, &path)? };
        Ok(outermost(found))
    })
    .await
}

/// Copy `src` to `dest` (which must not exist), leaving out `skip` (relative paths) and the HEAVY
/// folders, then write the snapshot the finish compares against.
#[tauri::command]
pub async fn folder_copy(host: String, src: String, dest: String, skip: Vec<String>) -> Result<(), String> {
    blocking(move || {
        if is_local(&host) {
            let (src, dest) = (PathBuf::from(expand_home(&src)), PathBuf::from(expand_home(&dest)));
            if dest.exists() {
                return Err(format!("{} already exists", dest.display()));
            }
            copy_local(&src, &dest, Path::new(""), &skip)?;
        } else {
            remote::run(&host, &copy_script(&src, &dest, &skip))?;
        }
        let manifest = manifest(&host, &dest, &skip)?;
        write_sidecar(&host, &dest, &serde_json::to_string(&manifest).map_err(|e| e.to_string())?)
    })
    .await
}

/// What finishing the copy `dest` of `src` would carry back, and what changed on both sides.
#[tauri::command]
pub async fn folder_changes(host: String, src: String, dest: String, skip: Vec<String>) -> Result<Changes, String> {
    blocking(move || {
        let then: Manifest = serde_json::from_str(&read_sidecar(&host, &dest)?).map_err(|e| format!("{}: {e}", sidecar(&dest)))?;
        Ok(compare(&then, &manifest(&host, &dest, &skip)?, &manifest(&host, &src, &skip)?))
    })
    .await
}

/// Copy `files` from the copy `dest` back into `src` (one the copy no longer has is deleted, as
/// when you keep the copy's side of a conflict it deleted), delete `delete` from `src`, then delete
/// the copy and its snapshot. The nested repos' worktrees must be removed first.
#[tauri::command]
pub async fn folder_finish(host: String, src: String, dest: String, files: Vec<String>, delete: Vec<String>) -> Result<(), String> {
    blocking(move || {
        if !dest.replace('\\', "/").contains(".worktrees/") {
            return Err(format!("{dest} is not in a .worktrees folder; not deleting it"));
        }
        let bad = |r: &String| r.split(['/', '\\']).any(|p| p == "..") || r.starts_with('/');
        if files.iter().chain(&delete).any(bad) {
            return Err("a path leaves the folder".into());
        }
        if is_local(&host) {
            let (src, dest) = (PathBuf::from(expand_home(&src)), PathBuf::from(expand_home(&dest)));
            for f in &files {
                let to = src.join(f);
                if !dest.join(f).exists() {
                    let _ = std::fs::remove_file(&to);
                    continue;
                }
                if let Some(dir) = to.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
                }
                std::fs::copy(dest.join(f), &to).map_err(|e| format!("{f}: {e}"))?;
            }
            for f in &delete {
                let _ = std::fs::remove_file(src.join(f));
            }
            std::fs::remove_dir_all(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
            let _ = std::fs::remove_file(expand_home(&sidecar(&dest.to_string_lossy())));
            Ok(())
        } else {
            remote::run(&host, &finish_script(&src, &dest, &files, &delete)).map(|_| ())
        }
    })
    .await
}

/// Which files to carry back: changed in the copy and not already the same in the folder; a
/// conflict when the folder changed too.
fn compare(then: &Manifest, copy: &Manifest, base: &Manifest) -> Changes {
    let mut c = Changes { changed: Vec::new(), deleted: Vec::new(), conflicts: Vec::new() };
    let names: std::collections::BTreeSet<&String> = then.keys().chain(copy.keys()).collect();
    for f in names {
        let (t, n, b) = (then.get(f), copy.get(f), base.get(f));
        if n == t || n == b {
            continue;
        }
        if b != t {
            c.conflicts.push(f.clone());
        } else if n.is_none() {
            c.deleted.push(f.clone());
        } else {
            c.changed.push(f.clone());
        }
    }
    c
}

/// Drop repos inside other repos (submodules, vendored checkouts): the outer worktree carries them.
fn outermost(mut found: Vec<String>) -> Vec<String> {
    found.sort();
    let mut out: Vec<String> = Vec::new();
    for r in found {
        if !r.is_empty() && !out.iter().any(|o| r.starts_with(&format!("{o}/"))) {
            out.push(r);
        }
    }
    out
}

fn sidecar(dest: &str) -> String {
    let dest = dest.trim_end_matches(['/', '\\']);
    let cut = dest.rfind(['/', '\\']).map(|i| i + 1).unwrap_or(0);
    format!("{}.{}.copy.json", &dest[..cut], &dest[cut..])
}

fn skipped(rel: &str, name: &str, skip: &[String]) -> bool {
    HEAVY.contains(&name) || skip.iter().any(|s| s == rel)
}

// ── local ───────────────────────────────────────────────────────────

fn rel_join(rel: &Path, name: &str) -> String {
    rel.join(name).to_string_lossy().replace('\\', "/")
}

fn repos_local(root: &Path) -> Vec<String> {
    fn walk(root: &Path, rel: &Path, depth: usize, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(root.join(rel)) else { return };
        for e in rd.filter_map(Result::ok) {
            let Ok(name) = e.file_name().into_string() else { continue };
            if HEAVY.contains(&name.as_str()) || !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let sub = rel.join(&name);
            if root.join(&sub).join(".git").exists() {
                out.push(sub.to_string_lossy().replace('\\', "/"));
            } else if depth > 1 {
                walk(root, &sub, depth - 1, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, Path::new(""), REPO_DEPTH, &mut out);
    out
}

fn copy_local(src: &Path, dest: &Path, rel: &Path, skip: &[String]) -> Result<(), String> {
    let to = dest.join(rel);
    std::fs::create_dir_all(&to).map_err(|e| format!("{}: {e}", to.display()))?;
    for e in std::fs::read_dir(src.join(rel)).map_err(|e| format!("{}: {e}", src.join(rel).display()))?.filter_map(Result::ok) {
        let Ok(name) = e.file_name().into_string() else { continue };
        let r = rel_join(rel, &name);
        if skipped(&r, &name, skip) {
            continue;
        }
        let ty = e.file_type().map_err(|e| e.to_string())?;
        if ty.is_symlink() {
            #[cfg(unix)]
            {
                let target = std::fs::read_link(e.path()).map_err(|e| format!("{r}: {e}"))?;
                std::os::unix::fs::symlink(target, to.join(&name)).map_err(|e| format!("{r}: {e}"))?;
            }
            #[cfg(not(unix))]
            if e.path().is_file() {
                std::fs::copy(e.path(), to.join(&name)).map_err(|e| format!("{r}: {e}"))?;
            }
        } else if ty.is_dir() {
            copy_local(src, dest, &rel.join(&name), skip)?;
        } else {
            std::fs::copy(e.path(), to.join(&name)).map_err(|e| format!("{r}: {e}"))?;
        }
    }
    Ok(())
}

fn manifest_local(root: &Path, rel: &Path, skip: &[String], out: &mut Manifest) -> Result<(), String> {
    let Ok(rd) = std::fs::read_dir(root.join(rel)) else { return Ok(()) };
    for e in rd.filter_map(Result::ok) {
        let Ok(name) = e.file_name().into_string() else { continue };
        let r = rel_join(rel, &name);
        if skipped(&r, &name, skip) {
            continue;
        }
        let ty = e.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            manifest_local(root, &rel.join(&name), skip, out)?;
        } else if ty.is_file() {
            let bytes = std::fs::read(e.path()).map_err(|e| format!("{r}: {e}"))?;
            out.insert(r, format!("{:x}", Sha256::digest(&bytes)));
        }
    }
    Ok(())
}

// ── remote ──────────────────────────────────────────────────────────

/// `find` arguments that prune the HEAVY folders and the `skip` paths under `.`.
fn prune(skip: &[String]) -> String {
    let mut parts: Vec<String> = HEAVY.iter().map(|h| format!("-name {}", sq(h))).collect();
    parts.extend(skip.iter().map(|s| format!("-path {}", sq(&format!("./{s}")))));
    format!("\\( {} \\) -prune", parts.join(" -o "))
}

fn repos_remote(host: &str, path: &str) -> Result<Vec<String>, String> {
    let heavy: Vec<String> = HEAVY.iter().filter(|h| **h != ".git").map(|h| format!("-name {}", sq(h))).collect();
    let inner = format!(
        "cd {} || exit 1; find . -mindepth 2 -maxdepth {} \\( {} \\) -prune -o -name .git -print",
        remote_path(path),
        REPO_DEPTH + 1,
        heavy.join(" -o ")
    );
    let out = remote::run(host, &format!("sh -c {}", sq(&inner)))?;
    Ok(out.lines().filter_map(|l| l.strip_prefix("./")?.strip_suffix("/.git")).map(String::from).collect())
}

fn copy_script(src: &str, dest: &str, skip: &[String]) -> String {
    let mut excludes: Vec<String> = HEAVY.iter().map(|h| format!("--exclude={}", sq(h))).collect();
    excludes.extend(skip.iter().map(|s| format!("--exclude={}", sq(&format!("./{s}")))));
    let inner = format!(
        "[ -e {d} ] && {{ echo \"$0 already exists\" >&2; exit 1; }}; mkdir -p {d} && cd {s} && tar cf - {x} . | (cd {d} && tar xf -)",
        d = remote_path(dest),
        s = remote_path(src),
        x = excludes.join(" ")
    );
    format!("sh -c {} {}", sq(&inner), sq(dest))
}

/// `cksum` is in every POSIX shell's toolbox; its CRC and size are enough to tell edits apart.
fn manifest_script(path: &str, skip: &[String]) -> String {
    let inner = format!("cd {} || exit 1; find . {} -o -type f -exec cksum {{}} +", remote_path(path), prune(skip));
    format!("sh -c {}", sq(&inner))
}

fn parse_cksum(out: &str) -> Manifest {
    out.lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, ' ');
            let (crc, size, name) = (it.next()?, it.next()?, it.next()?);
            Some((name.strip_prefix("./").unwrap_or(name).to_string(), format!("{crc} {size}")))
        })
        .collect()
}

fn finish_script(src: &str, dest: &str, files: &[String], delete: &[String]) -> String {
    let (s, d) = (remote_path(src), remote_path(dest));
    let mut lines = vec!["set -e".to_string()];
    for f in files {
        let q = sq(f);
        lines.push(format!("if [ -e {d}/{q} ]; then mkdir -p \"$(dirname {s}/{q})\" && cp -p {d}/{q} {s}/{q}; else rm -f {s}/{q}; fi"));
    }
    for f in delete {
        lines.push(format!("rm -f {s}/{}", sq(f)));
    }
    lines.push(format!("rm -rf {d} {}", remote_path(&sidecar(dest))));
    format!("sh -c {}", sq(&lines.join("\n")))
}

// ── both ────────────────────────────────────────────────────────────

fn manifest(host: &str, path: impl AsRef<Path>, skip: &[String]) -> Result<Manifest, String> {
    let path = path.as_ref();
    if is_local(host) {
        let root = PathBuf::from(expand_home(&path.to_string_lossy()));
        if !root.is_dir() {
            return Err(format!("{} is gone", root.display()));
        }
        let mut m = Manifest::new();
        manifest_local(&root, Path::new(""), skip, &mut m)?;
        Ok(m)
    } else {
        Ok(parse_cksum(&remote::run(host, &manifest_script(&path.to_string_lossy(), skip))?))
    }
}

fn write_sidecar(host: &str, dest: impl AsRef<Path>, json: &str) -> Result<(), String> {
    let file = sidecar(&dest.as_ref().to_string_lossy());
    if is_local(host) {
        std::fs::write(expand_home(&file), json).map_err(|e| format!("{file}: {e}"))
    } else {
        let script = format!("sh -c {}", sq(&format!("cat > {}", remote_path(&file))));
        remote::run_stdin(host, &script, json.as_bytes()).map(|_| ())
    }
}

fn read_sidecar(host: &str, dest: &str) -> Result<String, String> {
    let file = sidecar(dest);
    if is_local(host) {
        std::fs::read_to_string(expand_home(&file)).map_err(|e| format!("{file}: {e}"))
    } else {
        remote::run(host, &format!("cat {}", remote_path(&file)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pairs: &[(&str, &str)]) -> Manifest {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn compare_sorts_changes_into_back_deleted_and_conflicts() {
        let then = m(&[("a", "1"), ("b", "1"), ("c", "1"), ("d", "1"), ("e", "1")]);
        let copy = m(&[("a", "1"), ("b", "2"), ("c", "2"), ("e", "2"), ("new", "1")]);
        let base = m(&[("a", "9"), ("b", "1"), ("c", "3"), ("d", "1"), ("e", "2")]);
        assert_eq!(compare(&then, &copy, &base), Changes {
            changed: vec!["b".into(), "new".into()],
            deleted: vec!["d".into()],
            conflicts: vec!["c".into()],
        });
    }

    #[test]
    fn sidecar_sits_next_to_the_copy() {
        assert_eq!(sidecar("~/src/shop.worktrees/feat-x"), "~/src/shop.worktrees/.feat-x.copy.json");
        assert_eq!(sidecar("C:\\w\\shop.worktrees\\feat\\"), "C:\\w\\shop.worktrees\\.feat.copy.json");
    }

    #[test]
    fn outermost_drops_nested_repos() {
        assert_eq!(outermost(vec!["web/vendor/x".into(), "api".into(), "web".into()]), ["api", "web"]);
    }

    #[cfg(unix)]
    #[test]
    fn local_copy_skips_repos_and_heavy_folders_then_finds_changes() {
        let root = std::env::temp_dir().join(format!("tri-folders-{}", std::process::id()));
        let src = root.join("shop");
        for d in ["web/.git", "web/node_modules", "infra", "node_modules/x"] {
            std::fs::create_dir_all(src.join(d)).unwrap();
        }
        std::fs::write(src.join("README.md"), "a").unwrap();
        std::fs::write(src.join("infra/main.tf"), "a").unwrap();
        std::fs::write(src.join("node_modules/x/i.js"), "a").unwrap();
        assert_eq!(repos_local(&src), ["web"]);
        let dest = root.join("shop.worktrees/feat");
        let (s, d) = (src.to_string_lossy().to_string(), dest.to_string_lossy().to_string());
        tauri::async_runtime::block_on(folder_copy("local".into(), s.clone(), d.clone(), vec!["web".into()])).unwrap();
        assert!(dest.join("infra/main.tf").exists() && !dest.join("web").exists() && !dest.join("node_modules").exists());
        std::fs::write(dest.join("infra/main.tf"), "b").unwrap();
        std::fs::write(dest.join("README.md"), "b").unwrap();
        std::fs::write(src.join("README.md"), "c").unwrap();
        let ch = tauri::async_runtime::block_on(folder_changes("local".into(), s.clone(), d.clone(), vec!["web".into()])).unwrap();
        assert_eq!(ch, Changes { changed: vec!["infra/main.tf".into()], deleted: vec![], conflicts: vec!["README.md".into()] });
        tauri::async_runtime::block_on(folder_finish("local".into(), s, d, ch.changed, vec![])).unwrap();
        assert_eq!(std::fs::read_to_string(src.join("infra/main.tf")).unwrap(), "b");
        assert!(!dest.exists() && !root.join("shop.worktrees/.feat.copy.json").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remote_scripts_run_in_a_real_shell() {
        let root = std::env::temp_dir().join(format!("tri-rfolders-{}", std::process::id()));
        let src = root.join("my shop");
        for d in ["web/.git", "it's/node_modules", "infra"] {
            std::fs::create_dir_all(src.join(d)).unwrap();
        }
        std::fs::write(src.join("infra/main.tf"), "a").unwrap();
        std::fs::write(src.join("web/app.ts"), "a").unwrap();
        let sh = |script: String| {
            let out = std::process::Command::new("/bin/sh").arg("-c").arg(script).output().unwrap();
            assert!(out.status.success(), "{out:?}");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let (s, d) = (src.to_string_lossy().to_string(), root.join("my shop.worktrees/f").to_string_lossy().to_string());
        sh(copy_script(&s, &d, &["web".into()]));
        let man = parse_cksum(&sh(manifest_script(&d, &["web".into()])));
        assert_eq!(man.keys().collect::<Vec<_>>(), ["infra/main.tf"]);
        std::fs::write(sidecar(&d), "{}").unwrap();
        sh(finish_script(&s, &d, &["infra/main.tf".into()], &[]));
        assert!(!Path::new(&d).exists() && !Path::new(&sidecar(&d)).exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
