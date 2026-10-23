// Remote Control: the agents on your phone. phone.rs serves the phone page over Tailscale;
// this module turns it on and off (Settings › Remote), keeps it fed with a snapshot of the
// agents and their signals, and pushes a signal to paired phones when one alerts.
// Chosen from design/remote-control.html (connection A, desktop B, phone list A).

import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Project, type SoundEvent, type Tab, app, envName, isRemote, live, repoOf, setSettings, tabIcon, tabName } from "./state";
import { sigOf } from "./signals";
import { envLocked } from "./envlock";
import { iconSvg } from "./lucide";
import { flash } from "./ui";

export type PhoneDevice = { id: string; name: string; added: number; seen: number; online: boolean; push: boolean };
/** `on`: it should be serving (phone.json), so it starts with the app until turned off. */
export type PhoneStatus = { url: string | null; on: boolean; devices: PhoneDevice[] };
export type PairInfo = { code: string; url: string; qr: string; seconds: number };

const [status, setStatus] = createSignal<PhoneStatus>({ url: null, on: false, devices: [] });
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

export function forgetPhone(d: PhoneDevice) {
  invoke("phone_forget", { id: d.id }).catch((e) => setError(String(e)));
  flash(`forgot ${d.name} · it has to pair again`);
}

/** A signal alerted on the desktop (signals.ts): push it to the phones too, unless Settings ›
 *  Remote leaves this signal out. */
export function pushSignal(ev: SoundEvent, tab: Tab, title: string, body: string) {
  if (!status().url || !pushesFor(ev)) return;
  push(title, body, tab.id);
}

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

/** The agents a phone sees: terminal windows running an agent (plain shells left out), by project
 *  in sidebar order, with a worktree after its repo. Locked environments are left out. */
function snapshot() {
  const ordered = app.environments.flatMap((host) =>
    envLocked(host) ? [] : app.projects.filter((p) => p.host === host && !p.parent).flatMap((p) => [p, ...app.projects.filter((w) => w.parent === p.id)]),
  );
  const projects = ordered.map((p: Project) => {
    const agents = p.tabs.filter((t) => t.kind === "term" && !t.demo && live[t.id]?.pty !== undefined && (t.cmd?.trim() || live[t.id]?.agent));
    const seen: Record<string, number> = {};
    return {
      id: p.id,
      name: p.parent ? `${repoOf(p).name} · ${p.name}` : p.name,
      accent: p.accent,
      env: isRemote(p) ? envName(p.host) : "",
      agents: agents.map((t) => {
        const name = tabName(t);
        seen[name] = (seen[name] ?? 0) + 1;
        const l = live[t.id]!;
        return {
          id: t.id,
          name: seen[name] > 1 ? `${name} · ${seen[name]}` : name,
          icon: iconSvg(tabIcon(t)),
          sig: sigOf(t),
          msg: l.agent?.msg || l.title || "",
          at: l.agent?.at ?? 0,
          ws: t.space + 1,
          pty: l.pty,
        };
      }),
    };
  });
  return { projects: projects.filter((p) => p.agents.length) };
}

/** Mount once (in App), after the state has loaded: starts Remote Control if it was on, and
 *  keeps the phones' snapshot current while it serves. */
export function startPhoneSync() {
  void resume();

  let timer: number | undefined;
  createEffect(on(() => (status().url ? JSON.stringify(snapshot()) : ""), (json) => {
    if (!json) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => invoke("phone_agents", { json }).catch((e) => console.warn("phone_agents failed:", e)), 120);
  }));

  const unlisten = [
    listen("phone-changed", () => void refresh()),
    listen("phone-paired", () => {
      setPairing(null);
      flash("phone paired");
    }),
  ];
  onCleanup(() => unlisten.forEach((u) => u.then((f) => f())));
}
