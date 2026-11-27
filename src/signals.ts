// Agent signals: claude and pi report whether they are working, waiting for you, done or failed
// with the Program Status Protocol (OSC 7501). terms.ts answers their probe and stores each report
// on the tab's Live entry; this module turns reports into badges, sounds and desktop notifications.
// The reports travel in the pty, so they work locally and over ssh and shpool; tmux drops them.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { createSignal } from "solid-js";
import { produce } from "solid-js/store";
import {
  AgentState, AlertMode, Project, SoundEvent, Tab, agentOf, app, defaultNotify, focusTab, live, newId, projectById, repoOf, setApp, setNotify, space, tabName,
} from "./state";
import { flash } from "./ui";
import { keyOf } from "./keymap";
import { type Sig, sigOf } from "./sigs";
export { busySignals, sigOf, type Sig } from "./sigs";

export const SIG_RANK: Record<Sig, number> = { blocked: 3, error: 2, done: 1, working: 0 };
export const SIG_TEXT: Record<Sig, string> = { working: "working", blocked: "needs you", done: "done", error: "error" };
export const EVENTS: [SoundEvent, string][] = [["blocked", "Needs input"], ["done", "Done"], ["error", "Error"]];

/** The loudest signal among some windows. `working` counts only when asked for. */
export function topSig(tabs: Tab[], withWorking = false): Sig | null {
  let best: Sig | null = null;
  for (const t of tabs) {
    const s = sigOf(t);
    if (s && (withWorking || s !== "working") && (!best || SIG_RANK[s] > SIG_RANK[best])) best = s;
  }
  return best;
}

/** One line per window with a signal, for a project's tooltip. */
export const sigSummary = (p: Project) =>
  p.tabs.filter((t) => sigOf(t)).map((t) => `${tabName(t)}: ${SIG_TEXT[sigOf(t)!]}`).join("\n");

const STATES: AgentState[] = ["working", "blocked", "done", "error"];

/** Signal colours changed in Settings › Signals override the theme's --state-* tokens on <html>. */
export function applySignalColors() {
  const st = document.documentElement.style, c = app.settings.signalColors ?? {};
  for (const s of STATES) {
    if (c[s]) st.setProperty(`--state-${s}`, c[s]!);
    else st.removeProperty(`--state-${s}`);
  }
}

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

/** Loaded audio files as blob: URLs, by `system:<name>` or the bg.rs key of an uploaded file. */
const loaded = new Map<string, Promise<string | undefined>>();

function loadUrl(key: string, load: () => Promise<string | null>): Promise<string | undefined> {
  let p = loaded.get(key);
  if (!p) {
    p = load()
      .then(async (dataUrl) => (dataUrl ? URL.createObjectURL(await (await fetch(dataUrl)).blob()) : undefined))
      .catch((e) => {
        console.warn(`sound ${key} failed to load:`, e);
        loaded.delete(key);
        return undefined;
      });
    loaded.set(key, p);
  }
  return p;
}

const fileUrl = (key: string) => loadUrl(key, () => invoke<string | null>("sound_load", { key }));
const mineKey = (id: string) => `my_${id}`;

/** Drop the loaded copy of an uploaded file, so the next play reads it again (an import replaced it). */
export function reloadSound(key: string) {
  const p = loaded.get(key);
  loaded.delete(key);
  void p?.then((u) => u && URL.revokeObjectURL(u));
}

async function playUrl(url: Promise<string | undefined>, vol: number) {
  const u = await url;
  if (!u) return;
  const a = new Audio(u);
  a.volume = vol;
  a.play().catch((e) => console.warn("sound failed:", e));
}

/**
 * Play a sound by its id (see NotifySettings): built-ins are synthesized, system sounds and My
 * sounds are files loaded on first use. "custom", a project's own upload, needs that file's `custom` URL.
 */
