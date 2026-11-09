// Browser windows are native child webviews drawn over a placeholder element, one webview per
// page; only the window's shown page is visible. Everything here is keyed by page id.
// Native views always paint above HTML, so they are hidden while overlays are open.
// On Linux, Tauri packs child webviews into a GtkBox and ignores their bounds, so
// there the canvas shows the page in an iframe instead ("framed" mode).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { batch, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  type Agent, DEFAULT_PROFILE, activePage, addPage, addTab, app, focusTab, isRemote, isWebApp, live, Page, Profile, Project, profileById,
  projectById, setPageUrl, space, Tab, tabIcon, tabName, tabProfile, visibleTabs,
} from "./state";
import { looksLikeUrl } from "./agents";
import { agentTarget, agentWindows, rememberAgent } from "./agenttarget";
import { offeredIn } from "./scope";
import { setupStatus } from "./agentsetup";
import { sigOf } from "./sigs";
import { iconSvg } from "./lucide";
import { pasteText } from "./terms";
import { flash } from "./ui";
import { onReopened, pageFwd, releasePage, remoteUrl, resolveUrl } from "./tunnels";
import { targetOf, toLocal } from "./tunnelmap";

export type BrowserInfo = {
  url: string; title: string; loading: boolean;
  /** framed mode: bumped to reload */ rev?: number;
  /** framed mode: what the iframe loads when it differs from `url` (through a remote tunnel) */ src?: string;
};

/** False on Linux, where the canvas falls back to an iframe. */
export const nativeBrowsers = !/Linux/i.test(navigator.userAgent) || /Android/i.test(navigator.userAgent);
/** Framed mode keeps its own history, since a cross-origin iframe's history is not reachable. */
const framedHistory = new Map<string, { list: string[]; i: number }>();
export const [browserInfo, setBrowserInfo] = createStore<Record<string, BrowserInfo>>({});

/** False before macOS 14, whose web view can't keep Browser Profiles apart: every window then
 *  opens in the default profile, and the profile controls are hidden. */
export const [profilesSupported, setProfilesSupported] = createSignal(true);
invoke<boolean>("browser_profiles_supported").then(setProfilesSupported).catch((e) => console.warn("browser_profiles_supported failed:", e));

/** macOS: a sign-in the page's profile could save, by page id. The password stays native (passwords.rs). */
export type PasswordPrompt = { origin: string; user: string; update: boolean };
export const [passwordPrompts, setPasswordPrompts] = createStore<Record<string, PasswordPrompt>>({});

type Box = { x: number; y: number; width: number; height: number };

/** Pages whose native webview exists. */
const created = new Set<string>();
/** The Browser Profile each created page's webview was made in. A webview can't change profile,
 *  so a window that switches gets new ones. */
const madeIn = new Map<string, string>();
/** How many times a page's webview was remade; part of its label, so a closing webview's late
 *  events and the new webview's never mix. */
const gens = new Map<string, number>();
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
/** Where the open HTML overlays (menus, popovers, dialogs) are; webviews they overlap hide. */
let overlays: Box[] = [];
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const covered = (b: Box) => b.x < coveredTo || overlays.some((o) => overlaps(o, b));

const label = (pageId: string) => (gens.get(pageId) ? `browser-${pageId}~${gens.get(pageId)}` : `browser-${pageId}`);
const pageIdOf = (lbl: string) => lbl.replace(/^browser-/, "").replace(/~\d+$/, "");
/** An event from the page's current webview, not one it replaced. */
const current = (lbl: string) => lbl.startsWith("browser-") && created.has(pageIdOf(lbl)) && label(pageIdOf(lbl)) === lbl;
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

/** Each page's native calls, in order. Commands run concurrently, so a bounds or hide sent while
 *  browser_open is still creating the webview would fail ("no browser") and never be retried,
 *  leaving it at a stale rect, on top of other windows, or hidden (a white window). */
const queues = new Map<string, Promise<unknown>>();

/** Fire-and-forget call on a page's webview, after its earlier ones; logs instead of raising.
 *  `args` may still be coming (an address waiting for its tunnel); later calls wait behind it. */
