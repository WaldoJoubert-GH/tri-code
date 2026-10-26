// Settings › Agents: whether Claude and pi have agent windows set up, read from their own configs on each
// open, with the action that fits: install, update the path, remove, or ask again after Don't ask again.

import { For, Show, onMount } from "solid-js";
import { app } from "./state";
import {
  AGENT_KEYS,
  AGENT_NAMES,
  type AgentKey,
  type SetupState,
  askAgain,
  installAgent,
  refreshSetup,
  removeAgent,
  setupBusy,
  setupError,
  setupStatus,
  neverAsk,
} from "./agentsetup";

const LABEL: Record<SetupState, string> = { missing: "not set up", installed: "set up", stale: "points at another path" };

function AgentRow(props: { agent: AgentKey }) {
  const info = () => setupStatus()?.[props.agent];
  const answer = () => app.agentSetup?.[props.agent];
  const label = () => {
    const i = info();
    if (!i) return "checking…";
    return i.present ? LABEL[i.state] : "not installed";
  };
  const tone = () => (info()?.state === "installed" ? "ok" : info()?.present ? "" : "warn");
  return (
    <div class="row">
      {AGENT_NAMES[props.agent]}
      <span class={`ag-state ${tone()}`}>{label()}</span>
      <span class="ag-acts">
        <Show when={info()?.present}>
          <Show
            when={info()?.state === "installed"}
            fallback={
              <button type="button" disabled={!setupStatus()?.node || !!setupBusy()} onClick={() => void installAgent(props.agent)}>
                {info()?.state === "stale" ? "Update path" : "Install"}
              </button>
            }
          >
            <button type="button" disabled={!!setupBusy()} onClick={() => void removeAgent(props.agent)}>
              Remove
            </button>
          </Show>
        </Show>
        <Show
          when={answer() === "never"}
          fallback={
            <Show when={info()?.present && info()?.state !== "installed"}>
              <button type="button" class="reset" title="Stop asking about this agent" onClick={() => neverAsk(props.agent)}>
                Don't ask
              </button>
            </Show>
          }
        >
          <button type="button" class="reset" title="Ask again the next time a project opens" onClick={() => askAgain(props.agent)}>
            Ask again
          </button>
        </Show>
      </span>
    </div>
  );
}

export function AgentsPage() {
  onMount(() => void refreshSetup(true));
  return (
    <>
      <h4>Agent windows</h4>
      <p class="note">
        An agent in a project's terminal can open, read and close that project's windows, such as a dev server. Setting it up registers a server with the agent's own config. Only Commands with <b>Agent</b> switched on in the Commands window can be opened.
      </p>
      <For each={AGENT_KEYS}>{(k) => <AgentRow agent={k} />}</For>
      <Show when={setupStatus() && !setupStatus()!.node}>
        <p class="note">Node isn't on PATH, so the server can't run. Install Node to set up agent windows.</p>
      </Show>
      <Show when={setupError()}>
        <p class="note">{setupError()}</p>
      </Show>
    </>
  );
}
