import "./canvas.css";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  type Page, type Project, type Tab, activePage, addPage, app, focusTab, isTerminal, live, projectById, removePage,
  removeTab, restoreTab, sendTo, setRatio, showPage, space, swapTabs, tabName, toggleMono, visibleTabs,
} from "./state";
import { type Rect, neighbour, ratioAt, tile } from "./layout";
import { flash, showToast } from "./ui";
import {
  browserInfo, nativeBrowsers, closeBrowser, closePage, browserBack, browserForward, browserReload, navigateBrowser,
  normalizeUrl, openExternal, pickElement, placeBrowser, setBrowsersSuspended,
} from "./browsers";
import { Icon } from "./lucide";
import { closeSession, ensureSession, focusSession, mountSession, unmountSession } from "./terms";
import IssuesPanel from "./IssuesPanel";
import FileList from "./FileList";
import FileView from "./FileView";
import GitPanel from "./GitPanel";
import AgentsPanel from "./AgentsPanel";
import { gitOf } from "./git";
import { dev, panelTitle } from "./issues";
import { FavBar, StartPage, closeFavEdit, favEditFor, starPage } from "./favs";

const BAR = 28;
const NAV = 32;
const FAVS = 26;
const px = (n: number) => `${Math.round(n)}px`;

/** Last measured viewport size, for the keyboard helpers that run outside the component. */
let lastW = 0;
let lastH = 0;

/** Tiling of a project's active workspace at a given viewport size. */
function layoutOf(p: Project, w: number, h: number) {
  const tabs = visibleTabs(p);
  const sp = space(p);
  const mono = tabs.findIndex((t) => t.id === sp.mono);
  const focus = tabs.findIndex((t) => t.id === sp.focus);
  const t = tile(tabs.length, sp.layout, sp.ratio, w, h, app.gap, mono, focus);
  return { tabs, rects: t.rects, split: t.split, mono, focus };
}

type DragState = { id: string; dx: number; dy: number; dropId: string | null; ws: number | null };

