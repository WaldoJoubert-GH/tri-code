// The git window's state and actions: one runtime record per project (never persisted).
// A project is one repo or, when its folder holds several, a list of repos with one active;
// Status, selection, commit message and PR are per active repo, and every action runs in it.
// The backend is src-tauri/src/git.rs; ✦ drafts run `claude -p` on the project's host with
// the context the user has switched on (the "context chips").

import { invoke } from "@tauri-apps/api/core";
import { createStore, produce } from "solid-js/store";
import { type Project, addTab, focusTab, repoOf } from "./state";
import { copyText } from "./clipboard";
import { devOf, inProgress, slugOf } from "./issues";
import { flash } from "./ui";
import { bumpRepoEpoch, invalidateRepos } from "./repos";

/** `index` / `work`: lines added and removed on each side (absent for untracked or binary);
 *  `orig`: a rename's original path. */
export type Change = { path: string; x: string; y: string; index?: [number, number]; work?: [number, number]; orig?: string };
export type Commit = { sha: string; subject: string; when: string; pushed: boolean };
export type CommitDetail = {
  sha: string; author: string; when: string; message: string; stat: string; diff: string;
};
export type GitStatus = {
  branch: string | null; upstream: string | null; ahead: number; behind: number; base: string;
  files: Change[]; commits: Commit[];
};
export type CheckState = "pending" | "pass" | "fail" | "skip";
export type Check = { name: string; state: CheckState };
export type Pr = {
  number: number; title: string; body: string; state: "OPEN" | "CLOSED" | "MERGED"; url: string;
  isDraft: boolean; baseRefName: string; mergeable: string; checks: Check[];
};
export type Finding = { sev: "fix" | "note" | "ok"; loc: string; text: string };
export type Drawer = "push" | "pr" | "merge";
export type CtxId = "diff" | "issue" | "style" | "terms";
/** One repo's status when a project is a folder of repos; `repo` is relative to the project. */
export type RepoStatus = { repo: string; status?: GitStatus; error?: string };
/** A file in one of the two lists: the same path can be in both (partly staged). */
export type Sel = { repo: string; path: string; staged: boolean };

type GitUi = {
  loading: boolean;
  error?: string;
  /** A folder of repos: one status per nested repo. One entry (repo "") for a repo project. */
  repos?: RepoStatus[];
  /** The active repo's path relative to the project ("" when the project folder is the repo). */
  repo: string;
  /** The active repo could not be read. */
  repoError?: string;
  status?: GitStatus;
  /** undefined: not looked up yet; null: the branch has no PR. */
  pr?: Pr | null;
  prError?: string;
  sel?: Sel;
  diff?: { key: string; text?: string; error?: string };
  /** A commit opened from the Commits list; while set, its detail replaces the file diff. */
  commit?: { key: string; detail?: CommitDetail; error?: string };
  msg: string;
  /** The text in the box is a ✦ draft the user has not edited yet. */
  msgAi: boolean;
  prTitle: string;
  prBody: string;
  prAi: boolean;
  prDraft: boolean;
  review?: Finding[];
  drawer: Drawer | null;
  strategy: "squash" | "merge" | "rebase";
  delBranch: boolean;
  /** The ✦ draft in progress. */
  busy: "commit" | "pr" | "review" | null;
  /** The git/gh action in progress. */
  working: "commit" | "push" | "pr" | "merge" | "stage" | null;
  ctx: Record<CtxId, boolean>;
  /** CONTEXT.md from the project root; null when there is none. */
  terms?: string | null;
  /** A draft commit message per repo (one git window, a folder of repos). */
  msgs: Record<string, string>;
};

export const [git, setGit] = createStore<Record<string, GitUi>>({});

const fresh = (): GitUi => ({
  loading: false, repo: "", msgs: {}, msg: "", msgAi: false, prTitle: "", prBody: "", prAi: false, prDraft: false,
  drawer: null, strategy: "squash", delBranch: true, busy: null, working: null,
  ctx: { diff: true, issue: true, style: true, terms: true },
});

const DEFAULTS = fresh();
/** The project's record; defaults until the first write creates it. */
export const gitOf = (projectId: string): GitUi => git[projectId] ?? DEFAULTS;

