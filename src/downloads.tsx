// Downloads in browser windows (downloads.rs saves them to the Downloads folder). A button in the
// nav row shows progress and opens the window's list; a strip under the nav shows the newest one.
// Both are part of the window, not floating, since the native webview paints over HTML.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { pageOfLabel, redownload } from "./browsers";
import { Icon } from "./lucide";
import { flash } from "./ui";

export type Download = {
  id: number;
  pageId: string;
  url: string;
  name: string;
  state: "running" | "done" | "failed" | "cancelled";
  received: number;
  /** 0 when unknown */
  total: number;
  cancellable: boolean;
  /** bytes per second, smoothed; 0 until known */
  rate: number;
  /** when it last changed */
  at: number;
};

/** Each browser window's downloads of this run, newest first, by tab id. */
const [downloads, setDownloads] = createStore<Record<string, Download[]>>({});
/** Windows with a download that ended since their list was last opened. */
const [unseen, setUnseen] = createStore<Record<string, "done" | "failed" | undefined>>({});
/** The download whose strip each window closed. */
const [dismissed, setDismissed] = createStore<Record<string, number>>({});

/** Most downloads a window lists. */
const KEEP = 20;
/** A finished download's strip folds away after this, unless the pointer is on it. */
const FOLD_MS = 6000;

type Event = Omit<Download, "pageId" | "rate" | "at"> & { label: string };

listen<Event>("browser-download", (e) => {
  const { label, ...d } = e.payload;
  const owner = pageOfLabel(label);
  if (!owner) return;
  const tabId = owner.tab.id;
  const now = Date.now();
  setDownloads(
    produce((all) => {
      const list = (all[tabId] ??= []);
      const prev = list.find((x) => x.id === d.id);
      if (!prev) {
        list.unshift({ ...d, pageId: owner.pageId, rate: 0, at: now });
        if (list.length > KEEP) list.length = KEEP;
        return;
      }
      const secs = (now - prev.at) / 1000;
      const rate = d.state === "running" && secs > 0 ? (d.received - prev.received) / secs : 0;
      Object.assign(prev, d, { rate: prev.rate ? prev.rate * 0.7 + rate * 0.3 : rate, at: now });
    }),
  );
  if (d.state === "done" || d.state === "failed") {
    setUnseen(tabId, (u) => (u === "failed" || d.state === "failed" ? "failed" : "done"));
    if (!owner.shown) flash(d.state === "done" ? `downloaded ${d.name}` : `download failed: ${d.name}`);
  }
}).catch((e) => console.warn("listen browser-download failed:", e));

/** A closed browser window's downloads go with it. */
export function forgetDownloads(tabId: string): void {
  setDownloads(produce((all) => void delete all[tabId]));
  setUnseen(tabId, undefined);
}

const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

const left = (d: Download) => {
  if (!d.total || !d.rate) return "";
  const s = Math.ceil((d.total - d.received) / d.rate);
  return s < 60 ? ` · ${s} s left` : ` · ${Math.ceil(s / 60)} min left`;
};

/** "ZIP", "PDF", "TGZ": the file's type, short. */
const kind = (name: string) => {
  const m = name.toLowerCase().match(/\.(tar\.gz|tgz|[a-z0-9]{1,5})$/);
  return m ? (m[1] === "tar.gz" ? "TGZ" : m[1].slice(0, 4).toUpperCase()) : "FILE";
};

const progress = (d: Download) =>
  d.total ? `${size(d.received)} of ${size(d.total)}${d.rate ? ` · ${size(d.rate)}/s` : ""}${left(d)}` : d.received ? size(d.received) : "Downloading…";

const fail = (what: string) => (e: unknown) => flash(`can't ${what}: ${e}`);
const openFile = (d: Download) => invoke("download_open", { id: d.id }).catch(fail("open it"));
const reveal = (d: Download) => invoke("download_reveal", { id: d.id }).catch(fail("show it"));
const cancel = (d: Download) => invoke("download_cancel", { id: d.id }).catch(fail("cancel"));
const again = (d: Download) => redownload(d.pageId, d.url);

