// Worktrees: more checkouts of a project's repo, each on its own branch in a sibling folder
// (`<repo>.worktrees/<branch>`), so several agents can work on different branches at once.
// A Worktree is a Project with a `parent`: its own windows, workspaces and signals, listed
// under the repo's row in the sidebar. The backend is git_worktree_* in src-tauri/src/git.rs.
//
// A folder that is not a repo (several repos side by side, or no git at all) gets the same
// thing by copying: the folder goes to the same `<folder>.worktrees/<branch>`, each repo nested
// in it is added back as a git worktree on the branch, and finishing copies what changed outside
// git back. The copying is folder_* in src-tauri/src/folders.rs. Chosen from
// design/folder-worktrees.html; see ADR 0003.

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { type Agent, type Project, addWorktree, app, projectById, repoOf, setApp, worktreesOf } from "./state";
import { launchAgent } from "./agents";
import { dropProject } from "./Sidebar";
import { folderStatus, gitOf, peekStatus } from "./git";
import { ask, flash } from "./ui";

/** One entry of `git worktree list`. */
export type GitWorktree = { path: string; branch: string | null; main: boolean };

/** What git last said about each repo project's checkouts, by its id. Runtime only. */
export const [listed, setListed] = createStore<Record<string, GitWorktree[]>>({});

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
/** git prints absolute paths; a project's path may start with `~`, so compare what follows it. */
const samePath = (gitPath: string, path: string) =>
  path.startsWith("~") ? norm(gitPath).endsWith(norm(path.slice(1))) : norm(gitPath) === norm(path);

/** What a project's folder is, for New worktree: a repo, or a folder to copy with the repos nested in it. Runtime only. */
export type FolderKind = { git: true } | { git: false; repos: string[] };
export const [kinds, setKinds] = createStore<Record<string, FolderKind>>({});

/** Ask the project's host whether its folder is a repo and, if not, which repos are inside it. */
export async function scanFolder(repo: Project): Promise<FolderKind> {
  try {
    setListed(repo.id, await invoke<GitWorktree[]>("git_worktrees", { host: repo.host, path: repo.path }));
    setKinds(repo.id, { git: true });
  } catch {
    const repos = await invoke<string[]>("folder_repos", { host: repo.host, path: repo.path });
    setKinds(repo.id, { git: false, repos });
  }
  return kinds[repo.id];
}

/** A Worktree of a folder that isn't a repo: a copy. */
export const isCopy = (p: Project) => !!p.copy;

const join = (dir: string, rel: string) => `${dir.replace(/[\\/]+$/, "")}/${rel}`;

export async function loadWorktrees(repo: Project): Promise<void> {
  try {
    setListed(repo.id, await invoke<GitWorktree[]>("git_worktrees", { host: repo.host, path: repo.path }));
  } catch {
    // not a repo, or the host is unreachable: the stored branch names stay
  }
}

/** Add the checkouts already in `<repo>.worktrees/` that the sidebar doesn't list (made with git
 *  by hand, or before the project was added), so they can be opened and removed like the rest.
 *  Only folders New worktree would have made count: `worktreeDir(repo, <name>)`. A copy is found
 *  by its nested repos' worktrees, so a copy of a folder with no repos in it isn't. */