export default function Canvas(props: { project: Project }) {
  let viewport!: HTMLDivElement;
  let splitEl!: HTMLDivElement;
  let ro: ResizeObserver | undefined;
  let settleRaf = 0;
  let sizeTimer: number | undefined;

  const [size, setSize] = createSignal({ w: 0, h: 0 });
  /** False for one frame after a resize, so the window snaps instead of animating. */
  const [settled, setSettled] = createSignal(true);
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [splitOn, setSplitOn] = createSignal(false);
  /** Tab whose size readout is showing. */
  const [sized, setSized] = createSignal<string | null>(null);

  const tiling = createMemo(() => layoutOf(props.project, size().w, size().h));
  const rectById = createMemo(() => {
    const t = tiling();
    const m = new Map<string, Rect>();
    t.tabs.forEach((tab, i) => m.set(tab.id, t.rects[i]));
    return m;
  });
  const anyDrag = createMemo(() => drag() !== null);
  const animOn = () => settled() && drag() === null && !splitOn();
  const splitRect = () => (tiling().mono >= 0 ? undefined : tiling().split);

  const local = (x: number, y: number) => {
    const r = viewport.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  };

  const showSizing = (id: string) => {
    setSized(id);
    clearTimeout(sizeTimer);
    sizeTimer = window.setTimeout(() => setSized(null), 700);
  };

  onMount(() => {
    ro = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect;
      lastW = w;
      lastH = h;
      setSize({ w, h });
      setSettled(false);
      cancelAnimationFrame(settleRaf);
      settleRaf = requestAnimationFrame(() => setSettled(true));
    });
    ro.observe(viewport);
  });
  onCleanup(() => {
    ro?.disconnect();
    cancelAnimationFrame(settleRaf);
    clearTimeout(sizeTimer);
  });

  const startSplit = (e: PointerEvent) => {
    e.preventDefault();
    splitEl.setPointerCapture(e.pointerId);
    setSplitOn(true);
    const pid = props.project.id;
    const move = (ev: PointerEvent) => {
      const q = local(ev.clientX, ev.clientY);
      setRatio(pid, ratioAt(q.x, size().w, app.gap));
      const first = tiling().tabs[0];
      if (first) showSizing(first.id);
    };
    const up = () => {
      splitEl.removeEventListener("pointermove", move);
      splitEl.removeEventListener("pointerup", up);
      splitEl.removeEventListener("pointercancel", up);
      setSplitOn(false);
    };
    splitEl.addEventListener("pointermove", move);
    splitEl.addEventListener("pointerup", up);
    splitEl.addEventListener("pointercancel", up);
  };

  /** One window. Keyed by the tab object, so it survives reordering. */
  const Win = (wp: { tab: Tab }) => {
    const tab = wp.tab;
    const id = tab.id;
    const isBrowser = tab.kind === "browser";
    const isIssues = tab.kind === "issues";
    const isFiles = tab.kind === "files";
    const isFile = tab.kind === "file";
    const isGit = tab.kind === "git";
    const isAgents = tab.kind === "agents";
    const isPanel = isIssues || isFiles || isFile || isGit || isAgents;

    let barEl!: HTMLDivElement;
    let termEl!: HTMLDivElement;
    let pageEl!: HTMLDivElement;
    let inputEl!: HTMLInputElement;
    let placeRaf = 0;
    let pageRo: ResizeObserver | undefined;

    const rect = () => rectById().get(id) ?? { x: 0, y: 0, w: 0, h: 0 };
    const focused = createMemo(() => space(props.project).focus === id);
    const mono = createMemo(() => space(props.project).mono === id);
    // Mono (carousel) gives every window a rect: the focused one centered, its neighbours
    // in the gutters, the rest zero-sized. Zero-sized windows are hidden; the neighbours dim.
    const hidden = createMemo(() => { const r = rect(); return r.w <= 0 || r.h <= 0; });
    const peek = createMemo(() => space(props.project).layout === "mono" && !focused() && !hidden());
    const dragging = createMemo(() => drag()?.id === id);
    const dropping = createMemo(() => drag()?.dropId === id);
    const z = () => (dragging() ? 7 : mono() ? 4 : focused() ? 3 : 2);
    const geom = () => {
      const r = rect();
      const d = drag();
      const dx = d?.id === id ? d.dx : 0;
      const dy = d?.id === id ? d.dy : 0;
      return { left: r.x + dx, top: r.y + dy };
    };
    const tipText = () => {
      const r = rect();
      if (isBrowser) {
        const favs = props.project.favs.length ? FAVS : 0;
        return <>{Math.round(r.w)} × {Math.max(0, Math.round(r.h - BAR - NAV - favs))} <span>px</span></>;
      }
      if (isPanel) {
        return <>{Math.round(r.w)} × {Math.max(0, Math.round(r.h - BAR))} <span>px</span></>;
      }
      const cols = Math.max(0, Math.floor((r.w - 22) / 7.8));
      const rows = Math.max(0, Math.floor((r.h - 28 - 14) / 17));
      return <>{cols} × {rows} <span>cols × rows</span></>;
    };

    const title = () =>
      isBrowser ? (browserInfo[pageId()]?.title ?? "")
      : isIssues ? panelTitle(props.project)
      : isFiles ? `${props.project.name} files`
      : isFile ? ((tab.path ?? "").split("/").pop() ?? "")
      : isGit ? `${props.project.name} · ${gitOf(props.project.id).status?.branch ?? ""}`
      : isAgents ? "shared by every project"
      : (live[id]?.title ?? "");

    /** Browser windows: the shown page. Back, reload, the address and the star act on it. */
    const page = () => activePage(tab);
    const pageId = () => page()?.id ?? "";
    const url = () => browserInfo[pageId()]?.url ?? page()?.url ?? "";
    const pageTitle = (pg: Page) => browserInfo[pg.id]?.title || (pg.url ? pg.url.replace(/^https?:\/\//, "") : "New tab");
    /** Close one page; closing the last one closes the window. */
    const closeTabPage = (pg: string) => {
      if ((tab.pages?.length ?? 0) < 2) return requestClose(props.project.id, id);
      removePage(props.project.id, id, pg);
      closePage(pg);
    };
    const newPage = () => addPage(props.project.id, id, "", { show: true });

    const blank = () => !url() || url() === "about:blank";
    const isFav = () => !blank() && props.project.favs.some((f) => f.url === url());
    /** A blank browser shows the start page (favourite tiles), so its webview stays hidden until it has an address. */
    const place = () => placeBrowser(props.project, tab, blank() ? null : pageEl.getBoundingClientRect());
    /** Keep the native webview on the placeholder while the window animates into place. */
    const follow = (ms = 250) => {
      cancelAnimationFrame(placeRaf);
      const end = performance.now() + ms;
      const step = () => {
        place();
        if (performance.now() < end) placeRaf = requestAnimationFrame(step);
      };
      step();
    };

    onMount(() => {
      if (isBrowser) {
        pageRo = new ResizeObserver(() => place());
        pageRo.observe(pageEl);
        follow();
      } else if (!isPanel) {
        ensureSession(props.project, tab);
        mountSession(id, termEl);
      }
    });
    onCleanup(() => {
      pageRo?.disconnect();
      cancelAnimationFrame(placeRaf);
      if (isBrowser) placeBrowser(props.project, tab, null);
      else if (!isPanel) unmountSession(id);
    });

    if (isBrowser) {
      createEffect(on([rect, anyDrag, blank, pageId], () => follow(), { defer: true }));
    } else if (!isPanel) {
      createEffect(() => {
        // after mount, so the session element is attached and visible when it takes focus
        if (focused()) requestAnimationFrame(() => focusSession(id));
      });
    }

    const doMax = () => {
      const wasMax = mono();
      toggleMono(props.project.id, id);
      flash(wasMax ? "restore" : "maximize");
      showSizing(id);
    };

    let starEl!: HTMLButtonElement;
    const star = () => {
      const s = favEditFor();
      if (s?.anchor === starEl) closeFavEdit();
      else starPage(props.project.id, pageId(), url(), starEl);
    };
    const open = (u: string) => navigateBrowser(pageId(), u);

    const onUrlKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        navigateBrowser(pageId(), normalizeUrl(inputEl.value));
        inputEl.blur();
      } else if (e.key === "Escape") {
        inputEl.value = url();
        inputEl.blur();
      }
    };

    const startDrag = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest("button, .ptab")) return;
      if (!rectById().get(id)) return;
      e.preventDefault();
      const pid = props.project.id;
      const start = local(e.clientX, e.clientY);
      barEl.setPointerCapture(e.pointerId);
      focusTab(pid, id);
      setBrowsersSuspended(true);

      let dropId: string | null = null;
      let ws: number | null = null;
      let btn: HTMLElement | null = null;
      setDrag({ id, dx: 0, dy: 0, dropId: null, ws: null });

      const move = (ev: PointerEvent) => {
        const q = local(ev.clientX, ev.clientY);
        const t = tiling();
        // The window under the pointer is the swap target.
        const hit = t.tabs.find((x, i) => {
          const r = t.rects[i];
          return x.id !== id && q.x > r.x && q.x < r.x + r.w && q.y > r.y && q.y < r.y + r.h;
        });
        // A workspace button under the pointer is the send target.
        const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("#spaces button[data-ws]") ?? null;
        const target = el && Number(el.dataset.ws) !== props.project.ws ? el : null;
        if (target !== btn) {
          btn?.classList.remove("target");
          btn = target;
          btn?.classList.add("target");
        }
        ws = target ? Number(target.dataset.ws) : null;
        dropId = hit?.id ?? null;
        setDrag({ id, dx: q.x - start.x, dy: q.y - start.y, dropId, ws });
      };

      const up = () => {
        barEl.removeEventListener("pointermove", move);
        barEl.removeEventListener("pointerup", up);
        barEl.removeEventListener("pointercancel", up);
        btn?.classList.remove("target");
        setBrowsersSuspended(false);
        setDrag(null);
        if (ws !== null) {
          sendTo(pid, id, ws);
          flash(`${tabName(tab)} → workspace ${ws + 1}`);
        } else if (dropId !== null) {
          const other = tiling().tabs.find((x) => x.id === dropId);
          swapTabs(pid, id, dropId);
          flash(`swap with ${other?.kind ?? "window"}`);
        }
      };

      barEl.addEventListener("pointermove", move);
      barEl.addEventListener("pointerup", up);
      barEl.addEventListener("pointercancel", up);
    };

    return (
      <div
        class="win"
        classList={{
          focused: focused(),
          attention: !!live[id]?.attention,
          floating: dragging(),
          drop: dropping(),
          sizing: sized() === id,
          hidden: hidden(),
          peek: peek(),
        }}
        style={{
          left: px(geom().left),
          top: px(geom().top),
          width: px(rect().w),
          height: px(rect().h),
          "z-index": z(),
        }}
        onPointerDown={() => focusTab(props.project.id, id)}
        onKeyDown={(e) => {
          // Ctrl+D while the window's own HTML (address, bar) has focus; the webview keeps its own keys.
          if (isBrowser && e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyD") {
            e.preventDefault();
            star();
          }
        }}
      >
        <div
          class="bar"
          ref={barEl}
          onPointerDown={startDrag}
          onDblClick={(e) => {
            if (!(e.target as Element).closest("button, .ptab")) doMax();
          }}
        >
          <span
            class={`dot ${
              isBrowser ? "web"
              : isIssues ? `plane${dev[props.project.id]?.syncing ? " syncing" : ""}`
              : isFiles || isFile ? "files"
              : isGit ? "git"
              : isAgents ? "agents"
              : (live[id]?.status ?? "connecting")
            }`}
          />
          <span class="kind">{tabName(tab)}</span>
          <Show when={isBrowser && (tab.pages?.length ?? 0) > 1} fallback={<span class="ttl">{title()}</span>}>
            <div class="ptabs" role="tablist">
              <For each={tab.pages}>
                {(pg) => (
                  <div
                    class="ptab"
                    role="tab"
                    classList={{ on: pg.id === pageId() }}
                    aria-selected={pg.id === pageId()}
                    title={browserInfo[pg.id]?.url || pg.url}
                    onClick={() => showPage(props.project.id, id, pg.id)}
                    onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                    onAuxClick={(e) => e.button === 1 && closeTabPage(pg.id)}
                  >
                    <span>{pageTitle(pg)}</span>
                    <button title="Close tab" onClick={(e) => { e.stopPropagation(); closeTabPage(pg.id); }}>×</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={isBrowser}>
            <button title="New tab" onClick={newPage}>+</button>
          </Show>
          <button title="Maximize (Alt+F)" onClick={doMax}>▢</button>
          <button title="Close (Alt+Q)" onClick={() => requestClose(props.project.id, id)}>×</button>
        </div>
        {isBrowser ? (
          <>
            <div class="nav">
              <button title="Back" onClick={() => browserBack(pageId())}>←</button>
              <button title="Forward" onClick={() => browserForward(pageId())}>→</button>
              <button title="Reload" onClick={() => browserReload(pageId())}>↻</button>
              <span class="addr">
                <input
                  class="url"
                  spellcheck={false}
                  aria-label="Address"
                  ref={inputEl}
                  value={blank() ? "" : url()}
                  onKeyDown={onUrlKey}
                />
                <button
                  class="star"
                  ref={starEl}
                  aria-pressed={isFav()}
                  disabled={blank()}
                  title={isFav() ? "Edit favourite (Ctrl+D)" : "Favourite this page (Ctrl+D)"}
                  onClick={star}
                >
                  {isFav() ? "★" : "☆"}
                </button>
              </span>
              <Show when={nativeBrowsers && !blank()}>
                <button title="Select element for the agent" onClick={() => pickElement(props.project, pageId())}>
                  <Icon name="crosshair" size={14} />
                </button>
              </Show>
              <button title="Open in system browser" onClick={() => openExternal(url())}>↗</button>
            </div>
            <FavBar projectId={props.project.id} favs={props.project.favs} url={url()} onOpen={open} />
            <div class="page" ref={pageEl}>
              <Show when={blank()}>
                <StartPage favs={props.project.favs} onOpen={open} />
              </Show>
              {/* Linux has no positionable native webviews, so the page is framed here instead. */}
              <Show when={!nativeBrowsers && url() ? `${pageId()}|${browserInfo[pageId()]?.rev ?? 0}|${url()}` : false} keyed>
                {(k) => <iframe class="frame" src={k.split("|").slice(2).join("|")} title={url()} />}
              </Show>
            </div>
          </>
        ) : isIssues ? (
          <IssuesPanel project={props.project} tab={tab} focused={focused()} />
        ) : isFiles ? (
          <FileList project={props.project} tab={tab} focused={focused()} />
        ) : isFile ? (
          <FileView project={props.project} tab={tab} />
        ) : isGit ? (
          <GitPanel project={props.project} tab={tab} focused={focused()} />
        ) : isAgents ? (
          <AgentsPanel project={props.project} />
        ) : (
          <div class="body" ref={termEl} />
        )}
        <div class="tip">{tipText()}</div>
      </div>
    );
  };

  return (
    <div class="viewport" classList={{ gap0: app.gap === 0 }} ref={viewport}>
      <div class="world" classList={{ anim: animOn() }}>
        <For each={tiling().tabs}>{(tab) => <Win tab={tab} />}</For>
        <Show when={splitRect()}>
          {(s) => (
            <div
              class="split"
              classList={{ active: splitOn() }}
              ref={splitEl}
              style={{ left: px(s().x), top: px(s().y), width: px(s().w), height: px(s().h) }}
              onPointerDown={startSplit}
            />
          )}
        </Show>
      </div>
      <Show when={tiling().tabs.length === 0}>
        <div class="empty">
          <b>Workspace {props.project.ws + 1} of {props.project.name} is empty</b>
          <div><kbd>Alt</kbd><kbd>Enter</kbd> opens a shell here</div>
          <div><kbd>Alt</kbd><kbd>Shift</kbd><kbd>{props.project.ws + 1}</kbd> sends the focused window here</div>
        </div>
      </Show>
    </div>
  );
}

