// File listing and reading for the files window, plus which `file` window shows
// what. Listings and file bodies are cached by host + path and refreshed on demand.

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { type FileOpen, type Project, type Tab, addTab, app, focusTab, projectById, setFileTab, setSettings } from "./state";

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

/** Write `text` over the file on disk and make it the cached body. */
export async function saveText(project: Project, path: string, text: string): Promise<void> {
  await invoke("write_file", { host: project.host, path, contents: text });
  const k = key(project.host, path);
  const file = texts[k]?.file;
  const size = new TextEncoder().encode(text).length;
  if (file) setTexts(k, "file", { ...file, text, size });
}

/** A repo image as a `data:` URL, for the Markdown preview. */
export const loadImage = (project: Project, path: string) => invoke<string>("read_image", { host: project.host, path });

export type Media = "image" | "video" | "audio";

const MEDIA: Record<string, [Media, string]> = {
  png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"], webp: ["image", "image/webp"], avif: ["image", "image/avif"],
  bmp: ["image", "image/bmp"], ico: ["image", "image/x-icon"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"], ogv: ["video", "video/ogg"],
  mp3: ["audio", "audio/mpeg"], wav: ["audio", "audio/wav"], ogg: ["audio", "audio/ogg"],
  m4a: ["audio", "audio/mp4"], flac: ["audio", "audio/flac"],
};

/** The media kind and mime type a file window shows `path` as, by extension. */
export function mediaType(path: string): [Media, string] | null {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return MEDIA[ext] ?? null;
}

/** A media file as a blob URL; the caller revokes it. */
export async function loadMedia(project: Project, path: string, mime: string): Promise<string> {
  const buf = await invoke<ArrayBuffer>("read_media", { host: project.host, path });
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}

export const dirState =(project: Project, path: string): DirState | undefined => dirs[key(project.host, full(project, path))];
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

/** Every file a `file` tab holds: its tab strip, or just its one file. */
export const filesOf = (t: Tab): string[] => t.files ?? (t.path ? [t.path] : []);

/** A file waiting on "Replace, beside, as a tab or preview?", asked in the window it would replace. */
export type Ask = { projectId: string; tabId: string; path: string; fromTabId?: string };
const [ask, setAsk] = createSignal<Ask | null>(null);
export { ask };
export const cancelAsk = () => setAsk(null);

/** Answer the question: open the file that way, and with `remember`, from now on. */
export function answerAsk(how: Exclude<FileOpen, "ask">, remember: boolean) {
  const a = ask();
  const p = a && projectById(a.projectId);
  setAsk(null);
  if (!p) return;
  if (remember) setSettings({ fileOpen: how });
  openWith(p, a.path, how, a.fromTabId);
}

/** Show `path` the way Settings says (`fresh`, from Ctrl: a new window, or in "window" mode the last one).
 *  A file that is already open is focused instead. */
export function openFile(project: Project, path: string, fromTabId?: string, fresh = false): void {
  const fileTabs = project.tabs.filter((t) => t.kind === "file");
  const open = fileTabs.find((t) => filesOf(t).includes(path));
  if (open) {
    if (open.path !== path) setFileTab(project.id, open.id, { path });
    lastUsed.set(open.id, Date.now());
    focusTab(project.id, open.id);
    return;
  }
  const mode = app.settings.fileOpen;
  openWith(project, path, fresh ? (mode === "window" ? "reuse" : "window") : mode, fromTabId);
}

function openWith(project: Project, path: string, how: FileOpen, fromTabId?: string) {
  const fileTabs = project.tabs.filter((t) => t.kind === "file");
  const last = fileTabs.sort((a, b) => (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0))[0];
  const show = (t: Tab, patch: Parameters<typeof setFileTab>[2]) => {
    setFileTab(project.id, t.id, patch);
    lastUsed.set(t.id, Date.now());
    focusTab(project.id, t.id);
  };
  const fresh = (preview: boolean) => {
    const id = addTab(project.id, "file", { path, after: fromTabId });
    if (preview) setFileTab(project.id, id, { preview: true });
    lastUsed.set(id, Date.now());
  };
  if (how === "preview") {
    const pv = fileTabs.find((t) => t.preview);
    return pv ? show(pv, { path, files: undefined }) : fresh(true);
  }
  if (!last || how === "window") return fresh(false);
  if (how === "ask") {
    focusTab(project.id, last.id);
    return setAsk({ projectId: project.id, tabId: last.id, path, fromTabId });
  }
  const files = filesOf(last);
  // "reuse" swaps the file being shown and leaves the rest of a tab strip alone
  const next = how === "tabs" ? [...files, path] : files.map((f) => (f === last.path ? path : f));
  show(last, { path, files: next.length > 1 ? next : undefined, preview: undefined });
}

/** Close one file of a `file` tab's strip; the neighbour to its left (or right) is shown. */
export function closeFileInTab(project: Project, tab: Tab, path: string) {
  const files = filesOf(tab), i = files.indexOf(path);
  const rest = files.filter((f) => f !== path);
  if (!rest.length) return;
  const shown = tab.path === path ? rest[Math.max(0, i - 1)] : tab.path;
  setFileTab(project.id, tab.id, { path: shown, files: rest.length > 1 ? rest : undefined });
}

/** Keep a preview: the next file opened gets a preview window of its own. */
export function keepPreview(project: Project, tab: Tab) {
  if (tab.preview) setFileTab(project.id, tab.id, { preview: undefined });
}

/** Change the mode. Leaving "preview" keeps every preview window as it is. */
export function setFileOpen(mode: FileOpen) {
  setSettings({ fileOpen: mode });
  if (mode === "preview") return;
  for (const p of app.projects) for (const t of p.tabs) if (t.preview) setFileTab(p.id, t.id, { preview: undefined });
}
