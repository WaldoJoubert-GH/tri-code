// Agents, shown as Commands: what the New Window Menu offers (claude, pi, a shell, lazygit, a
// multi-line script, ...), each a name, a command, a lucide icon, an optional hotkey and a Scope.
// An agent with a `url` is a web app and opens a browser window instead. Edited in the Commands
// Window (AgentsPanel.tsx); the list lives in state.json as `agents`, in + menu order.

import { createSignal } from "solid-js";
import { Agent, Hotkey, Project, Tab, addAgent, addTab, app, focusTab, isWebApp, newId } from "./state";
import { normalizeUrl } from "./browsers";
import { flash } from "./ui";
import { modDown } from "./modkey";
import { actionById, chordKeys, chordProblem, chordText, owner, sameChord, withKey } from "./keymap";
import { chordHolder, offeredIn, sameScope } from "./scope";

export { nameProblem, offeredIn, offeredTogether, reaches, replaceNote, sameScope, scopeIcon, scopeLabel } from "./scope";

/** The chord as <kbd> labels, the modifier first. */
export const hotkeyKeys = (h: Hotkey) => chordKeys(h);
export const hotkeyText = (h: Hotkey) => chordText(h);

/** Why an agent's hotkey is ignored, or "". Of two commands that some project offers together,
 *  the first in the list keeps a shared chord, unless one replaces the other. */
export function hotkeyProblem(a: Agent): string {
  const h = a.hotkey;
  if (!h) return "";
  const os = chordProblem(h);
  if (os) return os;
  const taken = owner(h);
  if (taken) return `${hotkeyText(h)} is tri-code's “${actionById(taken.id)!.desc}”`;
  const b = chordHolder(a);
  return b ? `${hotkeyText(h)} is already ${b.name || "another command"}'s` : "";
}

export function urlProblem(a: Agent): string {
  return isWebApp(a) && !a.url?.trim() ? "needs a URL" : "";
}

/** The agent bound to this modifier chord in project `p`, if any (hotkeys.ts asks once the Keymap misses). */
export function agentForKey(e: KeyboardEvent, p: Project): Agent | undefined {
  if (!modDown(e)) return;
  const h: Hotkey = { code: e.code, ...(e.shiftKey ? { shift: true } : {}), ...(e.ctrlKey ? { ctrl: true } : {}) };
  return offeredIn(p).find((a) => a.hotkey && sameChord(a.hotkey, h) && !hotkeyProblem(a));
}

/** Set while the commands window records a hotkey, so hotkeys.ts lets the chord through. */
export const [recording, setRecording] = createSignal<string | null>(null);

export function newAgent(): Agent {
  return { id: newId(), name: "", command: "", icon: "bot" };
}

/** "dev" → "dev copy", then "dev copy 2", ..., free in the same scope. */
function copyName(a: Agent): string {
  const base = `${a.name.replace(/ copy( \d+)?$/, "")} copy`;
  const taken = (n: string) => app.agents.some((b) => sameScope(a.scope, b.scope) && b.name.trim().toLowerCase() === n.toLowerCase());
  let name = base;
  for (let i = 2; taken(name); i++) name = `${base} ${i}`;
  return name;
}

/** A copy of `a` right under it, without its hotkey (a chord can't be on two rows). Returns its id. */
export function duplicateAgent(a: Agent): string {
  // A plain copy: the store's proxies can't be structuredCloned.
  const { hotkey: _, ...rest }: Agent = JSON.parse(JSON.stringify(a));
  const copy: Agent = { ...rest, id: newId(), name: copyName(a) };
  addAgent(copy, a.id);
  return copy.id;
}

/** Whether typed text is an address rather than a command: a scheme, localhost, an IP or a
 *  dotted name ending in letters (so `python3.12` stays a command). */
export const looksLikeUrl = (s: string) =>
  /^(https?:\/\/|localhost(:\d|\/|$)|\d{1,3}(\.\d{1,3}){3}(:|\/|$)|[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d|\/|$))/i.test(s.trim());

/** Open a new window for `a`: a terminal running its command, or a browser at a web app's URL. */
export function launchAgent(p: Project, a: Agent) {
  if (isWebApp(a)) addTab(p.id, "browser", { agent: a, url: normalizeUrl(a.url ?? "") });
  else addTab(p.id, "term", { agent: a });
  flash(`new ${a.name || (isWebApp(a) ? "browser" : "terminal")}`);
}

/** Alt+Enter: a plain shell, whatever window is focused. */
export function newShell(p: Project) {
  const terms = offeredIn(p).filter((a) => !isWebApp(a));
  const shell = terms.find((a) => a.id === "shell") ?? terms.find((a) => !a.command.trim()) ?? terms[0];
  if (shell) launchAgent(p, shell);
  else flash(`no commands · add one in the ${withKey("commands window", "agents")}`);
}

/**
 * The window "send to agent" types into: the focused terminal, else one on this workspace, else
 * any. Plain shells are skipped, since an issue or a review note typed there is just a command.
 */
export function agentTarget(p: Project, focus: string | undefined): Tab | undefined {
  const terms = p.tabs.filter((t) => t.kind === "term" && !!t.cmd?.trim());
  return terms.find((t) => t.id === focus) ?? terms.find((t) => t.space === p.ws) ?? terms[0];
}

/** Open or focus the project's commands window. */
export function openAgentsPanel(project: Project): string {
  const existing = project.tabs.find((t) => t.kind === "agents");
  const id = existing?.id ?? addTab(project.id, "agents");
  focusTab(project.id, id);
  return id;
}
