// Agent signals: claude and pi report whether they are working, waiting for you, done or failed
// with the Program Status Protocol (OSC 7501). terms.ts answers their probe and stores each report
// on the tab's Live entry; this module turns reports into badges, sounds and desktop notifications.
// The reports travel in the pty, so they work locally and over ssh and shpool; tmux drops them.

import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import {
  AgentState, AlertMode, Project, SoundEvent, Tab, app, focusTab, live, projectById, repoOf, setNotify, setProjectNotify, space, tabName,
} from "./state";
import { flash } from "./ui";
import { keyOf } from "./keymap";

/** What a window signals now. `working` only badges the tab strip, title bar and status line. */
export type Sig = AgentState;

export const SIG_RANK: Record<Sig, number> = { blocked: 3, error: 2, done: 1, working: 0 };
export const SIG_TEXT: Record<Sig, string> = { working: "working", blocked: "needs you", done: "done", error: "error" };
export const EVENTS: [SoundEvent, string][] = [["blocked", "Needs input"], ["done", "Done"], ["error", "Error"]];

/** Blocked until answered, done and error until seen, working while it runs. A bell in a plain shell counts as blocked. */
export function sigOf(t: Tab): Sig | null {
  const l = live[t.id];
  const a = l?.agent;
  if (a?.state === "blocked" || a?.state === "working") return a.state;
  if (a && !a.seen) return a.state;
  return l?.attention ? "blocked" : null;
}

/** The loudest signal among some windows. `working` counts only when asked for. */
export function topSig(tabs: Tab[], withWorking = false): Sig | null {
  let best: Sig | null = null;
  for (const t of tabs) {
    const s = sigOf(t);
    if (s && (withWorking || s !== "working") && (!best || SIG_RANK[s] > SIG_RANK[best])) best = s;
  }
  return best;
}

/** One line per window that needs you, for a project's tooltip. */
export const sigSummary = (p: Project) =>
  p.tabs.filter((t) => sigOf(t) && sigOf(t) !== "working").map((t) => `${tabName(t)}: ${SIG_TEXT[sigOf(t)!]}`).join("\n");

/** Built-in sounds, synthesized so the app ships no audio files: [frequency Hz, start s, length s]. */
export const SOUNDS: Record<string, { name: string; notes: [number, number, number][]; type?: OscillatorType }> = {
  chime: { name: "Chime", notes: [[880, 0, 0.14], [1318.5, 0.11, 0.24]] },
  ping: { name: "Ping", notes: [[1568, 0, 0.2]] },
  soft: { name: "Soft", notes: [[523.25, 0, 0.16], [659.25, 0.09, 0.24]] },
  bubble: { name: "Bubble", notes: [[392, 0, 0.06], [587.3, 0.05, 0.06], [880, 0.1, 0.12]] },
  knock: { name: "Knock", notes: [[196, 0, 0.08], [196, 0.15, 0.08]], type: "triangle" },
};

// A Worktree alerts the way its repo project is set to.
export const soundFor = (p: Project, ev: SoundEvent) => repoOf(p).notify?.[ev] ?? app.notify[ev];
export const alertFor = (p: Project): AlertMode => (app.notify.dnd ? "badge" : repoOf(p).notify?.alert ?? app.notify.alert);
export const desktopFor = (p: Project) => repoOf(p).notify?.desktop ?? app.notify.desktop;

let ctx: AudioContext | undefined;

/** Play a built-in sound, or an uploaded one when `id` is "custom". */
export function playSound(id: string, custom?: string) {
  if (!id || id === "off") return;
  const vol = app.notify.volume / 100;
  if (id === "custom") {
    if (!custom) return;
    const a = new Audio(custom);
    a.volume = vol;
    a.play().catch((e) => console.warn("sound failed:", e));
    return;
  }
  const s = SOUNDS[id];
  if (!s) return;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  const t0 = ctx.currentTime + 0.02;
  for (const [f, at, len] of s.notes) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = s.type ?? "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + at);
    g.gain.linearRampToValueAtTime(0.22 * vol, t0 + at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + at);
    o.stop(t0 + at + len + 0.02);
  }
}

/** Uploaded sounds by `<project id>-<event>`, as blob: URLs; loaded on first use. */
const customSounds = new Map<string, string>();
const soundKey = (projectId: string, ev: SoundEvent) => `${projectId}-${ev}`;

