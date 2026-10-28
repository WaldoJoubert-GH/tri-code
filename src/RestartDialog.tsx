// "Are you sure?" before a restart-to-update that would end agents still working or waiting for
// you. Opened by installUpdate() in updater.ts; the counts are live, so the text follows the agents.
// Cancel has the focus, so Enter is safe. Escape or a click outside closes it.

import { Show } from "solid-js";
import { appVersion, askRestart, cancelRestart, installNow, updateReady } from "./updater";
import { busySignals } from "./sigs";
import { Icon } from "./lucide";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 agents are working, 1 needs you and 1 failed." */
function summary(sigs: ReturnType<typeof busySignals>) {
  const count = (s: string) => sigs.filter((x) => x === s).length;
  const parts: string[] = [];
  if (count("working")) parts.push(plural(count("working"), "agent is", "agents are") + " still working");
  if (count("blocked")) parts.push(plural(count("blocked"), "agent needs", "agents need") + " you");
  if (count("error")) parts.push(plural(count("error"), "agent has", "agents have") + " failed");
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
}

export function RestartDialog() {
  return (
    <Show when={askRestart() && updateReady()}>
      {(u) => {
        const sigs = () => busySignals();
        return (
          <div class="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && cancelRestart()}>
            <div
              class="restart-dlg"
              role="alertdialog"
              aria-label="Restart to update?"
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelRestart();
              }}
            >
              <header>
                <span>
                  <Icon name="triangle-alert" size={14} />
                  Restart to update to {u().version}?
                </span>
                <button type="button" title="Close (Esc)" aria-label="Close" onClick={cancelRestart}>×</button>
              </header>
              <div class="body">
                <p>
                  {sigs().length ? `${summary(sigs())}.` : "No agent is busy now."} Restarting ends local terminal sessions, so
                  anything running in them stops. Remote ones reattach.
                </p>
                <p class="ver">tri-code {appVersion} → {u().version}</p>
              </div>
              <footer>
                <button
                  type="button"
                  ref={(el) => requestAnimationFrame(() => el.focus())}
                  onClick={cancelRestart}
                >
                  Cancel
                </button>
                <button type="button" class="danger" onClick={() => void installNow()}>
                  Restart anyway
                </button>
              </footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
