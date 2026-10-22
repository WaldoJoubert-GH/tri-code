// App-wide settings: a dialog with a page per topic. The Settings button at the foot of the
// sidebar opens it on the page used last; the toolbar's ? button and the "help" hotkey open the
// Hotkeys page. Chosen from design/settings-hotkeys.html.

import { For, Show, createSignal } from "solid-js";
import { GAP_MAX, app, setGap, setMonoGutter } from "./state";
import { keyOf } from "./keymap";
import { Icon } from "./lucide";
import { HotkeysPage } from "./HotkeySettings";

export type SettingsPage = "windows" | "hotkeys";

const PAGES: { page: SettingsPage; name: string; icon: string }[] = [
  { page: "windows", name: "Windows", icon: "layout-panel-left" },
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
              <Show when={p() === "hotkeys"}><HotkeysPage /></Show>
            </section>
          </div>
        </div>
      )}
    </Show>
  );
}
