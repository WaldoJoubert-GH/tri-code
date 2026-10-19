// Browser windows are native child webviews drawn over a placeholder element, one webview per
// page; only the window's shown page is visible. Everything here is keyed by page id.
// Native views always paint above HTML, so they are hidden while overlays are open.
// On Linux, Tauri packs child webviews into a GtkBox and ignores their bounds, so
// there the canvas shows the page in an iframe instead ("framed" mode).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createStore, produce } from "solid-js/store";
import { activePage, addPage, addTab, app, focusTab, Page, Project, projectById, setPageUrl, Tab, visibleTabs } from "./state";
import { flash } from "./ui";

export type BrowserInfo = { url: string; title: string; loading: boolean; /** framed mode: bumped to reload */ rev?: number };

/** False on Linux, where the canvas falls back to an iframe. */
export const nativeBrowsers = !/Linux/i.test(navigator.userAgent) || /Android/i.test(navigator.userAgent);
/** Framed mode keeps its own history, since a cross-origin iframe's history is not reachable. */
const framedHistory = new Map<string, { list: string[]; i: number }>();
export const [browserInfo, setBrowserInfo] = createStore<Record<string, BrowserInfo>>({});

type Box = { x: number; y: number; width: number; height: number };

/** Pages whose native webview exists. */
const created = new Set<string>();
/** Pages whose native webview is currently shown. */
const shown = new Set<string>();
/** Latest rect requested by the canvas per page; null means hidden. */
const latest = new Map<string, Box | null>();
/** Last box sent to the native side, to skip redundant bounds calls. */
const lastSent = new Map<string, string>();
/** Last use per browser window (tab id), to pick the one a terminal's Ctrl+click opens in. */
const lastUsed = new Map<string, number>();
let suspended = false;
/** The peeked sidebar floats over the canvas from the window's left edge to here; webviews reaching under it hide. */
let coveredTo = 0;
const covered = (b: Box) => b.x < coveredTo;

