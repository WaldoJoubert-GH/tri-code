// Remote Control: tri-code on your phone. phone.rs serves the phone page over Tailscale;
// this module turns it on and off (Settings › Remote), keeps it fed with a snapshot of the
// projects, their windows and signals (and the terminals' last lines for the tiles), and pushes
// a signal to paired phones when one alerts.
// Chosen from design/remote-control.html (connection A, desktop B, phone list A); the
// project-first phone page from design/remote-view.html (variant B).

import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Project, type SoundEvent, type Tab, activePage, app, envIcon, envName, isLocalHost, live, repoOf, setSettings, tabIcon, tabName } from "./state";
import { onAlert } from "./signals";
import { sigOf } from "./sigs";
import { envLocked } from "./envlock";
import { iconSvg } from "./lucide";
import { screenTail } from "./terms";
import { labelOf, tileLabel } from "./worktrees";
import { answerPhones, phoneCommands } from "./phoneask";
import { flash } from "./ui";

export type PhoneDevice = { id: string; name: string; added: number; seen: number; online: boolean; push: boolean };
/** How a phone reaches tri-code: over Tailscale (HTTPS, pushes), the local network (HTTP, no
 *  pushes), or only this computer, for a tunnel or proxy of your own. */
export type PhoneReach = "tailscale" | "lan" | "local";
/** What Settings › Remote can change; kept in phone.json beside the pairings, not state.json. */
export type PhoneConfig = { reach: PhoneReach; port: number; tsPort: number; address: string };
/** `on`: it should be serving (phone.json), so it starts with the app until turned off. */
export type PhoneStatus = { url: string | null; on: boolean; devices: PhoneDevice[] } & PhoneConfig;
export type PairInfo = { code: string; url: string; qr: string; seconds: number };

const [status, setStatus] = createSignal<PhoneStatus>({ url: null, on: false, devices: [], reach: "tailscale", port: 7520, tsPort: 7443, address: "" });
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal("");
const [pairing, setPairing] = createSignal<(PairInfo & { until: number }) | null>(null);

export { status as phoneStatus, busy as phoneBusy, error as phoneError, pairing as phonePairing };

/** Signals that reach a phone: all of them unless Settings › Remote says otherwise. */
export const PUSH_DEFAULT: Record<SoundEvent, boolean> = { blocked: true, error: true, done: true };
export const pushesFor = (ev: SoundEvent) => app.settings.remote?.push?.[ev] ?? PUSH_DEFAULT[ev];

export function setPushFor(ev: SoundEvent, on: boolean) {
  setSettings({ remote: { ...app.settings.remote, push: { ...app.settings.remote?.push, [ev]: on } } });
}

async function refresh() {
  try {
    setStatus(await invoke<PhoneStatus>("phone_status"));
  } catch (e) {
    console.warn("phone_status failed:", e);
  }
}

/** While it should be on but couldn't start (Tailscale not up yet after login, say), try again. */
const RETRY_MS = 30_000;
let retry: number | undefined;

export async function startPhone(): Promise<boolean> {
  clearTimeout(retry);
  setBusy(true);
  setError("");
  try {
    setStatus(await invoke<PhoneStatus>("phone_start"));
    return true;
  } catch (e) {
    setError(String(e));
    return false;
  } finally {
    setBusy(false);
  }
}

/** Launch: start it if it was on, and keep trying until it starts or is turned off. */
async function resume() {
  await refresh();
  if (!status().on || status().url) return;
  if (await startPhone()) return;
  retry = window.setTimeout(() => void resume(), RETRY_MS);
}

export async function stopPhone() {
  clearTimeout(retry);
  setBusy(true);
  setPairing(null);
  try {
    await invoke("phone_stop");
  } catch (e) {
    setError(String(e));
  } finally {
    setBusy(false);
    void refresh();
  }
}

export async function pairPhone() {
  try {
    const p = await invoke<PairInfo>("phone_pair");
    setPairing({ ...p, until: Date.now() + p.seconds * 1000 });
  } catch (e) {
    setError(String(e));
  }
}

export const cancelPairing = () => setPairing(null);

/** Change how phones reach tri-code or its ports. While it serves, it starts again that way. */
export async function setPhoneConfig(change: Partial<PhoneConfig>) {
  const s = status();
  const config: PhoneConfig = { reach: s.reach, port: s.port, tsPort: s.tsPort, address: s.address, ...change };
  setBusy(true);
  setError("");
  setPairing(null);
  try {
    setStatus(await invoke<PhoneStatus>("phone_config", { config }));
  } catch (e) {
    setError(String(e));
    void refresh();
  } finally {
    setBusy(false);
  }
}

export function forgetPhone(d: PhoneDevice) {
  invoke("phone_forget", { id: d.id }).catch((e) => setError(String(e)));
  flash(`forgot ${d.name} · it has to pair again`);
}

/** A signal alerted on the desktop (signals.ts): push it to the phones too, unless Settings ›
 *  Remote leaves this signal out. */
onAlert((ev, tab, title, body) => {
  if (!status().url || !pushesFor(ev)) return;
  push(title, body, tab.id);
});

function push(title: string, body: string, tab: string) {
  invoke("phone_push", { title, body, tab }).catch((e) => flash(`couldn't push to the phone: ${e}`));
}

