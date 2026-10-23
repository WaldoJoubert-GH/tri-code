import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import {
  SPACES, activeProject, app, goSpace, isRemote, isTerminal, loadState,
  persistChanges, repoOf, setLayout, space, tabName,
} from "./state";
import { SIG_TEXT, nextSignal, sigOf, topSig } from "./signals";
import { SignalsPopover, signalsOpen, toggleSignals } from "./SignalSettings";
import { FeedbackPopover, feedbackOpen, toggleFeedback } from "./Feedback";
import Canvas from "./Canvas";
import Sidebar, { sidebarPeek } from "./Sidebar";
import { TabMenu, TabStrip, tabMenuOpen } from "./tabs";
import ClaudeUsage from "./Usage";
import { SettingsDialog, hotkeysOpen, openSettings, settingsOpen, toggleHotkeys } from "./Settings";
import { phoneStatus, startPhoneSync } from "./phone";
import { AppearancePopover, appearanceOpen, backgroundCss, setBgImage, toggleAppearance } from "./Appearance";
import { AboutDialog, aboutOpen, setAboutOpen } from "./About";
import { Icon, IconPicker, iconPickerOpen } from "./lucide";
import { OpenProjectDialog, openProjectOpen } from "./OpenProject";
import { NewWorktreeDialog } from "./NewWorktree";
import { newWorktreeOpen } from "./worktrees";
import { loadIcons } from "./icons";
import { installHotkeys } from "./hotkeys";
import { installClipboardFallback } from "./clipboard";
import { openExternal, openUrlInProject, setBrowsersOverlaid, setBrowsersSuspended } from "./browsers";
import { FavPopover, favEditOpen } from "./favs";
import { GoToFile, goToFileOpen, toggleGoToFile } from "./GoToFile";
import { Palette, paletteOpen, togglePalette } from "./Palette";
import { Tour, startTour, tourOpen } from "./Tour";
import { ensureSession, setLinkHandler } from "./terms";
import { PinPad, envLocked, syncEnvs } from "./envlock";
import { flash, flashMsg, toast, undoToast } from "./ui";
import { keyOf, withKey } from "./keymap";
import { appVersion, installUpdate, startUpdateChecks, updateReady } from "./updater";
import { type Change, type GitStatus, type RepoStatus, branchStatus, folderStatus, isStaged, isUnstaged, openGitPanel, peekStatus, unpushed } from "./git";
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
    // After a webview reload, PTYs and browser webviews from the previous page are unreachable.
    await invoke("pty_kill_all");
    await invoke("browser_close_all").catch((e) => console.warn("browser_close_all failed:", e));
    await loadState();
    await syncEnvs();
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
    // A first launch (or one that quit mid-tour) opens the tour's sample project.
    if (!app.toured) void startTour();
  });
  persistChanges(ready);
  createEffect(on(ready, (r) => r && startPhoneSync(), { defer: true }));

  // Start a session for every terminal tab once, including tabs added later.
  const started = new Set<string>();
  createEffect(() => {
    if (!ready()) return;
    for (const p of app.projects) {
      if (envLocked(p.host)) continue; // they start once it is unlocked
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

  // Git colours changed in Settings → Git override the theme's --git-* tokens.
  createEffect(() => {
    const st = document.documentElement.style, c = app.settings.gitColors ?? {};
    for (const k of ["add", "del", "mod", "ren"] as const) {
      if (c[k]) st.setProperty(`--git-${k}`, c[k]!);
      else st.removeProperty(`--git-${k}`);
    }
    if (app.settings.gitTint === undefined) st.removeProperty("--git-tint");
    else st.setProperty("--git-tint", `${app.settings.gitTint}%`);
  });

  // Warm the active project's `.dev/` so the toolbar chips and sidebar bar have data.
  createEffect(() => {
    if (!ready()) return;
    const p = activeProject();
    const r = p && !envLocked(p.host) && repoOf(p);
    if (r && !untrack(() => dev[r.id]?.loaded)) untrack(() => loadDev(r));
  });

  // Native browser windows draw above HTML, so hide them while an overlay is open.
  // Only the ones under an overlay hide; the tour spotlights anything, so it hides them all.
  createEffect(() => setBrowsersOverlaid(appearanceOpen() || settingsOpen() || tabMenuOpen() || iconPickerOpen() || favEditOpen() || openProjectOpen() || newWorktreeOpen() || goToFileOpen() || paletteOpen() || aboutOpen() || signalsOpen() || feedbackOpen()));
  createEffect(() => setBrowsersSuspended(tourOpen()));

  const backdrop = () => {
    const p = activeProject();
    const r = p && repoOf(p);
    return r ? { background: backgroundCss(r), "--dim": String(r.dim / 100) } : { background: "var(--canvas)", "--dim": "0" };
  };

  return (
    <div class="app" classList={{ rail: app.sidebarCollapsed, peek: sidebarPeek() }}>
      <Sidebar />
      <Toolbar />
      <div class="stage">
        <div class="bg" style={backdrop()} />
        <Show when={activeProject()} keyed fallback={<div class="empty">{withKey("Open a project", "open-project")} to get started.</div>}>
          {(p) => <Show when={!envLocked(p.host)} fallback={<PinPad host={p.host} />}><Canvas project={p} /></Show>}
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
      <SettingsDialog />
      <FavPopover />
      <GoToFile />
      <Palette />
      <OpenProjectDialog />
      <NewWorktreeDialog />
      <AboutDialog />
      <SignalsPopover />
      <FeedbackPopover />
      <IconPicker />
      <Tour />
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
                      title={`Workspace ${i + 1}${inWs().length ? ": " + inWs().map((t) => tabName(t) + (sigOf(t) ? ` (${SIG_TEXT[sigOf(t)!]})` : "")).join(", ") : " (empty)"} · ${keyOf(`ws-${i + 1}`)}`}
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
              <button aria-label="Main + stack" aria-pressed={space(p).layout === "master"} title={withKey("Main + stack", "layout")} onClick={() => setLayout(p.id, "master")}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="6.5" height="11" rx="1.2" /><rect x="9.5" y="2.5" width="5" height="5" rx="1.2" /><rect x="9.5" y="8.5" width="5" height="5" rx="1.2" /></svg>
              </button>
              <button aria-label="Grid" aria-pressed={space(p).layout === "grid"} title={withKey("Grid", "layout")} onClick={() => setLayout(p.id, "grid")}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="6" height="5" rx="1.2" /><rect x="9" y="2.5" width="5.5" height="5" rx="1.2" /><rect x="1.5" y="8.5" width="6" height="5" rx="1.2" /><rect x="9" y="8.5" width="5.5" height="5" rx="1.2" /></svg>
              </button>
              <button aria-label="Mono (centered column)" aria-pressed={space(p).layout === "mono"} title={withKey("Mono", "layout")} onClick={() => setLayout(p.id, "mono")}>
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
        title={where() ? `${where()} · ${withKey("Go to file", "go-to-file")}` : ""}
        aria-haspopup="dialog"
        aria-expanded={goToFileOpen()}
        disabled={!activeProject()}
        onClick={toggleGoToFile}
      >
        <Show when={activeProject()}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></svg>
          <span class="wp"><bdi>{where()}</bdi></span>
          <Show when={keyOf("go-to-file", " ")}>{(k) => <kbd>{k()}</kbd>}</Show>
        </Show>
      </button>
      <InProgressChips />
      <Show when={activeProject()}>
        <button class="tool theme-btn" id="themeBtn" title={withKey("Project appearance", "appearance")} onClick={(e) => toggleAppearance(e.currentTarget)}>
          <i />
          Appearance
        </button>
      </Show>
      <button class="tool" id="palBtn" title={withKey("Command palette", "palette")} aria-label="Command palette" onClick={togglePalette}>
        <Icon name="square-chevron-right" size={14} />
      </button>
      <button class="tool" title={withKey("Hotkeys", "help")} aria-pressed={hotkeysOpen()} onClick={toggleHotkeys}>
        ?
      </button>
    </div>
  );
}

function StatusBar() {
  return (
    <div class="status">
      <BranchStatus />
      <span class="flash">{flashMsg()}</span>
      <StatusTimer />
      <SignalCounts />
      <Show when={updateReady()}>
        {(u) => (
          <button class="update" title={`Install tri-code ${u().version} and restart. Local terminal sessions end; remote ones reattach.`} onClick={installUpdate}>
            ↻ Restart to update · {u().version}
          </button>
        )}
      </Show>
      <Show when={phoneStatus().url}>
        <button
          class="bellbtn phonebtn"
          title={`Remote control is on · ${phoneStatus().devices.filter((d) => d.online).length} phone(s) connected · Settings › Remote`}
          aria-label="Remote control"
          onClick={() => openSettings("remote")}
        >
          <Icon name="smartphone" size={13} />
          <Show when={phoneStatus().devices.filter((d) => d.online).length}>{(n) => <span>{n()}</span>}</Show>
        </button>
      </Show>
      <button
        class="bellbtn"
        id="feedbackBtn"
        title="Report a bug or suggest a feature"
        aria-label="Feedback"
        aria-haspopup="dialog"
        aria-expanded={feedbackOpen()}
        onClick={(e) => toggleFeedback(e.currentTarget)}
      >
        <Icon name="message-square-plus" size={13} />
      </button>
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
      <Show when={app.settings.claudeUsage !== false}>
        <ClaudeUsage />
      </Show>
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
      <button class="sigs" title={parts().some((x) => x.s !== "working") ? withKey("Go to the next agent that needs you", "next-signal") : "Agents at work"} onClick={nextSignal}>
        <For each={parts()}>{(x) => <span class={`s-${x.s}`}><span class={`sg s-${x.s}`} />{label(x.s, x.n)}</span>}</For>
      </button>
    </Show>
  );
}

/** The project's "In Progress" issues, next to Appearance. Click a chip to drill in. */
function InProgressChips() {
  return (
    <Show when={activeProject()} keyed>
      {(p) => <ProjectInProgressChips p={p} />}
    </Show>
  );
}

function ProjectInProgressChips(props: { p: NonNullable<ReturnType<typeof activeProject>> }) {
  const p = props.p;
  const r = repoOf(p);
  const list = () => (r ? inProgress(r.id) : []);
  return (
    <Show when={list().length}>
      <div class="prog" role="group" aria-label="In Progress issues">
        <For each={list().slice(0, 2)}>
          {(i) => {
            const run = () => runningEntry(r!.id)?.issue_id === issueKey(i);
            return (
              <button
                classList={{ run: run() }}
                title={`${slugOf(dev[r!.id], i)} · ${i.title} · In Progress${run() ? " · timer running" : ""}. Click to open`}
                onClick={() => openIssuePanel(p!, issueKey(i))}
              >
                <span class="sd" style={{ background: stateOf(dev[r!.id], i)?.color ?? "#f59e0b" }} />
                <span class="sid">{slugOf(dev[r!.id], i)}</span>
                <span class="pt">{i.title}</span>
                <Show when={run()}>
                  <span class="pe"><i class="rec" />{formatHm(clock() - Date.parse(runningEntry(r!.id)!.started_at))}</span>
                </Show>
              </button>
            );
          }}
        </For>
        <Show when={list().length > 2}>
          <button class="more" title={`${list().slice(2).map((i) => slugOf(dev[r!.id], i)).join(", ")} · open the list`} onClick={() => openIssuePanel(p!)}>
            +{list().length - 2}
          </button>
        </Show>
      </div>
    </Show>
  );
}

/** Running Entry and the day's total, in the status line. */
function StatusTimer() {
  const repo = () => {
    const a = activeProject();
    return a && repoOf(a);
  };
  const d = () => {
    const p = repo();
    return p ? dev[p.id] : undefined;
  };
  const run = () => {
    const p = repo();
    return p ? runningEntry(p.id) : null;
  };
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
        today {repo() ? formatHm(todayTotal(repo()!.id)) : "0m"}
      </span>
    </Show>
  );
}

/** The active project's branch and changes, like `git status --short`; nothing when it is not a repo. */
function BranchStatus() {
  const [hover, setHover] = createSignal<DOMRect | null>(null);
  const project = () => activeProject();
  const fl = () => {
    const p = project();
    return p ? folderStatus[p.id] : undefined;
  };
  const st = () => {
    const p = project();
    if (!p) return undefined;
    return branchStatus[p.id] ?? (fl()?.length === 1 ? fl()![0].status : undefined);
  };
  const tick = () => {
    const p = activeProject();
    if (p && !document.hidden) void peekStatus(p);
  };
  createEffect(on(() => app.activeProject, tick));
  // Every 10s locally, every 30s over ssh; and when the window comes back.
  let n = 0;
  const timer = setInterval(() => {
    const p = activeProject();
    if (p && (!isRemote(p) || ++n % 3 === 0)) tick();
  }, 10_000);
  window.addEventListener("focus", tick);
  onCleanup(() => (clearInterval(timer), window.removeEventListener("focus", tick)));

  return (
    <Show
      when={fl() && fl()!.length > 1}
      fallback={
        <Show when={st()}>
          {(s) => (
            <>
              <button
                class="gstat"
                aria-label="Git status · open the git window"
                onClick={() => project() && openGitPanel(project()!)}
                onMouseEnter={(e) => setHover(e.currentTarget.getBoundingClientRect())}
                onMouseLeave={() => setHover(null)}
              >
                <Icon name="git-branch" size={12} />
                <span class="nm" classList={{ det: !s().branch }}>{s().branch ?? `HEAD ${s().commits[0]?.sha.slice(0, 7) ?? ""}`}</span>
                <Show when={s().files.length}><span>*</span></Show>
                <Show when={aheadBehind(s())}><span class="ab">{aheadBehind(s())}</span></Show>
                <ChangeCounts s={s()} />
              </button>
              <Show when={hover()}>{(r) => <GitStatusPop s={s()} at={r()} />}</Show>
            </>
          )}
        </Show>
      }
    >
      <button
        class="gstat"
        aria-label="Git status · a folder of repos · open the git window"
        onClick={() => project() && openGitPanel(project()!)}
        onMouseEnter={(e) => setHover(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHover(null)}
      >
        <Icon name="git-branch" size={12} />
        <span class="nm">{fl()!.length} repos</span>
        <Show when={fl()!.some((r) => (r.status?.files.length ?? 0) > 0)}><span>*</span></Show>
        <FolderCounts repos={fl()!} />
      </button>
      <Show when={hover()}>{(r) => <FolderStatusPop repos={fl()!} at={r()} />}</Show>
    </Show>
  );
}

/** The sum of a folder's repos' changes, in the same + ~ − ? symbols as ChangeCounts. */
function FolderCounts(props: { repos: RepoStatus[] }) {
  const n = () => {
    const out = { A: 0, M: 0, D: 0, U: 0 };
    for (const r of props.repos) for (const c of r.status?.files ?? []) out[kindOf(c)]++;
    return out;
  };
  const parts = () =>
    ([["A", "+"], ["M", "~"], ["D", "−"], ["U", "?"]] as const)
      .filter(([k]) => n()[k])
      .map(([k, sym]) => ({ k, t: `${sym}${n()[k]}` }));
  return (
    <Show when={parts().length}>
      <span class="cnt"><For each={parts()}>{(x) => <span class={x.k}>{x.t}</span>}</For></span>
    </Show>
  );
}

function FolderStatusPop(props: { repos: RepoStatus[]; at: DOMRect }) {
  const changed = () => props.repos.reduce((n, r) => n + (r.status?.files.length ?? 0), 0);
  return (
    <div class="gstat-pop" style={{ left: `${Math.min(props.at.left, window.innerWidth - 392)}px`, bottom: `${window.innerHeight - props.at.top + 6}px` }}>
      <div class="ph">
        <b>{props.repos.length} repos</b>
        <span>{changed() ? `${changed()} changed across the folder` : "nothing to commit anywhere"}</span>
      </div>
      <For each={props.repos}>
        {(r) => (
          <div class="repo-line">
            <span class="rn">{r.repo || "project"}</span>
            <span class="rb">{r.status?.branch ?? "—"}</span>
            <span class="rc" classList={{ warn: (r.status?.files.length ?? 0) > 0, bad: !!r.error }}>
              {r.error ? "error" : r.status?.files.length ? `${r.status.files.length} changed` : "clean"}
            </span>
          </div>
        )}
      </For>
      <div class="pf">Click to open the git window{keyOf("git") ? ` · ${keyOf("git")}` : ""}</div>
    </div>
  );
}

function aheadBehind(s: GitStatus): string {
  const up = unpushed(s);
  return [up ? `↑${up}` : "", s.upstream && s.behind ? `↓${s.behind}` : ""].filter(Boolean).join(" ");
}

/** Short-status letter for a change: added, deleted, untracked, else modified. */
const kindOf = (c: Change) => (c.x === "?" ? "U" : c.x === "A" ? "A" : c.x === "D" || c.y === "D" ? "D" : "M");

function ChangeCounts(props: { s: GitStatus }) {
  const parts = () => {
    const n = { A: 0, M: 0, D: 0, U: 0 };
    for (const c of props.s.files) n[kindOf(c)]++;
    return ([["A", "+"], ["M", "~"], ["D", "−"], ["U", "?"]] as const).filter(([k]) => n[k]).map(([k, sym]) => ({ k, t: `${sym}${n[k]}` }));
  };
  return (
    <Show when={parts().length}>
      <span class="cnt"><For each={parts()}>{(x) => <span class={x.k}>{x.t}</span>}</For></span>
    </Show>
  );
}

function GitStatusPop(props: { s: GitStatus; at: DOMRect }) {
  const s = () => props.s;
  const sections = () => [
    { title: "Staged", list: s().files.filter(isStaged), code: (c: Change) => c.x },
    { title: "Changes", list: s().files.filter((c) => isUnstaged(c) && c.x !== "?"), code: (c: Change) => c.y },
    { title: "Untracked", list: s().files.filter((c) => c.x === "?"), code: () => "?" },
  ].filter((x) => x.list.length);
  const tracking = () =>
    !s().branch ? `detached at ${s().commits[0]?.sha.slice(0, 7) ?? "HEAD"}`
    : !s().upstream ? "no upstream · not pushed yet"
    : `tracking ${s().upstream}${s().ahead || s().behind ? ` · ↑${s().ahead} ↓${s().behind}` : " · up to date"}`;
  const cls = (code: string) => (code === "?" ? "U" : code === "A" || code === "D" ? code : "M");
  return (
    <div class="gstat-pop" style={{ left: `${Math.min(props.at.left, window.innerWidth - 392)}px`, bottom: `${window.innerHeight - props.at.top + 6}px` }}>
      <div class="ph">
        <b>{s().branch ?? "HEAD"}</b>
        <span>{tracking()}</span>
      </div>
      <Show when={s().files.length} fallback={<div class="clean">Nothing to commit, working tree clean.</div>}>
        <For each={sections()}>
          {(sec) => (
            <>
              <div class="sec">{sec.title} · {sec.list.length}</div>
              <For each={sec.list.slice(0, 8)}>
                {(c) => <div class="f"><span class={`s ${cls(sec.code(c))}`}>{sec.code(c)}</span><span class="p">{c.path}</span></div>}
              </For>
              <Show when={sec.list.length > 8}><div class="more">+{sec.list.length - 8} more</div></Show>
            </>
          )}
        </For>
      </Show>
      <div class="pf">Click to open the git window{keyOf("git") ? ` · ${keyOf("git")}` : ""}</div>
    </div>
  );
}