function send(pageId: string, cmd: string, args: Record<string, unknown> | Promise<Record<string, unknown>> = {}) {
  const lbl = label(pageId); // now: a remade page's close goes to the webview it replaces
  const run = async () => invoke(cmd, { label: lbl, ...(await args) }).catch((e) => console.warn(`${cmd} failed:`, e));
  queues.set(pageId, (queues.get(pageId) ?? Promise.resolve()).then(run));
}

/** The project and browser window a page belongs to. */
function ownerOf(pageId: string): { project: Project; tab: Tab; page: Page } | undefined {
  for (const project of app.projects) {
    for (const tab of project.tabs) {
      const page = tab.pages?.find((pg) => pg.id === pageId);
      if (page) return { project, tab, page };
    }
  }
}

/**
 * The address a page's webview loads for `url`: in a remote project, a `localhost` or `file:`
 * address goes through its tunnel (tunnels.ts). Never fails: a tunnel that can't open leaves the
 * page blank while the window shows why, and the page loads once it opens.
 */
function localOf(pageId: string, url: string, here?: boolean): Promise<string> {
  const o = ownerOf(pageId);
  if (!o) return Promise.resolve(url);
  return resolveUrl(o.project, pageId, url, here ?? !!o.page.here).catch(() => "about:blank");
}

/** The address to show and keep for one a page's webview reports. */
function shownUrl(pageId: string, url: string): string {
  const o = ownerOf(pageId);
  return o && !o.page.here ? remoteUrl(o.project.host, pageId, url) : url;
}

// A tunnel opened again (after a drop or a failure): its pages load their addresses through it.
onReopened((f) => {
  for (const id of f.pages) {
    const o = ownerOf(id);
    const t = o && targetOf(o.page.url, o.project.path);
    if (!o || !t || !f.local) continue;
    const url = toLocal(o.page.url, t.target, f.local);
    if (!nativeBrowsers) patchInfo(id, { src: url, rev: (browserInfo[id]?.rev ?? 0) + 1 });
    else if (created.has(id)) send(id, "browser_navigate", { url });
  }
});

/** The page a browser webview's event came from, its window, and whether it is on screen now. */
export function pageOfLabel(lbl: string): { pageId: string; tab: Tab; shown: boolean } | undefined {
  if (!lbl.startsWith("browser-")) return;
  const pageId = pageIdOf(lbl);
  const o = ownerOf(pageId);
  return o && { pageId, tab: o.tab, shown: shown.has(pageId) };
}

/** Download a URL again from inside a page, which stays where it is. */
export function redownload(pageId: string, url: string): void {
  invoke("browser_download", { label: label(pageId), url }).catch((e) => flash(`can't download again: ${e}`));
}

function patchInfo(pageId: string, patch: Partial<BrowserInfo>) {
  setBrowserInfo(pageId, (prev) => ({ ...{ url: "", title: "New tab", loading: false }, ...prev, ...patch }));
}

function hide(pageId: string) {
  if (!shown.delete(pageId)) return;
  send(pageId, "browser_hide");
}

function show(pageId: string) {
  if (shown.has(pageId)) return;
  shown.add(pageId);
  send(pageId, "browser_show");
}

function syncBounds(pageId: string, b: Box) {
  const k = key(b);
  if (lastSent.get(pageId) === k) return;
  lastSent.set(pageId, k);
  send(pageId, "browser_bounds", b);
}

/** Put a shown page's webview at `b`; native webviews draw above all HTML, so a covered one hides. */
function apply(pageId: string, b: Box) {
  if (covered(b)) return hide(pageId);
  syncBounds(pageId, b);
  show(pageId);
}

// Native events: keep the page URL and title in sync with the webview.
listen<{ label: string; url: string; loading: boolean }>("browser-nav", (e) => {
  const { label: lbl, loading } = e.payload;
  if (!current(lbl)) return;
  const id = pageIdOf(lbl);
  // A page waiting for its tunnel sits on about:blank; it keeps showing the address it waits for.
  if (e.payload.url === "about:blank" && pageFwd[id]) return patchInfo(id, { loading });
  const url = shownUrl(id, e.payload.url);
  patchInfo(id, { url, loading });
  const o = ownerOf(id);
  if (o && !loading && url !== "about:blank" && o.page.url !== url) setPageUrl(o.project.id, o.tab.id, id, url);
}).catch((e) => console.warn("listen browser-nav failed:", e));