/** Settings › Remote: check the phones get pushes without waiting for an agent. */
export function testPush() {
  const n = status().devices.filter((d) => d.push).length;
  if (!n) return flash("no phone has allowed notifications yet");
  push("tri-code", "Test push: notifications work", "");
  flash(`test push sent to ${n} phone${n === 1 ? "" : "s"}`);
}

/** The icons the phone's own chrome uses (pins, locks, git rows, file rows). */
const PHONE_ICONS = ["pin", "lock", "git-branch", "folder", "file", "files", "square-terminal", "globe"];

/** A line under a window's name on the phone: what it shows, for the windows that aren't terminals. */
function windowLine(p: Project, t: Tab): string {
  switch (t.kind) {
    case "browser": return activePage(t)?.url || "blank page";
    case "editor": return t.path ? t.path.split(/[\\/]/).pop()! : `${t.files?.length ?? 0} files open`;
    case "git": return labelOf(p).text;
    case "issues": return t.timeline ? "timeline" : "issues";
    default: return "";
  }
}

/** What a phone sees, as the sidebar shows it: the pins, then each Environment's projects with
 *  their Worktrees, each with its windows by workspace. A locked Environment shows only its name. */
function snapshot() {
  const open = (host: string) => !envLocked(host);
  const order = app.environments.flatMap((host) =>
    open(host) ? app.projects.filter((p) => p.host === host && !p.parent && !p.sample).flatMap((p) => [p, ...app.projects.filter((w) => w.parent === p.id)]) : [],
  );
  const projects = order.map((p: Project) => {
    const seen: Record<string, number> = {};
    const tabs = p.tabs.filter((t) => !t.demo);
    return {
      id: p.id,
      name: p.parent ? labelOf(p).text : p.name,
      repo: p.parent ? repoOf(p).name : "",
      parent: p.parent ?? "",
      host: p.host,
      tile: p.parent ? tileLabel(p) : p.name.slice(0, 1).toUpperCase(),
      // The repo's lucide icon when it has one, as its sidebar tile shows; else its letter.
      glyph: repoOf(p).icon?.kind === "lucide" ? iconSvg((repoOf(p).icon as { name: string }).name) : "",
      branch: labelOf(p).text,
      accent: p.accent,
      ws: p.ws + 1,
      commands: phoneCommands(p),
      windows: tabs.map((t) => {
        const name = tabName(t);
        seen[name] = (seen[name] ?? 0) + 1;
        const l = live[t.id];
        return {
          id: t.id,
          kind: t.kind,
          name: seen[name] > 1 ? `${name} · ${seen[name]}` : name,
          icon: iconSvg(tabIcon(t)),
          sig: sigOf(t),
          msg: t.kind === "term" ? l?.agent?.msg || l?.title || "" : windowLine(p, t),
          at: l?.agent?.at ?? 0,
          ws: t.space + 1,
          min: !!t.min,
          agent: !!l?.agent,
          pty: l?.pty,
        };
      }),
    };
  });
  return {
    // The desktop's look, so the phone follows it: its theme and keycap colour.
    look: { theme: app.settings.theme ?? "", accentKeys: !!app.settings.accentKeys },
    // The sidebar's and toolbar's icons, drawn by the phone as the desktop draws them.
    icons: Object.fromEntries(PHONE_ICONS.map((n) => [n, iconSvg(n)])),
    envs: app.environments.map((host) => ({ host, name: envName(host), icon: iconSvg(envIcon(host)), remote: !isLocalHost(host), locked: !open(host) })),
    pinned: app.pinned.filter((id) => projects.some((p) => p.id === id)),
    projects,
  };
}

/** The last lines of every terminal's screen, for the phone's tiles. Read on a timer while a phone
 *  is connected, since a terminal's screen isn't in the store. */
const TAIL_LINES = 10;
const TAIL_MS = 1500;
function tails(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of app.projects) {
    if (envLocked(p.host)) continue;
    for (const t of p.tabs) if (t.kind === "term" && !t.demo) out[t.id] = screenTail(t.id, TAIL_LINES).map((s) => s.slice(0, 160));
  }
  return out;
}

/** Mount once (in App), after the state has loaded: starts Remote Control if it was on, and
 *  keeps the phones' snapshot current while it serves. */
export function startPhoneSync() {
  void resume();

  let timer: number | undefined;
  createEffect(on(() => (status().url ? JSON.stringify(snapshot()) : ""), (json) => {
    if (!json) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => invoke("phone_snapshot", { json }).catch((e) => console.warn("phone_snapshot failed:", e)), 120);
  }));

  let lastTails = "";
  const tailTimer = window.setInterval(() => {
    if (!status().url || !status().devices.some((d) => d.online)) return void (lastTails = "");
    const json = JSON.stringify(tails());
    if (json === lastTails) return;
    lastTails = json;
    invoke("phone_tails", { json }).catch((e) => console.warn("phone_tails failed:", e));
  }, TAIL_MS);
  onCleanup(() => clearInterval(tailTimer));

  const unlisten = [
    answerPhones(),
    listen("phone-changed", () => void refresh()),
    listen("phone-paired", () => {
      setPairing(null);
      flash("phone paired");
    }),
  ];
  onCleanup(() => unlisten.forEach((u) => u.then((f) => f())));
}