const args = (p: Project) => ({ host: p.host, path: p.path });
/** Strip trailing path separators (both kinds) without depending on a regex escape. */
const trimSep = (p: string) => {
  let end = p.length;
  while (end > 1) {
    const c = p.charCodeAt(end - 1);
    if (c === 47 || c === 92) end--;
    else break;
  }
  // Keep a Windows drive root's slash: C:\ is a directory, C: is "the current directory on C:".
  if (end === 2 && p.charCodeAt(1) === 58) return p.slice(0, 3);
  return p.slice(0, end);
};
/** Where the active repo's git commands run. */
export const repoRoot = (p: Project, repo: string) => (repo ? `${trimSep(p.path)}/${repo}` : trimSep(p.path));
const argsAt = (p: Project, repo: string) => ({ host: p.host, path: repoRoot(p, repo) });
const set = (p: Project, fn: (g: GitUi) => void) => setGit(produce((s) => { s[p.id] ??= fresh(); fn(s[p.id]); }));

/** The first changed file of a repo (staged first), for switching repos. */
const firstChangeOf = (s?: GitStatus): Change | undefined =>
  s ? (s.files.find(isStaged) ?? s.files.find(isUnstaged)) : undefined;

export const isStaged = (c: Change) => c.x !== "." && c.x !== "?";
export const isUnstaged = (c: Change) => c.y !== "." || c.x === "?";
export const staged = (s?: GitStatus) => (s?.files ?? []).filter(isStaged);
export const unstaged = (s?: GitStatus) => (s?.files ?? []).filter(isUnstaged);
export const unpushed = (s?: GitStatus) =>
  !s ? 0 : s.upstream ? s.ahead : s.commits.filter((c) => !c.pushed).length;

/** Where the branch is: what the next step in the header is. */
export function stepOf(g: GitUi): "commit" | "push" | "pr" | "merge" | "done" {
  const s = g.status;
  if (g.pr?.state === "MERGED") return "done";
  if (s && staged(s).length + unstaged(s).length > 0) return "commit";
  if (unpushed(s) > 0 || (s && !s.upstream && s.branch && s.branch !== s.base)) return "push";
  if (g.pr?.state === "OPEN") return "merge";
  return "pr";
}

// ── status line ─────────────────────────────────────────────────────

/** The status line's view of each project: null when it is not a repo (or can't be reached). */
export const [branchStatus, setBranchStatus] = createStore<Record<string, GitStatus | null>>({});
/** A folder of repos' status line view; null when the project is one repo (or not a repo). */
export const [folderStatus, setFolderStatus] = createStore<Record<string, RepoStatus[] | null>>({});
const peeking = new Set<string>();
/** A folder costs one git batch per repo; poll it every 30s, not every 10s like one repo. */
const lastFolderPeek = new Map<string, number>();

/** git_status alone, without the git window's diff and PR lookups. `now` skips a folder's 30s wait
 *  (the editor saved a file). */
export async function peekStatus(p: Project, now = false): Promise<void> {
  if (peeking.has(p.id)) return;
  const folderAt = lastFolderPeek.get(p.id);
  if (!now && folderAt && Date.now() - folderAt < 30_000) return;
  peeking.add(p.id);
  try {
    setBranchStatus(p.id, await invoke<GitStatus>("git_status", args(p)));
    setFolderStatus(p.id, null);
    lastFolderPeek.delete(p.id);
  } catch {
    setBranchStatus(p.id, null);
    try {
      const repos = await invoke<RepoStatus[]>("folder_status", args(p));
      setFolderStatus(p.id, repos.length ? repos : null);
      lastFolderPeek.set(p.id, Date.now());
    } catch {
      setFolderStatus(p.id, null);
    }
  } finally {
    peeking.delete(p.id);
  }
}

// ── file marks (the editor's tree and tabs) ─────────────────────────

/** A file's change as the editor marks it: Modified, Added, Untracked, Deleted, Renamed, Conflict. */
export type FileMark = "M" | "A" | "U" | "D" | "R" | "C";
export type FileMarks = {
  /** By absolute path (forward slashes). An untracked folder is listed as itself. */
  files: Map<string, FileMark>;
  /** Folders holding a change, with the most pressing one inside. */
  dirs: Map<string, FileMark>;
  /** Untracked folders: everything under them is untracked. */
  untracked: string[];
};

const RANK: Record<FileMark, number> = { U: 0, A: 1, R: 2, D: 3, M: 4, C: 5 };
const slashes = (p: string) => trimSep(p).replace(/\\/g, "/");