export async function adoptWorktrees(repo: Project): Promise<void> {
  const kind = await scanFolder(repo);
  /** The `<name>` of the folder in `<repo>.worktrees/` that git's `gitPath` (of nested repo `rel`) is in, if it is. */
  const nameOf = (gitPath: string, rel: string) => {
    const parts = gitPath.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
    const name = parts[parts.length - (rel ? rel.split("/").length : 0) - 1];
    return name && samePath(gitPath, rel ? join(worktreeDir(repo, name), rel) : worktreeDir(repo, name)) ? name : null;
  };
  const found = new Map<string, { gitPath: string; branch: string; repos: string[] }>();
  if (kind.git) {
    for (const w of listed[repo.id] ?? []) {
      const name = !w.main && nameOf(w.path, "");
      if (name) found.set(name, { gitPath: w.path, branch: w.branch ?? name, repos: [] });
    }
  } else {
    for (const r of kind.repos) {
      const ws = await invoke<GitWorktree[]>("git_worktrees", { host: repo.host, path: join(repo.path, r) }).catch((): GitWorktree[] => []);
      for (const w of ws) {
        const name = !w.main && nameOf(w.path, r);
        if (!name) continue;
        const f = found.get(name) ?? { gitPath: w.path.slice(0, -r.length - 1), branch: w.branch ?? name, repos: [] };
        f.repos.push(r);
        found.set(name, f);
      }
    }
  }
  for (const [name, f] of found) {
    const path = worktreeDir(repo, name);
    if (app.projects.some((p) => p.host === repo.host && (norm(p.path) === norm(path) || samePath(f.gitPath, p.path)))) continue;
    addWorktree(repo.id, { path, branch: f.branch, ...(kind.git ? {} : { copy: { repos: f.repos } }) }, false);
  }
}

/** The branch a checkout is on, as git last said, else the one it was made for. */
export function branchOf(p: Project): string {
  // A folder that isn't a repo has no branch; its copies do.
  if (!p.parent && (kinds[p.id]?.git === false || worktreesOf(p.id).some(isCopy))) return "base";
  const hit = listed[repoOf(p).id]?.find((w) => samePath(w.path, p.path));
  if (hit) return hit.branch ?? "detached";
  return p.branch ?? gitOf(p.id).status?.branch ?? "main";
}

/** A copy's nested repos and the branch each one is on, as folderStatus last read them. */
export function nestedBranches(p: Project): { repo: string; branch: string }[] {
  return (folderStatus[p.id] ?? []).map((r) => ({ repo: r.repo, branch: r.status?.branch ?? "detached" }));
}

/** What the sidebar row, its tooltip, the rail tile and Finish call a Worktree. `mark` is `pin` for a
 *  name the user chose and `split` when a copy's repos are on different branches. */
export type Label = { text: string; mark?: "pin" | "split"; tip: string[] };

/** The label rule (CONTEXT.md, Worktree): the title if one is set; a copy's repos' branch (the most
 *  of them, a tie going to a branch that isn't the copy's first); a plain worktree's branch; a copy
 *  with no repos in it, its folder. `branchOf` stays the git truth it is built on. */
export function labelOf(p: Project): Label {
  const folder = p.path.split(/[\\/]/).pop() || p.path;
  if (!p.parent) return { text: branchOf(p), tip: [branchOf(p)] };
  if (p.title) return { text: p.title, mark: "pin", tip: [`${p.title}  (pinned name)`, `folder: ${folder}`, `branch: ${branchOf(p)}`] };
  if (!p.copy) return { text: branchOf(p), tip: [branchOf(p), `folder: ${folder}`] };
  const repos = nestedBranches(p);
  if (!repos.length) return { text: folder, tip: [folder, `folder: ${folder}`, "  no nested repos: nothing to follow"] };
  const n = new Map<string, number>();
  for (const r of repos) n.set(r.branch, (n.get(r.branch) ?? 0) + 1);
  const text = [...n].sort(([a, x], [b, y]) => y - x || Number(a === p.branch) - Number(b === p.branch))[0][0];
  const split = n.size > 1;
  return {
    text,
    mark: split ? "split" : undefined,
    tip: [text, `folder: ${folder}`, ...repos.map((r) => `  ${r.repo}: ${r.branch}`)],
  };
}

/** The short label of a Worktree's tile: its issue's number while the label still carries it, else the
 *  start of the label. A pinned name is never the issue's, so it gets its letters. */
export function tileLabel(p: Project): string {
  const text = labelOf(p).text;
  const n = p.issue?.match(/-(\d+)$/)?.[1];
  if (n && !p.title && text.includes(n)) return n.length > 3 ? n.slice(-3) : n;
  return text.split("/").pop()!.slice(0, 2) || "?";
}

/** Set a Worktree's name; empty goes back to following the branch. */
export function renameWorktree(p: Project, title: string): void {
  setApp("projects", (q) => q.id === p.id, "title", title.trim() || undefined);
}

