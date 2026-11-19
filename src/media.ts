// Media Controls (Settings › Windows › Media, on unless turned off): what this machine is playing, from media.rs, and play / pause /
// skip / seek. The sidebar shows it above Settings (MediaDock.tsx); the popover lists the other players.
// Chosen from design/media-controls.html (variant C).

import { Channel, invoke } from "@tauri-apps/api/core";
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";
import { app } from "./state";
import { flash } from "./ui";

/** One player's session, as media.rs sends it. */
export type MediaSession = {
  id: string;
  /** The app, for people: "Spotify", "Edge". */
  app: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  /** Seconds into the track at `at` (Unix ms), when the app says. */
  position: number | null;
  at: number;
  duration: number | null;
  canPrev: boolean;
  canNext: boolean;
  canSeek: boolean;
  /** data: or http(s) URL. */
  art: string | null;
};

export type MediaAction = "toggle" | "next" | "prev" | "seek";

const [sessions, setSessions] = createSignal<MediaSession[]>([]);
/** The player picked in the popover; unset follows the OS's current one. */
const [picked, setPicked] = createSignal<string | null>(null);
/** The track hidden with ×, until another one plays. */
const [dismissed, setDismissed] = createSignal<string | null>(null);
/** Ticks while something plays, so positions move between reports. */
const [now, setNow] = createSignal(Date.now());
const [popAnchor, setPopAnchor] = createSignal<HTMLElement | null>(null);

const trackKey = (s: MediaSession) => `${s.id}\u001f${s.title}\u001f${s.artist}`;

export const mediaOn = () => app.settings.media !== false;
export const mediaSessions = sessions;
/** The session the controls act on: the picked one while it lasts, else the OS's current one. */
export const currentMedia = (): MediaSession | null => {
  const all = sessions();
  return all.find((s) => s.id === picked()) ?? all[0] ?? null;
};
/** Something is playing or paused, and it wasn't hidden. */
export const mediaShown = () => {
  const c = currentMedia();
  return mediaOn() && !!c && dismissed() !== trackKey(c);
};

/** Seconds into the track now: the last report plus the time since, while playing. */
export function positionOf(s: MediaSession): number | null {
  if (s.position == null) return null;
  const p = s.playing ? s.position + Math.max(0, now() - s.at) / 1000 : s.position;
  return s.duration ? Math.min(p, s.duration) : p;
}

/** 0–1 through the track, or null when the app doesn't say. */
export function progressOf(s: MediaSession): number | null {
  const p = positionOf(s);
  return p == null || !s.duration ? null : Math.min(1, Math.max(0, p / s.duration));
}

export const clock = (sec: number | null) => {
  if (sec == null || !Number.isFinite(sec)) return "–:––";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};

/** Run an action on the current session (or `id`). Play / pause and seek show at once; the next report confirms. */
export async function mediaControl(action: MediaAction, position?: number, id?: string) {
  const s = id ? sessions().find((x) => x.id === id) : currentMedia();
  if (!s) return;
  if (action === "toggle" || action === "seek") {
    const pos = action === "seek" ? position ?? 0 : positionOf(s);
    setSessions((all) => all.map((x) => (x.id === s.id ? { ...x, playing: action === "toggle" ? !x.playing : x.playing, position: pos, at: Date.now() } : x)));
  }
  try {
    await invoke("media_control", { id: s.id, action, position });
  } catch (e) {
    flash(`${s.app}: ${e}`);
  }
}

export function pickMedia(id: string) {
  setPicked(id);
}

/** Hide the dock until another track plays. */
export function dismissMedia() {
  const c = currentMedia();
  if (c) setDismissed(trackKey(c));
  closeMediaPop();
}

export const mediaPopOpen = () => popAnchor() !== null;
export const mediaPopAnchor = popAnchor;
export function openMediaPop(anchor: HTMLElement) {
  setPopAnchor(anchor);
}
export function closeMediaPop() {
  setPopAnchor(null);
}
export function toggleMediaPop(anchor: HTMLElement) {
  if (popAnchor()) closeMediaPop();
  else openMediaPop(anchor);
}

/** The session a hotkey or the palette acts on, or why there is none (flashed). */
function hotkeyTarget(): MediaSession | null {
  if (!mediaOn()) return (flash("media controls are off (Settings › Windows › Media)"), null);
  const c = currentMedia();
  if (!c) flash("nothing is playing");
  return c;
}

/** Play or pause from a hotkey or the palette. */
export function mediaPlayPause() {
  const c = hotkeyTarget();
  if (!c) return;
  void mediaControl("toggle");
  flash(`${c.playing ? "paused" : "playing"} · ${c.title}`);
}

/** Next or previous track from a hotkey or the palette. */
export function mediaSkip(dir: "next" | "prev") {
  const c = hotkeyTarget();
  if (!c) return;
  if (!(dir === "next" ? c.canNext : c.canPrev)) return flash(`${c.app} has no ${dir === "next" ? "next" : "previous"} track`);
  void mediaControl(dir);
  flash(`${dir === "next" ? "next" : "previous"} track · ${c.app}`);
}

createRoot(() => {
  // Watch while the preview is on. A new watch replaces the old one in Rust.
  createEffect(() => {
    if (!mediaOn()) return;
    const ch = new Channel<MediaSession[]>();
    ch.onmessage = (all) => {
      setSessions(all);
      setNow(Date.now());
      if (picked() && !all.some((s) => s.id === picked())) setPicked(null);
    };
    invoke("media_watch", { on: ch }).catch((e) => console.warn("media_watch:", e));
    onCleanup(() => {
      void invoke("media_unwatch");
      setSessions([]);
      closeMediaPop();
    });
  });
  // The clock runs only while something on screen is playing.
  createEffect(() => {
    if (!sessions().some((s) => s.playing)) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(t));
  });
  // The dock went away (the player closed): so does its popover.
  createEffect(() => {
    if (!mediaShown()) closeMediaPop();
  });
});
