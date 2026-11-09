// Which windows are agents, and which one "send to agent" (Select element, an issue, the palette)
// types into. Plain shells and Commands like `bun dev` or lazygit are left out: text typed there
// runs as a command. Pure apart from the store, for bun test.

import { createEffect, createRoot } from "solid-js";
import { type Project, type Tab, app, live, space } from "./state";

/** claude or pi as a window's command, before either has said anything. */
const AGENT_CLI = /^(claude|pi)(\.cmd|\.exe)?(\s|$)/;

/** A terminal running an agent: it answered the signal probe or reported, has a conversation to
 *  resume, or runs claude or pi. A Worktree's setup window never is. */
export function isAgentWindow(t: Tab): boolean {
  if (t.kind !== "term" || t.once) return false;
  const l = live[t.id];
  if (l?.ready || l?.agent) return true;
  const cmd = t.cmd?.trim() ?? "";
  return !!cmd && (!!t.resume || AGENT_CLI.test(cmd));
}

export const agentWindows = (p: Project): Tab[] => p.tabs.filter(isAgentWindow);

/** The agent window last focused or chosen in each project, by project id. */
const lastAgent = new Map<string, string>();

/** Remember `tabId` as the project's agent: Select element's choice, or a focused agent window. */
export function rememberAgent(projectId: string, tabId: string) {
  lastAgent.set(projectId, tabId);
}

/**
 * The window "send to agent" types into: the focused agent, else the one last focused or chosen
 * (sending from a browser or the issues focuses those instead), else one on this workspace, else
 * the newest.
 */
export function agentTarget(p: Project, focus: string | undefined): Tab | undefined {
  const agents = agentWindows(p);
  return agents.find((t) => t.id === focus)
    ?? agents.find((t) => t.id === lastAgent.get(p.id))
    ?? agents.find((t) => t.space === p.ws)
    ?? agents[agents.length - 1];
}

/** Mount once (App): remembers each project's focused agent window as focus moves. */
export function trackAgentFocus() {
  createRoot(() => createEffect(() => {
    for (const p of app.projects) {
      const t = p.tabs.find((x) => x.id === space(p)?.focus);
      if (t && isAgentWindow(t)) rememberAgent(p.id, t.id);
    }
  }));
}
