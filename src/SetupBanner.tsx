// The setup banner: one strip over the active local project, offering the agents that can be set up.
// The rules and actions are in agentsetup.ts.

import { For, Show } from "solid-js";
import { activeProject, app, isRemote } from "./state";
import { AGENT_NAMES, askAbout, deferredAgents, installAgent, neverAsk, notNow, setupBusy, setupError, setupStatus } from "./agentsetup";
import "./agentsetup.css";

/** The banner for the active local project, when there is an agent to ask about. */
export function SetupBanner() {
  const pending = () => {
    const p = activeProject();
    return p && !isRemote(p) ? askAbout(setupStatus(), app.agentSetup ?? {}, deferredAgents()) : [];
  };
  const names = () => pending().map((k) => AGENT_NAMES[k]).join(" and ");
  return (
    <Show when={pending().length > 0}>
      <div class="setup-banner" role="region" aria-label="Agent windows setup">
        <p>
          <b>Agents here can't open windows yet.</b> Add the tri-code server to {names()} so an agent can open a dev server, read it and wait for it to start. It only sees this project's windows.
        </p>
        <Show
          when={setupStatus()?.node}
          fallback={<p class="sb-warn">Node isn't on PATH, so the server can't run. Install Node, then reopen the project.</p>}
        >
          <div class="sb-acts">
            <For each={pending()}>
              {(k) => (
                <button class="sb-btn primary" disabled={!!setupBusy()} onClick={() => void installAgent(k)}>
                  {setupBusy() === k ? "Installing…" : `Install for ${AGENT_NAMES[k]}`}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="sb-acts">
          <button class="sb-btn" onClick={() => notNow(pending())}>Not now</button>
          <button class="sb-btn quiet" onClick={() => pending().forEach(neverAsk)}>Don't ask again</button>
        </div>
        <Show when={setupError()}>
          <p class="sb-err">{setupError()}</p>
        </Show>
      </div>
    </Show>
  );
}
