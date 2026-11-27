// The tour (design/tour.html): a sample project already at work, and a spotlight that walks through
// six stops. Each stop asks for one thing, ticks once you've done it and moves on by itself; its keys
// can be clicked as well as pressed. The Welcome window offers it last; Alt+X › Take the tour replays it.

import { invoke } from "@tauri-apps/api/core";
import { For, JSX, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { Project, Tab, addSampleProject, app, goSpace, live, setApp, setToured, worktreesOf } from "../../shared/state/state";
import { openProjectDialog } from "../../OpenProject";
import { dropProject } from "../../projects";
import { askDemo } from "../../terms";
import { flash } from "../../shared/ui/ui";
import { Caps, Key } from "../../shared/keys/Keys";
import { flashHints, hintsShown } from "../../shared/keys/hints";
import { runHotkey } from "../../hotkeys";
import { tabMenuOpen, toggleTabMenu } from "../../tabs";
import { modLabel } from "../../shared/keys/modkey";
import { Modal } from "../../shared/ui/Modal";

const [step, setStep] = createSignal(0);
/** "tour" while walking the stops, "end" for the closing card. */
const [mode, setMode] = createSignal<"tour" | "end" | null>(null);
export const tourOpen = () => mode() !== null;

const sample = () => app.projects.find((p) => p.sample);
const demoTab = (p: Project, kind: Tab["demo"]) => p.tabs.find((t) => t.demo === kind);
const piAgent = (p: Project) => live[demoTab(p, "pi")?.id ?? ""]?.agent;
/** Windows other than terminals and the editor: git, browser, database, docker, monitor, issues, commands. */
const tools = (p: Project) => p.tabs.filter((t) => t.kind !== "term" && t.kind !== "editor").length;

/** What the try-it checks compare against: the project as it was when the stop came up. */
type Base = { terms: number; files: string; tools: number; worktrees: number; pi?: number };
const baseOf = (p: Project): Base => ({
  terms: p.tabs.filter((t) => t.kind === "term").length,
  files: p.tabs.filter((t) => t.kind === "editor").map((t) => t.path).join("|"),
  tools: tools(p),
  worktrees: worktreesOf(p.id).length,
  pi: piAgent(p)?.at,
});

type Stop = {
  /** What the spotlight frames. */
  target: (p: Project) => string;
  /** Where the card goes: beside the target, under it, or over it. */
  side: "right" | "below" | "above";
  /** A popover the stop opens, which the card keeps clear of. */
  avoid?: string;
  title: string;
  body: () => JSX.Element;
  /** The one thing to do, and when it counts as done. */
  try: { label: (p: Project) => JSX.Element; done: (p: Project, base: Base) => boolean };
  /** Runs as the stop comes up. Returns a cleanup. */
  enter?: (p: Project) => (() => void) | void;
};

/** An action's key as a button: clicking it does what pressing it does. */
const Do = (props: { id: string; label?: string }) => (
  <button class="tour-key" title="Click to do the same" onClick={() => runHotkey(props.id)}>
    <Caps id={props.id} />
    <Show when={props.label}><span>{props.label}</span></Show>
  </button>
);

const STOPS: Stop[] = [
  {
    target: () => "aside", side: "right", title: "Your projects, by machine",
    body: () => <>Each folder sits under the machine it's on: <b>local</b>, or a server you reach over ssh. Agents keep running when you switch away or close tri-code, and a dot on a project tells you when one wants you.</>,
    try: {
      label: () => <>Hold <Key k={modLabel()} />, or <button class="tour-key" onClick={() => flashHints(1600)}><span>show me</span></button>. Every icon turns into its key, so there's nothing to learn first.</>,
      done: () => hintsShown(),
    },
  },
  {
    target: () => ".top .tabs", side: "below", title: "Windows tile themselves",
    body: () => <>Each project has four workspaces, each a canvas of its own windows. claude, a dev server and the editor are on 1; pi is on 2. Open a window and the others make room.</>,
    try: { label: () => <>Open a shell: <Do id="term-like" /></>, done: (p, b) => p.tabs.filter((t) => t.kind === "term").length > b.terms },
  },
  {
    target: () => "#where", side: "below", avoid: ".pal", title: "One box for commands and files",
    body: () => <><Caps id="palette" /> or a click on the path opens it. Commands come first, then files. <Key k="Enter" /> opens a file in the editor; <Key k="Shift" /><Key k="Enter" /> types <code>@path</code> into the agent instead.</>,
    try: {
      label: () => <>Press <Do id="palette" />, type <code>sett</code> and press <Key k="Enter" /></>,
      done: (p, b) => p.tabs.filter((t) => t.kind === "editor").map((t) => t.path).join("|") !== b.files,
    },
  },
  {
    target: (p) => {
      const pi = demoTab(p, "pi");
      return pi && piAgent(p)?.state === "blocked" && pi.space === p.ws ? `.win[data-tab="${pi.id}"] .bar` : ".status .sigs";
    },
    side: "above", title: "Agents tell you when they need you",
    body: () => <>claude and pi say when they're working, waiting, done or failed: on the tab, the workspace, the project and the status line. When one you aren't watching needs you, you hear it and get a notification.</>,
    try: {
      label: (p) => {
        const pi = demoTab(p, "pi");
        if (piAgent(p)?.state !== "blocked") return <>Watch the status line: pi is about to ask you something.</>;
        if (pi && pi.space === p.ws) return <>Answer it: press <Key k="y" /></>;
        return <>pi is asking on workspace {(pi?.space ?? 1) + 1}. Jump to it: <Do id="next-signal" /></>;
      },
      done: (p, b) => {
        const a = piAgent(p);
        return !!a && a.at !== b.pi && a.state !== "blocked";
      },
    },
    enter: (p) => {
      const t = window.setTimeout(() => {
        const pi = demoTab(p, "pi");
        if (pi && piAgent(p)?.state !== "blocked") askDemo(pi.id);
      }, 1500);
      return () => clearTimeout(t);
    },
  },
  {
    target: () => ".tab-add", side: "right", avoid: ".tabmenu", title: "A window for every job",
    body: () => <><b>+</b> lists every kind of window with its key: the editor, git with its diffs, a browser, your databases, docker, the machine's monitor, issues. Agents can open them too, through tri-code's MCP server.</>,
    try: { label: () => <>Open any one from the menu, or git: <Do id="git" /></>, done: (p, b) => tools(p) > b.tools },
    enter: (p) => {
      const t = window.setTimeout(() => {
        const add = document.querySelector<HTMLElement>(".tab-add");
        if (add && !tabMenuOpen()) toggleTabMenu(add, p.id);
      }, 250);
      return () => clearTimeout(t);
    },
  },
  {
    target: (p) => `.project[data-drop="${p.id}"]`, side: "right", title: "One task, one worktree",
    body: () => <><Caps id="new-worktree" /> makes a branch in its own folder, with its own windows and accent, right under its project. Give an agent a task there and keep working here. Finish it from git once it's merged.</>,
    try: { label: () => <>Make one: <Do id="new-worktree" /></>, done: (p, b) => worktreesOf(p.id).length > b.worktrees },
  },
];

/** Open the sample project (writing its folder the first time) and start at the first stop. */
export async function startTour() {
  let p = sample();
  if (!p) {
    try {
      addSampleProject(await invoke<string>("tour_folder"));
    } catch (e) {
      flash(`tour: ${e}`);
      return;
    }
    p = sample()!;
  } else {
    setApp("activeProject", p.id);
    goSpace(p.id, 0);
  }
  setStep(0);
  setMode("tour");
}

function finish() {
  setToured();
  setMode("end");
}

function close() {
  setToured();
  setMode(null);
}

/** Close the sample project and the worktrees made in it during the tour. Their folders stay, as any project's do. */
function dropSample() {
  const p = sample();
  if (!p) return;
  worktreesOf(p.id).forEach(dropProject);
  dropProject(p);
}

export function Tour() {
  let spot!: HTMLDivElement;
  let card: HTMLDivElement | undefined;
  const [base, setBase] = createSignal<Base | null>(null);
  const [did, setDid] = createSignal(false);
  const stop = () => STOPS[step()];
  const next = () => (step() < STOPS.length - 1 ? setStep(step() + 1) : finish());
  /** The tour runs in the sample project, or in a worktree made from it. */
  const here = () => {
    const p = sample();
    return !!p && (app.activeProject === p.id || worktreesOf(p.id).some((w) => w.id === app.activeProject));
  };

  // A fresh baseline for each stop, and whatever the stop opens; the tick latches once its check passes.
  createEffect(on([step, mode], () => {
    const p = sample();
    setDid(false);
    setBase(p ? baseOf(p) : null);
    if (mode() !== "tour" || !p) return;
    const undo = stop().enter?.(p);
    if (undo) onCleanup(undo);
  }));
  createEffect(() => {
    const p = sample(), b = base(), t = stop().try;
    if (mode() === "tour" && p && b && !did() && t.done(p, b)) setDid(true);
  });
  // Done: show the tick for a moment, then move on. Next still works for anyone reading ahead.
  createEffect(on(did, (d) => {
    if (!d) return;
    const at = step();
    const t = window.setTimeout(() => {
      if (mode() === "tour" && step() === at) next();
    }, 1200);
    onCleanup(() => clearTimeout(t));
  }));
  // Closing the sample project ends the tour.
  createEffect(() => {
    if (tourOpen() && !sample()) close();
  });

  // Follow the target every frame: windows tile, the sidebar folds, popovers open.
  let raf = 0;
  const follow = () => {
    raf = requestAnimationFrame(follow);
    const p = sample();
    if (mode() !== "tour" || !p || !card) return;
    const el = here() ? document.querySelector(stop().target(p)) : null;
    const r = el?.getBoundingClientRect();
    const pad = 4, W = innerWidth, H = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight;
    if (!r || !r.width) {
      spot.style.display = "none";
      Object.assign(card.style, { left: `${(W - cw) / 2}px`, top: `${(H - ch) / 2}px` });
      return;
    }
    Object.assign(spot.style, { display: "", left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    let x = r.left, y = r.bottom + 14;
    if (stop().side === "right") [x, y] = [r.right + 16, r.top + 30];
    else if (stop().side === "above") y = r.top - ch - 14;
    const a = stop().avoid && document.querySelector(stop().avoid!)?.getBoundingClientRect();
    if (a && a.width) {
      // Beside the popover if there is room on its right, else its left, else under it.
      if (a.right + cw + 14 < W - 12) [x, y] = [a.right + 14, a.top];
      else if (a.left - cw - 14 > 12) [x, y] = [a.left - cw - 14, a.top];
      else y = a.bottom + 14;
    }
    card.style.left = `${Math.max(12, Math.min(W - cw - 12, x))}px`;
    card.style.top = `${Math.max(12, Math.min(H - ch - 12, y))}px`;
  };
  createEffect(() => {
    cancelAnimationFrame(raf);
    if (mode() === "tour") follow();
  });
  onCleanup(() => cancelAnimationFrame(raf));

  const openAs = (tab: "open" | "new" | "clone") => {
    setMode(null);
    openProjectDialog(undefined, tab);
  };

  return (
    <>
      <Show when={mode() === "tour"}>
        <div class="tour-spot" ref={spot} />
        <div class="tour-card" ref={card} role="dialog" aria-label="Tour">
          <Show
            when={here()}
            fallback={
              <>
                <h4>The tour is paused</h4>
                <p>It runs in the <b>tour</b> project.</p>
                <div class="row">
                  <button class="g-btn quiet" onClick={close}>End the tour</button>
                  <button class="g-btn primary" onClick={() => setApp("activeProject", sample()!.id)}>Back to the tour</button>
                </div>
              </>
            }
          >
            <div class="tour-rail">
              <For each={STOPS}>
                {(s, i) => <button classList={{ on: i() === step(), past: i() < step() }} title={s.title} aria-label={`Stop ${i() + 1}: ${s.title}`} onClick={() => setStep(i())} />}
              </For>
            </div>
            <div class="tn">{step() + 1} of {STOPS.length}</div>
            <h4>{stop().title}</h4>
            <p>{stop().body()}</p>
            <div class="try" classList={{ did: did() }}>{did() ? "✓ That's it" : <>Try it: {stop().try.label(sample()!)}</>}</div>
            <div class="row">
              <button class="g-btn quiet" onClick={finish}>Skip tour</button>
              <span class="grow" />
              <Show when={step() > 0}>
                <button class="g-btn" onClick={() => setStep(step() - 1)}>Back</button>
              </Show>
              <button class="g-btn primary" onClick={next}>{step() === STOPS.length - 1 ? "Finish" : "Next"}</button>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={mode() === "end"}>
        <Modal label="Tour finished" dismiss={false}>
          <div class="tour-end">
            <h3>Now open your own</h3>
            <p>Any folder on this computer or on a server you reach over ssh. The <b>tour</b> project stays in the sidebar until you close it.</p>
            <div class="tour-picks">
              <button onClick={() => openAs("open")}><b>Open a folder</b><span>One you already have</span></button>
              <button onClick={() => openAs("new")}><b>New folder</b><span>Start fresh, with git init</span></button>
              <button onClick={() => openAs("clone")}><b>Clone a repo</b><span>From a git URL or GitHub</span></button>
            </div>
            <ul class="tour-later">
              <li><Caps id="appearance" /> <b>Appearance</b> · name, icon, accent, backdrop and transparency for each project</li>
              <li><code>tri .</code> · opens the folder you're in from any terminal (Settings › Command line)</li>
              <li><b>Your phone</b> · watch and answer agents over Tailscale (Settings › Remote)</li>
              <li><Caps id="palette" /> › <b>Take the tour</b> · replays this</li>
            </ul>
            <div class="row">
              <button class="g-btn quiet" onClick={() => { setMode(null); dropSample(); }}>Close the tour project</button>
              <span class="grow" />
              <button class="g-btn" onClick={() => void startTour()}>Replay</button>
            </div>
          </div>
        </Modal>
      </Show>
    </>
  );
}
