// App-wide settings: a dialog with a page per topic. The Settings button at the foot of the
// sidebar opens it on the page used last; the toolbar's ? button and the "help" hotkey open the
// Hotkeys page. Chosen from design/settings-hotkeys.html.

import { For, Show, batch, createSignal } from "solid-js";
import { AgentState, DRAFT_COMMAND, GAP_MAX, GIT_TINT, GitColor, app, setDraftCommand, setDiffDefault, setGap, setGitColor, setGitTint, setMonoGutter, setClaudeUsage, setCommandCodeUsage, setSignalColor, setSkipFolders, setWorktreeAgent, skipFolders, worktreeAgent } from "./state";
import { applySignalColors } from "./signals";
import { keyOf } from "./keymap";
import { Icon } from "./lucide";
import { HotkeysPage } from "./HotkeySettings";
import { RemotePage } from "./RemoteSettings";
import { BrowserPage } from "./profiles";
import { AgentsPage } from "./AgentSettings";

export type SettingsPage = "windows" | "agents" | "files" | "git" | "signals" | "browser" | "remote" | "hotkeys";

const PAGES: { page: SettingsPage; name: string; icon: string }[] = [
  { page: "windows", name: "Windows", icon: "layout-panel-left" },
  { page: "agents", name: "Agents", icon: "bot" },
  { page: "files", name: "Files", icon: "folder-search" },
  { page: "git", name: "Git", icon: "git-branch" },
  { page: "signals", name: "Signals", icon: "bell" },
  { page: "browser", name: "Browser", icon: "globe" },
  { page: "remote", name: "Remote", icon: "smartphone" },
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

const SIGNAL_COLORS: { key: AgentState; name: string }[] = [
  { key: "working", name: "Working" },
  { key: "blocked", name: "Needs you" },
  { key: "done", name: "Done" },
  { key: "error", name: "Error" },
];

/** The theme's colour for a --state-* token, as #rrggbb for the colour input. */
function signalThemeColor(key: AgentState) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--state-${key}`).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#888888";
}

function SignalsPage() {
  // Applied at once, so the picker reads the theme's colour again straight after a reset.
  const pick = (key: AgentState, color: string | undefined) =>
    batch(() => {
      setSignalColor(key, color);
      applySignalColors();
    });
  return (
    <>
      <h4>Colours</h4>
      <For each={SIGNAL_COLORS}>
        {(s) => (
          <label class={`row signal-color s-${s.key}`}>
            <span class={`sg s-${s.key}`} />
            {s.name}
            <input
              type="color"
              aria-label={`${s.name} colour`}
              value={app.settings.signalColors?.[s.key] ?? signalThemeColor(s.key)}
              onInput={(e) => pick(s.key, e.currentTarget.value)}
            />
            <button type="button" class="reset" title="Back to the theme's colour" disabled={!app.settings.signalColors?.[s.key]} onClick={() => pick(s.key, undefined)}>↺</button>
          </label>
        )}
      </For>
      <p class="note">Used by the project and workspace badges, the tabs, the status line, window borders and the agent chip. Working is blue; the others follow the theme. A colour you pick is kept in light and dark; ↺ goes back to the theme's.</p>
    </>
  );
}

/** The three Draft Commands. Each example is a Claude Code command and the same model through pi. */
const DRAFT_ROWS = [
  { kind: "commit", name: "Commit message", examples: ['claude -p --model claude-haiku-5-5 --tools ""', "pi -p --model commandcode/claude-haiku-5-5 --no-tools --no-session"] },
  { kind: "pr", name: "Pull request", examples: ['claude -p --model claude-sonnet-5-5 --tools ""', "pi -p --model commandcode/claude-sonnet-5-5 --no-tools --no-session"] },
  { kind: "review", name: "Review", examples: ['claude -p --model opus --tools ""', "pi -p --model commandcode/claude-opus-5-5 --no-tools --no-session"] },
] as const;

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
      <h4>Worktrees</h4>
      <label class="row wt-agent">
        New worktree opens
        <select value={worktreeAgent()} onChange={(e) => setWorktreeAgent(e.currentTarget.value)}>
          <For each={app.agents}>{(a) => <option value={a.id}>{a.name || "untitled"}</option>}</For>
          <option value="">nothing</option>
        </select>
        <button type="button" class="reset" title="Back to the first agent with a command" disabled={app.settings.worktreeAgent === undefined} onClick={() => setWorktreeAgent(undefined)}>↺</button>
      </label>
      <p class="note">The agent the New worktree dialog starts on; you can still pick another there.</p>
      <h4>Drafts</h4>
      <For each={DRAFT_ROWS}>
        {(d) => (
          <div class="draft-kind">
            <label class="row draft-row">
              {d.name}
              <input
                type="text"
                spellcheck={false}
                aria-label={`${d.name} draft command`}
                value={app.settings.draftCommands?.[d.kind] ?? DRAFT_COMMAND}
                onChange={(e) => setDraftCommand(d.kind, e.currentTarget.value)}
              />
              <button type="button" class="reset" title={`Back to ${DRAFT_COMMAND}`} disabled={app.settings.draftCommands?.[d.kind] === undefined} onClick={() => setDraftCommand(d.kind, undefined)}>↺</button>
            </label>
            <ul class="draft-eg">
              <For each={d.examples}>{(e) => <li>{e}</li>}</For>
            </ul>
          </div>
        )}
      </For>
      <p class="note">Each command runs in the project folder on the project's host, with the prompt on stdin. Its stdout is the draft. A failure on stderr, or a non-zero exit, shows as ✦ draft failed.</p>
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
      <h4>Status line</h4>
      <div class="row">
        Claude usage
        <span class="set-seg" role="radiogroup" aria-label="Claude usage">
          <For each={[[true, "Show"], [false, "Hide"]] as const}>
            {([on, label]) => (
              <button type="button" role="radio" aria-checked={(app.settings.claudeUsage !== false) === on} onClick={() => setClaudeUsage(on)}>
                {label}
              </button>
            )}
          </For>
        </span>
      </div>
      <p class="note">The session and weekly limits at the bottom right, read with Claude Code's login every 5 minutes. Hidden, it isn't fetched.</p>
      <div class="row">
        Command Code usage
        <span class="set-seg" role="radiogroup" aria-label="Command Code usage">
          <For each={[[true, "Show"], [false, "Hide"]] as const}>
            {([on, label]) => (
              <button type="button" role="radio" aria-checked={(app.settings.commandCodeUsage !== false) === on} onClick={() => setCommandCodeUsage(on)}>
                {label}
              </button>
            )}
          </For>
        </span>
      </div>
      <p class="note">Command Code's 5-hour and weekly limits, read with its own login every 5 minutes. It shows nothing until you're signed in there, and is not fetched when hidden.</p>
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
              <Show when={p() === "agents"}><AgentsPage /></Show>
              <Show when={p() === "files"}><FilesPage /></Show>
              <Show when={p() === "git"}><GitPage /></Show>
              <Show when={p() === "signals"}><SignalsPage /></Show>
              <Show when={p() === "browser"}><BrowserPage /></Show>
              <Show when={p() === "remote"}><RemotePage /></Show>
              <Show when={p() === "hotkeys"}><HotkeysPage /></Show>
            </section>
          </div>
        </div>
      )}
    </Show>
  );
}
