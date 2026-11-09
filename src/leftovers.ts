// Leftovers (CONTEXT.md): what tri-code started that outlived its window and still holds a place:
// a ghost terminal no tab has, a stray process in a project's folder whose parent is gone, a remote
// `tri-*` session no tab has, a leftover checkout git no longer lists, a prunable worktree entry.
// The sidebar badges the row each one holds, a status line chip lists them all, and Remove worktree
// ends the ones in its folder before deleting it. Read when the app gains focus and after a window
// closes, at most every 30s. The backend is src-tauri/src/leftovers.rs. Chosen from
// design/orphans.html (variant B).

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { type Project, app, isLocalHost, isTerminal, projectById, sessionName } from "./state";
import { envLocked } from "./envlock";
import { ask, flash } from "./ui";

export type LeftoverKind = "ghost" | "stray" | "remote" | "folder" | "prune";

export type Leftover = {
  /** Stable across scans, for keyed lists. */
  id: string;
  kind: LeftoverKind;
  host: string;
  /** The project whose folder or windows it belongs to (a Worktree, or a repo for a folder or prune). */
  place: string | null;
  label: string;
  detail: string;
  pty?: number;
  pid?: number;
  /** The folder a stray is in, or a leftover checkout's path. */
  dir?: string;
  session?: string;
};

/** A process in a folder that isn't running in one of tri-code's tabs. `orphan`: a tri-code terminal
 *  started it (`session`) and its parent is gone, so it is a stray. Otherwise it is someone else's
 *  (an editor): never ended without asking, and Remove worktree names it. */
export type Holder = { pid: number; name: string; cmd: string; dir: string; orphan: boolean; session: string | null; age: number };

type Local = { ghosts: { id: number; key: string }[]; procs: Holder[] };
type Checkouts = { folders: string[]; prunable: { path: string; branch: string | null }[] };

const [items, setItems] = createStore<Leftover[]>([]);
export const leftovers = () => items;

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
/** Paths from the host (git, a folder listing) are absolute; a project's may start with `~`, so
 *  compare what follows it. */
export const samePath = (abs: string, path: string) =>
  path.startsWith("~") ? norm(abs).endsWith(norm(path.slice(1))) : norm(abs) === norm(path);
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Every terminal a tab has, by its session key: what must keep running. */
const keepKeys = () => app.projects.flatMap((p) => p.tabs.filter((t) => isTerminal(t) && !t.demo).map((t) => sessionName(p, t)));

/** The project a session key was made for (`tri-<project>-<tab>`), if it is still here. */
const placeOfKey = (key: string) => app.projects.find((p) => key.startsWith(`tri-${p.id}-`))?.id ?? null;

/** The project whose folder `dir` is. */
const placeOfDir = (host: string, dir: string) => app.projects.find((p) => p.host === host && samePath(dir, p.path))?.id ?? null;

const ago = (secs: number) => (secs < 60 ? "now" : secs < 3600 ? `${Math.floor(secs / 60)}m` : secs < 86400 ? `${Math.floor(secs / 3600)}h` : `${Math.floor(secs / 86400)}d`);

const usable = (host: string) => !envLocked(host);

let last = 0;
let running: Promise<void> | null = null;

/** Read every Environment's leftovers again; skipped within 30s of the last read unless `force`. */
export function scanLeftovers(force = false): Promise<void> {
  if (running) return running;
  if (!force && Date.now() - last < 30_000) return Promise.resolve();
  last = Date.now();
  running = scan().finally(() => (running = null));
  return running;
}

/** Read again shortly: a window just closed, and its programs take a moment to go. */
export function rescanSoon() {
  setTimeout(() => void scanLeftovers(true), 2500);
}

