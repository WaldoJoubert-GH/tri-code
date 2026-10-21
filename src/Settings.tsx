// App-wide settings: the Settings button at the foot of the sidebar opens this popover beside it.
// Settings are also changed where they matter: what opening a file does is asked the first time a
// second file is opened (FileView's ask card) and is in the ⋯ menu of every file window.
// Chosen from design/settings.html (variant D), with the settings button moved to the sidebar.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { type FileOpen, GAPS, app, setGap } from "./state";
import { setFileOpen } from "./files";

/** The modes in menu order, each with its short name and what it does. */
export const FILE_OPEN: { mode: FileOpen; name: string; help: string }[] = [
  { mode: "ask", name: "Ask each time", help: "Asks the first time another file opens: replace, beside, as a tab or preview." },
  { mode: "reuse", name: "Replace", help: "The file replaces what the last file window shows." },
  { mode: "window", name: "New window", help: "Every file gets its own window." },
  { mode: "tabs", name: "Tabs", help: "One file window, with a tab per file." },
  { mode: "preview", name: "Preview", help: "One preview window that the next file replaces. Keep it, or edit it, and the next file opens a new preview." },
];

const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
export const settingsOpen = () => anchor() !== null;
export const closeSettings = () => setAnchor(null);

/** Open beside `el` (the sidebar button), or beside wherever that button is when opened from the palette. */
export function toggleSettings(el?: HTMLElement | null) {
  if (settingsOpen()) return closeSettings();
  setAnchor(el ?? document.getElementById("settingsBtn") ?? document.body);
}

/** Beside the button, bottom edges level, kept on screen. */
function place(el: HTMLElement, a: HTMLElement) {
  const r = a.getBoundingClientRect(), h = el.offsetHeight;
  el.style.left = `${Math.min(r.right + 10, window.innerWidth - el.offsetWidth - 8)}px`;
  el.style.top = `${Math.max(8, Math.min(r.bottom - h, window.innerHeight - h - 8))}px`;
}

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function SettingsPopover() {
  const onDown = (e: PointerEvent) => {
    if (settingsOpen() && !(e.target as Element).closest(".pop.settings, #settingsBtn")) closeSettings();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  return (
    <Show when={anchor()} keyed>
      {(a) => (
        <div class="pop settings" role="dialog" aria-label="Settings" ref={(el) => requestAnimationFrame(() => place(el, a))}>
          <div class="ttl">Settings <span>every project</span></div>
          <h4>Opening a file</h4>
          <div class="radios" role="radiogroup" aria-label="Opening a file">
            <For each={FILE_OPEN}>
              {(o) => (
                <label class="radio">
                  <input type="radio" name="fileOpen" checked={app.settings.fileOpen === o.mode} onChange={() => setFileOpen(o.mode)} />
                  <span>{o.name}<small>{o.help}</small></span>
                </label>
              )}
            </For>
          </div>
          <p class="note">Ctrl+click, or Ctrl+Enter in Go to File, opens a new window instead (in New window mode, it replaces).</p>
          <h4>Windows</h4>
          <label class="row">
            Gap between windows
            <select value={String(app.gap)} onChange={(e) => setGap(+e.currentTarget.value)}>
              <For each={GAPS}>{(g) => <option value={String(g)} selected={app.gap === g}>{g}</option>}</For>
            </select>
          </label>
        </div>
      )}
    </Show>
  );
}
