import "./canvas.css";
import { For, Show, createEffect, createMemo, createSignal, lazy, on, onCleanup, onMount } from "solid-js";
import {
  type Page, type Project, type Tab, activePage, addPage, agentOf, app, focusTab, isTerminal, live, projectById, removePage,
  canvasTabs, minimiseTab, removeTab, repoOf, restoreTab, sendTo, setRatio, showPage, space, swapTabs, tabIcon, tabName, toggleMono, visibleTabs,
} from "./state";
import { type Rect, neighbour, ratioAt, tile } from "./layout";
import { flash, showToast } from "./ui";
import { isKey, withKey } from "./keymap";
import { Caps } from "./Keys";
import {
  browserInfo, nativeBrowsers, closeBrowser, closePage, browserBack, browserForward, browserReload, navigateBrowser,
  addressToUrl, openExternal, pickElement, placeBrowser, setBrowsersSuspended,
} from "./browsers";
import { Icon } from "./lucide";
import { closeSession, ensureSession, focusSession, mountSession, unmountSession } from "./terms";
import IssuesPanel from "./IssuesPanel";
import { dirtyCount, dropEditor } from "./files";

/** CodeMirror and its languages load the first time an editor window opens. */
const Editor = lazy(() => import("./Editor"));
import GitPanel from "./GitPanel";
import AgentsPanel from "./AgentsPanel";
import { gitOf } from "./git";
import { clock, dev, panelTitle } from "./issues";
import { SIG_TEXT, sigOf } from "./signals";
import { FavBar, StartPage, closeFavEdit, favEditFor, starPage } from "./favs";

/** "just now", "4m ago", "2h ago": how long an agent has been in its state. */
const ago = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
};

/** Loads shorter than this (HMR, cache) show no line at all, so they don't flicker. Matches .loadbar's delay. */
const LOAD_SHOW_MS = 150;

/**
 * A thin line on the edge above a browser page while it loads. The webview only reports
 * started / finished, so the line creeps toward ~88% and fills then fades when the page is done.
 */
function LoadBar(props: { loading: boolean }) {
  const [run, setRun] = createSignal(0); // 0 hides it; bumped per load so each gets a fresh line
  let el: HTMLDivElement | undefined;
  let started = 0;
  let timer = 0;
  createEffect(on(() => props.loading, (loading) => {
    clearTimeout(timer);
    if (loading) {
      started = performance.now();
      return setRun((n) => n + 1);
    }
    if (!el || !run()) return;
    if (performance.now() - started < LOAD_SHOW_MS) return setRun(0);
    // Freeze the line where the trickle got to, then let it fill and fade.
    el.style.width = getComputedStyle(el).width;
    el.classList.add("done");
    void el.offsetWidth;
    el.style.width = "";
    timer = window.setTimeout(() => setRun(0), 450);
  }));
  onCleanup(() => clearTimeout(timer));
  return <Show when={run()} keyed>{(_n) => <div class="loadbar" ref={el} />}</Show>;
}

const BAR = 28;
const NAV = 32;
const FAVS = 26;
const px = (n: number) => `${Math.round(n)}px`;

/** Last measured viewport size, for the keyboard helpers that run outside the component. */
let lastW = 0;
let lastH = 0;

