import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, onMount, untrack } from "solid-js";
import {
  GAPS, SPACES, activeProject, app, focusedTab, goSpace, isRemote, isTerminal, live, loadState,
  persistChanges, setGap, setLayout, space, tabName,
} from "./state";
import { SIG_TEXT, nextSignal, sigOf, topSig } from "./signals";
import { SignalsPopover, signalsOpen, toggleSignals } from "./SignalSettings";
import Canvas from "./Canvas";
import Sidebar, { sidebarPeek } from "./Sidebar";
import { TabMenu, TabStrip, tabMenuOpen } from "./tabs";
import ClaudeUsage from "./Usage";
import { AppearancePopover, appearanceOpen, backgroundCss, setBgImage, toggleAppearance } from "./Appearance";
import { HelpOverlay, helpOpen, setHelpOpen } from "./Help";
import { AboutDialog, aboutOpen, setAboutOpen } from "./About";
import { Icon, IconPicker, iconPickerOpen } from "./lucide";
import { OpenProjectDialog, openProjectOpen } from "./OpenProject";
import { loadIcons } from "./icons";
import { installHotkeys } from "./hotkeys";
import { installClipboardFallback } from "./clipboard";
import { openExternal, openUrlInProject, setBrowsersSuspended } from "./browsers";
import { FavPopover, favEditOpen } from "./favs";
import { GoToFile, goToFileOpen, toggleGoToFile } from "./GoToFile";
import { Palette, paletteOpen, togglePalette } from "./Palette";
import { ensureSession, setLinkHandler } from "./terms";
import { flash, flashMsg, toast, undoToast } from "./ui";
import { appVersion, installUpdate, startUpdateChecks, updateReady } from "./updater";
import {
  clock, dev, formatHm, formatHms, inProgress, issueKey, loadDev, openIssuePanel, runningEntry, slugOf, startClock, stateOf, todayTotal,
} from "./issues";

export default function App() {
  const [ready, setReady] = createSignal(false);

  onMount(async () => {
    installHotkeys();
    startClock();
    installClipboardFallback();
    setLinkHandler((url, tabId, external) => {
      if (external) {
        openExternal(url);
        return;
      }
      const owner = app.projects.find((p) => p.tabs.some((t) => t.id === tabId))?.id ?? app.activeProject;
      if (owner) openUrlInProject(owner, url, tabId);
    });
    // After a webview reload, PTYs from the previous page are unreachable.
    await invoke("pty_kill_all");
    await loadState();
    for (const p of app.projects) {
      if (p.bg !== "image") continue;
      invoke<string | null>("bg_load", { projectId: p.id })
        .then((dataUrl) => {
          if (dataUrl) return setBgImage(p.id, dataUrl);
        })
        .catch((e) => console.error("bg_load failed:", e));
    }
    loadIcons();
    setReady(true);
    startUpdateChecks();
  });
  persistChanges(ready);

  // Start a session for every terminal tab once, including tabs added later.
  const started = new Set<string>();
  createEffect(() => {
    if (!ready()) return;
    for (const p of app.projects) {
      for (const t of p.tabs) {
        if (!isTerminal(t) || started.has(t.id)) continue;
        started.add(t.id);
        untrack(() => ensureSession(p, t));
      }
    }
  });

  // The accent of the active project drives --accent (see styles.css).
  createEffect(() => {
    document.documentElement.style.setProperty("--accent-raw", activeProject()?.accent ?? "#7aa2f7");
  });

  // Warm the active project's `.dev/` so the toolbar chips and sidebar bar have data.
  createEffect(() => {
    if (!ready()) return;
    const p = activeProject();
    if (p && !untrack(() => dev[p.id]?.loaded)) untrack(() => loadDev(p));
  });

  // Native browser windows draw above HTML, so hide them while an overlay is open.
  createEffect(() => setBrowsersSuspended(appearanceOpen() || helpOpen() || tabMenuOpen() || iconPickerOpen() || favEditOpen() || openProjectOpen() || goToFileOpen() || paletteOpen() || aboutOpen() || signalsOpen()));

  const backdrop = () => {
    const p = activeProject();
    return p ? { background: backgroundCss(p), "--dim": String(p.dim / 100) } : { background: "var(--canvas)", "--dim": "0" };
  };

  return (
    <div class="app" classList={{ rail: app.sidebarCollapsed, peek: sidebarPeek() }}>
      <Sidebar />
      <Toolbar />
      <div class="stage">
        <div class="bg" style={backdrop()} />
        <Show when={activeProject()} keyed fallback={<div class="empty">Open a project (Alt+O) to get started.</div>}>
          {(p) => <Canvas project={p} />}
        </Show>
        <Show when={toast()}>
          {(t) => (
            <div class="toast">
              <span>{t().msg}</span>
              <Show when={t().undo}>
                <button onClick={undoToast}>Undo</button>
              </Show>
            </div>
          )}
        </Show>
      </div>
      <StatusBar />
      <TabMenu />
      <AppearancePopover />
      <FavPopover />
      <GoToFile />
      <Palette />
      <OpenProjectDialog />
      <HelpOverlay />
      <AboutDialog />
      <SignalsPopover />
      <IconPicker />
    </div>
  );
}

