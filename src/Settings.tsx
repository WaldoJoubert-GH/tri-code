// App-wide settings: a dialog with a page per topic. The Settings button at the foot of the
// sidebar opens it on the page used last; the toolbar's ? button and the "help" hotkey open the
// Hotkeys page. Settings are also changed where they matter: what opening a file does is asked
// the first time a second file is opened (FileView's ask card) and is in the ⋯ menu of every
// file window. Chosen from design/settings-hotkeys.html.

import { For, Show, createSignal } from "solid-js";
import { type FileOpen, GAP_MAX, app, setGap, setMonoGutter } from "./state";
import { setFileOpen } from "./files";
import { keyOf } from "./keymap";
import { Icon } from "./lucide";
import { HotkeysPage } from "./HotkeySettings";

/** The modes in menu order, each with its short name and what it does. */
export const FILE_OPEN: { mode: FileOpen; name: string; help: string }[] = [
  { mode: "ask", name: "Ask each time", help: "Asks the first time another file opens: replace, beside, as a tab or preview." },
  { mode: "reuse", name: "Replace", help: "The file replaces what the last file window shows." },
  { mode: "window", name: "New window", help: "Every file gets its own window." },
  { mode: "tabs", name: "Tabs", help: "One file window, with a tab per file." },
  { mode: "preview", name: "Preview", help: "One preview window that the next file replaces. Keep it, or edit it, and the next file opens a new preview." },
];

export type SettingsPage = "general" | "windows" | "hotkeys";

const PAGES: { page: SettingsPage; name: string; icon: string }[] = [
  { page: "general", name: "General", icon: "file-text" },
  { page: "windows", name: "Windows", icon: "layout-panel-left" },
  { page: "hotkeys", name: "Hotkeys", icon: "keyboard" },
];

const [page, setPage] = createSignal<SettingsPage | null>(null);
let lastPage: SettingsPage = "general";

export const settingsOpen = () => page() !== null;
export const hotkeysOpen = () => page() === "hotkeys";

export function closeSettings() {
  if (page()) lastPage = page()!;
  setPage(null);
}

/** Open on `page`, or the page used last. */
export function openSettings(p?: SettingsPage) {
  setPage(p ?? lastPage);
}

/** The sidebar button, the palette and a file window's ⋯ menu: open on the last page, or close. */
export function toggleSettings() {
  if (settingsOpen()) closeSettings();
  else openSettings();
}

/** The ? button and the "help" hotkey: open on Hotkeys, or close it. */
export function toggleHotkeys() {
  if (hotkeysOpen()) closeSettings();
  else openSettings("hotkeys");
}

function GeneralPage() {
  return (
    <>
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
    </>
  );
}

function WindowsPage() {
  const steps = () => [keyOf("gap-less"), keyOf("gap-more")].filter(Boolean).join(" / ");
  return (
    <>
      <h4>Windows</h4>
      <label class="row">
        Gap between windows
        <span class="px">
          <input
            type="number" min={0} max={GAP_MAX} value={app.gap}
            title={steps() ? `${steps()} step it` : ""}
            onInput={(e) => e.currentTarget.value !== "" && setGap(+e.currentTarget.value)}
            onBlur={(e) => (e.currentTarget.value = String(app.gap))}
          />
          px
        </span>
      </label>
      <label class="row">
        Carousel gutter
        <span class="px">
          <input
            type="number" min={0} placeholder="auto" value={app.settings.monoGutter ?? ""}
            title="Width each side of the centred window, where its neighbours peek. Empty is auto; 0 hides them."
            onInput={(e) => setMonoGutter(e.currentTarget.value === "" ? undefined : +e.currentTarget.value)}
          />
          px
        </span>
      </label>
      <p class="note">The carousel gutter is the space each side of the centred window. Leave it empty for auto; 0 hides the neighbours.</p>
    </>
  );
}

/** Mount once (in App). Closes on a click outside it; Escape is handled in hotkeys.ts. */
export function SettingsDialog() {
  return (
    <Show when={page()}>
      {(p) => (
        <div class="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && closeSettings()}>
          <div class="settings-dlg" role="dialog" aria-label="Settings">
            <header>
              Settings <span>every project</span>
              <button type="button" class="x" title="Close (Esc)" aria-label="Close" onClick={closeSettings}>×</button>
            </header>
            <nav aria-label="Settings pages">
              <For each={PAGES}>
                {(o) => (
                  <button type="button" aria-current={p() === o.page ? "page" : undefined} onClick={() => setPage(o.page)}>
                    <Icon name={o.icon} size={14} />
                    {o.name}
                    <Show when={o.page === "hotkeys" && keyOf("help", " ")}>{(k) => <kbd>{k()}</kbd>}</Show>
                  </button>
                )}
              </For>
            </nav>
            <section class="settings-page">
              <Show when={p() === "general"}><GeneralPage /></Show>
              <Show when={p() === "windows"}><WindowsPage /></Show>
              <Show when={p() === "hotkeys"}><HotkeysPage /></Show>
            </section>
          </div>
        </div>
      )}
    </Show>
  );
}