// ---- the nav button ----

const RING = 2 * Math.PI * 9;

export function DownloadButton(props: { tabId: string }) {
  const list = () => downloads[props.tabId] ?? [];
  const running = () => list().filter((d) => d.state === "running");
  /** 0..1 over the running downloads that report a size; undefined when none do. */
  const share = () => {
    const sized = running().filter((d) => d.total);
    if (!sized.length) return undefined;
    return sized.reduce((a, d) => a + d.received, 0) / sized.reduce((a, d) => a + d.total, 0);
  };
  const title = () => {
    const r = running().length;
    return r ? `Downloading ${r === 1 ? running()[0].name : `${r} files`}` : "Downloads";
  };
  return (
    <Show when={list().length}>
      <button
        class="dlbtn"
        classList={{ running: running().length > 0, spin: running().length > 0 && share() === undefined }}
        aria-haspopup="menu"
        title={title()}
        onClick={(e) => toggleDownloadMenu(props.tabId, e.currentTarget)}
      >
        <Show when={running().length}>
          <svg class="ring" viewBox="0 0 22 22" aria-hidden="true">
            <circle class="track" cx="11" cy="11" r="9" />
            <circle class="val" cx="11" cy="11" r="9" stroke-dasharray={String(RING)} stroke-dashoffset={String(RING * (1 - (share() ?? 0.25)))} />
          </svg>
        </Show>
        <Icon name="download" size={13} />
        <Show when={!running().length && unseen[props.tabId]}>
          <span class="dot" classList={{ bad: unseen[props.tabId] === "failed" }} />
        </Show>
      </button>
    </Show>
  );
}

// ---- the strip under the nav ----

export function DownloadBar(props: { tabId: string }) {
  const newest = () => {
    const d = downloads[props.tabId]?.[0];
    return d && dismissed[props.tabId] !== d.id ? d : undefined;
  };
  const [hover, setHover] = createSignal(false);
  // A finished download folds away after a while; hovering holds it.
  createEffect(() => {
    const d = newest();
    if (!d || d.state !== "done" || hover()) return;
    const t = window.setTimeout(() => setDismissed(props.tabId, d.id), FOLD_MS);
    onCleanup(() => clearTimeout(t));
  });
  return (
    <Show when={newest()}>
      {(d) => (
        <div
          class={`dlbar ${d().state}`}
          classList={{ folding: d().state === "done" && !hover() }}
          role="status"
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
        >
          <span class="ficon">{kind(d().name)}</span>
          <span class="info">
            <span class="name" title={d().name}>{d().name}</span>
            <span class="sub">
              {d().state === "running" ? progress(d())
                : d().state === "done" ? <><span class="ok">Saved</span> to Downloads · {size(d().received)}</>
                : d().state === "failed" ? <><span class="bad">Failed</span>{d().received ? ` after ${size(d().received)}` : ""}</>
                : "Cancelled"}
            </span>
          </span>
          <span class="acts">
            <Show when={d().state === "running" && d().cancellable}>
              <button onClick={() => cancel(d())}>Cancel</button>
            </Show>
            <Show when={d().state === "done"}>
              <button class="primary" onClick={() => openFile(d())}>Open</button>
              <button onClick={() => reveal(d())}>Show in folder</button>
            </Show>
            <Show when={d().state === "failed" || d().state === "cancelled"}>
              <button class={d().state === "failed" ? "primary" : ""} onClick={() => again(d())}>
                {d().state === "failed" ? "Try again" : "Download again"}
              </button>
            </Show>
          </span>
          <Show when={d().state !== "running"}>
            <button class="x" title="Close" onClick={() => setDismissed(props.tabId, d().id)}>×</button>
          </Show>
          <Show when={d().state === "running"}>
            <span class="prog" classList={{ spin: !d().total }} style={{ width: d().total ? `${(d().received / d().total) * 100}%` : undefined }} />
          </Show>
          <Show when={d().state === "done" && !hover()}>
            <span class="fold" style={{ "animation-duration": `${FOLD_MS}ms` }} />
          </Show>
        </div>
      )}
    </Show>
  );
}

