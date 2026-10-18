// Browser windows are native child webviews drawn over a placeholder element.
// Native views always paint above HTML, so they are hidden while overlays are open.
// On Linux, Tauri packs child webviews into a GtkBox and ignores their bounds, so
// there the canvas shows the page in an iframe instead ("framed" mode).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createStore, produce } from "solid-js/store";
import { addTab, app, focusTab, Project, projectById, setTabUrl, Tab, visibleTabs } from "./state";
import { flash } from "./ui";

export type BrowserInfo = { url: string; title: string; loading: boolean; /** framed mode: bumped to reload */ rev?: number };

/** False on Linux, where the canvas falls back to an iframe. */
export const nativeBrowsers = !/Linux/i.test(navigator.userAgent) || /Android/i.test(navigator.userAgent);
/** Framed mode keeps its own history, since a cross-origin iframe's history is not reachable. */
const framedHistory = new Map<string, { list: string[]; i: number }>();
export const [browserInfo, setBrowserInfo] = createStore<Record<string, BrowserInfo>>({});

type Box = { x: number; y: number; width: number; height: number };

/** Tabs whose native webview exists. */
const created = new Set<string>();
/** Tabs whose native webview is currently shown. */
const shown = new Set<string>();
/** Latest rect requested by the canvas per tab; null means hidden. */
const latest = new Map<string, Box | null>();
/** Last box sent to the native side, to skip redundant bounds calls. */
const lastSent = new Map<string, string>();
/** Last use per tab, to pick the browser that Ctrl+click reuses. */
const lastUsed = new Map<string, number>();
let suspended = false;
/** The peeked sidebar floats over the canvas from the window's left edge to here; webviews reaching under it hide. */
let coveredTo = 0;
const covered = (b: Box) => b.x < coveredTo;

