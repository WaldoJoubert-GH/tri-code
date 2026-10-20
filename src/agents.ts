// Agents: the apps the New Window Menu offers (claude, pi, a shell, lazygit, ...), each a name,
// a command, a lucide icon and an optional Alt hotkey. An agent with a `url` is a web app and
// opens a browser window instead. Edited in the agents window (AgentsPanel.tsx); the list
// lives in state.json as `agents`.

import { createSignal } from "solid-js";
import { Agent, Hotkey, Project, Tab, addTab, agentOf, app, focusTab, isWebApp, newId } from "./state";
import { normalizeUrl } from "./browsers";
import { RESERVED } from "./hotkeys";
import { flash } from "./ui";

const KEY_LABELS: Record<string, string> = {
  Enter: "Enter", Semicolon: ";", Quote: "'", Minus: "-", Equal: "=", Backquote: "`", Comma: ",", Period: ".",
  Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Space: "Space",
};

/** The key part of a chord as printed: `KeyX` → X, `Digit5` → 5, `F2` stays. */
export function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  return KEY_LABELS[code] ?? code;
}

/** The chord as <kbd> labels, Alt first. */
export const hotkeyKeys = (h: Hotkey) => ["Alt", ...(h.ctrl ? ["Ctrl"] : []), ...(h.shift ? ["Shift"] : []), keyLabel(h.code)];
export const hotkeyText = (h: Hotkey) => hotkeyKeys(h).join("+");

const sameChord = (a: Hotkey, b: Hotkey) => a.code === b.code && !!a.shift === !!b.shift && !!a.ctrl === !!b.ctrl;

/** Why an agent's hotkey is ignored, or "". The first agent in the list keeps a shared chord. */
export function hotkeyProblem(a: Agent): string {
  const h = a.hotkey;
  if (!h) return "";
  if (RESERVED[h.code]) return `${hotkeyText(h)} is tri-code's “${RESERVED[h.code]}”`;
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

/** The agent bound to this Alt chord, if any (hotkeys.ts asks once its own bindings miss). */
export function agentForKey(e: KeyboardEvent): Agent | undefined {
  const h: Hotkey = { code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey };
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

/** Alt+Enter: another window like the focused terminal (even if its agent is gone), else a shell. */
export function newTerminalLike(p: Project, f: Tab | undefined) {
  if (f?.kind === "term") {
    const a = agentOf(f) ?? { id: f.agent ?? "", name: f.name ?? "terminal", command: f.cmd ?? "", icon: "" };
    return launchAgent(p, a);
  }
  const terms = app.agents.filter((a) => !isWebApp(a));
  const shell = terms.find((a) => a.id === "shell") ?? terms.find((a) => !a.command.trim()) ?? terms[0];
  if (shell) launchAgent(p, shell);
  else flash("no agents · add one in the agents window (Alt+;)");
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