async function customSound(projectId: string, ev: SoundEvent): Promise<string | undefined> {
  const key = soundKey(projectId, ev);
  if (customSounds.has(key)) return customSounds.get(key);
  try {
    const dataUrl = await invoke<string | null>("sound_load", { key });
    if (!dataUrl) return undefined;
    const url = URL.createObjectURL(await (await fetch(dataUrl)).blob());
    customSounds.set(key, url);
    return url;
  } catch (e) {
    console.warn("sound_load failed:", e);
    return undefined;
  }
}

/** Play the sound a project gives a signal. */
export async function playFor(p: Project, ev: SoundEvent) {
  const id = soundFor(p, ev);
  playSound(id, id === "custom" ? await customSound(repoOf(p).id, ev) : undefined);
}

/** Store an uploaded audio file as the project's sound for a signal. */
export function uploadSound(p: Project, ev: SoundEvent, file: File) {
  const r = new FileReader();
  r.onload = async () => {
    try {
      await invoke("sound_save", { key: soundKey(p.id, ev), dataUrl: String(r.result) });
    } catch (e) {
      flash(`couldn't save sound: ${e}`);
      return;
    }
    const old = customSounds.get(soundKey(p.id, ev));
    if (old) URL.revokeObjectURL(old);
    customSounds.set(soundKey(p.id, ev), URL.createObjectURL(file));
    setProjectNotify(p.id, { [ev]: "custom", files: { ...p.notify?.files, [ev]: file.name } });
    void playFor(p, ev);
    flash(`${p.name}: ${file.name} plays for ${SIG_TEXT[ev]}`);
  };
  r.readAsDataURL(file);
}

/** Drop a project's uploaded sounds (project removed). */
export function forgetSounds(projectId: string) {
  for (const [ev] of EVENTS) {
    const key = soundKey(projectId, ev);
    const url = customSounds.get(key);
    if (url) URL.revokeObjectURL(url);
    customSounds.delete(key);
    invoke("sound_delete", { key }).catch((e) => console.warn("sound_delete failed:", e));
  }
}

let permission: Promise<boolean> | undefined;

async function notify(title: string, body: string) {
  permission ??= (async () => (await isPermissionGranted()) || (await requestPermission()) === "granted")();
  try {
    if (await permission) sendNotification({ title, body });
  } catch (e) {
    console.warn("notification failed:", e);
  }
}

const WHAT: Record<SoundEvent, string> = { blocked: "needs input", done: "is done", error: "stopped with an error" };

/**
 * A tab's agent changed state (terms.ts). `looking`: its window was on screen in a focused app.
 * Working never alerts; the rest play the project's sound and notify, by its alert setting.
 */
export function onSignal(projectId: string, t: Tab, state: AgentState, msg: string, looking: boolean) {
  const p = projectById(projectId);
  if (!p || state === "working") return;
  const mode = alertFor(p);
  if (mode === "badge" || (mode === "away" && looking)) return;
  void playFor(p, state);
  if (desktopFor(p)) {
    const title = live[t.id]?.title;
    void notify(`${tabName(t)} ${WHAT[state]}`, [p.name, title, msg && msg !== title ? msg : ""].filter(Boolean).join(" · "));
  }
}

/** Alt+U: the next agent that needs you, across projects: waiting for input first, then errors, then finished work. */
export function nextSignal() {
  const active = app.projects.find((p) => p.id === app.activeProject);
  const all = app.projects.flatMap((p) => p.tabs.map((t) => ({ p, t, s: sigOf(t) })))
    .filter((x) => x.s && x.s !== "working" && !(x.p === active && x.t.space === x.p.ws && space(x.p).focus === x.t.id))
    .sort((a, b) => SIG_RANK[b.s!] - SIG_RANK[a.s!] || (live[a.t.id]?.agent?.at ?? 0) - (live[b.t.id]?.agent?.at ?? 0));
  const hit = all[0];
  if (!hit) return flash("no agent needs you");
  focusTab(hit.p.id, hit.t.id);
  flash(`${hit.p.name} · ${tabName(hit.t)} ${SIG_TEXT[hit.s!]}${all.length > 1 ? ` · ${all.length - 1} more${keyOf("next-signal") ? ` (${keyOf("next-signal")})` : ""}` : ""}`);
}

export function toggleDnd() {
  setNotify({ dnd: !app.notify.dnd });
  flash(app.notify.dnd ? "do not disturb: badges only" : "alerts back on");
}

// Audio starts suspended until a gesture; unlock it on the first click so a later signal can play.
document.addEventListener("pointerdown", () => {
  ctx ??= new AudioContext();
  void ctx.resume();
}, { once: true });
