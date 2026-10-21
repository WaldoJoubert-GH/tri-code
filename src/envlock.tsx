// Environment ssh options and PIN locks, on the frontend side. state.json keeps them
// (envSsh, envLocks); envssh.rs in Rust applies them to every ssh call. An environment
// with a PIN starts locked. While it is locked its projects show the PIN pad instead
// of the canvas and its terminals don't start. An unlock lasts `minutes`, then it
// locks again.

import { invoke } from "@tauri-apps/api/core";
import { For, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { app, envName, type EnvSsh } from "./state";
import { clock } from "./issues";
import { Icon } from "./lucide";

/** Unlocked hosts, until when (ms). Runtime only, so a restart locks every PIN'd environment again. */
const [unlocked, setUnlocked] = createStore<Record<string, number>>({});

/** Reactive: true while `host` has a PIN and no live unlock. */
export const envLocked = (host: string) => !!app.envLocks[host] && !((unlocked[host] ?? 0) > clock());

/** Push every environment's ssh options and locks to Rust. Call once after loadState. */
export async function syncEnvs() {
  await Promise.all([
    ...Object.entries(app.envSsh).map(([host, ssh]) => invoke("env_ssh_set", { host, ssh })),
    ...Object.keys(app.envLocks).map((host) => invoke("env_lock", { host })),
  ]);
  setInterval(() => {
    for (const [host, until] of Object.entries(unlocked)) if (until <= Date.now()) void lockEnv(host);
  }, 5000);
}

export async function lockEnv(host: string) {
  setUnlocked(host, undefined!);
  await invoke("env_lock", { host });
}

/** Rejects with "Wrong PIN" when it doesn't match. */
export async function unlockEnv(host: string, pin: string) {
  const l = app.envLocks[host];
  if (!l) return;
  await invoke("env_unlock", { host, pin, salt: l.salt, hash: l.hash });
  setUnlocked(host, Date.now() + l.minutes * 60_000);
}

/** A just-added environment starts unlocked: its PIN was typed a moment ago. */
export function markUnlocked(host: string, minutes: number) {
  setUnlocked(host, Date.now() + minutes * 60_000);
}

/** What `ssh ...` pasted into New environment means: a destination plus the options it can't carry. */
export function parseSsh(raw: string): { dest: string } & EnvSsh {
  const words: string[] = [];
  let cur = "", quote = "", any = false;
  for (const c of raw.trim()) {
    if (quote) c === quote ? (quote = "") : (cur += c);
    else if (c === "'" || c === '"') (quote = c), (any = true);
    else if (/\s/.test(c)) {
      if (cur || any) words.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (cur || any) words.push(cur);
  if (/^ssh(\.exe)?$/i.test(words[0] ?? "")) words.shift();

  let dest = "", user = "", identityFile = "", port = "";
  const options: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "-i") identityFile = words[++i] ?? "";
    else if (w === "-p") port = words[++i] ?? "";
    else if (w === "-l") user = words[++i] ?? "";
    else if (w === "-o") options.push(words[++i] ?? "");
    else if (!w.startsWith("-") && !dest) dest = w;
  }
  // A terminal usually starts in the home folder, so `.\key.pem` there means `~\key.pem`.
  identityFile = identityFile.replace(/^\.(?=[\\/])/, "~");
  if (user && dest && !dest.includes("@")) dest = `${user}@${dest}`;
  return { dest, identityFile: identityFile || undefined, port: port || undefined, options: options.length ? options : undefined };
}

const COOLDOWN_TRIES = 5;
const COOLDOWN_MS = 30_000;

/** Shown in place of the canvas while the active project's environment is locked. */
export function PinPad(props: { host: string }) {
  const [pin, setPin] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [shake, setShake] = createSignal(false);
  let tries = 0, coolUntil = 0;

  const submit = async () => {
    if (busy() || !pin()) return;
    if (coolUntil > Date.now()) return setError(`Too many tries. Wait ${Math.ceil((coolUntil - Date.now()) / 1000)} s`);
    setBusy(true);
    try {
      await unlockEnv(props.host, pin());
    } catch (e) {
      tries++;
      setPin("");
      if (tries >= COOLDOWN_TRIES) {
        tries = 0;
        coolUntil = Date.now() + COOLDOWN_MS;
        setError(`Too many tries. Wait ${COOLDOWN_MS / 1000} s`);
      } else setError(String(e));
      setShake(true);
      setTimeout(() => setShake(false), 300);
    } finally {
      setBusy(false);
    }
  };
  const digit = (d: string) => {
    if (pin().length < 8) setPin(pin() + d);
    setError("");
  };

  // Plain keys type the PIN while the pad is up; nothing else on screen takes digits.
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || (e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
    if (/^\d$/.test(e.key)) digit(e.key);
    else if (e.key === "Backspace") setPin(pin().slice(0, -1));
    else if (e.key === "Enter") void submit();
    else return;
    e.preventDefault();
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="pin-wrap">
      <div class="pin-pad" classList={{ shake: shake() }} role="dialog" aria-label={`Unlock ${envName(props.host)}`}>
        <Icon name="lock" size={20} />
        <div class="who">{envName(props.host)}</div>
        <div class="sub">Enter the PIN to open this environment</div>
        <div class="dots" aria-label={`${pin().length} digits entered`}>
          <For each={Array.from({ length: Math.max(4, pin().length) })}>{(_, i) => <i classList={{ f: i() < pin().length }} />}</For>
        </div>
        <div class="keys">
          <For each={["1", "2", "3", "4", "5", "6", "7", "8", "9"]}>{(d) => <button type="button" onClick={() => digit(d)}>{d}</button>}</For>
          <button type="button" title="Delete" aria-label="Delete" onClick={() => setPin(pin().slice(0, -1))}><Icon name="delete" size={16} /></button>
          <button type="button" onClick={() => digit("0")}>0</button>
          <button type="button" title="Unlock (Enter)" aria-label="Unlock" disabled={busy()} onClick={submit}><Icon name="lock-open" size={16} /></button>
        </div>
        <div class="err">{error()}</div>
      </div>
    </div>
  );
}