export function markOf(c: Change): FileMark {
  if (c.x === "?") return "U";
  if (c.x === "U" || c.y === "U" || (c.x === "A" && c.y === "A") || (c.x === "D" && c.y === "D")) return "C";
  if (c.x === "D" || c.y === "D") return "D";
  if (c.x === "A") return "A";
  if (c.x === "R" || c.x === "C") return "R";
  return "M";
}

/** Every changed file in the project, from the status the status line polls (or the git window's
 *  refresh), so the tree costs no git calls of its own. */
export function fileMarks(p: Project): FileMarks {
  const repos: RepoStatus[] = folderStatus[p.id] ?? (branchStatus[p.id] ? [{ repo: "", status: branchStatus[p.id]! }] : []);
  const files = new Map<string, FileMark>();
  const dirs = new Map<string, FileMark>();
  const untracked: string[] = [];
  const top = slashes(p.path);
  for (const r of repos) {
    const root = slashes(repoRoot(p, r.repo));
    for (const c of r.status?.files ?? []) {
      const mark = markOf(c);
      const path = `${root}/${c.path.replace(/\/$/, "")}`;
      if (c.path.endsWith("/")) untracked.push(path);
      files.set(path, mark);
      for (let d = path.slice(0, path.lastIndexOf("/")); d.length > top.length; d = d.slice(0, d.lastIndexOf("/"))) {
        const was = dirs.get(d);
        if (was && RANK[was] >= RANK[mark]) break;
        dirs.set(d, mark);
      }
    }
  }
  return { files, dirs, untracked };
}

/** The mark for a tree row or tab path, if it has one. */
export function markAt(m: FileMarks, path: string, dir = false): FileMark | undefined {
  const p = slashes(path);
  const own = m.files.get(p) ?? (dir ? m.dirs.get(p) : undefined);
  if (own) return own;
  return m.untracked.some((u) => p.startsWith(`${u}/`)) ? "U" : undefined;
}

// ── loading ─────────────────────────────────────────────────────────

export async function refresh(p: Project): Promise<void> {
  set(p, (g) => { g.loading = true; });
  let repos: RepoStatus[] = [];
  try {
    const root = await invoke<GitStatus>("git_status", args(p));
    repos = [{ repo: "", status: root }];
  } catch (rootError) {
    try {
      repos = await invoke<RepoStatus[]>("folder_status", args(p));
      if (!repos.length) throw new Error(`No git repositories in ${p.path}`);
      // The editor finds a file's repo from its own list: a repo cloned into the folder since joins it.
      const known = gitOf(p.id).repos?.map((r) => r.repo).join("\n");
      if (known !== undefined && known !== repos.map((r) => r.repo).join("\n")) invalidateRepos(p);
    } catch (e) {
      set(p, (g) => {
        g.error = String(e);
        g.loading = false;
        g.status = undefined;
        g.repos = undefined;
        g.repo = "";
        g.repoError = undefined;
        g.sel = undefined;
        g.diff = undefined;
      });
      setBranchStatus(p.id, null);
      setFolderStatus(p.id, null);
      return;
    }
  }

  const active = (g: GitUi, list: RepoStatus[]): RepoStatus => {
    const keep = list.find((r) => r.repo === g.repo);
    if (keep) return keep;
    return list.find((r) => r.status && staged(r.status).length + unstaged(r.status).length) ?? list[0];
  };

  set(p, (g) => {
    g.repos = repos;
    g.error = undefined;
    g.loading = false;
    const repo = active(g, repos);
    if (repo.repo !== g.repo) {
      g.msgs[g.repo] = g.msg;
      g.msg = g.msgs[repo.repo] ?? "";
      g.pr = undefined;
      g.prError = undefined;
      g.prTitle = "";
      g.prBody = "";
      g.prAi = false;
      g.review = undefined;
      g.drawer = null;
      g.commit = undefined;
    }
    g.repo = repo.repo;
    g.status = repo.status;
    g.repoError = repo.error;
    const s = repo.status;
    const list = (st: boolean) => (s?.files ?? []).filter(st ? isStaged : isUnstaged);
    if (!g.sel || g.sel.repo !== g.repo || !list(g.sel.staged).some((c) => c.path === g.sel!.path)) {
      const first = list(true)[0] ?? list(false)[0];
      g.sel = first ? { repo: g.repo, path: first.path, staged: isStaged(first) } : undefined;
    }
    g.diff = undefined;
  });

  if (repos.length === 1 && repos[0].repo === "") {
    setBranchStatus(p.id, repos[0].status ?? null);
    setFolderStatus(p.id, null);
  } else {
    setBranchStatus(p.id, null);
    setFolderStatus(p.id, repos);
  }

  await loadDiff(p);
  if (gitOf(p.id).status?.branch) void loadPr(p);
  if (gitOf(p.id).terms === undefined) void loadTerms(p);
}

