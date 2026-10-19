// Settings for agent signals: a sound per signal, when to alert, desktop notifications. The same
// form serves the status line's bell (app-wide, project = undefined) and Appearance › Signals
// (one project, where every field can also follow the app-wide default).

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { AlertMode, Project, SoundEvent, app, setNotify, setProjectNotify } from "./state";
import { EVENTS, SOUNDS, desktopFor, playFor, playSound, uploadSound } from "./signals";
import { Icon } from "./lucide";

export function SignalsForm(props: { project?: Project }) {
  const p = () => props.project;
  const n = () => p()?.notify ?? {};
  let fileEl: HTMLInputElement | undefined;
  let uploadFor: SoundEvent | null = null;

  const value = (ev: SoundEvent) => (p() ? n()[ev] ?? "default" : app.notify[ev]);
  const play = (ev: SoundEvent) => {
    const proj = p();
    if (proj) void playFor(proj, ev);
    else playSound(app.notify[ev]);
  };
  const choose = (ev: SoundEvent, v: string, el: HTMLSelectElement) => {
    const proj = p();
    if (v === "upload") {
      el.value = value(ev);
      uploadFor = ev;
      return fileEl?.click();
    }
    if (proj) setProjectNotify(proj.id, { [ev]: v === "default" ? undefined : v });
    else setNotify({ [ev]: v });
    play(ev);
  };
  const options = (ev: SoundEvent) => [
    ...(p() ? [["default", `Default · ${SOUNDS[app.notify[ev]]?.name ?? "Off"}`]] : []),
    ...Object.entries(SOUNDS).map(([k, s]) => [k, s.name]),
    ...(p() && n()[ev] === "custom" ? [["custom", n().files?.[ev] ?? "Your sound"]] : []),
    ["off", "Off"],
    ...(p() ? [["upload", "Upload a sound…"]] : []),
  ];

  const alerts = (): [AlertMode | "default", string][] => [
    ...(p() ? [["default", "Default"] as [AlertMode | "default", string]] : []),
    ["away", p() ? "Away" : "When away"],
    ["always", "Always"],
    ["badge", "Badge only"],
  ];
  const alert = () => (p() ? n().alert ?? "default" : app.notify.alert);
  const setAlert = (v: AlertMode | "default") => {
    const proj = p();
    if (proj) setProjectNotify(proj.id, { alert: v === "default" ? undefined : v });
    else if (v !== "default") setNotify({ alert: v });
  };
  const desktop = () => (p() ? desktopFor(p()!) : app.notify.desktop);
  const setDesktop = (on: boolean) => {
    const proj = p();
    if (proj) setProjectNotify(proj.id, { desktop: on === app.notify.desktop ? undefined : on });
    else setNotify({ desktop: on });
  };

  return (
    <>
      <h4>Sounds</h4>
      <div class="sgrid">
        <For each={EVENTS}>
          {([ev, label]) => (
            <>
              <span class={`lbl s-${ev}`}><span class={`sg s-${ev}`} />{label}</span>
              <select aria-label={`Sound for ${label.toLowerCase()}`} onChange={(e) => choose(ev, e.currentTarget.value, e.currentTarget)}>
                <For each={options(ev)}>{([k, name]) => <option value={k} selected={k === value(ev)}>{name}</option>}</For>
              </select>
              <button type="button" class="play" title="Play" aria-label={`Play the ${label.toLowerCase()} sound`} onClick={() => play(ev)}>
                <Icon name="play" size={12} />
              </button>
            </>
          )}
        </For>
      </div>
      <input
        ref={fileEl}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          const proj = p();
          if (f && proj && uploadFor) uploadSound(proj, uploadFor, f);
        }}
      />
      <h4>Alert</h4>
      <div class="seg wide" role="group" aria-label="When to alert">
        <For each={alerts()}>
          {([k, name]) => <button type="button" aria-pressed={alert() === k} onClick={() => setAlert(k)}>{name}</button>}
        </For>
      </div>
      <label class="chk">
        <input type="checkbox" checked={desktop()} onChange={(e) => setDesktop(e.currentTarget.checked)} />
        Desktop notifications
        <Show when={p() && n().desktop === undefined}><span class="muted">· default</span></Show>
      </label>
      <Show when={!p()}>
        <div class="row">
          Volume
          <input type="range" min="0" max="100" step="5" value={String(app.notify.volume)} onInput={(e) => setNotify({ volume: +e.currentTarget.value })} onChange={() => playSound(app.notify.blocked)} />
          <span class="val">{app.notify.volume}%</span>
        </div>
        <label class="chk">
          <input type="checkbox" checked={app.notify.dnd} onChange={(e) => setNotify({ dnd: e.currentTarget.checked })} />
          Do not disturb <span class="muted">· badges only</span>
        </label>
      </Show>
      <p class="snote">
        {p() ? "Away: you're not looking at that window (another project or workspace, or tri-code is in the background). " : "Projects follow these unless Appearance › Signals sets their own. "}
        The badges always show: claude and pi report working, needs you, done and error over <code>OSC 7501</code>, locally and over ssh (not through tmux).
      </p>
    </>
  );
}

const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
export const signalsOpen = () => anchor() !== null;
export const closeSignals = () => setAnchor(null);
export function toggleSignals(a?: HTMLElement | null) {
  if (anchor()) return closeSignals();
  setAnchor(a ?? document.getElementById("bellBtn"));
}

/** The status line's bell. Mount once (in App); Escape is handled in hotkeys.ts. */
export function SignalsPopover() {
  const onDown = (e: PointerEvent) => {
    if (anchor() && !(e.target as Element).closest(".pop, #bellBtn")) closeSignals();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  /** Above the bell, kept inside the window. */
  const place = (el: HTMLElement, a: HTMLElement) => {
    const r = a.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8)) + "px";
    el.style.top = Math.max(8, r.top - el.offsetHeight - 6) + "px";
  };

  return (
    <Show when={anchor()} keyed>
      {(a) => (
        <div class="pop" role="dialog" aria-label="Signals and sounds" ref={(el) => requestAnimationFrame(() => place(el, a))}>
          <div class="ttl">Signals <span>every project</span></div>
          <SignalsForm />
        </div>
      )}
    </Show>
  );
}