/** Start next feature: create `branch` from each nested repo's default branch on origin, in every
 *  repo that is clean. A repo with uncommitted changes is skipped and named, never stashed. The
 *  pinned name is cleared, since the work it named is over. */
export async function startNextFeature(p: Project, branch: string): Promise<void> {
  const status = folderStatus[p.id] ?? [];
  if (!status.length) return flash("no nested repos to switch");
  const dirty = status.filter((r) => (r.status?.files.length ?? 0) > 0).map((r) => r.repo);
  const made: string[] = [];
  for (const r of status.filter((r) => !dirty.includes(r.repo))) {
    try {
      await invoke("git_switch_create", { host: p.host, path: join(p.path, r.repo), branch, base: r.status?.base || "main" });
      made.push(r.repo);
    } catch (e) {
      flash(`${r.repo}: git switch -c ${branch}: ${e}`);
    }
  }
  renameWorktree(p, "");
  await peekStatus(p, true);
  flash([`${branch} in ${made.join(", ") || "no repo"}`, dirty.length ? `${dirty.join(", ")} has uncommitted changes, so it stayed` : ""].filter(Boolean).join(" · "));
}

/** A branch name from free text: lowercase, words joined by `-`, `/` kept for prefixes. */
export const toBranch = (text: string) =>
  text.trim().toLowerCase().replace(/[^a-z0-9/._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-/.]+|[-/.]+$/g, "").slice(0, 60);

/** The branch for an issue, with its Slug-ID first so the git window links the two. */
export function issueBranch(slug: string, title: string): string {
  const b = toBranch(`${slug}-${title}`);
  return b.length <= 40 ? b : b.slice(0, 41).replace(/-[^-]*$/, "");
}

/** Where a new Worktree's folder goes: next to the repo, in `<repo>.worktrees/`. */
export function worktreeDir(repo: Project, branch: string): string {
  const path = repo.path.replace(/[\\/]+$/, "");
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  return `${path}.worktrees${sep}${branch.replace(/[\\/]/g, "-")}`;
}

// ── the New Worktree dialog's state ─────────────────────────────────

/** The repo project the dialog adds to, or null when it is closed. */
export const [newWorktreeFor, setNewWorktreeFor] = createSignal<string | null>(null);
export const newWorktreeOpen = () => newWorktreeFor() !== null;

/** A branch New worktree can check out (git.rs `Branch`): `remote` when only a remote has it. */
export type Branch = { name: string; remote: string | null };
/** Each repo project's branches, by its id, as of the last New worktree. Runtime only. */
export const [branches, setBranches] = createStore<Record<string, Branch[]>>({});

/** The repo project whose remotes New worktree is fetching, if any. Runtime only. */
export const [fetching, setFetching] = createSignal<string | null>(null);

const loadBranches = (repo: Project) =>
  invoke<Branch[]>("git_branches", { host: repo.host, path: repo.path }).then((b) => setBranches(repo.id, b), () => {});

/** List the branches git already knows, then fetch and list them again with what was pushed since. */
async function fetchBranches(repo: Project): Promise<void> {
  await loadBranches(repo);
  if (kinds[repo.id]?.git === false) return;
  setFetching(repo.id);
  try {
    await invoke("git_fetch", { host: repo.host, path: repo.path });
    await loadBranches(repo);
  } catch (e) {
    if (kinds[repo.id]?.git) flash(`git fetch: ${e}`);
  } finally {
    if (fetching() === repo.id) setFetching(null);
  }
}

export function openNewWorktree(p: Project) {
  const repo = repoOf(p);
  void adoptWorktrees(repo).catch(() => {});
  void fetchBranches(repo);
  setNewWorktreeFor(repo.id);
}
export const closeNewWorktree = () => setNewWorktreeFor(null);

// ── create and remove ───────────────────────────────────────────────