/** Switch the active repo in a folder; the commit box, commits and push/PR/merge follow it. */
export function selectRepo(p: Project, repo: string): void {
  const g = gitOf(p.id);
  if (g.repo === repo) return;
  const rs = g.repos?.find((r) => r.repo === repo);
  const first = firstChangeOf(rs?.status);
  set(p, (g) => {
    g.msgs[g.repo] = g.msg;
    g.repo = repo;
    g.status = rs?.status;
    g.repoError = rs?.error;
    g.msg = g.msgs[repo] ?? "";
    g.pr = undefined;
    g.prError = undefined;
    g.prTitle = "";
    g.prBody = "";
    g.prAi = false;
    g.review = undefined;
    g.drawer = null;
    g.commit = undefined;
    g.sel = first ? { repo, path: first.path, staged: isStaged(first) } : undefined;
    g.diff = undefined;
  });
  void loadDiff(p);
  if (rs?.status?.branch) void loadPr(p);
}

/** gh's statusCheckRollup mixes check runs and commit statuses; reduce both to four states. */
function checksOf(raw: any[] | undefined): Check[] {
  return (raw ?? []).map((c) => {
    const name = c.name ?? c.context ?? "check";
    const v = String(c.conclusion || c.state || c.status || "").toUpperCase();
    const state: CheckState =
      v === "SUCCESS" ? "pass"
      : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v) ? "fail"
      : ["SKIPPED", "NEUTRAL", "STALE"].includes(v) ? "skip"
      : "pending";
    return { name, state };
  });
}

export async function loadPr(p: Project): Promise<void> {
  const repo = gitOf(p.id).repo;
  try {
    const raw = await invoke<any | null>("gh_pr_view", argsAt(p, repo));
    set(p, (g) => {
      if (g.repo !== repo) return;
      g.prError = undefined;
      g.pr = raw ? { ...raw, checks: checksOf(raw.statusCheckRollup) } : null;
    });
  } catch (e) {
    set(p, (g) => {
      if (g.repo !== repo) return;
      g.prError = String(e);
      g.pr = null;
    });
  }
}

async function loadTerms(p: Project): Promise<void> {
  const path = `${p.path.replace(/[\\/]+$/, "")}/CONTEXT.md`;
  try {
    const f = await invoke<{ text: string | null }>("read_file", { host: p.host, path });
    set(p, (g) => { g.terms = f.text; });
  } catch {
    set(p, (g) => { g.terms = null; });
  }
}

export async function loadDiff(p: Project): Promise<void> {
  const g = gitOf(p.id);
  const sel = g.sel;
  if (!sel) return set(p, (g) => { g.diff = undefined; });
  const status = g.repos?.find((r) => r.repo === sel.repo)?.status
    ?? (sel.repo === g.repo ? g.status : undefined);
  const change = status?.files.find((c) => c.path === sel.path);
  const key = `${sel.repo}|${sel.staged ? "i" : "w"}:${sel.path}`;
  set(p, (g) => { g.diff = { key }; });
  try {
    const text = await invoke<string>("git_diff", {
      ...argsAt(p, sel.repo), file: sel.path, staged: sel.staged, untracked: !sel.staged && change?.x === "?",
      orig: sel.staged ? change?.orig ?? null : null,
    });
    set(p, (g) => { if (g.diff?.key === key) g.diff.text = text; });
  } catch (e) {
    set(p, (g) => { if (g.diff?.key === key) g.diff.error = String(e); });
  }
}