// ---- the list under the button ----

type Menu = { tabId: string; anchor: HTMLElement };
const [menu, setMenu] = createSignal<Menu | null>(null);

/** The menu is HTML, so native browser webviews under it hide while it is open (see App). */
export const downloadMenuOpen = () => menu() !== null;
export const closeDownloadMenu = () => setMenu(null);

export function toggleDownloadMenu(tabId: string, anchor: HTMLElement) {
  setUnseen(tabId, undefined);
  setMenu((m) => (m?.anchor === anchor ? null : { tabId, anchor }));
}

function place(el: HTMLElement, a: HTMLElement) {
  const r = a.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth)) + "px";
  el.style.top = Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 4) + "px";
}

/** "just now", "4 min ago", "2 h ago" */
const ago = (at: number) => {
  const m = Math.floor((Date.now() - at) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
};

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function DownloadMenu() {
  const onDown = (e: PointerEvent) => {
    const m = menu();
    if (m && !(e.target as Element).closest(".dlmenu") && !m.anchor.contains(e.target as Node)) closeDownloadMenu();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  const clear = (tabId: string) => setDownloads(tabId, (l) => (l ?? []).filter((d) => d.state === "running"));
  const folder = () => invoke("downloads_folder").catch(fail("open the Downloads folder"));

  return (
    <Show when={menu()} keyed>
      {(m) => (
        <div class="dlmenu" role="menu" aria-label="Downloads" ref={(el) => requestAnimationFrame(() => place(el, m.anchor))}>
          <header>
            <b>Downloads</b>
            <button onClick={() => clear(m.tabId)}>Clear list</button>
          </header>
          <div class="dlrows">
            <For each={downloads[m.tabId] ?? []} fallback={<div class="dlnone">No downloads in this window yet</div>}>
              {(d) => (
                <div class="dlrow" classList={{ gone: d.state === "cancelled" }}>
                  <span class="ficon">{kind(d.name)}</span>
                  <span class="info">
                    <span class="name" title={d.name}>{d.name}</span>
                    <span class="sub">
                      {d.state === "running" ? progress(d)
                        : d.state === "done" ? `${size(d.received)} · ${ago(d.at)}`
                        : d.state === "failed" ? <><span class="bad">Failed</span> · {ago(d.at)}</>
                        : `Cancelled · ${ago(d.at)}`}
                    </span>
                    <Show when={d.state === "running"}>
                      <span class="track"><i classList={{ spin: !d.total }} style={{ width: d.total ? `${(d.received / d.total) * 100}%` : undefined }} /></span>
                    </Show>
                  </span>
                  <span class="ra">
                    <Show when={d.state === "running" && d.cancellable}>
                      <button title="Cancel" onClick={() => cancel(d)}><Icon name="x" size={13} /></button>
                    </Show>
                    <Show when={d.state === "done"}>
                      <button title="Open" onClick={() => openFile(d)}><Icon name="external-link" size={13} /></button>
                      <button title="Show in folder" onClick={() => reveal(d)}><Icon name="folder-open" size={13} /></button>
                    </Show>
                    <Show when={d.state === "failed" || d.state === "cancelled"}>
                      <button title="Download again" onClick={() => again(d)}><Icon name="rotate-cw" size={13} /></button>
                    </Show>
                  </span>
                </div>
              )}
            </For>
          </div>
          <footer>
            <span>Saved to your Downloads folder</span>
            <button onClick={folder}>Open folder</button>
          </footer>
        </div>
      )}
    </Show>
  );
}