const label = (pageId: string) => `browser-${pageId}`;
const pageIdOf = (lbl: string) => lbl.replace(/^browser-/, "");
const key = (b: Box) => `${b.x},${b.y},${b.width},${b.height}`;
const box = (r: DOMRect): Box => ({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
/** Framed mode cannot read a page's title, so its tab shows the address without the scheme. */
const framedTitle = (url: string) => (url ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "New tab");
const touch = (tabId: string) => lastUsed.set(tabId, Date.now());

/** Fire-and-forget invoke that logs instead of raising unhandled rejections. */
const send = (cmd: string, args: Record<string, unknown>) =>
  invoke(cmd, args).catch((e) => console.warn(`${cmd} failed:`, e));

/** The project and browser window a page belongs to. */
function ownerOf(pageId: string): { project: Project; tab: Tab; page: Page } | undefined {
  for (const project of app.projects) {
    for (const tab of project.tabs) {
      const page = tab.pages?.find((pg) => pg.id === pageId);
      if (page) return { project, tab, page };
    }
  }
}

function patchInfo(pageId: string, patch: Partial<BrowserInfo>) {
  setBrowserInfo(pageId, (prev) => ({ ...{ url: "", title: "New tab", loading: false }, ...prev, ...patch }));
}

function hide(pageId: string) {
  if (!shown.delete(pageId)) return;
  send("browser_hide", { label: label(pageId) });
}

function show(pageId: string) {
  if (shown.has(pageId)) return;
  shown.add(pageId);
  send("browser_show", { label: label(pageId) });
}

function syncBounds(pageId: string, b: Box) {
  const k = key(b);
  if (lastSent.get(pageId) === k) return;
  lastSent.set(pageId, k);
  send("browser_bounds", { label: label(pageId), ...b });
}

// Native events: keep the page URL and title in sync with the webview.
listen<{ label: string; url: string; loading: boolean }>("browser-nav", (e) => {
  const { label: lbl, url, loading } = e.payload;
  if (!lbl.startsWith("browser-")) return;
  const id = pageIdOf(lbl);
  if (!created.has(id)) return;
  patchInfo(id, { url, loading });
  const o = ownerOf(id);
  if (o && !loading && url !== "about:blank" && o.page.url !== url) setPageUrl(o.project.id, o.tab.id, id, url);
}).catch((e) => console.warn("listen browser-nav failed:", e));

listen<{ label: string; title: string }>("browser-title", (e) => {
  const { label: lbl, title } = e.payload;
  if (!lbl.startsWith("browser-")) return;
  const id = pageIdOf(lbl);
  if (created.has(id)) patchInfo(id, { title });
}).catch((e) => console.warn("listen browser-title failed:", e));

// A page asked for a new one (target=_blank, window.open, Ctrl+click): add a page after it in its window.
listen<{ label: string; url: string; background: boolean }>("browser-open", (e) => {
  const { label: lbl, url, background } = e.payload;
  const o = ownerOf(pageIdOf(lbl));
  if (!o) return;
  touch(o.tab.id);
  addPage(o.project.id, o.tab.id, url, { opener: o.page.id, show: !background });
  if (background) flash(`opened ${hostOf(url)} in a background tab`);
}).catch((e) => console.warn("listen browser-open failed:", e));

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

/** Framed mode: give a page its info and history the first time it is seen. */
function initFramed(page: Page) {
  if (browserInfo[page.id]) return;
  const url = page.url;
  setBrowserInfo(page.id, { url, title: framedTitle(url), loading: false, rev: 0 });
  if (url) framedHistory.set(page.id, { list: [url], i: 0 });
}

/** Create a page's webview at `b`, shown or loading behind the shown page. */
function create(page: Page, b: Box, hidden: boolean) {
  created.add(page.id);
  setBrowserInfo(page.id, { url: page.url, title: page.url ? hostOf(page.url) : "New tab", loading: !!page.url });
  send("browser_open", { label: label(page.id), url: page.url, ...b, hidden });
  lastSent.set(page.id, key(b));
  if (!hidden) shown.add(page.id);
}

/**
 * Called by the canvas with the placeholder's rect for the window's shown page, or null when
 * it is not visible (or blank). Pages in the background stay hidden, but load at the same rect
 * so switching to one is instant.
 */
export function placeBrowser(_project: Project, tab: Tab, rect: DOMRect | null): void {
  const active = activePage(tab);
  if (!active) return;
  if (!nativeBrowsers) {
    if (!browserInfo[active.id]) touch(tab.id);
    for (const page of tab.pages ?? []) initFramed(page);
    return;
  }
  if (rect && (rect.width < 2 || rect.height < 2)) return;
  const b = rect ? box(rect) : null;
  for (const page of tab.pages ?? []) {
    if (page.id === active.id) continue;
    latest.set(page.id, null);
    hide(page.id);
    if (b && page.url && !created.has(page.id)) create(page, b, true);
  }
  const id = active.id;
  latest.set(id, b);
  if (!b) return hide(id);

  if (!created.has(id)) {
    touch(tab.id);
    create(active, b, suspended || covered(b));
    return;
  }
  if (suspended) return; // remembered; applied when resumed
  syncBounds(id, b);
  covered(b) ? hide(id) : show(id);
}

/** Record a page's address in the project. */
function remember(pageId: string, url: string) {
  const o = ownerOf(pageId);
  if (o) setPageUrl(o.project.id, o.tab.id, pageId, url);
}

/** Framed mode: show `url` and record it in the project. */
function frame(pageId: string, url: string) {
  patchInfo(pageId, { url, title: framedTitle(url), loading: false });
  remember(pageId, url);
}

export function navigateBrowser(pageId: string, url: string): void {
  const o = ownerOf(pageId);
  if (o) touch(o.tab.id);
  if (!nativeBrowsers) {
    const h = framedHistory.get(pageId) ?? { list: [], i: -1 };
    h.list = h.list.slice(0, h.i + 1).concat(url);
    h.i = h.list.length - 1;
    framedHistory.set(pageId, h);
    return frame(pageId, url);
  }
  if (!created.has(pageId)) {
    patchInfo(pageId, { url, title: browserInfo[pageId]?.title ?? "New tab", loading: !!url });
    remember(pageId, url);
    return;
  }
  send("browser_navigate", { label: label(pageId), url });
}

/** Framed mode: step through our own history. */
function framedGo(pageId: string, d: number) {
  const h = framedHistory.get(pageId);
  if (!h || h.i + d < 0 || h.i + d >= h.list.length) return;
  h.i += d;
  frame(pageId, h.list[h.i]);
}

export function browserBack(pageId: string): void {
  if (!nativeBrowsers) return framedGo(pageId, -1);
  if (created.has(pageId)) send("browser_back", { label: label(pageId) });
}

export function browserForward(pageId: string): void {
  if (!nativeBrowsers) return framedGo(pageId, 1);
  if (created.has(pageId)) send("browser_forward", { label: label(pageId) });
}

export function browserReload(pageId: string): void {
  if (!nativeBrowsers) return patchInfo(pageId, { rev: (browserInfo[pageId]?.rev ?? 0) + 1 });
  if (created.has(pageId)) send("browser_reload", { label: label(pageId) });
}

/** Close one page's webview. */
export function closePage(pageId: string): void {
  if (created.has(pageId)) send("browser_close", { label: label(pageId) });
  created.delete(pageId);
  shown.delete(pageId);
  latest.delete(pageId);
  lastSent.delete(pageId);
  framedHistory.delete(pageId);
  setBrowserInfo(produce((s) => { delete s[pageId]; }));
}

/** Close every page of a browser window. */
export function closeBrowser(tab: Tab): void {
  for (const page of tab.pages ?? []) closePage(page.id);
  lastUsed.delete(tab.id);
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

/**
 * Open a URL as a new page of the project's last-used browser window on the active workspace
 * (or in its shown page when that is blank), or in a new window.
 */
export function openUrlInProject(projectId: string, url: string, fromTabId?: string): void {
  const project = projectById(projectId);
  if (!project) return;
  const browsers = visibleTabs(project).filter((t) => t.kind === "browser");
  const target = browsers.sort((a, b) => (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0))[0];
  const page = target && activePage(target);
  if (target && page && !page.url) {
    navigateBrowser(page.id, url);
    focusTab(projectId, target.id);
  } else if (target) {
    touch(target.id);
    addPage(projectId, target.id, url, { show: true });
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
