import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, onMount, untrack } from "solid-js";
import {
  GAPS, SPACES, TabKind, activeProject, addTab, app, focusedTab, goSpace, isRemote, isTerminal, live, loadState,
  persistChanges, setGap, setLayout, space,
} from "./state";
import Canvas from "./Canvas";
import Sidebar from "./Sidebar";
import ClaudeUsage from "./Usage";
import { AppearancePopover, appearanceOpen, backgroundCss, setBgImage, toggleAppearance } from "./Appearance";
import { HelpOverlay, helpOpen, setHelpOpen } from "./Help";
import { installHotkeys } from "./hotkeys";
import { installClipboardFallback } from "./clipboard";
import { openExternal, openUrlInProject, setBrowsersSuspended } from "./browsers";
import { ensureSession, setLinkHandler } from "./terms";
import { flash, flashMsg, toast, undoToast } from "./ui";
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
    setReady(true);
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
  createEffect(() => setBrowsersSuspended(appearanceOpen() || helpOpen()));

  const backdrop = () => {
    const p = activeProject();
    return p ? { background: backgroundCss(p), "--dim": String(p.dim / 100) } : { background: "var(--canvas)", "--dim": "0" };
  };

  return (
    <div class="app" classList={{ rail: app.sidebarCollapsed }}>
      <Sidebar />
      <Toolbar />
      <div class="stage">
        <div class="bg" style={backdrop()} />
        <Show when={activeProject()} keyed fallback={<div class="empty">Add a project to get started.</div>}>
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
      <AppearancePopover />
      <HelpOverlay />
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
            <div class="new">
              <For each={["claude", "pi", "shell", "browser", "issues"] as TabKind[]}>
                {(k) => (
                  <button
                    onClick={() => {
                      if (k === "issues") {
                        openIssuePanel(p);
                        return;
                      }
                      addTab(p.id, k);
                      flash(`new ${k}`);
                    }}
                  >
                    + {k}
                  </button>
                )}
              </For>
            </div>
            <div class="sep" />
            <div class="spaces" id="spaces" role="group" aria-label="Workspaces">
              <For each={Array.from({ length: SPACES }, (_, i) => i)}>
                {(i) => {
                  const inWs = () => p.tabs.filter((t) => t.space === i);
                  return (
                    <button
                      data-ws={i}
                      classList={{
                        used: inWs().length > 0,
                        att: i !== p.ws && inWs().some((t) => live[t.id]?.attention),
                      }}
                      aria-current={p.ws === i}
                      title={`Workspace ${i + 1}${inWs().length ? ": " + inWs().map((t) => t.kind).join(", ") : " (empty)"} · Alt+${i + 1}`}
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
              <button aria-pressed={space(p).layout === "master"} title="Main + stack (Alt+G)" onClick={() => setLayout(p.id, "master")}>
                Main + stack
              </button>
              <button aria-pressed={space(p).layout === "grid"} title="Grid (Alt+G)" onClick={() => setLayout(p.id, "grid")}>
                Grid
              </button>
            </div>
            <label class="gapctl">
              Gap
              <select value={String(app.gap)} onChange={(e) => setGap(+e.currentTarget.value)}>
                <For each={GAPS}>{(g) => <option value={String(g)} selected={app.gap === g}>{g}</option>}</For>
              </select>
            </label>
          </>
        )}
      </Show>
      <span class="where">{where()}</span>
      <InProgressChips />
      <Show when={activeProject()}>
        <button class="tool theme-btn" id="themeBtn" title="Project appearance (Alt+P)" onClick={(e) => toggleAppearance(e.currentTarget)}>
          <i />
          Appearance
        </button>
      </Show>
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
    const where = `${sp.layout === "master" ? `main ${Math.round(sp.ratio * 100)}%` : "grid"} · gap ${app.gap}`;
    const f = focusedTab(p);
    if (!f) return where;
    const title = live[f.id]?.title;
    return `${f.kind}${title ? " · " + title : ""}  [${where}]`;
  };

  return (
    <div class="status">
      <span class="focus">{info()}</span>
      <span class="flash">{flashMsg()}</span>
      <StatusTimer />
      <div class="hints">
        <span><kbd>Alt</kbd><kbd>I</kbd> issues</span>
        <span><kbd>Alt</kbd><kbd>/</kbd> all keys</span>
      </div>
      <ClaudeUsage />
    </div>
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