export function select(p: Project, sel: Sel): void {
  const g0 = gitOf(p.id);
  const repoChanged = g0.repo !== sel.repo;
  const rs = g0.repos?.find((r) => r.repo === sel.repo);
  set(p, (g) => {
    if (repoChanged) {
      g.msgs[g.repo] = g.msg;
      g.msg = g.msgs[sel.repo] ?? "";
      g.pr = undefined;
      g.prError = undefined;
      g.prTitle = "";
      g.prBody = "";
      g.prAi = false;
      g.review = undefined;
      g.drawer = null;
    }
    g.repo = sel.repo;
    g.status = rs?.status;
    g.repoError = rs?.error;
    g.sel = sel;
    g.commit = undefined;
  });
  void loadDiff(p);
  if (repoChanged && rs?.status?.branch) void loadPr(p);
}

/** Open a commit in the diff pane; clicking the one already open goes back to the file diff. */
export function selectCommit(p: Project, sha: string): void {
  if (gitOf(p.id).commit?.key === sha) {
    set(p, (g) => { g.commit = undefined; });
    return;
  }
  void loadCommit(p, sha);
}

async function loadCommit(p: Project, sha: string): Promise<void> {
  const repo = gitOf(p.id).repo;
  set(p, (g) => { g.commit = { key: sha }; });
  try {
    const detail = await invoke<CommitDetail>("git_show", { ...argsAt(p, repo), sha });
    set(p, (g) => { if (g.commit?.key === sha && g.repo === repo) g.commit.detail = detail; });
  } catch (e) {
    set(p, (g) => { if (g.commit?.key === sha && g.repo === repo) g.commit.error = String(e); });
  }
}

// ── actions ─────────────────────────────────────────────────────────

/** Run one git/gh action with the window's working flag; errors are flashed, not thrown. */
async function act(p: Project, what: NonNullable<GitUi["working"]>, fn: () => Promise<unknown>): Promise<boolean> {
  set(p, (g) => { g.working = what; });
  try {
    await fn();
    return true;
  } catch (e) {
    flash(`${what} failed: ${String(e).split("\n")[0]}`);
    return false;
  } finally {
    set(p, (g) => { g.working = null; });
  }
}

export async function stage(p: Project, files: string[]): Promise<void> {
  if (!files.length) return;
  const g = gitOf(p.id);
  if (await act(p, "stage", () => invoke("git_stage", { ...argsAt(p, g.repo), files }))) await refresh(p);
}

export async function unstage(p: Project, files: string[]): Promise<void> {
  if (!files.length) return;
  const g = gitOf(p.id);
  if (await act(p, "stage", () => invoke("git_unstage", { ...argsAt(p, g.repo), files }))) await refresh(p);
}

/** Commit the index; then optionally push, and open the PR drawer. */
export async function commit(p: Project, then: "push" | "pr" | null = null): Promise<void> {
  const g = gitOf(p.id);
  const msg = g.msg.trim();
  if (!msg || !staged(g.status).length || g.working) return;
  const n = staged(g.status).length;
  if (!(await act(p, "commit", () => invoke("git_commit", { ...argsAt(p, g.repo), message: msg + "\n" })))) return;
  set(p, (g) => { g.msg = ""; g.msgAi = false; });
  flash(`committed ${n} file${n === 1 ? "" : "s"}`);
  await refresh(p);
  if (!then) return;
  if (staged(gitOf(p.id).status).length + unstaged(gitOf(p.id).status).length) {
    return flash("committed; other changes are left, so nothing was pushed");
  }
  if (!(await push(p))) return;
  if (then === "pr" && !gitOf(p.id).pr) openDrawer(p, "pr");
}

export async function push(p: Project): Promise<boolean> {
  const s = gitOf(p.id).status;
  if (!s?.branch) { flash("detached HEAD: check out a branch to push"); return false; }
  const ok = await act(p, "push", () => invoke("git_push", { ...argsAt(p, gitOf(p.id).repo), setUpstream: !s.upstream }));
  if (!ok) return false;
  flash(`pushed ${s.branch}`);
  await refresh(p);
  return true;
}

export async function openPr(p: Project): Promise<void> {
  const g = gitOf(p.id);
  if (!g.prTitle.trim() || !g.status) return;
  const ok = await act(p, "pr", async () => {
    const url = await invoke<string>("gh_pr_create", {
      ...argsAt(p, g.repo), title: g.prTitle.trim(), body: g.prBody, base: g.status!.base, draft: g.prDraft,
    });
    flash(`opened ${url}`);
  });
  if (!ok) return;
  set(p, (g) => { g.prTitle = ""; g.prBody = ""; g.prAi = false; g.drawer = "merge"; });
  await loadPr(p);
}