/** Move focus to the nearest window in direction (dx, dy). Returns false if there is none. */
export function focusDir(project: Project, dx: number, dy: number): boolean {
  const { tabs, rects } = layoutOf(project, lastW, lastH);
  const i = tabs.findIndex((t) => t.id === space(project).focus);
  const n = neighbour(rects, i, dx, dy);
  if (n < 0 || n >= tabs.length) return false;
  focusTab(project.id, tabs[n].id);
  return true;
}

/** Swap the focused window with its neighbour in direction (dx, dy). Returns false if there is none. */
export function swapDir(project: Project, dx: number, dy: number): boolean {
  const { tabs, rects } = layoutOf(project, lastW, lastH);
  const i = tabs.findIndex((t) => t.id === space(project).focus);
  if (i < 0) return false;
  const n = neighbour(rects, i, dx, dy);
  if (n < 0 || n >= tabs.length) return false;
  swapTabs(project.id, tabs[i].id, tabs[n].id);
  flash(`swap with ${tabName(tabs[n])}`);
  return true;
}

/** Close a tab with a 5s undo toast; its session is only ended when the toast expires. */
export function requestClose(projectId: string, tabId: string): void {
  const p = projectById(projectId);
  const index = p ? p.tabs.findIndex((t) => t.id === tabId) : -1;
  if (!p || index < 0) return;
  const tab: Tab = { ...p.tabs[index], pages: p.tabs[index].pages?.map((pg) => ({ ...pg })) };
  // Read the title first: removeTab drops the live entry.
  const title =
    tab.kind === "browser" ? browserInfo[activePage(tab)?.id ?? ""]?.title
    : tab.kind === "file" ? tab.path
    : tab.kind === "files" ? `${p.name} files`
    : tab.kind === "git" ? `${p.name} git`
    : isTerminal(tab) ? live[tabId]?.title
    : undefined;
  removeTab(projectId, tabId);
  showToast(
    {
      msg: `Closed ${tabName(tab)}${title ? " · " + title : ""}.`,
      undo: () => restoreTab(projectId, tab, index),
    },
    () => (tab.kind === "browser" ? closeBrowser(tab) : isTerminal(tab) ? closeSession(tabId) : undefined),
  );
}
