// App-wide settings: a dialog with a page per topic. The Settings button at the foot of the
// sidebar opens it on the page used last; the toolbar's ? button and the "help" hotkey open the
// Hotkeys page. Chosen from design/settings-hotkeys.html; the Appearance page from variant B of
// design/settings-appearance.html.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, batch, createResource } from "solid-js";
import { AgentState, DRAFT_COMMAND, envIcon, envName, isLocalHost, GAP_MAX, GIT_TINT, GitColor, app, setSettings, setDraftCommand, setDiffDefault, setFont, setGap, setGitColor, setGitTint, setMonoGutter, setPreview, setClaudeUsage, setClaudeDailyTarget, setMedia, setLinkedFolders, setEnvHeaders, setClaudePace, setCommandCodeUsage, setSignalColor, setSkipFolders, setTheme, setWorktreeAgent, skipFolders, worktreeAgent } from "./state";
import { type FontKind, type Theme, fontMissing, themeOf } from "./look";
import { applySignalColors } from "./signals";
import { keyOf } from "./keymap";
import { Icon } from "./lucide";
import { Modal } from "./Modal";
import { Caps, KeyList } from "./Keys";
import { HotkeysPage } from "./HotkeySettings";
import { RemotePage } from "./RemoteSettings";
import { BrowserPage } from "./profiles";
import { NewsPage } from "./NewsSettings";
import { AgentsPage } from "./AgentSettings";
import { BackupPage } from "./Backup";
import { CliPage } from "./CliSettings";
import { SandboxPage } from "./SandboxSettings";
import { LanguagesPage } from "./LangSettings";
import { PREVIEWS, previewOn } from "./preview";
import { type SettingsPage, closeSettings, pageShown, setSettingsPage, settingsPage } from "./nav";
import { SignalsForm } from "./SignalSettings";
import { openEnvDialog } from "./EnvDialog";
import { openWelcome } from "./Welcome";
import { ICON_THEMES, type IconTheme } from "./fileicons";
import { FileIcon } from "./FileList";
import "./files.css";
import { linksOn } from "./links";

const PAGES: { page: SettingsPage; name: string; icon: string }[] = [
  { page: "appearance", name: "Appearance", icon: "palette" },
  { page: "windows", name: "Windows", icon: "layout-panel-left" },
  { page: "agents", name: "Agents", icon: "bot" },
  { page: "environments", name: "Environments", icon: "server" },
  { page: "files", name: "Files", icon: "folder-search" },
  { page: "languages", name: "Languages", icon: "code" },
  { page: "git", name: "Git", icon: "git-branch" },
  { page: "sandbox", name: "Sandbox", icon: "shield" },
  { page: "signals", name: "Signals", icon: "bell" },
  { page: "browser", name: "Browser", icon: "globe" },
  { page: "news", name: "News", icon: "rss" },
  { page: "remote", name: "Remote", icon: "smartphone" },
  { page: "cli", name: "Command line", icon: "square-terminal" },
  { page: "hotkeys", name: "Hotkeys", icon: "keyboard" },
  { page: "backup", name: "Backup", icon: "archive" },
  { page: "preview", name: "Preview", icon: "flask-conical" },
];

/** Settings › Preview: each preview feature with its own switch, all off until turned on. */
function PreviewPage() {
  return (
    <>
      <h4>Preview features</h4>
      <p class="note">Still being built and off by default. Turn one on to try it. Off, it is hidden everywhere; turning it on again brings back what it made.</p>
      <For each={PREVIEWS}>
        {(f) => (
          <div class="row preview-row">
            <span class="preview-tx">
              <b><Icon name={f.icon} size={13} /> {f.name}</b>
              <span class="note">{f.about}</span>
            </span>
            <span class="set-seg" role="radiogroup" aria-label={f.name}>
              <For each={[[false, "Off"], [true, "On"]] as const}>
                {([on, label]) => (
                  <button type="button" role="radio" aria-checked={previewOn(f.id) === on} onClick={() => setPreview(f.id, on)}>
                    {label}
                  </button>
                )}
              </For>
            </span>
          </div>
        )}
      </For>
    </>
  );
}

const THEMES: { theme: Theme; name: string; icon: string; title: string }[] = [
  { theme: "system", name: "System", icon: "monitor", title: "Follow your OS, and change when it does" },
  { theme: "light", name: "Light", icon: "sun", title: "Light, whatever your OS is set to" },
  { theme: "dark", name: "Dark", icon: "moon", title: "Dark, whatever your OS is set to" },
];

