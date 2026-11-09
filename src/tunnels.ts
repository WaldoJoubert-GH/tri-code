// Remote browser tunnels: in a remote project, a browser window's `localhost:5173` is the remote's,
// and a `file:///…` its file. Each such address opens a Forward (forward.rs): an ssh tunnel to the
// port, or a static server on the remote for the folder plus a tunnel to it. One Forward per host
// and target, shared by every page that uses it, on the same local port when that is free so the
// origin (cookies, HMR, OAuth redirects) stays `localhost:5173`. A dropped one reopens on its old
// port; one no page uses closes after a grace period. See tunnelmap.ts for the address mapping.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";
import { type Project, isRemote } from "./state";
import { type Target, targetOf, toLocal, toRemote } from "./tunnelmap";

export type FwdState = "opening" | "open" | "reconnecting" | "failed";

export type Fwd = {
  key: string;
  host: string;
  target: Target;
  state: FwdState;
  /** The local port, once open (kept while reconnecting, to reopen on it). */
  local?: number;
  id?: number;
  error?: string;
  /** Page ids using it (and "ext" for addresses handed to the system browser). */
  pages: string[];
};

/** Every Forward, by `${host}|${target key}`. */
export const [fwds, setFwds] = createStore<Record<string, Fwd>>({});
/** The Forward each page uses, by page id. */
export const [pageFwd, setPageFwd] = createStore<Record<string, string>>({});

const inflight = new Map<string, Promise<Fwd>>();
const releases = new Map<string, ReturnType<typeof setTimeout>>();
const retries = new Map<string, ReturnType<typeof setTimeout>>();
/** How long a Forward no page uses stays open, so a reload or a quick navigation away and back reuses it. */
const GRACE = 30_000;
const RETRY = 5_000;

type Reopened = (fwd: Fwd) => void;
const reopenedHandlers: Reopened[] = [];
/** Run `fn` when a Forward opens again after a drop or a failure, so its pages can load again. */
export function onReopened(fn: Reopened): void {
  reopenedHandlers.push(fn);
}

/** Point a page at a Forward (or none), releasing the one it used before. */
function use(pageId: string, key: string | undefined) {
  const old = pageFwd[pageId];
  if (old === key) return;
  if (key) setPageFwd(pageId, key);
  else setPageFwd(produce((s) => { delete s[pageId]; }));
  if (old && fwds[old]) {
    setFwds(old, "pages", (ps) => ps.filter((p) => p !== pageId));
    if (!fwds[old].pages.length) scheduleRelease(old);
  }
  if (key && fwds[key] && !fwds[key].pages.includes(pageId)) {
    setFwds(key, "pages", (ps) => [...ps, pageId]);
    clearTimeout(releases.get(key));
    releases.delete(key);
  }
}

function scheduleRelease(key: string) {
  clearTimeout(releases.get(key));
  releases.set(key, setTimeout(() => {
    releases.delete(key);
    const f = fwds[key];
    if (!f || f.pages.length) return;
    clearTimeout(retries.get(key));
    retries.delete(key);
    if (f.id != null) invoke("forward_close", { id: f.id }).catch((e) => console.warn("forward_close failed:", e));
    setFwds(produce((s) => { delete s[key]; }));
  }, GRACE));
}