function Toolbar() {
  const where = () => {
    const p = activeProject();
    return p ? `${isRemote(p) ? `${p.host}:` : ""}${p.path}` : "";
  };

  return (
    <div class="top">
      <Show when={activeProject()} keyed>
        {(p) => (
          <>
            <div class="spaces" id="spaces" role="group" aria-label="Workspaces">
              <For each={Array.from({ length: SPACES }, (_, i) => i)}>
                {(i) => {
                  const inWs = () => p.tabs.filter((t) => t.space === i);
                  const sig = () => (i === p.ws ? null : topSig(inWs()));
                  return (
                    <button
                      data-ws={i}
                      classList={{ used: inWs().length > 0, att: !!sig(), [`s-${sig()}`]: !!sig() }}
                      aria-current={p.ws === i}
                      title={`Workspace ${i + 1}${inWs().length ? ": " + inWs().map((t) => tabName(t) + (sigOf(t) ? ` (${SIG_TEXT[sigOf(t)!]})` : "")).join(", ") : " (empty)"} · Alt+${i + 1}`}
                      onClick={() => {
                        goSpace(p.id, i);
                        flash(`workspace ${i + 1}`);
                      }}
                    >
                      {i + 1}
                    </button>
                  );
                }}
              </For>
            </div>
            <div class="sep" />
            <div class="seg" role="group" aria-label="Tiling layout">
              <button aria-label="Main + stack" aria-pressed={space(p).layout === "master"} title="Main + stack (Alt+G)" onClick={() => setLayout(p.id, "master")}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="6.5" height="11" rx="1.2" /><rect x="9.5" y="2.5" width="5" height="5" rx="1.2" /><rect x="9.5" y="8.5" width="5" height="5" rx="1.2" /></svg>
              </button>
              <button aria-label="Grid" aria-pressed={space(p).layout === "grid"} title="Grid (Alt+G)" onClick={() => setLayout(p.id, "grid")}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="6" height="5" rx="1.2" /><rect x="9" y="2.5" width="5.5" height="5" rx="1.2" /><rect x="1.5" y="8.5" width="6" height="5" rx="1.2" /><rect x="9" y="8.5" width="5.5" height="5" rx="1.2" /></svg>
              </button>
              <button aria-label="Mono (centered column)" aria-pressed={space(p).layout === "mono"} title="Mono (Alt+G)" onClick={() => setLayout(p.id, "mono")}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="3.5" height="11" rx="1.2" opacity=".4" /><rect x="11" y="2.5" width="3.5" height="11" rx="1.2" opacity=".4" /><rect x="5.75" y="2.5" width="4.5" height="11" rx="1.2" /></svg>
              </button>
            </div>
            <div class="sep" />
            <TabStrip project={p} />
          </>
        )}
      </Show>
      <button
        class="where"
        id="where"
        title={where() ? `${where()} · Go to file (Alt+T)` : ""}
        aria-haspopup="dialog"
        aria-expanded={goToFileOpen()}
        disabled={!activeProject()}
        onClick={toggleGoToFile}
      >
        <Show when={activeProject()}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></svg>
          <span class="wp"><bdi>{where()}</bdi></span>
          <kbd>Alt T</kbd>
        </Show>
      </button>
      <InProgressChips />
      <Show when={activeProject()}>
        <button class="tool theme-btn" id="themeBtn" title="Project appearance (Alt+P)" onClick={(e) => toggleAppearance(e.currentTarget)}>
          <i />
          Appearance
        </button>
      </Show>
      <button class="tool" title="Command palette (Alt+X)" aria-label="Command palette" onClick={togglePalette}>
        <Icon name="square-chevron-right" size={14} />
      </button>
      <button class="tool" title="Hotkeys (Alt+/)" onClick={() => setHelpOpen(!helpOpen())}>
        ?
      </button>
    </div>
  );
}