/** Add a Worktree on `branch` (made from `base` if new), switch to it and open `agent` in it. */
export async function createWorktree(repo: Project, branch: string, opts: { base: string; issue?: string; agent?: Agent }): Promise<void> {
  const taken = worktreesOf(repo.id).find((w) => w.branch === branch);
  if (taken) {
    setApp("activeProject", taken.id);
    flash(`${branch} already has a worktree`);
    return;
  }
  const dir = worktreeDir(repo, branch);
  const kind = kinds[repo.id] ?? (await scanFolder(repo));
  let copy: { repos: string[] } | undefined;
  if (kind.git) {
    await invoke("git_worktree_add", { host: repo.host, path: repo.path, dir, branch, base: opts.base });
  } else {
    copy = { repos: await copyFolder(repo, dir, branch, kind.repos) };
  }
  const id = addWorktree(repo.id, { path: dir, branch, issue: opts.issue, ...(copy ? { copy } : {}) });
  const p = projectById(id);
  if (p && opts.agent) launchAgent(p, opts.agent);
  flash(`${copy ? "copy" : "worktree"} ${branch} · ${dir}`);
  void loadWorktrees(repo);
}

/** Copy `repo`'s folder to `dir` without its nested repos, then add each back as a git worktree on
 *  `branch` (from what that repo has checked out). Returns the repos that made it. */
async function copyFolder(repo: Project, dir: string, branch: string, repos: string[]): Promise<string[]> {
  await invoke("folder_copy", { host: repo.host, src: repo.path, dest: dir, skip: repos });
  const made: string[] = [];
  for (const r of repos) {
    try {
      await invoke("git_worktree_add", { host: repo.host, path: join(repo.path, r), dir: join(dir, r), branch, base: "HEAD" });
      made.push(r);
    } catch (e) {
      flash(`${r}: git worktree add: ${e}`);
    }
  }
  return made;
}

/** What finishing a copy would carry back to its folder (folders.rs `Changes`). */
type Changes = { changed: string[]; deleted: string[]; conflicts: string[] };

const listed8 = (files: string[]) => files.slice(0, 8).map((f) => `\n  ${f}`).join("") + (files.length > 8 ? `\n  …and ${files.length - 8} more` : "");

/** Finish a copy: copy what changed outside git back to the folder (asking about files changed on
 *  both sides), remove the nested repos' worktrees, delete the copy. */
