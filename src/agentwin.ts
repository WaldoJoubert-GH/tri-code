// Agent windows, on the webview's side (agent_windows.rs has the endpoint). The Commands an agent
// may open are the terminal Commands with the Agent toggle on that a project offers; they are
// pushed to Rust, which checks them again before it asks for a window. The endpoint's open and close
// requests arrive as events: an open adds a terminal tab, which spawns its PTY and answers the
// request; a close removes an agent's tab.

import { createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Agent, type Project, app, focusTab, addTab, isWebApp, projectById, removeTab } from "./state";
import { offeredIn } from "./scope";
import { flash } from "./ui";

/** Whether an agent in `p` may open `a`: a terminal Command with the Agent toggle on, that `p` offers. */
export const agentRunsIn = (p: Project, a: Agent) => !!a.agentRun && !isWebApp(a) && offeredIn(p).includes(a);

/** The open requests waiting for their window's PTY, by tab: the spawn takes its request with it. */
const requests = new Map<string, string>();

export function takeAgentReq(tab: string): string | undefined {
  const req = requests.get(tab);
  requests.delete(tab);
  return req;
}

/** What each project's agents may open, by Command id and name. */
function allowed(): Record<string, { id: string; name: string }[]> {
  return Object.fromEntries(
    app.projects.map((p) => [p.id, offeredIn(p).filter((a) => agentRunsIn(p, a)).map((a) => ({ id: a.id, name: a.name }))]),
  );
}

function openFor(req: string, project: string, agent: string) {
  const p = projectById(project);
  const a = app.agents.find((x) => x.id === agent);
  if (!p || !a || !agentRunsIn(p, a)) {
    void invoke("agent_open_failed", { req, error: "that command is no longer allowed for agents" }).catch(() => {});
    return;
  }
  const id = addTab(p.id, "term", { agent: a, by: "agent" });
  requests.set(id, req);
  focusTab(p.id, id);
  flash(`an agent opened ${a.name || "a terminal"} in ${p.name}`);
}

function closeFor(project: string, tab: string) {
  const t = projectById(project)?.tabs.find((x) => x.id === tab);
  if (t?.by === "agent") removeTab(project, tab);
}

/** Mount once, after the state has loaded (App): keeps Rust's list current and answers the endpoint. */
export function startAgentWindows() {
  createEffect(() => {
    const map = allowed();
    void invoke("agent_allowed", { allowed: map }).catch((e) => console.warn("agent_allowed failed:", e));
  });

  void listen<{ req: string; project: string; agent: string }>("agent-open", (e) => openFor(e.payload.req, e.payload.project, e.payload.agent));
  void listen<{ project: string; tab: string }>("agent-close", (e) => closeFor(e.payload.project, e.payload.tab));
}