/** One font's row: a dropdown of what's installed, with a warning if the saved font isn't. */
function FontRow(props: { kind: FontKind; name: string; fonts: string[] | null; installed: string[] | null }) {
  const saved = () => (props.kind === "ui" ? app.settings.fontUi : app.settings.fontMono);
  // A saved font stays in the list while it's missing, or the dropdown would say Default.
  const options = () => {
    const s = saved();
    return s && !props.fonts?.includes(s) ? [s, ...(props.fonts ?? [])] : props.fonts ?? [];
  };
  return (
    <>
      <label class="row font-row">
        <span class="lbl">{props.name}</span>
        <select value={saved() ?? ""} onChange={(e) => setFont(props.kind, e.currentTarget.value)}>
          <option value="">Default</option>
          <For each={options()}>{(f) => <option value={f} selected={f === saved()}>{f}</option>}</For>
        </select>
        <button type="button" class="reset" title="Back to the default" aria-label={`Reset ${props.name} font`} disabled={!saved()} onClick={() => setFont(props.kind, undefined)}>↺</button>
      </label>
      <Show when={fontMissing(saved(), props.installed)}>
        <p class="font-missing">{saved()} isn't installed here, so the default is showing. It comes back when the font does.</p>
      </Show>
    </>
  );
}

/** A two-or-more-way choice as a segmented control. */
function Seg<T>(props: { label: string; value: T; items: readonly (readonly [T, string, string?])[]; set: (v: T) => void }) {
  return (
    <span class="set-seg" role="radiogroup" aria-label={props.label}>
      <For each={props.items}>
        {([v, name, title]) => (
          <button type="button" role="radio" aria-checked={props.value === v} title={title} onClick={() => props.set(v)}>{name}</button>
        )}
      </For>
    </span>
  );
}

const ICON_SAMPLE: [string, boolean, boolean, number][] = [
  ["src", true, true, 0], ["FileList.tsx", false, false, 1], ["files.css", false, false, 1], ["docs", true, false, 0],
  ["node_modules", true, false, 0], ["Cargo.toml", false, false, 0], ["package.json", false, false, 0], ["README.md", false, false, 0],
];

function FileIconsSection() {
  const theme = () => app.settings.fileIcons ?? "classic";
  return (
    <>
      <h4>File icons</h4>
      <div class="row">
        Icon theme
        <Seg<IconTheme> label="File icon theme" value={theme()} items={ICON_THEMES.map((t) => [t.id, t.name, t.blurb] as const)}
          set={(v) => setSettings({ fileIcons: v === "classic" ? undefined : v })} />
      </div>
      <Show when={theme() === "atom" || theme() === "material"}>
        <div class="row icon-opt">
          Folders
          <Seg label="Folders" value={!!app.settings.iconPlainFolders}
            items={[[false, "By name", "src, docs, assets… each in its own colour and badge"], [true, "Plain", "Every folder the same grey"]]}
            set={(v) => setSettings({ iconPlainFolders: v || undefined })} />
        </div>
      </Show>
      <Show when={theme() === "atom"}>
        <div class="row icon-opt">
          Open folders
          <Seg label="Open folders" value={!!app.settings.iconFilledOpen}
            items={[[false, "Hollow", "Expanded folders as an outline"], [true, "Filled", "Expanded folders like closed ones"]]}
            set={(v) => setSettings({ iconFilledOpen: v || undefined })} />
        </div>
        <div class="row icon-opt">
          Colour
          <Seg label="Icon colour" value={!!app.settings.iconMono}
            items={[[false, "Coloured", "Each kind of file in its own colour"], [true, "Mono", "Every icon in the text colour"]]}
            set={(v) => setSettings({ iconMono: v || undefined })} />
        </div>
      </Show>
      <div class="icon-sample" aria-hidden="true">
        <For each={ICON_SAMPLE}>
          {([name, dir, open, depth]) => (
            <div class="frow" classList={{ dir }} style={{ "padding-left": `${6 + depth * 12}px` }}>
              <span class="fchev">{dir ? (open ? "▾" : "▸") : ""}</span>
              <FileIcon name={name} dir={dir} open={open} />
              <span class="fname">{name}</span>
            </div>
          )}
        </For>
      </div>
      <p class="note">The editor's file tree, its tabs and Go to File. The palette's <b>File Icon Theme…</b> previews each one as you move through them.</p>
    </>
  );
}