/** Open a Forward, on its old local port when it had one; `again` (a retry or a reconnect) reloads its pages once open. */
function open(key: string, again = false): Promise<Fwd> {
  const running = inflight.get(key);
  if (running) return running;
  const f = fwds[key];
  // Pages that were left blank by a failure, or by a drop, load again once it opens.
  const reload = again || f.state === "failed" || f.local != null;
  setFwds(key, { state: f.local ? "reconnecting" : "opening", error: undefined });
  const { host, target } = f;
  const prefer = f.local;
  const call = target.kind === "port"
    ? invoke<{ id: number; port: number }>("forward_port", { host, port: target.port, prefer: prefer ?? null })
    : invoke<{ id: number; port: number }>("forward_dir", { host, dir: target.dir, prefer: prefer ?? null });
  const p = call
    .then((r) => {
      if (!fwds[key]) {
        // Released while opening.
        invoke("forward_close", { id: r.id }).catch(() => {});
        throw new Error("closed");
      }
      setFwds(key, { state: "open", id: r.id, local: r.port, error: undefined });
      if (reload) for (const fn of reopenedHandlers) fn(fwds[key]);
      return fwds[key];
    })
    .catch((e) => {
      if (fwds[key]) {
        setFwds(key, { state: "failed", error: String(e).replace(/^Error: /, "") });
        scheduleRetry(key);
      }
      throw e;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** A failed Forward tries again while a page still wants it (the dev server may start any moment). */
function scheduleRetry(key: string) {
  clearTimeout(retries.get(key));
  retries.set(key, setTimeout(() => {
    retries.delete(key);
    const f = fwds[key];
    if (f?.state === "failed" && f.pages.length) open(key, true).catch(() => {});
  }, RETRY));
}

/** Try a failed or dropped Forward again now. */
export function reconnect(key: string): void {
  const f = fwds[key];
  if (!f) return;
  clearTimeout(retries.get(key));
  if (f.id != null && f.state === "open") {
    invoke("forward_close", { id: f.id }).catch(() => {});
    setFwds(key, "id", undefined);
  }
  open(key, true).catch(() => {});
}

/**
 * The address a page's webview loads for `url`: in a remote project, a loopback or `file:` address
 * goes through its Forward, opened first. `here` keeps it on this machine. Throws when the Forward
 * can't open; its state and error are then in `fwds`, and it retries by itself.
 */
export async function resolveUrl(project: Project, pageId: string, url: string, here = false): Promise<string> {
  const t = !here && url && isRemote(project) ? targetOf(url, project.path) : null;
  if (!t) {
    use(pageId, undefined);
    return url;
  }
  const key = `${project.host}|${t.key}`;
  if (!fwds[key]) setFwds(key, { key, host: project.host, target: t.target, state: "opening", pages: [] });
  use(pageId, key);
  const f = fwds[key];
  const ready = f.state === "open" && f.local ? f : await open(key);
  return toLocal(url, t.target, ready.local!);
}

/**
 * The remote address for one a page's webview reports, and point the page at the Forward it came
 * through; a page that left the tunnel (a link to another site) lets its Forward go.
 */
export function remoteUrl(host: string, pageId: string | undefined, localUrl: string): string {
  if (!localUrl || localUrl === "about:blank") return localUrl;
  for (const f of Object.values(fwds)) {
    if (f.host !== host || !f.local) continue;
    const r = toRemote(localUrl, f.target, f.local);
    if (r) {
      if (pageId) use(pageId, f.key);
      return r;
    }
  }
  if (pageId) use(pageId, undefined);
  return localUrl;
}

/** The page closed: let its Forward go. */
export function releasePage(pageId: string): void {
  use(pageId, undefined);
}

/** The Forward a page uses, if any. */
export const fwdOfPage = (pageId: string): Fwd | undefined => {
  const k = pageFwd[pageId];
  return k ? fwds[k] : undefined;
};

/** What the page shows instead of its webview: the Forward is opening for the first time or failed. */
export const heldBy = (pageId: string): Fwd | undefined => {
  const f = fwdOfPage(pageId);
  return f && (f.state === "opening" || f.state === "failed") ? f : undefined;
};

/** How a Forward's remote end reads: `localhost:5173`, or the folder it serves. */
export const remoteLabel = (f: Fwd) => (f.target.kind === "port" ? `localhost:${f.target.port}` : f.target.dir);

// ssh died (sleep, network change): reopen it on its old port while pages use it.
listen<{ id: number }>("forward-closed", (e) => {
  const f = Object.values(fwds).find((x) => x.id === e.payload.id);
  if (!f) return;
  setFwds(f.key, "id", undefined);
  if (f.pages.length) open(f.key, true).catch(() => {});
  else setFwds(produce((s) => { delete s[f.key]; }));
}).catch((e) => console.warn("listen forward-closed failed:", e));
