// Worktrees: more checkouts of a project's repo, each on its own branch in a sibling folder
// (`<repo>.worktrees/<branch>`), so several agents can work on different branches at once.
// A Worktree is a Project with a `parent`: its own windows, workspaces and signals, listed
// under the repo's row in the sidebar. The backend is git_worktree_* in src-tauri/src/git.rs.

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { type Agent, type Project, addWorktree, app, projectById, repoOf, setApp, worktreesOf } from "./state";
import { launchAgent } from "./agents";
import { dropProject } from "./Sidebar";
import { gitOf } from "./git";
import { flash } from "./ui";

/** One entry of `git worktree list`. */
export type GitWorktree = { path: string; branch: string | null; main: boolean };

/** What git last said about each repo project's checkouts, by its id. Runtime only. */
export const [listed, setListed] = createStore<Record<string, GitWorktree[]>>({});

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
/** git prints absolute paths; a project's path may start with `~`, so compare what follows it. */
const samePath = (gitPath: string, path: string) =>
  path.startsWith("~") ? norm(gitPath).endsWith(norm(path.slice(1))) : norm(gitPath) === norm(path);

export async function loadWorktrees(repo: Project): Promise<void> {
  try {
    setListed(repo.id, await invoke<GitWorktree[]>("git_worktrees", { host: repo.host, path: repo.path }));
  } catch {
    // not a repo, or the host is unreachable: the stored branch names stay
  }
}

/** The branch a checkout is on, as git last said, else the one it was made for. */
export function branchOf(p: Project): string {
  const hit = listed[repoOf(p).id]?.find((w) => samePath(w.path, p.path));
  if (hit) return hit.branch ?? "detached";
  return p.branch ?? gitOf(p.id).status?.branch ?? "main";
}

/** The short label of a Worktree's tile: its issue's number, else the start of its branch. */
export function tileLabel(p: Project): string {
  const n = p.issue?.match(/-(\d+)$/)?.[1];
  if (n) return n.length > 3 ? n.slice(-3) : n;
  return (p.branch ?? "").split("/").pop()!.slice(0, 2) || "?";
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

export function openNewWorktree(p: Project) {
  const repo = repoOf(p);
  void loadWorktrees(repo);
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
  await invoke("git_worktree_add", { host: repo.host, path: repo.path, dir, branch, base: opts.base });
  const id = addWorktree(repo.id, { path: dir, branch, issue: opts.issue });
  const p = projectById(id);
  if (p && opts.agent) launchAgent(p, opts.agent);
  flash(`worktree ${branch} · ${dir}`);
  void loadWorktrees(repo);
}

/** Close a Worktree's windows, delete its folder and, if it is merged or you agree, its branch. */
export async function removeWorktree(p: Project): Promise<void> {
  const repo = projectById(p.parent ?? "");
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
  if (!confirm(`Remove worktree ${branch}? This will ${what}.`)) return;

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
      if (merged || confirm(`Branch ${branch} has commits that are not merged. Delete the branch too?`)) {
        await invoke("git_branch_delete", { host: repo.host, path: repo.path, branch, force: true }).catch((e) => flash(`git branch -D: ${e}`));
      }
    }
  }
  void loadWorktrees(repo);
  flash(`removed worktree ${branch}`);
}