async function finishCopy(p: Project, repo: Project): Promise<void> {
  const repos = p.copy?.repos ?? [];
  const title = labelOf(p).text;
  // Each nested repo's current branch and the copy's first one: both go, where merged.
  const now = nestedBranches(p);
  const branches = [...new Set([...now.map((r) => r.branch), p.branch ?? ""])].filter((b) => b && b !== "detached");
  const dirty: string[] = [];
  for (const r of repos) {
    const n = await invoke<{ files: unknown[] }>("git_status", { host: p.host, path: join(p.path, r) }).then((s) => s.files.length, () => 0);
    if (n) dirty.push(`${r} (${n})`);
  }
  let ch: Changes;
  try {
    ch = await invoke<Changes>("folder_changes", { host: p.host, src: repo.path, dest: p.path, skip: repos });
  } catch (e) {
    if (!await ask(`Can't tell what changed in ${p.path} (${e}). Delete the copy anyway, copying nothing back?`)) return;
    ch = { changed: [], deleted: [], conflicts: [] };
  }
  const what = [
    p.tabs.length ? `close its ${p.tabs.length} window${p.tabs.length > 1 ? "s" : ""}` : "",
    ch.changed.length ? `copy ${ch.changed.length} file${ch.changed.length > 1 ? "s" : ""} back to ${repo.name}:${listed8(ch.changed)}\n` : "",
    ch.deleted.length ? `delete ${ch.deleted.length} file${ch.deleted.length > 1 ? "s" : ""} the copy deleted:${listed8(ch.deleted)}\n` : "",
    repos.length ? `remove the worktrees of ${repos.join(", ")} and delete branches ${branches.join(", ")} where merged` : "",
    dirty.length ? `throw away uncommitted changes in ${dirty.join(", ")}` : "",
    `delete ${p.path}`,
  ].filter(Boolean).join("; ");
  if (!await ask(`Finish ${title}? This will ${what}.`)) return;
  // Changed on both sides: no git to merge them, so one side wins.
  const theirs = ch.conflicts.length && await ask(
    `${ch.conflicts.length} file${ch.conflicts.length > 1 ? "s" : ""} changed in ${repo.name} too since the copy was made:${listed8(ch.conflicts)}\n\nOK keeps the copy's version. Cancel keeps ${repo.name}'s.`,
  ) ? ch.conflicts : [];

  if (app.activeProject === p.id) setApp("activeProject", repo.id);
  dropProject(p);
  await new Promise((r) => setTimeout(r, 300));
  const kept: string[] = [];
  for (const r of repos) {
    const path = join(repo.path, r);
    await invoke("git_worktree_remove", { host: repo.host, path, dir: join(p.path, r), force: true }).catch((e) => flash(`${r}: git worktree remove: ${e}`));
    // This repo's current branch and the copy's first one (once, when they are the same).
    const own = [...new Set([now.find((n) => n.repo === r)?.branch, p.branch])].filter((b): b is string => !!b && b !== "detached");
    for (const branch of own) {
      await invoke("git_branch_delete", { host: repo.host, path, branch, force: false }).catch(() => kept.push(`${branch} in ${r}`));
    }
  }
  try {
    await invoke("folder_finish", { host: repo.host, src: repo.path, dest: p.path, files: [...ch.changed, ...theirs], delete: ch.deleted });
  } catch (e) {
    return flash(`finishing ${title}: ${e}. ${p.path} is still there.`);
  }
  const back = ch.changed.length + theirs.length + ch.deleted.length;
  flash([`finished ${title}`, back ? `${back} file${back > 1 ? "s" : ""} back in ${repo.name}` : "", kept.length ? `kept ${kept.join(", ")} (not merged)` : ""].filter(Boolean).join(" · "));
}

/** Close a Worktree's windows, delete its folder and, if it is merged or you agree, its branch.
 *  A copy is finished instead (see finishCopy). */
export async function removeWorktree(p: Project): Promise<void> {
  const repo = projectById(p.parent ?? "");
  if (repo && p.copy) return finishCopy(p, repo);
  if (!repo) return;
  const branch = branchOf(p);
  let dirty = 0;
  let gone = false;
  try {
    dirty = (await invoke<{ files: unknown[] }>("git_status", { host: p.host, path: p.path })).files.length;
  } catch {
    gone = true; // the folder is already gone; git only needs to forget it
  }
  const what = [
    p.tabs.length ? `close its ${p.tabs.length} window${p.tabs.length > 1 ? "s" : ""}` : "",
    `delete ${p.path}`,
    dirty ? `throw away ${dirty} uncommitted change${dirty > 1 ? "s" : ""}` : "",
  ].filter(Boolean).join(", ");
  if (!await ask(`Remove worktree ${branch}? This will ${what}.`)) return;

  if (app.activeProject === p.id) setApp("activeProject", repo.id);
  dropProject(p);
  // Windows will not delete a folder a closing terminal still has open.
  await new Promise((r) => setTimeout(r, 300));
  try {
    await invoke("git_worktree_remove", { host: repo.host, path: repo.path, dir: p.path, force: dirty > 0 || gone });
  } catch (e) {
    if (!gone) flash(`git worktree remove: ${e}`);
  }

  if (branch !== "detached") {
    try {
      await invoke("git_branch_delete", { host: repo.host, path: repo.path, branch, force: false });
    } catch {
      // Unmerged as far as git knows; a squash-merged PR looks like that too.
      const merged = gitOf(p.id).pr?.state === "MERGED";
      if (merged || await ask(`Branch ${branch} has commits that are not merged. Delete the branch too?`)) {
        await invoke("git_branch_delete", { host: repo.host, path: repo.path, branch, force: true }).catch((e) => flash(`git branch -D: ${e}`));
      }
    }
  }
  void loadWorktrees(repo);
  flash(`removed worktree ${branch}`);
}
