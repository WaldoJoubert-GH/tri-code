// File listing and reading for the editor, plus which editor window shows what.
// Listings and file bodies are cached by host + path and refreshed on demand.

import { invoke } from "@tauri-apps/api/core";
import { createStore, produce } from "solid-js/store";
import type { EditorState, Text } from "@codemirror/state";
import type { Body } from "./cm";
import { type Project, type Tab, addTab, focusTab, setEditorTab } from "./state";

export type FsEntry = { name: string; dir: boolean; size: number };
export type FsList = { path: string; entries: FsEntry[] };
/** `stamp` is the file's mtime and size when read; a save sends it back so a file changed since is not overwritten. */
export type FsText = { path: string; size: number; binary: boolean; truncated: boolean; text: string | null; stamp: string };

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

  // Bodies of files open in an editor reload now; every other cached body is dropped
  // so it is re-read the next time that file is opened.
  const shown = new Set(project.tabs.flatMap(filesOf));
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

/** What a save fails with when the file changed on disk since it was read (fs.rs `CHANGED`). */
export const CHANGED = "changed on disk";

/** Write `text` over the file on disk, make it the cached body and return its new stamp. With the
 *  `stamp` the text was read with, a file that changed since is left alone and this throws `CHANGED`;
 *  `null` overwrites whatever is there. */
export async function saveText(project: Project, path: string, text: string, stamp: string | null): Promise<string> {
  const next = await invoke<string>("write_file", { host: project.host, path, contents: text, stamp });
  const k = key(project.host, path);
  const file = texts[k]?.file;
  const size = new TextEncoder().encode(text).length;
  if (file) setTexts(k, "file", { ...file, text, size, stamp: next });
  return next;
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

/** Tabs, by id, ordered most recently used. Picks the editor a file opens in. */
const lastUsed = new Map<string, number>();
export const touchEditor = (tabId: string) => lastUsed.set(tabId, Date.now());

/** Every file an editor tab holds, in tab order. */
export const filesOf = (t: Tab): string[] => (t.kind === "editor" ? t.files ?? [] : []);

const editorsOf = (p: Project) => p.tabs.filter((t) => t.kind === "editor");
const latest = (tabs: Tab[]) => [...tabs].sort((a, b) => (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0))[0];

/** Open or focus the project's editor: the one used last, else a new one. */
export function openEditor(project: Project): string {
  const id = latest(editorsOf(project))?.id ?? addTab(project.id, "editor");
  touchEditor(id);
  focusTab(project.id, id);
  return id;
}

export type OpenHow = {
  /** The window it was opened from: an editor opens it there, anything else puts a new editor after it. */
  from?: string;
  /** In a preview tab, which the next preview replaces (a click in the tree, Enter in Go to File). */
  preview?: boolean;
  /** In a new editor window beside `from` (Ctrl+click, Ctrl+Enter). */
  beside?: boolean;
  /** A line to show once the file is open; `mode` also opens its diff (a drill from the git window). */
  at?: { line: number; mode?: "source" | "diff" };
};

/** A drill's sequence, so asking for the same line twice still jumps. */
let drills = 0;
const atPatch = (how: OpenHow) => (how.at ? { at: { ...how.at, seq: ++drills } } : {});

/**
 * Show `path` in an editor: the one it came from, else the one used last. A file already open
 * there (or, from elsewhere, in any editor) is shown and kept, unless this is a preview. Otherwise
 * it opens as a new tab after the shown one, or in place of the preview tab.
 */
export function openFile(project: Project, path: string, how: OpenHow = {}): void {
  const editors = editorsOf(project);
  const show = (t: Tab, patch: Parameters<typeof setEditorTab>[2]) => {
    setEditorTab(project.id, t.id, { path, ...atPatch(how), ...patch });
    touchEditor(t.id);
    focusTab(project.id, t.id);
  };
  if (how.beside || !editors.length) {
    const id = addTab(project.id, "editor", { path, after: how.from });
    setEditorTab(project.id, id, {
      path,
      ...(how.preview && !how.beside ? { preview: path } : {}),
      ...atPatch(how),
    });
    touchEditor(id);
    return;
  }
  const from = editors.find((t) => t.id === how.from);
  // From an editor, the file opens there even if another editor has it too.
  const open = from ? (filesOf(from).includes(path) ? from : undefined) : editors.find((t) => filesOf(t).includes(path));
  if (open) return show(open, open.preview === path && !how.preview ? { preview: undefined } : {});
  const t = from ?? latest(editors);
  const files = filesOf(t);
  const pv = t.preview && files.includes(t.preview) ? t.preview : undefined;
  let next: string[];
  if (pv && how.preview) next = files.map((f) => (f === pv ? path : f));
  else {
    const at = t.path ? files.indexOf(t.path) + 1 : files.length;
    next = [...files.slice(0, at), path, ...files.slice(at)];
  }
  show(t, { files: next, preview: how.preview ? path : pv });
}

/** Close one file of an editor; the neighbour to its left (or right) is shown. */
export function closeFileInTab(project: Project, tab: Tab, path: string) {
  const files = filesOf(tab), i = files.indexOf(path);
  const rest = files.filter((f) => f !== path);
  const shown = tab.path !== path ? tab.path : rest[Math.max(0, i - 1)];
  setEditorTab(project.id, tab.id, {
    files: rest.length ? rest : undefined,
    path: shown,
    preview: tab.preview === path ? undefined : tab.preview,
  });
}

/** Keep a preview tab: the next file opened gets a tab of its own. */
export function keepPreview(project: Project, tab: Tab, path = tab.path) {
  if (path && tab.preview === path) setEditorTab(project.id, tab.id, { preview: undefined });
}

// ---- open files of editor windows ------------------------------------------------------------
// Kept outside Editor.tsx, which is loaded on first use, so closing a window can drop them.

/** One open file of one editor window. */
export type Doc = {
  state: EditorState;
  body: Body;
  /** The text as last read or saved; the file is modified while the editor's differs. */
  base: Text;
  /** The file's stamp when `base` was read or saved, sent with a save (see fs.rs). */
  stamp: string;
  /** Scroll position, put back when the tab is shown again. */
  top: number;
  /** A save is in flight: the cache it updates is not a change on disk. */
  saving?: boolean;
};

const docs = new Map<string, Map<string, Doc>>();
export const docsOf = (tabId: string) => docs.get(tabId) ?? docs.set(tabId, new Map()).get(tabId)!;

/** Modified files, by editor window then path. */
export const [dirty, setDirty] = createStore<Record<string, Record<string, true | undefined>>>({});
export const markDirty = (tabId: string, path: string, on: boolean) => {
  if (!!dirty[tabId]?.[path] === on) return;
  setDirty(produce((d) => {
    const m = (d[tabId] ??= {});
    if (on) m[path] = true;
    else delete m[path];
  }));
};
export const dirtyCount = (tabId: string) => Object.keys(dirty[tabId] ?? {}).length;

/** Forget a closed editor window's files and edits (once its undo has expired). */
export function dropEditor(tabId: string) {
  docs.delete(tabId);
  setDirty(produce((d) => { delete d[tabId]; }));
}