const label = (tabId: string) => `browser-${tabId}`;
const tabIdOf = (lbl: string) => lbl.replace(/^browser-/, "");
const key = (b: Box) => `${b.x},${b.y},${b.width},${b.height}`;
const box = (r: DOMRect): Box => ({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const touch = (tabId: string) => lastUsed.set(tabId, Date.now());

/** Fire-and-forget invoke that logs instead of raising unhandled rejections. */
const send = (cmd: string, args: Record<string, unknown>) =>
  invoke(cmd, args).catch((e) => console.warn(`${cmd} failed:`, e));

const projectOf = (tabId: string) => app.projects.find((p) => p.tabs.some((t) => t.id === tabId));

function patchInfo(tabId: string, patch: Partial<BrowserInfo>) {
  setBrowserInfo(tabId, (prev) => ({ ...{ url: "", title: "New tab", loading: false }, ...prev, ...patch }));
}

function hide(tabId: string) {
  if (!shown.delete(tabId)) return;
  send("browser_hide", { label: label(tabId) });
}

function show(tabId: string) {
  if (shown.has(tabId)) return;
  shown.add(tabId);
  send("browser_show", { label: label(tabId) });
}

function syncBounds(tabId: string, b: Box) {
  const k = key(b);
  if (lastSent.get(tabId) === k) return;
  lastSent.set(tabId, k);
  send("browser_bounds", { label: label(tabId), ...b });
}

// Native events: keep the page URL and title in sync with the webview.
listen<{ label: string; url: string; loading: boolean }>("browser-nav", (e) => {
  const { label: lbl, url, loading } = e.payload;
  if (!lbl.startsWith("browser-")) return;
  const id = tabIdOf(lbl);
  if (!created.has(id)) return;
  patchInfo(id, { url, loading });
  const project = projectOf(id);
  const tab = project?.tabs.find((t) => t.id === id);
  if (project && !loading && url !== "about:blank" && tab?.url !== url) setTabUrl(project.id, id, url);
}).catch((e) => console.warn("listen browser-nav failed:", e));

listen<{ label: string; title: string }>("browser-title", (e) => {
  const { label: lbl, title } = e.payload;
  if (!lbl.startsWith("browser-")) return;
  const id = tabIdOf(lbl);
  if (created.has(id)) patchInfo(id, { title });
}).catch((e) => console.warn("listen browser-title failed:", e));

/** Normalise an address typed by the user: add a scheme when missing. */
export function normalizeUrl(s: string): string {
  const t = s.trim();
  if (!t) return "";
  // "host:port" is not a scheme; anything else with "name:" is.
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(t)) return t;
  const host = t.split(/[/:?#]/)[0];
  if (host === "localhost" || /^127\./.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return `http://${t}`;
  return `https://${t}`;
}

/** Called by the canvas with the placeholder's rect, or null when the window is not visible. */
export function placeBrowser(_project: Project, tab: Tab, rect: DOMRect | null): void {
  const id = tab.id;
  if (!nativeBrowsers) {
    if (!browserInfo[id]) {
      const url = tab.url ?? "";
      setBrowserInfo(id, { url, title: url ? hostOf(url) : "New tab", loading: false, rev: 0 });
      if (url) framedHistory.set(id, { list: [url], i: 0 });
      touch(id);
    }
    return;
  }
  if (rect && (rect.width < 2 || rect.height < 2)) return;
  const b = rect ? box(rect) : null;
  latest.set(id, b);
  if (!b) return hide(id);

  if (!created.has(id)) {
    created.add(id);
    touch(id);
    const url = tab.url ?? "";
    setBrowserInfo(id, { url, title: url ? hostOf(url) : "New tab", loading: !!url });
    send("browser_open", { label: label(id), url, ...b });
    lastSent.set(id, key(b));
    shown.add(id);
    if (suspended || covered(b)) hide(id);
    return;
  }
  if (suspended) return; // remembered; applied when resumed
  syncBounds(id, b);
  covered(b) ? hide(id) : show(id);
}

/** Framed mode: show `url` and record it in the project. */
function frame(tabId: string, url: string) {
  patchInfo(tabId, { url, title: url ? hostOf(url) : "New tab", loading: false });
  const project = projectOf(tabId);
  if (project) setTabUrl(project.id, tabId, url);
}

export function navigateBrowser(tabId: string, url: string): void {
  touch(tabId);
  if (!nativeBrowsers) {
    const h = framedHistory.get(tabId) ?? { list: [], i: -1 };
    h.list = h.list.slice(0, h.i + 1).concat(url);
    h.i = h.list.length - 1;
    framedHistory.set(tabId, h);
    return frame(tabId, url);
  }
  if (!created.has(tabId)) {
    patchInfo(tabId, { url, title: browserInfo[tabId]?.title ?? "New tab", loading: !!url });
    const project = projectOf(tabId);
    if (project) setTabUrl(project.id, tabId, url);
    return;
  }
  send("browser_navigate", { label: label(tabId), url });
}

/** Framed mode: step through our own history. */
function framedGo(tabId: string, d: number) {
  const h = framedHistory.get(tabId);
  if (!h || h.i + d < 0 || h.i + d >= h.list.length) return;
  h.i += d;
  frame(tabId, h.list[h.i]);
}

export function browserBack(tabId: string): void {
  if (!nativeBrowsers) return framedGo(tabId, -1);
  if (created.has(tabId)) send("browser_back", { label: label(tabId) });
}

export function browserForward(tabId: string): void {
  if (!nativeBrowsers) return framedGo(tabId, 1);
  if (created.has(tabId)) send("browser_forward", { label: label(tabId) });
}

export function browserReload(tabId: string): void {
  if (!nativeBrowsers) return patchInfo(tabId, { rev: (browserInfo[tabId]?.rev ?? 0) + 1 });
  if (created.has(tabId)) send("browser_reload", { label: label(tabId) });
}

export function closeBrowser(tabId: string): void {
  if (created.has(tabId)) send("browser_close", { label: label(tabId) });
  created.delete(tabId);
  shown.delete(tabId);
  latest.delete(tabId);
  lastSent.delete(tabId);
  lastUsed.delete(tabId);
  framedHistory.delete(tabId);
  setBrowserInfo(produce((s) => { delete s[tabId]; }));
}

/** Hide every native webview while HTML overlays are open; restore the placed ones afterwards. */
export function setBrowsersSuspended(on: boolean): void {
  suspended = on;
  if (on) {
    for (const id of [...shown]) hide(id);
    return;
  }
  for (const [id, b] of latest) {
    if (!b || !created.has(id) || covered(b)) continue;
    syncBounds(id, b);
    show(id);
  }
}

/** Hide only the webviews under the sidebar's peek (0 when it folds back), so the rest stay live. */
export function setBrowsersCovered(right: number): void {
  coveredTo = right;
  if (suspended) return;
  for (const [id, b] of latest) {
    if (!b || !created.has(id)) continue;
    if (covered(b)) hide(id);
    else (syncBounds(id, b), show(id));
  }
}

/** Open a URL in the project's browser window on the active workspace, or in a new one. */
export function openUrlInProject(projectId: string, url: string, fromTabId?: string): void {
  const project = projectById(projectId);
  if (!project) return;
  const browsers = visibleTabs(project).filter((t) => t.kind === "browser");
  const target = browsers.sort((a, b) => (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0))[0];
  if (target) {
    navigateBrowser(target.id, url);
    focusTab(projectId, target.id);
  } else {
    addTab(projectId, "browser", { url, after: fromTabId });
  }
  flash(`open ${url}`);
}

/** Open a URL in the system browser. */
export function openExternal(url: string): void {
  openUrl(url).catch((e) => console.warn("openUrl failed:", e));
  flash(`opened in system browser: ${url}`);
}
