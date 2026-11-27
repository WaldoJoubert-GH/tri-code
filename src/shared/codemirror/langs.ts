// Installed editor grammars and the offer to install one (Settings › Languages, the editor's banner
// and its status-bar language picker). Chosen from design/language-grammars.html. The grammar files
// live on this machine (grammars.rs), so a remote project's files use them too.
//
// Offer rules: a file whose language tri-code doesn't ship, but the Grammar Catalog has, shows a
// banner once per language. Not now hides it until tri-code restarts; Don't suggest is kept in
// settings (`grammars.never`); Settings › Languages can turn the banner off altogether.

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { produce } from "solid-js/store";
import { VERSION, GRAMMARS, grammarsOf, langById, removable } from "./grammars";
import { app, setApp } from "../state/state";

const [installed, setInstalled] = createSignal<ReadonlySet<string>>(new Set());
/** The grammar files on this machine, by name. Changes when one is installed or removed. */
export const installedGrammars = installed;
/** A language is installed when its own grammar is (its dependencies may be shared). */
export const isInstalled = (id: string) => installed().has(id);

let listed: Promise<void> | undefined;
/** Read what is installed, once; every later change goes through install and remove. */
export function loadInstalled(): Promise<void> {
  return (listed ??= invoke<string[]>("grammar_list")
    .then((names) => void setInstalled(new Set(names)))
    .catch((e) => console.warn("grammar_list failed:", e)));
}

export type Progress = { id: string; done: number; total: number };
const [progress, setProgress] = createSignal<Progress | null>(null);
/** The install under way: bytes of its grammars downloaded so far, of all it needs. One at a time. */
export const installing = progress;

const [failed, setFailed] = createSignal<{ id: string; msg: string } | null>(null);
/** The last install that failed, until the next one starts. */
export const installError = failed;

/** Download `id`'s grammar and the ones it needs, dependencies first, so the language switches on
 *  in one go when its own grammar lands. True once installed. */
export async function installLang(id: string): Promise<boolean> {
  if (progress()) return false;
  await loadInstalled();
  const todo = grammarsOf(id).filter((n) => !installed().has(n)).reverse();
  if (!todo.length) return true;
  const total = todo.reduce((s, n) => s + GRAMMARS[n].bytes, 0);
  let done = 0;
  setFailed(null);
  setProgress({ id, done, total });
  try {
    for (const n of todo) {
      await invoke("grammar_install", { version: VERSION, name: n, sha256: GRAMMARS[n].sha256 });
      done += GRAMMARS[n].bytes;
      setInstalled((s) => new Set([...s, n]));
      setProgress({ id, done, total });
    }
    return true;
  } catch (e) {
    setFailed({ id, msg: String(e) });
    return false;
  } finally {
    setProgress(null);
  }
}

/** Remove `id` and what only it needed. Its files show as plain text again. */
export async function removeLang(id: string): Promise<void> {
  const names = removable(id, installed());
  await invoke("grammar_remove", { names });
  setInstalled((s) => new Set([...s].filter((n) => !names.includes(n))));
  for (const [f, key] of Object.entries(overrides())) if (key === `t:${id}`) setOverride(f, undefined);
}

// ---- the offer

/** Languages whose banner was closed with Not now, until tri-code restarts. */
const [later, setLater] = createSignal<ReadonlySet<string>>(new Set());
export const notNow = (id: string) => setLater((s) => new Set([...s, id]));

/** False when Settings › Languages turned the banner off. */
export const suggesting = () => app.settings.grammars?.suggest !== false;
export const neverSuggest = (id: string) => !!app.settings.grammars?.never?.includes(id);

export function setSuggesting(on: boolean) {
  setApp(produce((s) => {
    const g = (s.settings.grammars ??= {});
    if (on) delete g.suggest;
    else g.suggest = false;
    if (!Object.keys(g).length) delete s.settings.grammars;
  }));
}

/** Don't suggest (on) or suggest again (off) a language's grammar. */
export function setNever(id: string, on: boolean) {
  setApp(produce((s) => {
    const g = (s.settings.grammars ??= {});
    const never = new Set(g.never ?? []);
    if (on) never.add(id);
    else never.delete(id);
    if (never.size) g.never = [...never].sort();
    else delete g.never;
    if (!Object.keys(g).length) delete s.settings.grammars;
  }));
}

/** Whether the banner offers `id` now. */
export const offering = (id: string) =>
  !!langById(id) && !isInstalled(id) && suggesting() && !later().has(id) && !neverSuggest(id);

// ---- the language a file is shown in, when picked in the status bar

/** Language keys (cm.ts `languageKey`) picked for files, by path, until tri-code restarts. */
const [overrides, setOverrides] = createSignal<Readonly<Record<string, string>>>({});
export const overrideOf = (path: string): string | undefined => overrides()[path];
export function setOverride(path: string, key: string | undefined) {
  setOverrides((o) => {
    const next = { ...o };
    if (key) next[path] = key;
    else delete next[path];
    return next;
  });
}