listen<{ label: string; title: string }>("browser-title", (e) => {
  const { label: lbl, title } = e.payload;
  if (current(lbl)) patchInfo(pageIdOf(lbl), { title });
}).catch((e) => console.warn("listen browser-title failed:", e));

listen<{ label: string; origin: string; user: string; update: boolean }>("browser-password", (e) => {
  const { label: lbl, origin, user, update } = e.payload;
  if (current(lbl)) setPasswordPrompts(pageIdOf(lbl), { origin, user, update });
}).catch((e) => console.warn("listen browser-password failed:", e));

function clearPrompt(pageId: string) {
  if (passwordPrompts[pageId]) setPasswordPrompts(produce((s) => { delete s[pageId]; }));
}

/** Save (or update) the sign-in a page's prompt asks about, or let it go. */
export function answerPassword(pageId: string, save: boolean): void {
  const p = passwordPrompts[pageId];
  clearPrompt(pageId);
  if (!p || !created.has(pageId)) return;
  invoke("browser_password_answer", { label: label(pageId), save })
    .then(() => save && flash(`${p.update ? "updated" : "saved"} the password for ${p.user || hostOf(p.origin)}`))
    .catch((e) => flash(`${e}`));
}

// A page asked for a new one (target=_blank, window.open, Ctrl+click): add a page after it in its window.
listen<{ label: string; url: string; background: boolean }>("browser-open", (e) => {
  const { label: lbl, url, background } = e.payload;
  const o = ownerOf(pageIdOf(lbl));
  if (!o) return;
  touch(o.tab.id);
  // A link out of a tunnelled page is reported as its local address: keep the remote one.
  const id = addPage(o.project.id, o.tab.id, o.page.here ? url : remoteUrl(o.project.host, undefined, url), { opener: o.page.id, show: !background });
  if (o.page.here) setPageUrl(o.project.id, o.tab.id, id, url, true);
  if (background) flash(`opened ${hostOf(url)} in a background tab`);
}).catch((e) => console.warn("listen browser-open failed:", e));

// Select element finished in a page: type its description into the agent window chosen in the
// composer (`to`), or start a new claude or pi (`new`) and type it there once it is ready.
// Never submitted: the user edits it in the agent and sends it from there.
listen<{ label: string; text: string; to: string; new: string }>("browser-pick", (e) => {
  const { label: lbl, text, to, new: start } = e.payload;
  const o = ownerOf(pageIdOf(lbl));
  if (!o || !text) return;
  if (start) return void typeIntoNew(o.project, start, text);
  const chosen = agentWindows(o.project).find((t) => t.id === to);
  const target = chosen ?? agentTarget(o.project, space(o.project).focus);
  if (!target) return flash("no agent in this project · start one from Select element or the + menu");
  rememberAgent(o.project.id, target.id);
  deliver(o.project, target, text, to && !chosen ? " (the one chosen had closed)" : "");
}).catch((e) => console.warn("listen browser-pick failed:", e));

/** Type a selection into an agent window, unsent, and show that window to edit it there. */
function deliver(project: Project, target: Tab, text: string, note = "") {
  if (!pasteText(target.id, text)) return flash(`${tabName(target)} isn't running · open it and try again`);
  focusTab(project.id, target.id);
  flash(`typed the selection into ${tabName(target)} · edit it there and press Enter to send${note}`);
}

/** How long a new agent gets to answer the signal probe before the selection is typed anyway. */
const START_TIMEOUT = 20_000;