export function playSound(id: string, custom?: Promise<string | undefined>) {
  if (!id || id === "off") return;
  const vol = app.notify.volume / 100;
  if (id === "custom") return void (custom && playUrl(custom, vol));
  if (id.startsWith("system:")) return void playUrl(loadUrl(id, () => invoke<string | null>("system_sound_load", { name: id.slice(7) })), vol);
  if (id.startsWith("mine:")) return void playUrl(fileUrl(mineKey(id.slice(5))), vol);
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

/** A project's own upload from before My sounds, by `<project id>-<event>`. */
const soundKey = (projectId: string, ev: SoundEvent) => `${projectId}-${ev}`;

/** Play the sound a project gives a signal, or the one window `t`'s command has of its own. */
export async function playFor(p: Project, ev: SoundEvent, t?: Tab) {
  let id = (t && agentOf(t)?.sounds?.[ev]) || soundFor(p, ev);
  // One of My sounds that is gone (a configuration imported without it) plays the app-wide sound, or tri-code's.
  const gone = (x: string) => x.startsWith("mine:") && !app.notify.mine.some((m) => `mine:${m.id}` === x);
  if (gone(id)) id = gone(app.notify[ev]) ? defaultNotify()[ev] : app.notify[ev];
  playSound(id, id === "custom" ? fileUrl(soundKey(repoOf(p).id, ev)) : undefined);
}

/** The OS's alert sounds by name (syssounds.rs), asked for once, when a sound picker first shows. */
const [systemList, setSystemList] = createSignal<string[]>([]);
let systemAsked = false;
export function loadSystemSounds() {
  if (systemAsked) return;
  systemAsked = true;
  invoke<string[]>("system_sounds").then(setSystemList, (e) => console.warn("system_sounds failed:", e));
}
export const systemSounds = systemList;
/** What the picker calls the system's sounds. */
export const SYSTEM_NAME = /Mac/.test(navigator.userAgent) ? "macOS" : /Windows/.test(navigator.userAgent) ? "Windows" : "Linux";

/** A sound's name for pickers and tooltips. `p` and `ev` name a project's own upload ("custom"). */
export function soundName(id: string | undefined, p?: Project, ev?: SoundEvent): string {
  if (!id || id === "off") return "Off";
  if (id.startsWith("system:")) return id.slice(7);
  if (id.startsWith("mine:")) return app.notify.mine.find((m) => m.id === id.slice(5))?.name ?? "Missing sound";
  if (id === "custom") return (p && ev && repoOf(p).notify?.files?.[ev]) || "Your sound";
  return SOUNDS[id]?.name ?? id;
}

/** Larger files are songs, not signals; and they travel inside exported configurations. */
export const MY_SOUND_MAX = 2 * 1024 * 1024;
const AUDIO_EXT = /\.(aiff?|caf|wav|mp3|m4a|aac|ogg|oga|opus|flac|webm)$/i;

/** Add an audio file to My sounds. Returns its sound id, or undefined (after saying why) when it can't. */
export async function addMySound(file: File): Promise<string | undefined> {
  if (!file.type.startsWith("audio/") && !AUDIO_EXT.test(file.name)) {
    flash(`${file.name} isn't an audio file`);
    return undefined;
  }
  if (file.size > MY_SOUND_MAX) {
    flash(`${file.name} is over 2 MB; pick a short sound`);
    return undefined;
  }
  const id = newId();
  try {
    const dataUrl = await new Promise<string>((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => fail(r.error);
      r.readAsDataURL(file);
    });
    await invoke("sound_save", { key: mineKey(id), dataUrl });
  } catch (e) {
    flash(`couldn't save sound: ${e}`);
    return undefined;
  }
  loaded.set(mineKey(id), Promise.resolve(URL.createObjectURL(file)));
  setNotify({ mine: [...app.notify.mine, { id, name: file.name.replace(/\.[^.]+$/, "") || file.name }] });
  return `mine:${id}`;
}

/** Remove one of My sounds. Signals that played it go back to the default: tri-code's for the app, the project's for a project or command. */
export function removeMySound(id: string) {
  const ref = `mine:${id}`, def = defaultNotify();
  const name = soundName(ref);
  let used = false;
  setApp(produce((s) => {
    s.notify.mine = s.notify.mine.filter((m) => m.id !== id);
    for (const [ev] of EVENTS) {
      if (s.notify[ev] === ref) {
        s.notify[ev] = def[ev];
        used = true;
      }
      for (const o of [...s.projects.map((p) => p.notify), ...s.agents.map((a) => a.sounds)]) {
        if (o?.[ev] !== ref) continue;
        delete o[ev];
        used = true;
      }
    }
    for (const a of s.agents) if (a.sounds && !Object.keys(a.sounds).length) delete a.sounds;
  }));
  reloadSound(mineKey(id));
  invoke("sound_delete", { key: mineKey(id) }).catch((e) => console.warn("sound_delete failed:", e));
  flash(used ? `removed ${name}; the signals that played it are back to their defaults` : `removed ${name}`);
}

/** Drop a project's own uploaded sounds (project removed). */
export function forgetSounds(projectId: string) {
  for (const [ev] of EVENTS) {
    const key = soundKey(projectId, ev);
    reloadSound(key);
    invoke("sound_delete", { key }).catch((e) => console.warn("sound_delete failed:", e));
  }
}

let permission: Promise<boolean> | undefined;

/** Which agent a desktop notification is about, carried in its `extra` so a click can go there. */
type NotifyTarget = { projectId: string; tabId: string };

async function notify(title: string, body: string, extra: NotifyTarget) {
  permission ??= (async () => (await isPermissionGranted()) || (await requestPermission()) === "granted")();
  try {
    if (await permission) sendNotification({ title, body, extra });
  } catch (e) {
    console.warn("notification failed:", e);
  }
}

const WHAT: Record<SoundEvent, string> = { blocked: "needs input", done: "is done", error: "stopped with an error" };

type AlertListener = (ev: SoundEvent, tab: Tab, title: string, body: string) => void;
const alertListeners: AlertListener[] = [];

/** Hear each signal that alerts, as the desktop notification words it. Remote Control (phone.ts)
 *  pushes them to phones this way, so this module doesn't import it. */
export function onAlert(fn: AlertListener) {
  alertListeners.push(fn);
}

/**
 * A tab's agent changed state (terms.ts). `looking`: its window was on screen in a focused app.
 * Working never alerts; the rest play the project's sound and notify, by its alert setting, and
 * tell the onAlert listeners (paired phones, phone.ts).
 */
export function onSignal(projectId: string, t: Tab, state: AgentState, msg: string, looking: boolean) {
  const p = projectById(projectId);
  if (!p || state === "working") return;
  const mode = alertFor(p);
  if (mode === "badge" || (mode === "away" && looking)) return;
  void playFor(p, state, t);
  const title = live[t.id]?.title;
  const head = `${tabName(t)} ${WHAT[state]}`;
  const body = [p.name, title, msg && msg !== title ? msg : ""].filter(Boolean).join(" · ");
  if (desktopFor(p)) void notify(head, body, { projectId, tabId: t.id });
  for (const fn of alertListeners) fn(state, t, head, body);
}

// A click on a notification raises the app and focuses the agent it was about. Notifications only
// report clicks when a listener existed as they were shown, so listen from the start.
onAction(async ({ actionId, notification }) => {
  if (actionId !== "tap") return;
  const { projectId, tabId } = (notification?.extra ?? {}) as Partial<NotifyTarget>;
  const w = getCurrentWindow();
  try {
    await w.unminimize();
    await w.show();
    await w.setFocus();
  } catch (e) {
    console.warn("couldn't raise the window:", e);
  }
  const p = projectId ? projectById(projectId) : undefined;
  if (!p || !p.tabs.some((t) => t.id === tabId)) return flash("that agent is gone");
  focusTab(p.id, tabId!);
}).catch((e) => console.warn("notification clicks unavailable:", e));

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
