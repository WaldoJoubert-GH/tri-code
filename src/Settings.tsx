// App-wide settings: a dialog with a page per topic. The Settings button at the foot of the
// sidebar opens it on the page used last; the toolbar's ? button and the "help" hotkey open the
// Hotkeys page. Chosen from design/settings-hotkeys.html.

import { For, Show, createSignal } from "solid-js";
import { GAP_MAX, GIT_TINT, GitColor, app, setDiffDefault, setGap, setGitColor, setGitTint, setMonoGutter, setSkipFolders, skipFolders } from "./state";
import { keyOf } from "./keymap";
import { Icon } from "./lucide";
import { HotkeysPage } from "./HotkeySettings";

export type SettingsPage = "windows" | "files" | "git" | "hotkeys";

const PAGES: { page: SettingsPage; name: string; icon: string }[] = [
  { page: "windows", name: "Windows", icon: "layout-panel-left" },
  { page: "files", name: "Files", icon: "folder-search" },
  { page: "git", name: "Git", icon: "git-branch" },
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

const GIT_COLORS: { key: GitColor; name: string; letter: string; cls: string }[] = [
  { key: "add", name: "Added and untracked", letter: "A", cls: "s-A" },
  { key: "del", name: "Deleted", letter: "D", cls: "s-D" },
  { key: "mod", name: "Modified", letter: "M", cls: "s-M" },
  { key: "ren", name: "Renamed and copied", letter: "R", cls: "s-R" },
];

/** The theme's colour for a --git-* token, as #rrggbb for the colour input. */
function themeColor(key: GitColor) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--git-${key}`).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#888888";
}

function GitPage() {
  return (
    <>
      <h4>Colours</h4>
      <For each={GIT_COLORS}>
        {(c) => (
          <label class="row git-color">
            <span class={`g-st ${c.cls}`}>{c.letter}</span>
            {c.name}
            <input
              type="color"
              value={app.settings.gitColors?.[c.key] ?? themeColor(c.key)}
              onInput={(e) => setGitColor(c.key, e.currentTarget.value)}
            />
            <button type="button" class="reset" title="Back to the theme's colour" disabled={!app.settings.gitColors?.[c.key]} onClick={() => setGitColor(c.key, undefined)}>↺</button>
          </label>
        )}
      </For>
      <label class="row git-tint">
        Diff line highlight
        <input type="range" min="0" max="60" step="2" value={String(app.settings.gitTint ?? GIT_TINT)} onInput={(e) => setGitTint(+e.currentTarget.value)} />
        <span class="val">{app.settings.gitTint ?? GIT_TINT}%</span>
        <button type="button" class="reset" title="Back to the default" disabled={app.settings.gitTint === undefined} onClick={() => setGitTint(undefined)}>↺</button>
      </label>
      <div class="git-preview" aria-hidden="true">
        <For each={[["", 41, 41, "export function togglePin(id: string) {"], ["d", 42, "", "  edit(id, (p) => { p.pinned = !p.pinned; });"], ["a", "", 42, "  edit(id, (p) => (p.pinned = !p.pinned));"], ["", 43, 43, "}"]] as const}>
          {([k, o, n, t]) => (
            <div class={`dv-urow ${k}`}>
              <span class="ln">{o}</span><span class="ln">{n}</span><span class="mk">{k === "a" ? "+" : k === "d" ? "−" : ""}</span><span class="tx">{t}</span>
            </div>
          )}
        </For>
      </div>
      <p class="note">Used by the git window, diffs, the file tree's status marks and the status line. A colour you pick is kept in light and dark; ↺ goes back to the theme's.</p>
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
              <Show when={p() === "git"}><GitPage /></Show>
              <Show when={p() === "hotkeys"}><HotkeysPage /></Show>
            </section>
          </div>
        </div>
      )}
    </Show>
  );
}
