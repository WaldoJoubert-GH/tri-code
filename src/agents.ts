// Agents: the apps the New Window Menu offers (claude, pi, a shell, lazygit, ...), each a name,
// a command, a lucide icon and an optional hotkey. An agent with a `url` is a web app and
// opens a browser window instead. Edited in the agents window (AgentsPanel.tsx); the list
// lives in state.json as `agents`.

import { createSignal } from "solid-js";
import { Agent, Hotkey, Project, Tab, addTab, app, focusTab, isWebApp, newId } from "./state";
import { normalizeUrl } from "./browsers";
import { flash } from "./ui";
import { modDown } from "./modkey";
import { actionById, chordKeys, chordProblem, chordText, owner, sameChord, withKey } from "./keymap";

/** The chord as <kbd> labels, the modifier first. */
export const hotkeyKeys = (h: Hotkey) => chordKeys(h);
export const hotkeyText = (h: Hotkey) => chordText(h);

/** Why an agent's hotkey is ignored, or "". The first agent in the list keeps a shared chord. */
export function hotkeyProblem(a: Agent): string {
  const h = a.hotkey;
  if (!h) return "";
  const os = chordProblem(h);
  if (os) return os;
  const taken = owner(h);
  if (taken) return `${hotkeyText(h)} is tri-code's “${actionById(taken.id)!.desc}”`;
  const first = app.agents.find((b) => b.hotkey && sameChord(b.hotkey, h));
  return first && first.id !== a.id ? `${hotkeyText(h)} is already ${first.name || "another agent"}'s` : "";
}

export function urlProblem(a: Agent): string {
  return isWebApp(a) && !a.url?.trim() ? "needs a URL" : "";
}

export function nameProblem(a: Agent): string {
  const name = a.name.trim().toLowerCase();
  if (!name) return "needs a name";
  return app.agents.some((b) => b.id !== a.id && b.name.trim().toLowerCase() === name) ? "another agent has this name" : "";
}

/** The agent bound to this modifier chord, if any (hotkeys.ts asks once the Keymap misses). */
export function agentForKey(e: KeyboardEvent): Agent | undefined {
  if (!modDown(e)) return;
  const h: Hotkey = { code: e.code, ...(e.shiftKey ? { shift: true } : {}), ...(e.ctrlKey ? { ctrl: true } : {}) };
  return app.agents.find((a) => a.hotkey && sameChord(a.hotkey, h) && !hotkeyProblem(a));
}

/** Set while the agents window records a hotkey, so hotkeys.ts lets the chord through. */
export const [recording, setRecording] = createSignal<string | null>(null);

export function newAgent(): Agent {
  return { id: newId(), name: "", command: "", icon: "bot" };
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
  const terms = app.agents.filter((a) => !isWebApp(a));
  const shell = terms.find((a) => a.id === "shell") ?? terms.find((a) => !a.command.trim()) ?? terms[0];
  if (shell) launchAgent(p, shell);
  else flash(`no agents · add one in the ${withKey("agents window", "agents")}`);
}

/**
 * The window "send to agent" types into: the focused terminal, else one on this workspace, else
 * any. Plain shells are skipped, since an issue or a review note typed there is just a command.
 */
export function agentTarget(p: Project, focus: string | undefined): Tab | undefined {
  const terms = p.tabs.filter((t) => t.kind === "term" && !!t.cmd?.trim());
  return terms.find((t) => t.id === focus) ?? terms.find((t) => t.space === p.ws) ?? terms[0];
}

/** Open or focus the project's agents window. */
export function openAgentsPanel(project: Project): string {
  const existing = project.tabs.find((t) => t.kind === "agents");
  const id = existing?.id ?? addTab(project.id, "agents");
  focusTab(project.id, id);
  return id;
}