async function scan(): Promise<void> {
  const keep = keepKeys();
  const found: Leftover[] = [];
  const repos = app.projects.filter((p) => !p.parent && !p.sample && usable(p.host));

  // Leftover checkouts first: their folders are scanned for strays too.
  const folders: { host: string; path: string; repo: string }[] = [];
  await Promise.all(repos.map(async (r) => {
    const c = await invoke<Checkouts>("leftovers_checkouts", { host: r.host, path: r.path }).catch(() => null);
    if (!c) return;
    for (const f of c.folders) {
      if (app.projects.some((p) => p.host === r.host && samePath(f, p.path))) continue;
      folders.push({ host: r.host, path: f, repo: r.id });
      found.push({ id: `folder:${r.host}:${f}`, kind: "folder", host: r.host, place: r.id, label: baseName(f), detail: "not a worktree git knows", dir: f });
    }
    for (const w of c.prunable) {
      found.push({ id: `prune:${r.host}:${w.path}`, kind: "prune", host: r.host, place: r.id, label: w.branch ?? baseName(w.path), detail: "folder gone; git still holds the branch", dir: w.path });
    }
  }));

  const dirs = [
    ...app.projects.filter((p) => isLocalHost(p.host) && !p.sample).map((p) => p.path),
    ...folders.filter((f) => isLocalHost(f.host)).map((f) => f.path),
  ];
  const local = await invoke<Local>("leftovers_local", { keep, dirs }).catch((e) => (console.warn("leftovers_local failed:", e), null));
  for (const g of local?.ghosts ?? []) {
    found.push({ id: `ghost:${g.key}`, kind: "ghost", host: "local", place: placeOfKey(g.key), label: "terminal", detail: `${g.key} · no window`, pty: g.id });
  }
  for (const p of (local?.procs ?? []).filter((p) => p.orphan)) {
    const folder = folders.find((f) => samePath(p.dir, f.path));
    found.push({
      id: `stray:${p.pid}`, kind: "stray", host: "local", place: folder ? folder.repo : placeOfDir("local", p.dir) ?? (p.session ? placeOfKey(p.session) : null),
      label: p.name.replace(/\.exe$/i, ""), detail: `pid ${p.pid} · ${ago(p.age)}`, pid: p.pid, dir: p.dir,
    });
  }

  const hosts = [...new Set(app.projects.filter((p) => !isLocalHost(p.host) && usable(p.host)).map((p) => p.host))];
  await Promise.all(hosts.map(async (host) => {
    const names = await invoke<string[]>("leftovers_remote", { host, keep }).catch(() => [] as string[]);
    // Only sessions of this machine's projects: another machine's tri-code on the same host has its own.
    for (const s of names) {
      const place = placeOfKey(s);
      if (place) found.push({ id: `remote:${host}:${s}`, kind: "remote", host, place, label: "session", detail: `${s} · no window`, session: s });
    }
  }));

  setItems(reconcile(found, { key: "id" }));
}

/** Leftovers that hold a project's own folder or windows: what its row's count says. */
export const leftoversAt = (id: string) => items.filter((l) => l.place === id && l.kind !== "folder");
/** A repo's leftover checkouts: rows of their own under it. */
export const staleCheckouts = (repoId: string) => items.filter((l) => l.place === repoId && l.kind === "folder");

const drop = (ids: string[]) => setItems((xs) => xs.filter((x) => !ids.includes(x.id)));

/** End one leftover. A leftover checkout is deleted, after asking, with whatever holds it. */
export async function endLeftover(l: Leftover): Promise<void> {
  try {
    if (l.kind === "ghost") await invoke("pty_kill", { id: l.pty });
    else if (l.kind === "stray") await invoke("leftovers_end", { pids: [l.pid], dirs: [l.dir] });
    else if (l.kind === "remote") await invoke("remote_kill_session", { host: l.host, session: l.session });
    else if (l.kind === "prune") {
      const repo = projectById(l.place ?? "");
      if (repo) await invoke("git_worktree_prune", { host: repo.host, path: repo.path });
    } else if (l.kind === "folder") {
      if (!await ask(`Delete ${l.dir}? Git doesn't list it as a worktree any more, so anything left in it is lost.`)) return;
      const inside = items.filter((x) => x.kind === "stray" && x.dir && samePath(x.dir, l.dir!));
      if (inside.length) await invoke("leftovers_end", { pids: inside.map((x) => x.pid), dirs: [l.dir] });
      await invoke("worktree_dir_delete", { host: l.host, dir: l.dir });
      drop(inside.map((x) => x.id));
    }
    drop([l.id]);
    flash(`${l.kind === "folder" ? "deleted" : l.kind === "prune" ? "pruned" : "ended"} ${l.label}`);
  } catch (e) {
    flash(`couldn't end ${l.label}: ${e}`);
  }
  rescanSoon();
}