export async function merge(p: Project): Promise<void> {
  const g = gitOf(p.id);
  if (!g.pr || g.pr.state !== "OPEN") return;
  const n = g.pr.number;
  const branch = g.status?.branch;
  // In a Worktree, gh's --delete-branch fails after the merge: it tries to check out the base,
  // which the repo's own folder already has. Delete the remote branch here instead; the local
  // one goes with the worktree (Remove worktree).
  const wt = !!p.parent;
  const ok = await act(p, "merge", () =>
    invoke("gh_pr_merge", { ...argsAt(p, g.repo), strategy: g.strategy, deleteBranch: g.delBranch && !wt }));
  if (!ok) return;
  if (wt && g.delBranch && branch) await invoke("git_push_delete", { ...argsAt(p, g.repo), branch }).catch(() => {});
  bumpRepoEpoch();
  flash(`merged #${n}`);
  set(p, (g) => { g.review = undefined; });
  await loadPr(p);
  await refresh(p);
}

export function openDrawer(p: Project, d: Drawer | null): void {
  set(p, (g) => { g.drawer = d; });
  const g = gitOf(p.id);
  if (d === "pr" && !g.prTitle && !g.busy) void draftPr(p);
}

export function setField(p: Project, k: "msg" | "prTitle" | "prBody", v: string): void {
  set(p, (g) => {
    g[k] = v;
    if (k === "msg") {
      g.msgAi = false;
      g.msgs[g.repo] = v;
    } else {
      g.prAi = false;
    }
  });
}

export function setOpt<K extends "prDraft" | "strategy" | "delBranch">(p: Project, k: K, v: GitUi[K]): void {
  set(p, (g) => { g[k] = v; });
}

export function toggleCtx(p: Project, id: CtxId): void {
  set(p, (g) => { g.ctx[id] = !g.ctx[id]; });
}

// ── ✦ drafts ────────────────────────────────────────────────────────

const LIMIT = 60_000;
const clip = (s: string) => (s.length > LIMIT ? `${s.slice(0, LIMIT)}\n… (diff truncated)` : s);