function StatusBar() {
  const info = () => {
    const p = activeProject();
    if (!p) return "";
    const sp = space(p);
    const where = sp.layout === "master" ? `main ${Math.round(sp.ratio * 100)}%` : sp.layout;
    const f = focusedTab(p);
    if (!f) return where;
    const title = live[f.id]?.title;
    return `${tabName(f)}${title ? " · " + title : ""}  [${where}]`;
  };

  return (
    <div class="status">
      <label class="gapctl" title="Gap between windows (Alt+, / Alt+.)">
        gap
        <select value={String(app.gap)} onChange={(e) => setGap(+e.currentTarget.value)}>
          <For each={GAPS}>{(g) => <option value={String(g)} selected={app.gap === g}>{g}</option>}</For>
        </select>
      </label>
      <span class="focus">{info()}</span>
      <span class="flash">{flashMsg()}</span>
      <StatusTimer />
      <SignalCounts />
      <div class="hints">
        <span><kbd>Alt</kbd><kbd>X</kbd> commands</span>
        <span><kbd>Alt</kbd><kbd>I</kbd> issues</span>
        <span><kbd>Alt</kbd><kbd>E</kbd> files</span>
        <span><kbd>Alt</kbd><kbd>/</kbd> all keys</span>
      </div>
      <Show when={updateReady()}>
        {(u) => (
          <button class="update" title={`Install tri-code ${u().version} and restart. Local terminal sessions end; remote ones reattach.`} onClick={installUpdate}>
            ↻ Restart to update · {u().version}
          </button>
        )}
      </Show>
      <button
        class="bellbtn"
        id="bellBtn"
        classList={{ dnd: app.notify.dnd }}
        title={app.notify.dnd ? "Do not disturb is on · signals and sounds for every project" : "Signals and sounds for every project"}
        aria-label="Signals and sounds"
        aria-haspopup="dialog"
        aria-expanded={signalsOpen()}
        onClick={(e) => toggleSignals(e.currentTarget)}
      >
        <Icon name={app.notify.dnd ? "bell-off" : "bell"} size={13} />
      </button>
      <button class="ver" title="About tri-code: check for updates, changelog" onClick={() => setAboutOpen(true)}>
        v{appVersion}
      </button>
      <ClaudeUsage />
    </div>
  );
}

/** What the agents are doing across every project. A click goes to the next one that needs you (Alt+U). */
function SignalCounts() {
  const count = (s: string) => app.projects.reduce((n, p) => n + p.tabs.filter((t) => sigOf(t) === s).length, 0);
  const parts = () =>
    (["blocked", "error", "done", "working"] as const)
      .map((s) => ({ s, n: count(s) }))
      .filter((x) => x.n);
  const label = (s: string, n: number) =>
    s === "blocked" ? `${n} need${n === 1 ? "s" : ""} you` : s === "error" ? `${n} error${n === 1 ? "" : "s"}` : `${n} ${s}`;
  return (
    <Show when={parts().length}>
      <button class="sigs" title={parts().some((x) => x.s !== "working") ? "Go to the next agent that needs you (Alt+U)" : "Agents at work"} onClick={nextSignal}>
        <For each={parts()}>{(x) => <span class={`s-${x.s}`}><span class={`sg s-${x.s}`} />{label(x.s, x.n)}</span>}</For>
      </button>
    </Show>
  );
}

/** The project's "In Progress" issues, next to Appearance. Click a chip to drill in. */
function InProgressChips() {
  const p = activeProject();
  const list = () => (p ? inProgress(p.id) : []);
  return (
    <Show when={list().length}>
      <div class="prog" role="group" aria-label="In Progress issues">
        <For each={list().slice(0, 2)}>
          {(i) => {
            const run = () => runningEntry(p!.id)?.issue_id === i.id;
            return (
              <button
                classList={{ run: run() }}
                title={`${slugOf(dev[p!.id], i)} · ${i.title} · In Progress${run() ? " · timer running" : ""}. Click to open`}
                onClick={() => openIssuePanel(p!, i.id)}
              >
                <span class="sd" style={{ background: stateOf(dev[p!.id], i)?.color ?? "#f59e0b" }} />
                <span class="sid">{slugOf(dev[p!.id], i)}</span>
                <span class="pt">{i.title}</span>
                <Show when={run()}>
                  <span class="pe"><i class="rec" />{formatHm(clock() - Date.parse(runningEntry(p!.id)!.started_at))}</span>
                </Show>
              </button>
            );
          }}
        </For>
        <Show when={list().length > 2}>
          <button class="more" title={`${list().slice(2).map((i) => slugOf(dev[p!.id], i)).join(", ")} · open the list`} onClick={() => openIssuePanel(p!)}>
            +{list().length - 2}
          </button>
        </Show>
      </div>
    </Show>
  );
}

/** Running Entry and the day's total, in the status line. */
function StatusTimer() {
  const p = activeProject();
  const d = () => (p ? dev[p.id] : undefined);
  const run = () => (p ? runningEntry(p.id) : null);
  return (
    <Show when={d()?.connected}>
      <span class="timer">
        <Show when={run()}>
          {(r) => {
            const issue = () => d()!.issues.find((i) => issueKey(i) === r().issue_id);
            return (
              <>
                <i class="rec" />
                <Show when={issue()}>{(x) => <b>{slugOf(d(), x())}</b>}</Show>{" "}
                {formatHms(clock() - Date.parse(r().started_at))} ·{" "}
              </>
            );
          }}
        </Show>
        today {d() ? formatHm(todayTotal(p!.id)) : "0m"}
      </span>
    </Show>
  );
}
