// Agent setup: when a local project opens, tri-code checks whether Claude and pi have the agent-windows
// server (agent_setup.rs). An agent that is installed but not set up gets one banner in the project,
// with an install button for each. The answer is kept in state.json, so it is asked once. "Not now"
// lasts until the next launch. Settings › Agents shows the same state and the way back.

import { createEffect, createSignal, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { app, isRemote, projectById, setAgentSetup, updateAgent } from "./state";
import { flash } from "./ui";

export type AgentKey = "claude" | "pi";
export type SetupState = "missing" | "installed" | "stale";
export type AgentSetupInfo = { present: boolean; state: SetupState };
export type Setup = { node: boolean; claude: AgentSetupInfo; pi: AgentSetupInfo };
type Answers = Partial<Record<AgentKey, "installed" | "never">>;

export const AGENT_KEYS: AgentKey[] = ["claude", "pi"];
export const AGENT_NAMES: Record<AgentKey, string> = { claude: "Claude", pi: "pi" };

/** Which agents to ask about: installed on this machine, not set up, and not answered yet. Pure, for bun test. */
export function askAbout(s: Setup | null, answers: Answers, deferred: readonly AgentKey[]): AgentKey[] {
  if (!s) return [];
  return AGENT_KEYS.filter((k) => s[k].present && s[k].state === "missing" && !answers[k] && !deferred.includes(k));
}

const [setup, setSetup] = createSignal<Setup | null>(null);
/** Agents the banner was dismissed for with Not now, until the next launch. */
const [deferred, setDeferred] = createSignal<AgentKey[]>([]);
const [busy, setBusy] = createSignal<AgentKey | "remove" | null>(null);
const [error, setError] = createSignal("");
export { setup as setupStatus, busy as setupBusy, error as setupError, deferred as deferredAgents };

const TTL = 30_000;
let checkedAt = 0;

/** Reads the agents' configs and PATH. Throttled, so switching projects doesn't re-check every time. */
export async function refreshSetup(force = false) {
  if (!force && Date.now() - checkedAt < TTL) return;
  checkedAt = Date.now();
  try {
    setSetup(await invoke<Setup>("agent_setup_status"));
  } catch (e) {
    console.warn("agent_setup_status failed:", e);
  }
}

export async function installAgent(agent: AgentKey) {
  setBusy(agent);
  setError("");
  try {
    await invoke("agent_setup_install", { agent });
    setAgentSetup(agent, "installed");
    // A plain shell is the one Command agents most often need (a dev server, a quick check), so it
    // is allowed for agents as soon as they can open windows. Turning it off afterwards sticks.
    updateAgent("shell", { agentRun: true });
    flash(`${AGENT_NAMES[agent]} can open agent windows now · shell is allowed for agents`);
  } catch (e) {
    setError(String(e));
  } finally {
    setBusy(null);
    await refreshSetup(true);
  }
}

export async function removeAgent(agent: AgentKey) {
  setBusy("remove");
  setError("");
  try {
    await invoke("agent_setup_remove", { agent });
    setAgentSetup(agent, undefined);
    flash(`${AGENT_NAMES[agent]} no longer has agent windows`);
  } catch (e) {
    setError(String(e));
  } finally {
    setBusy(null);
    await refreshSetup(true);
  }
}

export const neverAsk = (agent: AgentKey) => setAgentSetup(agent, "never");
export const askAgain = (agent: AgentKey) => setAgentSetup(agent, undefined);
export const notNow = (agents: AgentKey[]) => setDeferred((d) => [...d, ...agents]);

/** Mount once, after the state has loaded (App): checks on start, and whenever a local project is opened. */
export function startAgentSetup() {
  void refreshSetup(true);
  createEffect(on(() => app.activeProject, (id) => {
    const p = id ? projectById(id) : undefined;
    if (p && !isRemote(p)) void refreshSetup();
  }, { defer: true }));
}
