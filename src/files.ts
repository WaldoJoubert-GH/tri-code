// File listing and reading for the files window, plus which `file` window shows
// what. Listings and file bodies are cached by host + path and refreshed on demand.

import { invoke } from "@tauri-apps/api/core";
import { createStore } from "solid-js/store";
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
