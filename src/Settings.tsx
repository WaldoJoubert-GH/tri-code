// App-wide settings: a dialog with a page per topic. The Settings button at the foot of the
// sidebar opens it on the page used last; the toolbar's ? button and the "help" hotkey open the
// Hotkeys page. Chosen from design/settings-hotkeys.html.

import { For, Show, createSignal } from "solid-js";
import { GAP_MAX, app, setDiffDefault, setGap, setMonoGutter, setSkipFolders, skipFolders } from "./state";
import { keyOf } from "./keymap";
import { Icon } from "./lucide";
import { HotkeysPage } from "./HotkeySettings";

export type SettingsPage = "windows" | "files" | "hotkeys";

const PAGES: { page: SettingsPage; name: string; icon: string }[] = [
  { page: "windows", name: "Windows", icon: "layout-panel-left" },
  { page: "files", name: "Files", icon: "folder-search" },
  { page: "hotkeys", name: "Hotkeys", icon: "keyboard" },
];

const [page, setPage] = createSignal<SettingsPage | null>(null);
let lastPage: SettingsPage = "windows";

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

/** The sidebar button and the palette: open on the last page, or close. */
export function toggleSettings() {
  if (settingsOpen()) closeSettings();
  else openSettings();
}

/** The ? button and the "help" hotkey: open on Hotkeys, or close it. */
export function toggleHotkeys() {
  if (hotkeysOpen()) closeSettings();
  else openSettings("hotkeys");
}

function FilesPage() {
  return (
    <>
      <h4>Go to File</h4>
      <label class="row skip-row">
        Skip folders
        <textarea
          rows={2}
          spellcheck={false}
          value={skipFolders().join(", ")}
          title="Folder names, wherever they are. Gitignored files elsewhere are still found."
          onChange={(e) => setSkipFolders(e.currentTarget.value.split(/[,\s]+/))}
        />
        <Show when={app.settings.skipFolders}>
          <button type="button" class="reset" title="Back to the default list" onClick={() => setSkipFolders(undefined)}>↺</button>
        </Show>
      </label>
      <p class="note">Folder names, separated by commas or spaces, that Go to File never looks in, gitignored or not. <code>.git</code> is always skipped. Takes effect the next time the box opens.</p>
      <h4>Diffs</h4>
      <div class="row">
        Layout
        <span class="set-seg" role="radiogroup" aria-label="Diff layout">
          <For each={[["unified", "☰ Unified", "Stacked: removed lines above the added ones"], ["split", "▥ Split", "Side by side: before on the left, after on the right"]] as const}>
            {([m, label, title]) => (
              <button type="button" role="radio" aria-checked={(app.settings.diffMode ?? "split") === m} title={title} onClick={() => setDiffDefault(m)}>
                {label}
              </button>
            )}
          </For>
        </span>
      </div>
      <p class="note">For the git window and the editor's Diff, in every project. The toggle in a diff still switches one project; choosing here resets them all. Split shows unified in a pane narrower than about 660px.</p>
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
              <Show when={p() === "windows"}><WindowsPage /></Show>
              <Show when={p() === "files"}><FilesPage /></Show>
              <Show when={p() === "hotkeys"}><HotkeysPage /></Show>
            </section>
          </div>
        </div>
      )}
    </Show>
  );
}