/** The issue the work is for: an In Progress one whose slug is in the branch name, else the first. */
export function linkedIssue(p: Project): { slug: string; title: string; link: string } | undefined {
  const list = inProgress(repoOf(p).id);
  const branch = (gitOf(p.id).status?.branch ?? "").toLowerCase();
  const d = devOf(repoOf(p).id);
  // A bare number (GitHub's #231 once a branch drops the #, or an unprefixed Local issue) only counts at the start of the branch name.
  const named = (slug: string) => /^\d+$/.test(slug) ? new RegExp(`(^|/)${slug}-`).test(branch) : branch.includes(slug);
  const hit = list.find((i) => named(slugOf(d, i).toLowerCase().replace(/^#/, ""))) ?? list[0];
  return hit && { slug: slugOf(d, hit), title: hit.title, link: hit.link };
}

/** The context blocks the user has switched on, as tagged sections of the prompt. */
function context(p: Project, diffLabel: string, diff: string): string {
  const g = gitOf(p.id);
  const out: string[] = [];
  if (g.ctx.style && g.status?.commits.length) {
    out.push(`<recent_subjects>\n${g.status.commits.map((c) => c.subject).join("\n")}\n</recent_subjects>`);
  }
  const issue = g.ctx.issue ? linkedIssue(p) : undefined;
  if (issue) out.push(`<issue slug="${issue.slug}">\n${issue.title}\n${issue.link}\n</issue>`);
  if (g.ctx.terms && g.terms) out.push(`<glossary source="CONTEXT.md">\n${g.terms.slice(0, 20_000)}\n</glossary>`);
  if (g.ctx.diff) out.push(`<${diffLabel}>\n${clip(diff)}\n</${diffLabel}>`);
  return out.join("\n\n");
}

async function draft(p: Project, kind: NonNullable<GitUi["busy"]>, prompt: () => Promise<string>, done: (text: string) => void) {
  if (gitOf(p.id).busy) return;
  set(p, (g) => { g.busy = kind; });
  try {
    const text = await invoke<string>("claude_draft", { ...args(p), prompt: await prompt() });
    if (text) done(text.replace(/^```[a-z]*\n|\n```$/g, ""));
  } catch (e) {
    flash(`✦ draft failed: ${String(e).split("\n")[0]}`);
  } finally {
    set(p, (g) => { g.busy = null; });
  }
}

export function draftCommit(p: Project): Promise<void> {
  return draft(p, "commit", async () => {
    const diff = await invoke<string>("git_diff", { ...argsAt(p, gitOf(p.id).repo), file: null, staged: true, untracked: false, orig: null });
    const issue = gitOf(p.id).ctx.issue ? linkedIssue(p) : undefined;
    return [
      "Write a git commit message for the staged changes below.",
      "",
      "Rules:",
      "- Output only the commit message: no preamble, no quotes, no code fences.",
      "- First line: a summary of at most 72 characters, in the same style as the repository's recent subjects (if given).",
      "- Then a blank line and a short body, wrapped at 72 columns, saying what changed and why. Skip the body for a trivial change.",
      "- Use the glossary's terms (if given) for the things it names.",
      issue ? `- End with a line \`Refs ${issue.slug}\`.` : "",
      "",
      context(p, "staged_diff", diff || "(nothing staged)"),
    ].join("\n");
  }, (text) => set(p, (g) => { g.msg = text; g.msgAi = true; g.msgs[g.repo] = text; }));
}

export function draftPr(p: Project): Promise<void> {
  return draft(p, "pr", async () => {
    const base = gitOf(p.id).status?.base ?? "main";
    const r = await invoke<{ subjects: string; diff: string }>("git_range", { ...argsAt(p, gitOf(p.id).repo), base: `origin/${base}` });
    const issue = gitOf(p.id).ctx.issue ? linkedIssue(p) : undefined;
    return [
      `Write a GitHub pull request for this branch, which merges into ${base}.`,
      "",
      "Output format, and nothing else (no preamble, no code fences):",
      "- Line 1: the PR title, at most 70 characters, in the style of the commit subjects.",
      "- Line 2: blank.",
      "- Then the body in GitHub Markdown: a `## Summary` of 2–5 bullets, then a `## Test plan` checklist of how to check it.",
      issue ? `- End the body with \`Closes ${issue.slug}\`.` : "",
      "",
      `<commits>\n${r.subjects}\n</commits>`,
      "",
      context(p, "branch_diff", r.diff),
    ].join("\n");
  }, (text) => {
    const [title, ...rest] = text.split("\n");
    set(p, (g) => { g.prTitle = title.replace(/^#+\s*/, "").trim(); g.prBody = rest.join("\n").trim(); g.prAi = true; });
  });
}

export function review(p: Project): Promise<void> {
  return draft(p, "review", async () => {
    const base = gitOf(p.id).status?.base ?? "main";
    const r = await invoke<{ subjects: string; diff: string }>("git_range", { ...argsAt(p, gitOf(p.id).repo), base: `origin/${base}` });
    return [
      "Review this pull request before it is merged. Look for bugs, missed cases, security problems,",
      "and places where it does not do what the issue (if given) asks. Ignore style nits.",
      "",
      "Output one finding per line, at most 8, and nothing else:",
      "  fix|<path>:<line>|<what is wrong and how to fix it, one or two sentences>",
      "  note|<path>:<line>|<something worth a look that is not blocking>",
      "  ok|<area>|<something checked that is fine>   (at most 2 of these)",
      "",
      `<commits>\n${r.subjects}\n</commits>`,
      "",
      context(p, "branch_diff", r.diff),
    ].join("\n");
  }, (text) => {
    const findings = text.split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l): Finding[] => {
      const [sev, loc, ...rest] = l.split("|");
      const s = sev?.trim().toLowerCase();
      if ((s !== "fix" && s !== "note" && s !== "ok") || !rest.length) return [];
      return [{ sev: s, loc: loc.trim(), text: rest.join("|").trim() }];
    });
    set(p, (g) => { g.review = findings.length ? findings : [{ sev: "note", loc: "", text }]; });
  });
}

/** Type a review finding into the project's agent window (not submitted), as issues do. */
export function copyFinding(p: Project, i: number): void {
  const f = gitOf(p.id).review?.[i];
  if (!f) return;
  copyText(`Review note${f.loc ? ` on ${f.loc}` : ""}: ${f.text}`);
  flash("copied the note");
}

/** Open or focus the project's git window. */
export function openGitPanel(project: Project): string {
  const existing = project.tabs.find((t) => t.kind === "git");
  const id = existing?.id ?? addTab(project.id, "git");
  focusTab(project.id, id);
  return id;
}