function AppearancePage() {
  const [fonts] = createResource(() => invoke<{ all: string[]; mono: string[] }>("font_list").catch((e) => {
    console.warn("font_list failed:", e);
    return null;
  }));
  const theme = () => themeOf(app.settings);
  return (
    <>
      <h4>Theme</h4>
      <div class="row">
        <span class="set-seg theme-seg" role="radiogroup" aria-label="Theme">
          <For each={THEMES}>
            {(t) => (
              <button type="button" role="radio" aria-checked={theme() === t.theme} title={t.title} onClick={() => setTheme(t.theme)}>
                <Icon name={t.icon} size={12} />
                {t.name}
              </button>
            )}
          </For>
        </span>
      </div>
      <p class="note">{theme() === "system" ? "Follows your OS, and changes when it does." : `Stays ${theme()} whatever your OS is set to.`} Terminals and the editor change too. Colours you picked under Git and Signals are kept.</p>
      <h4>Keys</h4>
      <div class="row">
        Key colour
        <span class="set-seg" role="radiogroup" aria-label="Key colour">
          <For each={[[false, "Neutral", "Plain keys, like a keyboard's"], [true, "Accent", "Keys in the project's accent colour"]] as const}>
            {([accent, name, title]) => (
              <button type="button" role="radio" aria-checked={!!app.settings.accentKeys === accent} title={title} onClick={() => setSettings({ accentKeys: accent || undefined })}>
                {name}
              </button>
            )}
          </For>
        </span>
        <KeyList keys={["Shift", "W"]} class="key-sample" />
      </div>
      <p class="note">Every key the app draws, in hints, panels, dialogs and Settings.</p>
      <FileIconsSection />
      <h4>Fonts</h4>
      <FontRow kind="ui" name="Interface" fonts={fonts()?.all ?? null} installed={fonts()?.all ?? null} />
      <FontRow kind="mono" name="Code" fonts={fonts()?.mono ?? null} installed={fonts()?.all ?? null} />
      <div class="font-sample" aria-hidden="true">
        <div class="ui"><b>Open project</b><span>Worktrees and agents</span></div>
        <pre>
          <span class="fs-dir">~/tri-code</span> $ git status{"\n"}
          <span class="fs-add">A</span> src/Settings.tsx  <span class="fs-mod">M</span> src/styles.css{"\n"}
          0O 1lI {"{}[]"} =&gt; != &lt;= ===
        </pre>
      </div>
      <p class="note">Interface is for menus, panels and labels. Code is for terminals, the editor and diffs, so it only lists monospaced fonts.</p>
    </>
  );
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
      <h4>Linked folders</h4>
      <div class="row">
        Linked folders
        <span class="set-seg" role="radiogroup" aria-label="Linked folders">
          <For each={[[true, "On"], [false, "Off"]] as const}>
            {([on, label]) => (
              <button type="button" role="radio" aria-checked={linksOn() === on} onClick={() => setLinkedFolders(on)}>
                {label}
              </button>
            )}
          </For>
        </span>
      </div>
      <p class="note">
        Show other folders beside a project's own: an extra root each in the Editor's tree, and their files in Go to File. A project on an ssh host can link a folder there or on this computer. Link one from the tree's header or Link folder… in <Caps id="palette" />. Off, they are hidden and each project's links are kept for when it is on again.
      </p>
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

/** Settings › Environments: the machines projects run on, as the Welcome window's Machines step. */
function EnvironmentsPage() {
  return (
    <>
      <h4>Environments</h4>
      <For each={app.environments}>
        {(h) => (
          <div class="row env-row">
            <Icon name={envIcon(h)} size={14} />
            <span class="env-tx"><b>{envName(h)}</b>{isLocalHost(h) ? "this computer" : `over ssh · ${h}`}</span>
            <button type="button" class="set-btn" onClick={() => openEnvDialog(h)}>Edit…</button>
          </div>
        )}
      </For>
      <div class="row">
        <button type="button" class="set-btn" onClick={() => openEnvDialog()}><Icon name="plus" size={12} />Add an ssh host</button>
      </div>
      <p class="note">Projects are grouped by Environment in the sidebar. A host needs ssh that logs in with a key, and ideally shpool. To remove one, right-click its header in the sidebar.</p>
    </>
  );
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
      <div class="set-signals"><SignalsForm /></div>
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
      <p class="note">The command the New worktree dialog starts with under “and open”; you can pick more there.</p>
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
      <h4>Sidebar</h4>
      <div class="row">
        Environment headers
        <span class="set-seg" role="radiogroup" aria-label="Environment headers">
          <For each={[["show", "Show", "A header over each Environment, always"], ["auto", "Auto", "Hidden while there's only one Environment"], ["hide", "Hide", "No headers: one list of projects"]] as const}>
            {([v, label, title]) => (
              <button type="button" role="radio" aria-checked={(app.settings.envHeaders ?? "show") === v} title={title} onClick={() => setEnvHeaders(v)}>
                {label}
              </button>
            )}
          </For>
        </span>
      </div>
      <p class="note">Hidden, the projects run on as one list, still grouped by Environment. Right-click a project for its Environment, and a lock on its icon shows when it has a PIN. An Environment with no projects shows only in Open project.</p>
      <h4>Media</h4>
      <div class="row">
        Media controls
        <span class="set-seg" role="radiogroup" aria-label="Media controls">
          <For each={[[true, "On"], [false, "Off"]] as const}>
            {([on, label]) => (
              <button type="button" role="radio" aria-checked={(app.settings.media !== false) === on} onClick={() => setMedia(on)}>
                {label}
              </button>
            )}
          </For>
        </span>
      </div>
      <p class="note">
        What this computer is playing (Spotify, a browser tab, anything in Windows' media flyout; MPRIS players through playerctl on Linux) shows above Settings in the sidebar, with play, pause, skip and seek. Hidden while nothing plays. <Caps id="media-play" /> plays or pauses, <Caps id="media-next" /> and <Caps id="media-prev" /> skip (Hotkeys changes them). Off, nothing is watched. Not on macOS yet.
      </p>
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
      <label class="row">
        Claude daily target
        <span class="px">
          <input
            type="number" min={0} max={100} step={1} placeholder="off" value={app.settings.claudeDailyTarget ?? ""}
            onInput={(e) => setClaudeDailyTarget(e.currentTarget.value === "" ? undefined : +e.currentTarget.value)}
          />
          % / day
        </span>
      </label>
      <div class="row">
        Pace line moves
        <span class="set-seg" role="radiogroup" aria-label="Pace line moves">
          <For each={[["day", "Per day"], ["smooth", "Smoothly"]] as const}>
            {([pace, label]) => (
              <button type="button" role="radio" aria-checked={(app.settings.claudePace ?? "day") === pace} onClick={() => setClaudePace(pace)}>
                {label}
              </button>
            )}
          </For>
        </span>
      </div>
      <p class="note">A red line on Claude's week meter at where your daily target puts you by now: the target × days since the week began (7 days before it resets). Per day, it jumps to each day's full allowance at the day boundary; smoothly, it creeps forward through the day. Empty or 0 is off.</p>
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
    <Show when={settingsPage()}>
      {(p) => (
        <Modal label="Settings" onClose={closeSettings}>
          <div class="settings-dlg">
            <header>
              Settings <span>every project</span>
              <button type="button" class="x" title="Close (Esc)" aria-label="Close" onClick={closeSettings}>×</button>
            </header>
            <nav aria-label="Settings pages">
              <For each={PAGES.filter((o) => pageShown(o.page))}>
                {(o) => (
                  <button type="button" aria-current={p() === o.page ? "page" : undefined} onClick={() => setSettingsPage(o.page)}>
                    <Icon name={o.icon} size={14} />
                    {o.name}
                    <Show when={o.page === "hotkeys"}><Caps id="help" /></Show>
                  </button>
                )}
              </For>
              <button type="button" class="rerun" title="The first-launch setup: theme, agents, signals, environments" onClick={() => { closeSettings(); openWelcome(); }}>
                <Icon name="rocket" size={14} />
                Set up tri-code…
              </button>
            </nav>
            <section class="settings-page">
              <Show when={p() === "appearance"}><AppearancePage /></Show>
              <Show when={p() === "windows"}><WindowsPage /></Show>
              <Show when={p() === "agents"}><AgentsPage /></Show>
              <Show when={p() === "environments"}><EnvironmentsPage /></Show>
              <Show when={p() === "files"}><FilesPage /></Show>
              <Show when={p() === "languages"}><LanguagesPage /></Show>
              <Show when={p() === "git"}><GitPage /></Show>
              <Show when={p() === "sandbox" && pageShown("sandbox")}><SandboxPage /></Show>
              <Show when={p() === "signals"}><SignalsPage /></Show>
              <Show when={p() === "browser"}><BrowserPage /></Show>
              <Show when={p() === "news"}><NewsPage /></Show>
              <Show when={p() === "remote"}><RemotePage /></Show>
              <Show when={p() === "cli"}><CliPage /></Show>
              <Show when={p() === "hotkeys"}><HotkeysPage /></Show>
              <Show when={p() === "backup"}><BackupPage /></Show>
              <Show when={p() === "preview"}><PreviewPage /></Show>
            </section>
          </div>
        </Modal>
      )}
    </Show>
  );
}