/** Start agent `agentId` (claude or pi) in the project, wait until it reads input, then deliver. */
async function typeIntoNew(project: Project, agentId: string, text: string) {
  const agent = newAgentsFor(project).find((a) => a.id === agentId);
  if (!agent) return flash(`${agentId} isn't offered in this project`);
  const id = addTab(project.id, "term", { agent });
  rememberAgent(project.id, id);
  flash(`starting ${agent.name} for the selection…`);
  const started = Date.now();
  while (!live[id]?.ready && !live[id]?.agent && Date.now() - started < START_TIMEOUT) await sleep(100);
  // The probe comes as the agent starts; give its input box a moment to appear.
  await sleep(600);
  const tab = projectById(project.id)?.tabs.find((t) => t.id === id);
  if (!tab) return flash(`${agent.name} closed before the selection was typed`);
  deliver(project, tab, text, live[id]?.ready || live[id]?.agent ? "" : ` (${agent.name} was slow to start)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The agents Select element offers to start: claude and pi, when the project offers them and,
 *  locally, they are installed. */
function newAgentsFor(project: Project): Agent[] {
  const s = setupStatus();
  return offeredIn(project).filter((a) => (a.id === "claude" || a.id === "pi") && !isWebApp(a)
    && (isRemote(project) || !s || s[a.id].present));
}

/** What the composer's target menu shows: the project's agent windows, as the phone names them. */
function pickTargets(project: Project) {
  const seen: Record<string, number> = {};
  return agentWindows(project).map((t) => {
    const name = tabName(t);
    seen[name] = (seen[name] ?? 0) + 1;
    const l = live[t.id];
    return {
      id: t.id,
      name: seen[name] > 1 ? `${name} · ${seen[name]}` : name,
      icon: iconSvg(tabIcon(t)),
      sig: sigOf(t) ?? "",
      msg: l?.agent?.msg || l?.title || "",
      ws: t.space + 1,
    };
  });
}

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

const SEARCH = "https://www.google.com/search?q=";

/** What the address field goes to: an address as typed (scheme added), anything else a web search. */
export function addressToUrl(s: string): string {
  const t = s.trim();
  if (!t) return "";
  const isAddress = !/\s/.test(t) && (looksLikeUrl(t) || /^(about|file|data):/i.test(t) || /^[\w-]+:\d+(\/|$)/.test(t));
  return isAddress ? normalizeUrl(t) : SEARCH + encodeURIComponent(t);
}

/** Framed mode: give a page its info and history the first time it is seen. */
function initFramed(page: Page) {
  if (browserInfo[page.id]) return;
  const url = page.url;
  setBrowserInfo(page.id, { url, title: framedTitle(url), loading: false, rev: 0 });
  if (url) framedHistory.set(page.id, { list: [url], i: 0 });
  if (url) frameSrc(page.id, url);
}

/** Framed mode: load `url` through its tunnel in a remote project. */
function frameSrc(pageId: string, url: string, here?: boolean) {
  void localOf(pageId, url, here).then((src) => patchInfo(pageId, { src: src === url ? undefined : src }));
}

/** A profile's switches as browser_open and browser_autofill take them. */
const autofillOf = (prof: Profile) => ({ autofill: prof.autofill !== false, passwords: prof.passwords !== false });

/** Create a page's webview at `b` in `prof`, hidden: apply shows the window's shown page. */
function create(page: Page, b: Box, prof: Profile) {
  created.add(page.id);
  madeIn.set(page.id, prof.id);
  setBrowserInfo(page.id, { url: page.url, title: page.url ? hostOf(page.url) : "New tab", loading: !!page.url });
  const args = { ...b, hidden: true, profile: prof.id, ...autofillOf(prof) };
  send(page.id, "browser_open", localOf(page.id, page.url).then((url) => ({ url, ...args })));
  lastSent.set(page.id, key(b));
}

/** Close a page's webview so the next placeBrowser makes it again (in another profile). Its
 *  calls stay queued, so the new webview opens after the old one is closed. */
function drop(pageId: string) {
  if (!created.has(pageId)) return;
  send(pageId, "browser_close");
  clearPrompt(pageId);
  gens.set(pageId, (gens.get(pageId) ?? 0) + 1);
  created.delete(pageId);
  shown.delete(pageId);
  lastSent.delete(pageId);
  madeIn.delete(pageId);
}

/** A profile's autofill switches changed: apply them to its open webviews. */
export function applyProfileAutofill(prof: Profile): void {
  for (const [id, p] of madeIn) if (p === prof.id) send(id, "browser_autofill", autofillOf(prof));
}

/** Run `change` (deleting the profile), then close every webview still made in it; resolves once
 *  they are all closed, so its data can be erased. Windows on screen remake theirs during `change`. */
export async function leaveProfile(profileId: string, change: () => void): Promise<void> {
  const ids = [...madeIn].filter(([, p]) => p === profileId).map(([id]) => id);
  change();
  for (const id of ids) if (madeIn.get(id) === profileId) drop(id);
  await Promise.all(ids.map((id) => queues.get(id)));
}

/**
 * Called by the canvas with the placeholder's rect for the window's shown page, or null when
 * it is not visible (or blank). Pages in the background stay hidden, but load at the same rect
 * so switching to one is instant.
 */
export function placeBrowser(project: Project, tab: Tab, rect: DOMRect | null): void {
  const active = activePage(tab);
  if (!active) return;
  if (!nativeBrowsers) {
    if (!browserInfo[active.id]) touch(tab.id);
    for (const page of tab.pages ?? []) initFramed(page);
    return;
  }
  // A zero-sized rect is a window hidden by the layout (display:none): hide, or the webview stays on top.
  const b = rect && rect.width >= 2 && rect.height >= 2 ? box(rect) : null;
  // The window switched profile: every page reloads in the new one.
  const prof = (profilesSupported() ? undefined : profileById(DEFAULT_PROFILE)) ?? tabProfile(project, tab);
  if (b) for (const page of tab.pages ?? []) if (created.has(page.id) && madeIn.get(page.id) !== prof.id) drop(page.id);
  for (const page of tab.pages ?? []) {
    if (page.id === active.id) continue;
    latest.set(page.id, null);
    hide(page.id);
    if (b && page.url && !created.has(page.id)) create(page, b, prof);
  }
  const id = active.id;
  latest.set(id, b);
  if (!b) return hide(id);

  if (!created.has(id)) {
    touch(tab.id);
    create(active, b, prof);
  }
  if (suspended) return; // remembered; applied when resumed
  apply(id, b);
}

/** Record a page's address in the project. */
function remember(pageId: string, url: string, here?: boolean) {
  const o = ownerOf(pageId);
  if (o) setPageUrl(o.project.id, o.tab.id, pageId, url, here);
}

/** Framed mode: show `url` and record it in the project. */
function frame(pageId: string, url: string, here?: boolean) {
  patchInfo(pageId, { url, title: framedTitle(url), loading: false });
  remember(pageId, url, here);
  frameSrc(pageId, url, here);
}

/** Go to `url`. In a remote project `here` says whether `localhost` is this machine (Alt+Enter) or
 *  the remote (Enter); left out, the page keeps what it had. */
export function navigateBrowser(pageId: string, url: string, here?: boolean): void {
  const o = ownerOf(pageId);
  if (o) touch(o.tab.id);
  if (!nativeBrowsers) {
    const h = framedHistory.get(pageId) ?? { list: [], i: -1 };
    h.list = h.list.slice(0, h.i + 1).concat(url);
    h.i = h.list.length - 1;
    framedHistory.set(pageId, h);
    return frame(pageId, url, here);
  }
  if (!created.has(pageId)) {
    // Together: the canvas creates the webview as soon as the page stops being blank, from page.url.
    batch(() => {
      remember(pageId, url, here);
      patchInfo(pageId, { url, title: browserInfo[pageId]?.title ?? "New tab", loading: !!url });
    });
    return;
  }
  // Kept now rather than when the webview reports it: a page waiting for its tunnel loads this once it opens.
  batch(() => {
    remember(pageId, url, here);
    patchInfo(pageId, { url, loading: true });
  });
  send(pageId, "browser_navigate", localOf(pageId, url, here).then((u) => ({ url: u })));
}

/** Start Select element in a page. Its composer lists the project's agent windows, the one "send to
 *  agent" would use chosen, and offers to start a new claude or pi. */
export function pickElement(project: Project, pageId: string): void {
  if (!created.has(pageId)) return;
  const target = agentTarget(project, space(project).focus);
  const css = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(["working", "blocked", "done", "error"].map((s) => [s, css.getPropertyValue(`--state-${s}`).trim()]));
  // The keycap's colours (Keys.tsx), so the composer's keys look like the app's, in its theme and Keys setting.
  const keys = Object.fromEntries(["key", "key-edge", "key-base", "key-ink"].map((k) => [k, css.getPropertyValue(`--${k}`).trim()]));
  const opts = {
    accent: project.accent,
    agents: pickTargets(project),
    target: target?.id ?? "",
    new: newAgentsFor(project).map((a) => ({ id: a.id, name: a.name, icon: iconSvg(a.icon) })),
    colors,
    keys,
  };
  send(pageId, "browser_pick", { opts });
  flash("select element · Esc to stop");
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
  if (created.has(pageId)) send(pageId, "browser_back");
}

export function browserForward(pageId: string): void {
  if (!nativeBrowsers) return framedGo(pageId, 1);
  if (created.has(pageId)) send(pageId, "browser_forward");
}

export function browserReload(pageId: string): void {
  if (!nativeBrowsers) return patchInfo(pageId, { rev: (browserInfo[pageId]?.rev ?? 0) + 1 });
  if (created.has(pageId)) send(pageId, "browser_reload");
}

/** Close one page's webview. */
export function closePage(pageId: string): void {
  if (created.has(pageId)) send(pageId, "browser_close");
  queues.delete(pageId); // the close stays queued behind the page's earlier calls
  created.delete(pageId);
  shown.delete(pageId);
  latest.delete(pageId);
  lastSent.delete(pageId);
  madeIn.delete(pageId);
  gens.delete(pageId);
  framedHistory.delete(pageId);
  releasePage(pageId);
  clearPrompt(pageId);
  setBrowserInfo(produce((s) => { delete s[pageId]; }));
}

/** Close every page of a browser window. */
export function closeBrowser(tab: Tab): void {
  for (const page of tab.pages ?? []) closePage(page.id);
  lastUsed.delete(tab.id);
}

/** Re-place the shown webviews against the current overlays. */
function reapply() {
  if (suspended) return;
  for (const [id, b] of latest) {
    if (b && created.has(id)) apply(id, b);
  }
}

/** Hide every native webview (dragging a window, the tour); restore the placed ones afterwards. */
export function setBrowsersSuspended(on: boolean): void {
  suspended = on;
  if (on) for (const id of [...shown]) hide(id);
  else reapply();
}

/** Hide only the webviews under the sidebar's peek (0 when it folds back), so the rest stay live. */
export function setBrowsersCovered(right: number): void {
  coveredTo = right;
  reapply();
}

/** The roots of the HTML overlays setBrowsersOverlaid measures. */
const OVERLAYS = ".tabmenu, .pop, .iconpick, .gtf, .dialog-scrim, .profmenu, .dlmenu";
let overlayRo: ResizeObserver | undefined;
let overlayRaf = 0;

/**
 * An HTML overlay opened or closed. Native webviews draw above HTML, so only the ones an overlay
 * overlaps hide; the rest stay live instead of going white. Some overlays place themselves a
 * frame after mounting, so they are measured again then, and whenever they resize.
 */
export function setBrowsersOverlaid(on: boolean): void {
  cancelAnimationFrame(overlayRaf);
  overlayRo?.disconnect();
  overlayRo = undefined;
  const measure = () => {
    const els = on ? [...document.querySelectorAll<HTMLElement>(OVERLAYS)] : [];
    // Open but not rendered yet: keep every page out of its way until it can be measured.
    overlays = on && !els.length ? [{ x: -1e6, y: -1e6, width: 2e6, height: 2e6 }] : els.map((el) => box(el.getBoundingClientRect()));
    reapply();
    return els;
  };
  measure();
  if (!on) return;
  overlayRaf = requestAnimationFrame(() => {
    overlayRaf = requestAnimationFrame(() => {
      // An overlay that grows (the palette's results) may come to cover another webview.
      overlayRo = new ResizeObserver(() => measure());
      for (const el of measure()) overlayRo.observe(el);
    });
  });
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

/** Open a project's address in the system browser: a remote project's `localhost` through its
 *  tunnel, which then stays open while the app runs (the system browser never says it is done). */
export function openExternalIn(project: Project, url: string, here = false): void {
  if (here || !isRemote(project) || !targetOf(url, project.path)) return openExternal(url);
  resolveUrl(project, `ext:${project.host}:${url}`, url)
    .then((local) => {
      openUrl(local).catch((e) => console.warn("openUrl failed:", e));
      flash(`opened ${url} on ${project.host} in the system browser, as ${local}`);
    })
    .catch((e) => flash(`can't reach ${url} on ${project.host}: ${String(e).replace(/^Error: /, "")}`));
}