/** End every leftover in `list`; leftover checkouts are left for their own ×, since deleting asks. */
export async function endAll(list: Leftover[]): Promise<void> {
  const go = list.filter((l) => l.kind !== "folder");
  const strays = go.filter((l) => l.kind === "stray");
  if (strays.length) await invoke("leftovers_end", { pids: strays.map((l) => l.pid), dirs: [...new Set(strays.map((l) => l.dir))] }).catch(() => {});
  for (const l of go.filter((l) => l.kind !== "stray")) await endLeftover(l);
  drop(strays.map((l) => l.id));
  rescanSoon();
}

/** What has files open in a Worktree's folder right now, read fresh for Remove worktree: strays to
 *  end, ghost and remote sessions of the project, and others' programs that must close first. */
export async function holdersOf(p: Project): Promise<{ end: Leftover[]; others: Holder[] }> {
  const end = items.filter((l) => l.place === p.id && (l.kind === "ghost" || l.kind === "remote"));
  if (!isLocalHost(p.host)) return { end, others: [] };
  const local = await invoke<Local>("leftovers_local", { keep: keepKeys(), dirs: [p.path] }).catch(() => null);
  const procs = local?.procs ?? [];
  for (const h of procs.filter((h) => h.orphan)) {
    end.push({ id: `stray:${h.pid}`, kind: "stray", host: p.host, place: p.id, label: h.name.replace(/\.exe$/i, ""), detail: `pid ${h.pid}`, pid: h.pid, dir: h.dir });
  }
  return { end, others: procs.filter((h) => !h.orphan) };
}

/** End what `holdersOf` found (and `others` too, when the user agreed to). */
export async function endHolders(p: Project, end: Leftover[], others: Holder[] = []): Promise<void> {
  const pids = [...end.filter((l) => l.kind === "stray").map((l) => l.pid!), ...others.map((h) => h.pid)];
  if (pids.length) await invoke("leftovers_end", { pids, dirs: [p.path] }).catch((e) => flash(`couldn't end: ${e}`));
  for (const l of end) {
    if (l.kind === "ghost") await invoke("pty_kill", { id: l.pty }).catch(() => {});
    else if (l.kind === "remote") await invoke("remote_kill_session", { host: l.host, session: l.session }).catch(() => {});
  }
  drop(end.map((l) => l.id));
}

/** How a holder reads in a dialog: its name and pid, and its command when that says more. */
export const holderLine = (h: Pick<Holder, "name" | "pid" | "cmd">) => {
  const args = h.cmd.split(/\s+/).slice(1).join(" ");
  return `${h.name.replace(/\.exe$/i, "")} (pid ${h.pid})${args ? ` ${args.length > 60 ? args.slice(0, 59) + "…" : args}` : ""}`;
};

// ── the popover: one place's leftovers (a row's count) or all of them (the status line) ──

/** What the popover lists: a project id, `*` for every leftover, or null when closed. */
const [popFor, setPopFor] = createSignal<{ place: string; anchor: HTMLElement } | null>(null);
export { popFor as leftoversPop };
export const leftoversOpen = () => popFor() !== null;
export const closeLeftovers = () => setPopFor(null);
export function toggleLeftovers(place: string, anchor: HTMLElement) {
  if (popFor()?.place === place) return closeLeftovers();
  setPopFor({ place, anchor });
  void scanLeftovers(true);
}

/** Watch for the moments leftovers appear: the app coming back into focus. Call once. */
export function watchLeftovers() {
  window.addEventListener("focus", () => void scanLeftovers());
  void scanLeftovers(true);
}
