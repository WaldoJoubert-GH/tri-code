// About dialog: the running version, a "Check for updates" button and the changelog.
// Opened from the version in the status bar or the Command Palette. Click the backdrop or
// press Escape to close.

import { Show, createSignal } from "solid-js";
import changelog from "../CHANGELOG.md?raw";
import { renderMarkdown } from "./markdown";
import { Modal } from "./Modal";
import { appVersion, checkForUpdates, installUpdate, updateReady, updateStatus } from "./updater";
import "./files.css";

export const [aboutOpen, setAboutOpen] = createSignal(false);

/** The release sections only; the intro is for whoever edits the file. */
const sections = changelog.slice(changelog.indexOf("\n## ") + 1).split(/\n(?=## )/);
/** How many releases show before "Load more". */
const SHOWN = 4;
const latest = renderMarkdown(sections.slice(0, SHOWN).join("\n"));
const older = sections.length > SHOWN ? renderMarkdown(sections.slice(SHOWN).join("\n")) : "";

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
  const [showOlder, setShowOlder] = createSignal(false);
  return (
    <Show when={aboutOpen()}>
      <Modal label="About tri-code" onClose={() => setAboutOpen(false)}>
        <div class="about">
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
          <div class="log">
            <div class="md" innerHTML={latest} />
            <Show when={older}>
              <Show
                when={showOlder()}
                fallback={<button class="more" onClick={() => setShowOlder(true)}>Load more</button>}
              >
                <div class="md" innerHTML={older} />
              </Show>
            </Show>
          </div>
        </div>
      </Modal>
    </Show>
  );
}
