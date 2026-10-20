// The tour (design/onboarding.html, variant D): a sample project already at work, and a
// spotlight that walks through eight stops. A stop can ask you to try something, and ticks
// once you have. Starts on a first launch; Alt+X › Take the tour replays it.

import { invoke } from "@tauri-apps/api/core";
import { For, JSX, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { Project, Tab, addSampleProject, app, goSpace, live, setApp, setToured } from "./state";
import { paletteOpen } from "./Palette";
import { openProjectDialog } from "./OpenProject";
import { dropProject } from "./Sidebar";
import { askDemo } from "./terms";
import { flash } from "./ui";

const [step, setStep] = createSignal(0);
/** "tour" while walking the stops, "end" for the closing card. */
const [mode, setMode] = createSignal<"tour" | "end" | null>(null);
export const tourOpen = () => mode() !== null;

const sample = () => app.projects.find((p) => p.sample);
const demoTab = (p: Project, kind: Tab["demo"]) => p.tabs.find((t) => t.demo === kind);

/** What the try-it checks compare against: the project as it was when the stop came up. */
type Base = { terms: number; files: string; accent: string; pi?: number };
const baseOf = (p: Project): Base => ({
  terms: p.tabs.filter((t) => t.kind === "term").length,
  files: p.tabs.filter((t) => t.kind === "file").map((t) => t.path).join("|"),
  accent: p.accent,
  pi: live[demoTab(p, "pi")?.id ?? ""]?.agent?.at,
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
  try?: { label: () => JSX.Element; done: (p: Project, base: Base) => boolean };
};

const K = (props: { k: string[] }) => <For each={props.k}>{(k) => <kbd>{k}</kbd>}</For>;

const STOPS: Stop[] = [
  {
    target: () => "aside", side: "right", title: "Projects, grouped by machine",
    body: () => <>Every folder you open sits under its environment: <b>local</b>, or a server you reach over ssh. Agents keep running when you switch to another project, and a dot on its icon tells you when one wants you.</>,
  },
  {
    target: () => "#spaces", side: "below", title: "Four workspaces per project",
    body: () => <>Each is a canvas of its own windows. Here claude, a dev server and the files are on 1, and pi is waiting on 2.</>,
    try: { label: () => <>Press <K k={["Alt", "2"]} /> to look, then <K k={["Alt", "1"]} /> to come back</>, done: (p) => p.ws !== 0 },
  },
  {
    target: () => ".top .tabs", side: "below", title: "Windows tile themselves",
    body: () => <>The tabs are this workspace's windows. <b>+</b> adds claude, pi, a shell, a browser, files, git or issues, and the canvas makes room. No dragging needed.</>,
    try: { label: () => <>Click <b>+</b> and open a shell</>, done: (p, b) => p.tabs.filter((t) => t.kind === "term").length > b.terms },
  },
  {
    target: () => "#where", side: "below", avoid: ".gtf", title: "Find any file",
    body: () => <>Click the project path, or press <K k={["Alt", "T"]} />, and type a few letters of a file name. <K k={["Enter"]} /> opens it in a file window; <K k={["Shift", "Enter"]} /> types <code>@path</code> into the agent instead.</>,
    try: { label: () => <>Press <K k={["Alt", "T"]} /> and open <code>Settings.tsx</code></>, done: (p, b) => p.tabs.filter((t) => t.kind === "file").map((t) => t.path).join("|") !== b.files },
  },
  {
    target: (p) => `.win[data-tab="${demoTab(p, "claude")?.id}"] .bar`, side: "below", title: "Agents say what they're doing",
    body: () => <>claude and pi report when they're working, need you, are done or fail. It shows in the title bar, on the window's tab, its workspace number and the project's icon. Nothing to set up.</>,
  },
  {
    target: () => ".status .sigs", side: "above", title: "Never miss one waiting on you",
    body: () => <>The status line counts agents across every project. When one you aren't looking at needs you, tri-code plays a sound and shows a notification, and <K k={["Alt", "U"]} /> takes you to it.</>,
    try: {
      label: () => (
        <>
          <button class="g-btn" onClick={() => { const t = sample() && demoTab(sample()!, "pi"); if (t) askDemo(t.id); }}>Make pi ask</button>{" "}
          then press <K k={["Alt", "U"]} /> and answer <kbd>y</kbd>
        </>
      ),
      done: (p, b) => {
        const a = live[demoTab(p, "pi")?.id ?? ""]?.agent;
        return !!a && a.at !== b.pi && a.state !== "blocked";
      },
    },
  },
  {
    target: () => "#themeBtn", side: "below", avoid: ".pop", title: "Make each project yours",
    body: () => <>Name, icon, accent colour and background, per project, so you can tell them apart at a glance. tri-code starts with the project's own logo when it finds one.</>,
    try: { label: () => <>Press <K k={["Alt", "P"]} /> and pick an accent colour</>, done: (p, b) => p.accent !== b.accent },
  },
  {
    target: () => "#palBtn", side: "below", avoid: ".pal", title: "Everything has a name",
    body: () => <><K k={["Alt", "X"]} /> runs any command by name: new windows, layouts, projects, worktrees, this tour. <K k={["Alt", "/"]} /> lists every key.</>,
    try: { label: () => <>Press <K k={["Alt", "X"]} /></>, done: () => paletteOpen() },
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

export function Tour() {
  let spot!: HTMLDivElement;
  let card: HTMLDivElement | undefined;
  const [base, setBase] = createSignal<Base | null>(null);
  const [did, setDid] = createSignal(false);
  const stop = () => STOPS[step()];
  const here = () => sample()?.id === app.activeProject;

  // A fresh baseline for each stop; the tick latches once its check passes.
  createEffect(on([step, mode], () => {
    const p = sample();
    setDid(false);
    setBase(p ? baseOf(p) : null);
  }));
  createEffect(() => {
    const p = sample(), b = base(), t = stop().try;
    if (mode() === "tour" && p && b && t && !did() && t.done(p, b)) setDid(true);
  });
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
    if (stop().side === "right") [x, y] = [r.right + 16, r.top + 48];
    else if (stop().side === "above") y = r.top - ch - 14;
    const a = stop().avoid && document.querySelector(stop().avoid!)?.getBoundingClientRect();
    if (a) {
      // Beside the popover if there is room on its left, else under it.
      if (a.left - cw - 14 > 12) [x, y] = [a.left - cw - 14, a.top];
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

  const next = () => (step() < STOPS.length - 1 ? setStep(step() + 1) : finish());

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
            <div class="tn">{step() + 1} of {STOPS.length}</div>
            <h4>{stop().title}</h4>
            <p>{stop().body()}</p>
            <Show when={stop().try}>
              {(t) => <div class="try" classList={{ did: did() }}>{did() ? "✓ That's it." : <>Try it: {t().label()}</>}</div>}
            </Show>
            <div class="row">
              <span class="dots">
                <For each={STOPS}>{(_, i) => <i classList={{ on: i() === step() }} />}</For>
              </span>
              <button class="g-btn quiet" onClick={finish}>Skip tour</button>
              <Show when={step() > 0}>
                <button class="g-btn" onClick={() => setStep(step() - 1)}>Back</button>
              </Show>
              <button class="g-btn primary" onClick={next}>{step() === STOPS.length - 1 ? "Finish" : "Next"}</button>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={mode() === "end"}>
        <div class="dialog-scrim">
          <div class="tour-end" role="dialog" aria-label="Tour finished">
            <h3>Now open your own</h3>
            <p>
              Pick a folder on this computer or on a server you reach over ssh. The <b>tour</b> project stays in the
              sidebar until you close it; <K k={["Alt", "X"]} /> › Take the tour replays this.
            </p>
            <div class="row">
              <button class="g-btn quiet" onClick={() => { const p = sample(); setMode(null); if (p) dropProject(p); }}>Close the tour project</button>
              <button class="g-btn" onClick={() => void startTour()}>Replay</button>
              <button class="g-btn primary" onClick={() => { setMode(null); openProjectDialog(); }}>Open project <K k={["Alt", "O"]} /></button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}

