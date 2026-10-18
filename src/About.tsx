// About dialog: the running version, a "Check for updates" button and the changelog.
// Opened from the version in the status bar or the Command Palette. Click the backdrop or
// press Escape to close.

import { Show, createSignal } from "solid-js";
import changelog from "../CHANGELOG.md?raw";
import { renderMarkdown } from "./markdown";
import { appVersion, checkForUpdates, installUpdate, updateReady, updateStatus } from "./updater";
import "./files.css";

export const [aboutOpen, setAboutOpen] = createSignal(false);

/** The release sections only; the intro is for whoever edits the file. */
const releases = renderMarkdown(changelog.slice(changelog.indexOf("\n## ") + 1));

function statusText() {
  if (import.meta.env.DEV) return "Dev build: updates are off";
  const u = updateReady();
  if (u) return `${u.version} is downloaded. Restarting ends local terminal sessions; remote ones reattach.`;
  const s = updateStatus();
  switch (s.kind) {
    case "checking": return "Checking for updates…";
    case "downloading": return `Downloading ${s.version}…`;
    case "current": return `Up to date · checked ${s.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    case "failed": return `Update check failed: ${s.error}`;
    default: return "Checks for updates at startup and every 6 hours";
  }
}

export function AboutDialog() {
  const busy = () => ["checking", "downloading"].includes(updateStatus().kind);
  return (
    <Show when={aboutOpen()}>
      <div class="dialog-scrim" onClick={(e) => e.target === e.currentTarget && setAboutOpen(false)}>
        <div class="about" role="dialog" aria-label="About tri-code">
          <header>
            <span>tri-code <span class="ver">v{appVersion}</span></span>
            <button aria-label="Close" onClick={() => setAboutOpen(false)}>×</button>
          </header>
          <div class="upd">
            <span>{statusText()}</span>
            <Show
              when={updateReady()}
              fallback={
                <button disabled={import.meta.env.DEV || busy()} onClick={checkForUpdates}>
                  Check for updates
                </button>
              }
            >
              {(u) => <button class="primary" onClick={installUpdate}>↻ Restart to update · {u().version}</button>}
            </Show>
          </div>
          <div class="md" innerHTML={releases} />
        </div>
      </div>
    </Show>
  );
}
