// Settings › Command line: installs `tri`, the script that opens folders and files in tri-code from a
// terminal (`tri .`), and shows whether its folder is on PATH. The opening itself is cli.ts.

import { Show, onMount } from "solid-js";
import { cliBusy, cliError, cliSetup, installCli, refreshCli, removeCli } from "./cli";

const LABEL = { missing: "not installed", installed: "installed", stale: "starts another copy of tri-code" } as const;

export function CliPage() {
  onMount(() => void refreshCli());
  const s = cliSetup;
  return (
    <>
      <h4>The tri command</h4>
      <p class="note">
        Open a folder or file in tri-code from any terminal, as <code>code .</code> does: <code>tri .</code> opens the folder you are in as a project
        (or shows it, when it already is one), <code>tri src/main.rs:12</code> opens the file at that line in the project that holds it. Local paths only.
      </p>
      <div class="row">
        tri
        <span class={`ag-state ${s()?.state === "installed" ? "ok" : s()?.state === "stale" ? "warn" : ""}`}>{s() ? LABEL[s()!.state] : "checking…"}</span>
        <span class="ag-acts">
          <Show
            when={s()?.state === "installed"}
            fallback={
              <button type="button" disabled={!s() || cliBusy()} onClick={() => void installCli()}>
                {s()?.state === "stale" ? "Point at this copy" : "Install"}
              </button>
            }
          >
            <button type="button" disabled={cliBusy()} onClick={() => void removeCli()}>Remove</button>
          </Show>
        </span>
      </div>
      <Show when={s() && s()!.state !== "missing"}>
        <p class="note">
          <code>{s()!.script}</code>
          <Show
            when={s()!.onPath}
            fallback={<> · its folder isn't on PATH yet. Add it to your shell's profile to use <code>tri</code> outside tri-code.</>}
          >
            {" "}· on PATH. Terminals opened before the install need restarting; tri-code's own get it at once.
          </Show>
        </p>
      </Show>
      <Show when={cliError()}>
        <p class="note">{cliError()}</p>
      </Show>
    </>
  );
}
