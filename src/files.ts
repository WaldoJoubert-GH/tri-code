// File listing and reading for the files window, plus which `file` window shows
// what. Listings and file bodies are cached by host + path and refreshed on demand.

import { invoke } from "@tauri-apps/api/core";
import { createStore, produce } from "solid-js/store";
import { type Project, addTab, focusTab, setTabPath } from "./state";

export type FsEntry = { name: string; dir: boolean; size: number };
export type FsList = { path: string; entries: FsEntry[] };
export type FsText = { path: string; size: number; binary: boolean; truncated: boolean; text: string | null };

type DirState = { loading: boolean; list?: FsList; error?: string };
type TextState = { loading: boolean; file?: FsText; error?: string };

export const [dirs, setDirs] = createStore<Record<string, DirState>>({});
export const [texts, setTexts] = createStore<Record<string, TextState>>({});

const key = (host: string, path: string) => `${host}\u0000${path}`;
/** The tab's own path, or the project root when it is empty. */
const full = (project: Project, path: string) => path || project.path;

export function loadDir(project: Project, path: string): void {
  const k = key(project.host, full(project, path));
  const cur = dirs[k];
  if (cur?.loading || cur?.list) return;
  setDirs(k, { loading: true });
  invoke<FsList>("list_files", { host: project.host, path: full(project, path) })
    .then((list) => setDirs(k, { loading: false, list }))
    .catch((e) => setDirs(k, { loading: false, error: String(e) }));
}

export function refreshDir(project: Project, path: string): void {
  const k = key(project.host, full(project, path));
  setDirs(k, { loading: true, list: undefined, error: undefined });
  invoke<FsList>("list_files", { host: project.host, path: full(project, path) })
    .then((list) => setDirs(k, { loading: false, list }))
    .catch((e) => setDirs(k, { loading: false, error: String(e) }));
}

/**
 * Reload everything on disk for a project: every directory already listed in
 * the files window (not just the root) and every open `file` window. Without
 * this, `loadDir`'s cache kept expanded subdirectories stale until the whole
 * webview was reloaded — new and changed files never showed up.
 */
export function refreshProject(project: Project): void {
  const root = project.path;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const under = (path: string) => path === root || path.startsWith(prefix);
  /** Host and remaining path of a `key(host, path)` cache entry. */
  const split = (k: string): { host: string; path: string } => {
    const sep = k.indexOf("\u0000");
    return { host: k.slice(0, sep), path: k.slice(sep + 1) };
  };

  for (const k of Object.keys(dirs)) {
    const { host, path } = split(k);
    if (host !== project.host || !under(path)) continue;
    refreshDir(project, path);
  }

  // Bodies of open file windows reload now; every other cached body is dropped
  // so it is re-read the next time that file is opened (the window is reused).
  const shown = new Set(project.tabs.filter((t) => t.kind === "file" && t.path).map((t) => t.path!));
  for (const k of Object.keys(texts)) {
    const { host, path } = split(k);
    if (host !== project.host || !under(path) || shown.has(path)) continue;
    setTexts(produce((t) => { delete t[k]; }));
  }
  for (const path of shown) reloadText(project, path);
}

export function loadText(project: Project, path: string): void {
  const k = key(project.host, path);
  const cur = texts[k];
  if (cur?.loading || cur?.file) return;
  setTexts(k, { loading: true });
  invoke<FsText>("read_file", { host: project.host, path })
    .then((file) => setTexts(k, { loading: false, file }))
    .catch((e) => setTexts(k, { loading: false, error: String(e) }));
}

export function reloadText(project: Project, path: string): void {
  const k = key(project.host, path);
  setTexts(k, { loading: true, file: undefined, error: undefined });
  invoke<FsText>("read_file", { host: project.host, path })
    .then((file) => setTexts(k, { loading: false, file }))
    .catch((e) => setTexts(k, { loading: false, error: String(e) }));
}

export const dirState = (project: Project, path: string): DirState | undefined => dirs[key(project.host, full(project, path))];
export const textState = (project: Project, path: string): TextState | undefined => texts[key(project.host, path)];

/** Open or focus the project's files window. */
export function openFilesPanel(project: Project): string {
  const existing = project.tabs.find((t) => t.kind === "files");
  const id = existing?.id ?? addTab(project.id, "files");
  focusTab(project.id, id);
  return id;
}

/** Tabs, by id, ordered most recently opened. Drives `file` window reuse. */
const lastUsed = new Map<string, number>();

/** Show `path` in the project's `file` window, reusing the most recently used one. */
export function openFile(project: Project, path: string, fromTabId?: string): void {
  const target = project.tabs
    .filter((t) => t.kind === "file")
    .sort((a, b) => (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0))[0];
  if (target) {
    setTabPath(project.id, target.id, path);
    lastUsed.set(target.id, Date.now());
    focusTab(project.id, target.id);
    return;
  }
  const id = addTab(project.id, "file", { path, after: fromTabId });
  lastUsed.set(id, Date.now());
}