/** Tiling of a project's active workspace at a given viewport size. Minimised tabs are left out. */
function layoutOf(p: Project, w: number, h: number) {
  const tabs = canvasTabs(p);
  const sp = space(p);
  const mono = tabs.findIndex((t) => t.id === sp.mono);
  const focus = tabs.findIndex((t) => t.id === sp.focus);
  const t = tile(tabs.length, sp.layout, sp.ratio, w, h, app.gap, mono, focus, app.settings.monoGutter);
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
    const isEditor = tab.kind === "editor";
    const isGit = tab.kind === "git";
    const isAgents = tab.kind === "agents";
    const isPanel = isIssues || isEditor || isGit || isAgents;

    let barEl!: HTMLDivElement;
    let termEl!: HTMLDivElement;
    let pageEl!: HTMLDivElement;
    let inputEl!: HTMLInputElement;
    let placeRaf = 0;
    let pageRo: ResizeObserver | undefined;

    const rect = () => rectById().get(id) ?? { x: 0, y: 0, w: 0, h: 0 };
    const focused = createMemo(() => space(props.project).focus === id);
    const mono = createMemo(() => space(props.project).mono === id);
    /** Another window is maximized over this one (it keeps its tiled rect underneath). */
    const buried = createMemo(() => { const m = space(props.project).mono; return !!m && m !== id; });
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
    /** A web app set to "app" hides the address and favourites bars; ⋯ shows them for this window. */
    const [showAddr, setShowAddr] = createSignal(false);
    const appBar = () => isBrowser && agentOf(tab)?.bar === "app";
    const bare = () => appBar() && !showAddr();
    const tipText = () => {
      const r = rect();
      if (bare()) return <>{Math.round(r.w)} × {Math.max(0, Math.round(r.h - BAR))} <span>px</span></>;
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
      : isIssues ? panelTitle(repoOf(props.project))
      : isEditor ? (tab.path ? `${tab.path.split("/").pop()}${dirtyCount(id) ? ` · ${dirtyCount(id)} modified` : ""}` : props.project.name)
      : isGit ? `${props.project.name} · ${gitOf(props.project.id).status?.branch ?? ""}`
      : isAgents ? "shared by every project"
      : (live[id]?.title ?? "");

    /** Browser windows: the shown page. Back, reload, the address and the star act on it. */
    const page = () => activePage(tab);
    const pageId = () => page()?.id ?? "";
    const url = () => browserInfo[pageId()]?.url ?? page()?.url ?? "";
    const pageTitle = (pg: Page) => browserInfo[pg.id]?.title || (pg.url ? pg.url.replace(/^https?:\/\//, "") : "New tab");
    /** The shown page's load line: on the nav row, or on the title bar when the nav row is hidden. */
    const loadBar = () => (
      <Show when={pageId()} keyed>
        {(pid) => <LoadBar loading={browserInfo[pid]?.loading ?? false} />}
      </Show>
    );
    /** Close one page; closing the last one closes the window. */
    const closeTabPage = (pg: string) => {
      if ((tab.pages?.length ?? 0) < 2) return requestClose(props.project.id, id);
      removePage(props.project.id, id, pg);
      closePage(pg);
    };
    const newPage = () => addPage(props.project.id, id, "", { show: true });

    const blank = () => !url() || url() === "about:blank";
    const isFav = () => !blank() && props.project.favs.some((f) => f.url === url());
    /**
     * A blank browser shows the start page (favourite tiles), so its webview stays hidden until it has an address.
     * Native webviews draw above all HTML, so one under a maximized window is hidden too.
     */
    const place = () => placeBrowser(props.project, tab, blank() || buried() ? null : pageEl.getBoundingClientRect());
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
      createEffect(on([rect, anyDrag, blank, pageId, buried], () => follow(), { defer: true }));
      // A blank page has nothing to do but take an address.
      createEffect(() => {
        if (focused() && blank() && !bare()) requestAnimationFrame(() => inputEl.focus());
      });
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
        navigateBrowser(pageId(), addressToUrl(inputEl.value));
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
        data-tab={id}
        classList={{
          focused: focused(),
          "sig-blocked": sigOf(tab) === "blocked",
          "sig-error": sigOf(tab) === "error",
          "sig-done": sigOf(tab) === "done",
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
          if (isBrowser && isKey("favourite", e)) {
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
          <Icon
            name={tabIcon(tab)}
            class={`mark ${
              isBrowser ? "web"
              : isIssues ? `plane${dev[repoOf(props.project).id]?.syncing ? " syncing" : ""}`
              : isEditor ? "editor"
              : isGit ? "git"
              : isAgents ? "agents"
              : (live[id]?.status ?? "connecting")
            }`}
          />
          <span class="kind">{tabName(tab)}</span>
          <Show when={live[id]?.agent}>
            {(a) => (
              <span class="ast" classList={{ [`s-${a().state}`]: true, seen: sigOf(tab) !== a().state }} title={a().msg}>
                <span class={`sg s-${a().state}`} />
                {SIG_TEXT[a().state]}
                {a().state === "working" ? "" : ` · ${ago(clock() - a().at)}`}
              </span>
            )}
          </Show>
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
          <Show when={appBar()}>
            <button title={showAddr() ? "Hide the address bar" : "Show the address bar"} onClick={() => setShowAddr(!showAddr())}>
              <Icon name={showAddr() ? "chevron-up" : "ellipsis"} size={13} />
            </button>
          </Show>
          <button class="mn" title={withKey("Minimise", "minimise")} onClick={() => minimiseTab(props.project.id, id)}>–</button>
          <button title={withKey("Maximize", "maximize")} onClick={doMax}>▢</button>
          <button title={withKey("Close", "close")} onClick={() => requestClose(props.project.id, id)}>×</button>
          <Show when={bare()}>{loadBar()}</Show>
        </div>
        {isBrowser ? (
          <>
            <div class="nav" hidden={bare()}>
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
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  class="star"
                  ref={starEl}
                  aria-pressed={isFav()}
                  disabled={blank()}
                  title={withKey(isFav() ? "Edit favourite" : "Favourite this page", "favourite")}
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
              <Show when={!bare()}>{loadBar()}</Show>
            </div>
            <Show when={!bare()}>
              <FavBar projectId={props.project.id} favs={props.project.favs} url={url()} onOpen={open} />
            </Show>
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
          <IssuesPanel project={repoOf(props.project)} home={props.project} tab={tab} focused={focused()} />
        ) : isEditor ? (
          <Editor project={props.project} tab={tab} focused={focused()} />
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
        <Show
          when={visibleTabs(props.project).length}
          fallback={
            <div class="empty">
              <b>Workspace {props.project.ws + 1} of {props.project.name} is empty</b>
              <div><Caps id="term-like" /> opens a shell here</div>
              <div><Caps id={`send-${props.project.ws + 1}`} /> sends the focused window here</div>
            </div>
          }
        >
          {(n) => (
            <div class="empty">
              <b>{n() === 1 ? "The window here is" : `All ${n()} windows here are`} minimised</b>
              <div>Click a dimmed tab in the toolbar to bring one back</div>
              <div><Caps id="restore-last" /> brings back the last one</div>
            </div>
          )}
        </Show>
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
    : tab.kind === "editor" ? tab.path ?? p.name
    : tab.kind === "git" ? `${p.name} git`
    : isTerminal(tab) ? live[tabId]?.title
    : undefined;
  removeTab(projectId, tabId);
  showToast(
    {
      msg: `Closed ${tabName(tab)}${title ? " · " + title : ""}.`,
      undo: () => restoreTab(projectId, tab, index),
    },
    () => (tab.kind === "browser" ? closeBrowser(tab) : isTerminal(tab) ? closeSession(tabId) : tab.kind === "editor" ? dropEditor(tabId) : undefined),
  );
}
