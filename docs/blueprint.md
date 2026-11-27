# Codebase blueprint: one folder per module, `shared/` for cross-module use

Status: in progress. Steps 1 (back-edges), 2 (`src/shared/`) and 3 (leaf modules) of the [Migration order](#migration-order) are done; the inner modules and `app/` are still flat in `src/`.

Today `src/` is flat: 193 files, with every window, dialog, store and helper side by side. `src-tauri/src/` is flat too, apart from `db/`. This blueprint gives each module a folder and an **interface** (its `index.ts` / `mod.rs`), and puts what several modules use in `shared/`.

Terms follow the codebase-design vocabulary: a **module** has one **interface**; other modules cross its **seam** only there.

## Rules

1. **A module is a folder.** `src/modules/<name>/` holds the module's logic, its panels and dialogs, its CSS, its tests and its Settings page.
2. **`index.ts` is the interface.** Another module imports `../<name>` (the folder), never a file inside it. Inside a module, files import each other freely.
3. **`shared/` holds what two or more modules use.** It never imports from `modules/` or `app/`. When only one module uses a file, the file belongs in that module.
4. **`app/` is the composition root.** It may import every module; no module imports `app/`. The window kinds (`Canvas.tsx`, `tabs.tsx`), the hotkeys, the Command Palette and the Settings shell live here because they assemble everything.
5. **Settings pages live in their module.** `NewsSettings.tsx` goes to `modules/news/`; `app/settings/` only lays the pages out.
6. **Tests sit beside the code they test** (`*.test.ts` in the same folder). `bun test ./src/` already finds them recursively.

Rule 3 and 4 are enforced by a test (see [Enforcement](#enforcement)), as `keys.test.ts` already enforces Keycaps.

## Frontend layout (`src/`)

### `src/shared/`

| Folder | Files | Why it is shared |
|---|---|---|
| `shared/state/` | `state.ts`, `movetab.test.ts`, `resume.test.ts`, `pageprofiles.test.ts` | The app store; every module reads it. |
| `shared/ui/` | `ui.ts` (flash, toast, ask, clock), `Modal.tsx`, `ctxmenu.tsx`, `lucide.tsx`, `icons.tsx`, `fileicons.ts`, `favicons.ts`, `clipboard.ts`, `enterkey.ts`, and the tests of the last three | The UI kit: dialogs, menus, icons, copy. |
| `shared/keys/` | `keymap.ts`, `modkey.ts`, `hints.ts`, `Keys.tsx`, `keys.test.ts`, `hints.test.ts` | The Keymap, Hotkey Modifier, Hold Hints and Keycap: drawn by every module. |
| `shared/text/` | `diff.ts`, `DiffView.tsx`, `diff.css`, `markdown.ts`, `csv.ts`, `branchname.ts`, and the tests of `diff`, `markdown`, `csv` | Pure parsers used by 2+ modules (diff: Editor, Git, state; csv: Editor, Database). |
| `shared/codemirror/` | `cm.ts`, `langs.ts`, `grammars.ts`, `grammars.json`, `textmate.ts`, `tmparser.ts`, `LangPicker.tsx`, `LangSettings.tsx`, `grammars.test.ts`, `tmparser.test.ts` | The CodeMirror kit and Grammar Catalog: Editor, Database and Calculator all build editors on it. |
| `shared/` (top) | `look.ts`, `backdrop.ts` (each with its test), `preview.ts`, `scope.ts`, `sigs.ts`, `nav.ts`, `urls.ts`, `layout.test.ts` | Look, Backdrop, preview flags, Command Scope, the signal rules, and app-level navigation (see Back-edges). `urls.ts` also holds `NOT_HTTP` (step 3): the Docker Window and Remote Tunnels (`tunnelmap.ts`) both use it. |

Done in step 2. `preview.test.ts` tests the preview flag through `sandbox.ts` (`sandboxOf`, `runsInSandbox`), so it moved to `modules/sandbox/` in step 3. `projects.ts` stays in `src/` (see Back-edges).

### `src/modules/`

| Module | Files |
|---|---|
| `terminal/` | `terms.ts`, `agentwin.ts`, `demo.ts` |
| `agents/` (Commands; `Agent` in code) | `agents.ts`, `agentkeys.ts`, `agenttarget.ts`, `agentsetup.ts`, `AgentsPanel.tsx`, `AgentSettings.tsx`, `SetupBanner.tsx`, `agents.css`, `agentsetup.css` |
| `signals/` | `signals.ts`, `SignalSettings.tsx`, `SoundSelect.tsx` |
| `browser/` | `browsers.ts`, `profiles.tsx`, `debugmenu.tsx`, `downloads.tsx`, `favs.tsx`, `tunnels.ts`, `tunnelmap.ts`, `tunnelui.tsx`, `shots.ts` |
| `editor/` | `Editor.tsx`, `FileList.tsx`, `files.ts`, `MdPaper.tsx`, `mdexport.ts`, `files.css` |
| `linked-folders/` | `links.ts`, `LinkFolder.tsx` |
| `git/` | `git.ts`, `repos.ts`, `GitPanel.tsx`, `git.css`, `gitmarks.test.ts`, `marks.test.ts` |
| `issues/` | `issues.ts`, `timeline.ts`, `IssuesPanel.tsx` |
| `db/` | `db.ts`, `dbsql.ts`, `DbPanel.tsx`, `SheetView.tsx`, `db.css`, `sheet.css` |
| `docker/` | `docker.ts`, `dockerdata.ts`, `DockerPanel.tsx`, `docker.css` |
| `monitor/` | `monitor.ts`, `monitordata.ts`, `MonitorPanel.tsx`, `monitor.css` |
| `news/` | `news.ts`, `newsdata.ts`, `NewsPanel.tsx`, `NewsSettings.tsx`, `news.css` |
| `calc/` | `calc.ts`, `calcdata.ts`, `calclang.ts`, `CalcPanel.tsx`, `calc.css` |
| `media/` | `media.ts`, `MediaDock.tsx`, `media.css` |
| `environments/` | `EnvDialog.tsx`, `envform.ts`, `envlock.tsx`, `OpenProject.tsx`, `newfolder.ts` |
| `worktrees/` | `worktrees.ts`, `agentworktree.ts`, `setup.ts`, `ignored.ts`, `NewWorktree.tsx`, `WorktreeDialog.tsx` |
| `leftovers/` | `leftovers.ts`, `LeftoversPopover.tsx` |
| `sandbox/` | `sandbox.ts`, `SandboxSettings.tsx`, `sandbox.css` |
| `phone/` (Remote Control) | `phone.ts`, `phoneask.ts`, `RemoteSettings.tsx` |
| `appearance/` | `Appearance.tsx` |
| `welcome/` | `Welcome.tsx`, `welcomedata.ts`, `welcome.css` |
| `tour/` | `Tour.tsx` |
| `usage/` | `Usage.tsx`, `pace.ts` |

Each module's tests sit with it. Step 3 also moved `preview.test.ts` to `sandbox/`, and split `links.test.ts`'s `connOf` case into a new `db/db.test.ts` (see [step 3](#step-3-leaf-modules)).

### `src/app/`

`index.tsx`, `App.tsx`, `Canvas.tsx`, `tabs.tsx`, `layout.ts`, `Sidebar.tsx`, `commands.ts`, `hotkeys.ts`, `Palette.tsx`, `About.tsx`, `Feedback.tsx`, `RestartDialog.tsx`, `updater.ts`, `styles.css`, `canvas.css`, `__selftest.ts`, `vite-env.d.ts`, plus:

- `app/settings/`: `Settings.tsx`, `Backup.tsx`, `config.ts`, `HotkeySettings.tsx`
- `app/cli/`: `cli.ts`, `clipaths.ts`, `CliSettings.tsx` (the tri Command)

## Example tree

The frontend after the move. Each module also gets a new `index.ts`, its interface (marked ◆).

```
src/
├── app/                          composition root: may import anything
│   ├── index.tsx                 entry (index.html points here)
│   ├── App.tsx
│   ├── Canvas.tsx
│   ├── canvas.css                window frames, tiling, mono, split handle
│   ├── tabs.tsx
│   ├── layout.ts
│   ├── layout.test.ts
│   ├── Sidebar.tsx
│   ├── commands.ts               Command Palette entries
│   ├── hotkeys.ts
│   ├── Palette.tsx
│   ├── palette.css
│   ├── About.tsx
│   ├── Feedback.tsx
│   ├── RestartDialog.tsx
│   ├── restart.test.ts
│   ├── updater.ts
│   ├── app.css                   sidebar, toolbar, status line (from styles.css)
│   ├── settings/
│   │   ├── Settings.tsx          the shell: lays out each module's page
│   │   ├── settings.css
│   │   ├── Backup.tsx
│   │   ├── config.ts
│   │   ├── config.test.ts
│   │   └── HotkeySettings.tsx
│   └── cli/
│       ├── cli.ts
│       ├── cli.test.ts
│       ├── clipaths.ts
│       └── CliSettings.tsx
│
├── shared/                       used by 2+ modules; never imports modules/ or app/
│   ├── styles/
│   │   └── tokens.css            :root, themes (the one global import)
│   ├── state/
│   │   ├── state.ts
│   │   ├── movetab.test.ts
│   │   ├── resume.test.ts
│   │   └── pageprofiles.test.ts
│   ├── ui/
│   │   ├── ui.ts                 flash, toast, ask, clock
│   │   ├── ui.css
│   │   ├── Modal.tsx
│   │   ├── modal.css
│   │   ├── ctxmenu.tsx
│   │   ├── lucide.tsx
│   │   ├── icons.tsx
│   │   ├── fileicons.ts
│   │   ├── fileicons.css
│   │   ├── fileicons.test.ts
│   │   ├── favicons.ts
│   │   ├── favicons.test.ts
│   │   ├── clipboard.ts
│   │   ├── enterkey.ts
│   │   └── enterkey.test.ts
│   ├── keys/
│   │   ├── keymap.ts
│   │   ├── modkey.ts
│   │   ├── hints.ts
│   │   ├── hints.test.ts
│   │   ├── Keys.tsx              the Keycap
│   │   ├── keys.css
│   │   └── keys.test.ts
│   ├── text/
│   │   ├── diff.ts
│   │   ├── diff.test.ts
│   │   ├── DiffView.tsx
│   │   ├── diff.css
│   │   ├── markdown.ts
│   │   ├── markdown.test.ts
│   │   ├── markdown.css
│   │   ├── csv.ts
│   │   ├── csv.test.ts
│   │   └── branchname.ts
│   ├── codemirror/
│   │   ├── cm.ts
│   │   ├── langs.ts
│   │   ├── grammars.ts
│   │   ├── grammars.test.ts
│   │   ├── grammars.json         scripts/grammar-catalog.ts writes here
│   │   ├── textmate.ts
│   │   ├── tmparser.ts
│   │   ├── tmparser.test.ts
│   │   ├── LangPicker.tsx
│   │   └── LangSettings.tsx
│   ├── look.ts
│   ├── look.test.ts
│   ├── backdrop.ts
│   ├── backdrop.test.ts
│   ├── preview.ts
│   ├── scope.ts
│   ├── sigs.ts
│   ├── nav.ts                    the Settings page state
│   ├── urls.ts                   normalizeUrl
│   └── layout.test.ts            new: enforces the folder rules
│
└── modules/                      each imports only shared/ and other modules' index.ts
    ├── git/
    │   ├── index.ts              ◆
    │   ├── git.ts
    │   ├── repos.ts
    │   ├── GitPanel.tsx
    │   ├── git.css
    │   ├── gitmarks.test.ts
    │   └── marks.test.ts
    ├── issues/
    │   ├── index.ts              ◆
    │   ├── issues.ts
    │   ├── timeline.ts
    │   ├── IssuesPanel.tsx
    │   ├── issues.css            from canvas.css
    │   ├── issues.test.ts
    │   └── timeline.test.ts
    ├── news/
    │   ├── index.ts              ◆
    │   ├── news.ts
    │   ├── newsdata.ts
    │   ├── NewsPanel.tsx
    │   ├── NewsSettings.tsx      its Settings page lives here
    │   ├── news.css
    │   └── newsdata.test.ts
    ├── browser/
    │   ├── index.ts              ◆
    │   ├── browsers.ts
    │   ├── profiles.tsx
    │   ├── debugmenu.tsx
    │   ├── downloads.tsx
    │   ├── favs.tsx
    │   ├── tunnels.ts
    │   ├── tunnelmap.ts
    │   ├── tunnelui.tsx
    │   ├── shots.ts
    │   ├── browser.css           from canvas.css + styles.css
    │   └── …tests
    ├── editor/
    │   ├── index.ts              ◆
    │   ├── Editor.tsx
    │   ├── FileList.tsx
    │   ├── files.ts
    │   ├── MdPaper.tsx
    │   ├── mdexport.ts
    │   └── editor.css            what's left of files.css
    ├── db/
    │   └── …                     db.ts, dbsql.ts, DbPanel.tsx, SheetView.tsx, db.css, sheet.css
    ├── terminal/                 terms.ts, agentwin.ts, demo.ts
    ├── agents/                   agents.ts, agentkeys, agenttarget, agentsetup, AgentsPanel, AgentSettings, SetupBanner, *.css
    ├── signals/                  signals.ts, SignalSettings.tsx, SoundSelect.tsx, signals.css
    ├── environments/             EnvDialog, envform, envlock, OpenProject, newfolder, environments.css
    ├── worktrees/                worktrees.ts, agentworktree, setup, ignored, NewWorktree, WorktreeDialog, worktrees.css
    ├── linked-folders/           links.ts, LinkFolder.tsx, linked-folders.css
    ├── leftovers/                leftovers.ts, LeftoversPopover.tsx
    ├── sandbox/                  sandbox.ts, SandboxSettings.tsx, sandbox.css
    ├── phone/                    phone.ts, phoneask.ts, RemoteSettings.tsx
    ├── docker/                   docker.ts, dockerdata.ts, DockerPanel.tsx, docker.css
    ├── monitor/                  monitor.ts, monitordata.ts, MonitorPanel.tsx, monitor.css
    ├── calc/                     calc.ts, calcdata.ts, calclang.ts, CalcPanel.tsx, calc.css
    ├── media/                    media.ts, MediaDock.tsx, media.css
    ├── appearance/               Appearance.tsx, appearance.css
    ├── welcome/                  Welcome.tsx, welcomedata.ts, welcome.css
    ├── tour/                     Tour.tsx, tour.css
    └── usage/                    Usage.tsx, pace.ts, usage.css
```

The backend, keeping single-file modules as files:

```
src-tauri/src/
├── main.rs
├── lib.rs                        mod lines, tray, invoke_handler
├── shared/
│   ├── mod.rs
│   ├── spawn.rs
│   ├── remote.rs
│   ├── envssh.rs
│   ├── store.rs
│   ├── devfs.rs
│   ├── fs.rs
│   └── tunnel.rs                 from db/
├── browser/
│   ├── mod.rs                    was browser.rs
│   ├── debug.rs
│   ├── keys.rs
│   ├── shot.rs
│   ├── gtk.rs
│   ├── downloads.rs
│   ├── passwords.rs
│   ├── passwords.js
│   ├── pick.js
│   ├── forward.rs
│   └── mdpdf.rs
├── git/
│   ├── mod.rs                    was git.rs
│   ├── worktree.rs               split out of git.rs
│   ├── github.rs
│   ├── folders.rs
│   └── ignored.rs
├── db/                           as today, minus tunnel.rs
├── terminal/                     pty.rs, ptyd.rs
├── agents/                       agent_setup.rs, agent_windows.rs, resume.rs
├── environments/                 envs.rs, dirs.rs, newfolder.rs
├── issues/                       plane.rs
├── phone/                        mod.rs, push.rs
├── appearance/                   bg.rs, fonts.rs, syssounds.rs
├── docker.rs
├── sbx.rs
├── monitor.rs
├── news.rs
├── media.rs
├── leftovers.rs
├── grammars.rs
├── usage.rs
├── tour.rs
├── cli.rs
└── altspace.rs
```

An `index.ts` re-exports only what other modules use. For example, `modules/issues/index.ts`:

```ts
export { IssuesPanel } from "./IssuesPanel";
export { dev, inProgress, slugOf, devOf, sourcesOf, stateOf, isActive, forgetProject } from "./issues";
```

`git.ts` then imports `from "../issues"`, never `"../issues/issues"`. An `index.ts` whose export list keeps growing marks a shallow module worth a second look.

## Back-edges to cut first

These imports break rules 3 and 4 today. Each needs a small change before (or as) its files move.

| Edge | Fix |
|---|---|
| `state.ts` → `news/newsdata` (`NewsFeed` type) | Done: `NewsFeed` is defined in `state.ts`; `newsdata.ts` re-exports it. |
| `worktrees.ts`, `Tour.tsx` → `Sidebar` (`dropProject`) | Done: moved to `src/projects.ts`. Not `shared/state`: it calls into browsers, terms, Appearance, icons, issues and signals, so in state it would add six back-edges. Before step 4's cross-module rule, give `state` an "on project dropped" hook each module registers with (as `onAlert`), leaving `dropProject` in state. |
| `NewsPanel`, `NewWorktree`, `profiles`, `debugmenu`, `Sidebar`, `SandboxSettings`, `App`, `commands`, `hotkeys` → `Settings` | Done: `src/shared/nav.ts` holds the whole Settings page state (`SettingsPage`, `settingsPage`, `openSettings`, `closeSettings`, `toggleSettings`, `settingsOpen`, `hotkeysOpen`, `toggleHotkeys`); `Settings.tsx` exports only `SettingsDialog`. |
| `cli`, `LinkFolder`, `Welcome`, `Tour`, `Sidebar` → `OpenProject` (`openProjectDialog`, `openFolder`, `FolderPicker`) | Fine once `OpenProject` is `environments/`' interface. `FolderPicker` is used by Linked Folders too: export it from `environments/index.ts`. |
| `signals` ↔ `phone` (`pushSignal` / `sigOf`) | Done: `signals` exposes `onAlert(fn)` and `phone` registers with it at load; `phone` takes `sigOf` from `sigs.ts`. |
| `agents`, `AgentsPanel`, `phoneask` ↔ `browser` (`normalizeUrl` one way; `agentsetup`, `agenttarget` the other) | Done: `normalizeUrl` is in `src/shared/urls.ts`. The browser → agents direction stays (Select element sends to an agent). |
| `envlock` → `issues` (`clock`) | Done: `clock`, `setClock`, `startClock` are in `ui.ts`. |
| `terms` → `signals` → `phone` → `terms` (cycle) | Cut by the `onAlert` change above. |
| `tour` → `hotkeys` (`runHotkey`), `tabs` (`tabMenuOpen`, `toggleTabMenu`) | Open: a module importing `app/`. Cut before step 5 turns on the `app/` rule, e.g. by letting `app/` hand the Tour those as callbacks. |
| `tunnelmap` → `docker` (`NOT_HTTP`) | Done in step 3: `NOT_HTTP` is in `shared/urls.ts`. Through `docker/index.ts` it would have pulled `DockerPanel.tsx` into `tunnelmap.test.ts`, which bun can't load (see step 3). |

## CSS

There are 16 CSS files today. Twelve of them already belong to one module and just move with it. The other three (`styles.css`, `canvas.css`, `files.css`, about 2,500 lines between them) hold rules for many modules and get split.

**Rule:** the CSS for a module sits in the module's folder and is imported by the component that uses those classes. Shared CSS is imported by the shared component it styles, so `Modal.tsx` imports `modal.css` and the rules travel with the component. Only the tokens and base rules are imported once, from `app/index.tsx`.

### Files that move as they are

| File | Goes to |
|---|---|
| `agents.css`, `agentsetup.css` | `modules/agents/` |
| `calc.css` | `modules/calc/` |
| `db.css`, `sheet.css` | `modules/db/` |
| `docker.css` | `modules/docker/` |
| `git.css` | `modules/git/` |
| `media.css` | `modules/media/` |
| `monitor.css` | `modules/monitor/` |
| `news.css` | `modules/news/` |
| `sandbox.css` | `modules/sandbox/` |
| `welcome.css` | `modules/welcome/` |
| `diff.css` | `shared/text/` (with `DiffView.tsx`) |

### `styles.css` (1,406 lines), split by owner

| Lines (today) | What | Goes to |
|---|---|---|
| 1–80 | Tokens: `:root`, dark theme, `data-theme` | `shared/styles/tokens.css` |
| 80–121 | The Keycap, accent keys, keys in tiles | `shared/keys/keys.css` |
| 742–781, 690–698, 1390–1399 | Modal, toast, px fields | `shared/ui/modal.css`, `shared/ui/ui.css` |
| 122–376, 463–477, 555–641, 668–676, 699–740, 1400–1406 | Layout, sidebar, toolbar, Tab Strip, New Window Menu, stage, status line, Leftovers chip, Feedback, About, Restart | `app/app.css` (or split: `app/sidebar.css`, `app/toolbar.css`, `app/statusline.css`) |
| 377–462 | Browser Profiles, Debug Menu, downloads list | `modules/browser/browser.css` |
| 478–554, 1214–1233 | Project Appearance panel, Settings › Appearance | `modules/appearance/appearance.css` |
| 202–228, 642–667, 1138–1179 | Agent Signals, signal settings | `modules/signals/signals.css` |
| 677–689 | Pace line | `modules/usage/usage.css` |
| 741, 947–1073 | Open Project dialog, Environment dialog | `modules/environments/environments.css` |
| 782–821, 852–889 | New Worktree dialog | `modules/worktrees/worktrees.css` |
| 822–851 | Link Folder dialog | `modules/linked-folders/linked-folders.css` |
| 890–946 | Sandbox shield and toggle | `modules/sandbox/sandbox.css` |
| 1074–1117 | Tour | `modules/tour/tour.css` |
| 1118–1137, 1330–1389 | Settings shell, Settings › Hotkeys | `app/settings/settings.css` |
| 1180–1213, 1234–1329 | Settings › News, Languages, Browser, Remote | the page's own module |

The line ranges are rough because some sections sit inside others (the worktree rows at 229–289 are drawn by `Sidebar.tsx`, so they stay in `app/`). Split by section header, one owner per section.

### `canvas.css` (766 lines)

| Lines | What | Goes to |
|---|---|---|
| 1–89, 104–117, 334–364 | Window chrome, Transparency, Mono, Hold Hints on windows, title-bar mark, terminal body, split handle, empty workspace | `app/canvas.css` |
| 64–66 | Sandbox shield on a terminal | `modules/sandbox/sandbox.css` |
| 90–103, 118–333 | Browser window: page tabs, nav, load bar, profiles band, passwords, downloads, favourites, tunnels | `modules/browser/browser.css` |
| 365–766 | Issues window, Timeline, State Pill, In Progress chips, sidebar issue widget | `modules/issues/issues.css` |

### `files.css` (318 lines)

`About.tsx`, `Palette.tsx` and `Settings.tsx` import it only for a few classes, so it splits three ways:

| Lines | What | Goes to |
|---|---|---|
| 27–49 | File-type chip and File Icon Themes | `shared/ui/fileicons.css` (with `fileicons.ts`) |
| 50–113 | Markdown and HTML preview (About's changelog uses it) | `shared/text/markdown.css` |
| 114–157 | Command Palette | `app/palette.css` |
| rest | Tree, tabs, editor, media, grammar offer, language picker, Diff mode, Linked Folder roots | `modules/editor/editor.css` |

### What can break

- **Cascade order.** Vite bundles CSS in import order. Today `styles.css` loads first and everything else after it. Once its rules are spread across modules, a rule that only won because it came later can lose: the `.body > *` rule in `canvas.css` that `LinkFolder` and `NewWorktree` work around is one known case. For each split PR, build before and after and diff the bundled CSS sorted by selector, so only the order can change, then check the affected windows in both themes.
- **`keys.test.ts`** checks that no file except `styles.css` styles a `kbd`. After the split that should be `shared/keys/keys.css`. The test already reads `src/` recursively (step 2).
- **Class names stay global.** Moving files doesn't scope anything. That's fine for now, since most modules already prefix their classes (`.db-`, `.git-`, `.dock-`). The enforcement test could later check that a module's CSS only uses its own prefix, but that's out of scope here.
- `src-tauri/phone/app.css` (the phone page) is not part of the Vite build and stays where it is. Its header comment that names `src/styles.css` needs the new paths.

### Order

CSS moves in the same PR as its module (rule 1). The three big files are split in their own PRs: `files.css` with `editor/`, `canvas.css` with `issues/` and `browser/`, and `styles.css` last, alongside `app/`. That way tokens and base rules stay put until everything else has left.

## Backend layout (`src-tauri/src/`)

A Rust file is already a module, so a single-file module keeps its `name.rs`; a module with two or more files becomes `name/mod.rs` + parts. `lib.rs` keeps only `mod` lines, the tray and the `invoke_handler`.

| Folder | Files |
|---|---|
| `shared/` | `spawn.rs`, `remote.rs`, `envssh.rs`, `store.rs`, `devfs.rs` (Dev Directory client), `fs.rs`, `tunnel.rs` (from `db/tunnel.rs`: Docker and Remote Tunnels use it too) |
| `browser/` | `mod.rs` (was `browser.rs`), `debug.rs`, `keys.rs`, `shot.rs`, `gtk.rs`, `downloads.rs`, `passwords.rs`, `passwords.js`, `pick.js`, `forward.rs` (Remote Tunnels), `mdpdf.rs` |
| `terminal/` | `pty.rs`, `ptyd.rs` (stays `pub`: `main.rs` runs it) |
| `agents/` | `agent_setup.rs`, `agent_windows.rs` (the MCP endpoint), `resume.rs` |
| `git/` | `mod.rs` (was `git.rs`, 1386 lines; split worktree commands into `worktree.rs`), `github.rs`, `folders.rs` (Folder Copy), `ignored.rs` |
| `issues/` | `plane.rs` |
| `db/` | as today, minus `tunnel.rs` |
| `environments/` | `envs.rs`, `dirs.rs`, `newfolder.rs` |
| `phone/` | `mod.rs` (was `phone.rs`), `push.rs`; `src-tauri/phone/` assets stay where they are |
| `appearance/` | `bg.rs`, `fonts.rs`, `syssounds.rs` |
| single files | `docker.rs`, `sbx.rs`, `monitor.rs`, `news.rs`, `media.rs`, `leftovers.rs`, `grammars.rs`, `usage.rs`, `tour.rs`, `cli.rs`, `altspace.rs` |

`include_str!` / `include_bytes!` paths are relative to the file, so moving `browser.rs`, `passwords.rs`, `phone.rs` and `tour.rs` means adding a `../` to each (`pick.js` and `passwords.js` move with their file, so theirs stay).

## Things that hard-code paths today

- `index.html`: `/src/index.tsx` → `/src/app/index.tsx`.
- `scripts/grammar-catalog.ts`: writes `../src/shared/codemirror/grammars.json` (done in step 2).
- `keys.test.ts`: walks all of `src/` recursively, by paths relative to `src/` (done in step 2). Its "only `styles.css` styles a kbd" rule names `styles.css` at the `src/` root: change it to `shared/keys/keys.css` when `styles.css` is split.
- File-header comments naming `src/X.tsx` (most CSS files, several tests) and CONTEXT.md's file references: update in the same PR as each move.

## Enforcement

Add `src/shared/layout.test.ts` (bun test) that reads every `.ts`/`.tsx` under `src/`, parses its relative imports and fails when:

- a file in `shared/` imports from `modules/` or `app/` (on since step 2, as "imports only from `src/shared/`", which also catches a file still flat in `src/`);
- a file in `modules/` imports from `app/`;
- a file in `modules/a/` imports a path inside `modules/b/` other than the folder itself (`../b`) or its `index.ts` (on since step 3);
- a file outside `modules/` imports a path inside `modules/x/` other than the folder or its `index.ts`, CSS included (on since step 3, while `app/` and the inner modules are still flat in `src/`);
- a `src/` file sits outside `app/`, `shared/` and `modules/` (apart from those three folders).

The step 3 checks also assert that the ten leaf modules are there, each with an `index.ts`, and that files outside `modules/` import them, so they can't pass on an empty scan.

## Migration order

One PR per step; each ends with `bun run typecheck`, `bun test ./src/`, `cargo check` and a launch.

1. **Cut the back-edges** above, in place, with no moves. Small, reviewable, and it makes every later move mechanical. Done.
2. **`shared/`**: move the shared files and fix imports. Add the enforcement test with only the `shared/` rule on. Done: no shared file imported a root one, so nothing had to change but paths.
3. **Leaf modules** (nothing else imports them except `app/`): `calc`, `monitor`, `news`, `docker`, `media`, `usage`, `db`, `sandbox`, `welcome`, `tour`. Done; see [Step 3: leaf modules](#step-3-leaf-modules).
4. **Inner modules**: `issues`, `git`, `linked-folders`, `editor`, `environments`, `worktrees`, `leftovers`, `signals`, `phone`, `agents`, `terminal`, `browser`, `appearance`. Turn on the cross-module rule.
5. **`app/`** last, then turn on the last rule.
6. **Rust**: `shared/` first (most `crate::` paths change there), then each folder. `git.rs`'s split is its own PR.

Use `git mv` so history follows the files.

### Step 3: leaf modules

Each `index.ts` re-exports only what files outside the module imported on the day. A component that was a default export is re-exported by name (`export { default as DbPanel }`), so importers write `import { DbPanel } from "./modules/db"`.

| Module | `index.ts` exports | Imported from |
|---|---|---|
| `calc/` | `CalcPanel`, `openCalcPanel` | Canvas, commands, hotkeys, tabs |
| `monitor/` | `MonitorPanel`, `openMonitorPanel` | Canvas, commands, hotkeys, tabs |
| `news/` | `NewsPanel`, `openNewsPanel`, `NewsPage` | Canvas, commands, hotkeys, tabs, Settings |
| `docker/` | `DockerPanel`, `openDockerPanel`, `closeDockerWindow` | Canvas, commands, hotkeys, tabs |
| `media/` | `MediaDock`, `MediaPopover`, `closeMediaPop`, `currentMedia`, `mediaOn`, `mediaPlayPause`, `mediaPopOpen`, `mediaSkip` | App, Sidebar, commands, hotkeys |
| `usage/` | `ClaudeUsage`, `CommandCodeUsage` | App |
| `db/` | `DbPanel`, `BookView`, `CsvTable`, `closeSession`, `connsOf`, `dbTitle`, `isProd`, `openDbWindow`, `openSheetDb` | Canvas, commands, hotkeys, tabs, **Editor** |
| `sandbox/` | `SandboxPage` and 22 more: `adoptSandboxes`, `canSandbox`, `ensureSandbox`, `hostKey`, `isRunning`, `listBoxes`, `mountsFor`, `newSandboxName`, `onSandboxStep`, `readySandbox`, `refreshSbx`, `relativeGitdir`, `removeSandbox`, `runsInSandbox`, `sandboxByDefault`, `sandboxFolders`, `sandboxOf`, `sbxReady`, `sbxState`, `setSandboxHost`, `startSandbox`, `stopSandbox` | App, Canvas, Sidebar, Settings, **terms, worktrees, NewWorktree, docker/** |
| `welcome/` | `Welcome`, `openWelcome`, `closeWelcome`, `welcomeOpen`, `PlusMenuList`, `lookForAgents` | App, commands, hotkeys, Settings, **AgentSettings** |
| `tour/` | `Tour`, `startTour`, `tourOpen` | App, commands, **welcome/** |

What turned out different from the plan:

- **Not all leaves.** The bold importers aren't `app/`: Editor uses the Database Window's grid for CSV and workbooks, Settings › Commands shares the Welcome window's + menu list, Welcome starts the Tour, and Docker Sandboxes are used by terminals, Worktrees and the Docker Window. They all go through `index.ts`, so nothing had to change. `sandbox/`'s interface is the widest (23 names): the shallow-module sign the Example tree warns about, worth a second look.
- **Leaves still import root files** that become other modules in step 4: `news/` and `docker/` import `browsers`; `db/` imports `links`; `welcome/` imports `agentsetup`, `agents`, `signals`, `SoundSelect`, `EnvDialog`, `OpenProject` and `links`; `tour/` imports `OpenProject`, `projects`, `terms`, and the `app/` files `hotkeys` and `tabs` (see Back-edges). Step 4 turns these into folder imports as each one moves.
- **bun can't load a `.tsx`** (Solid's JSX has no runtime under `bun test`). An `index.ts` that re-exports a component therefore can't be imported by anything a test loads. Two tests broke on it: `tunnelmap.test.ts` (fixed by moving `NOT_HTTP` to `shared/urls.ts`) and `links.test.ts`'s `connOf` case (moved to `modules/db/db.test.ts`, which imports `./db` from inside the module). Rule for later steps: a test of a module's logic lives in the module and imports its files directly; a tested pure file elsewhere takes what it needs from `shared/`, not from a module whose interface carries a component.
- **CSS order moved twice.** An `index.ts` loads all of a module's files, so `SandboxSettings.tsx` (and `sandbox.css`) now loads with `App.tsx`'s import of `sandbox/` rather than with Settings, and `SheetView.tsx` with `sheet.css` left the lazy Editor chunk for the main one (Canvas imports `DbPanel` through `db/`). Diffing the built CSS before and after: those two blocks moved and nothing else changed; neither shares a selector of equal specificity with a rule it now precedes.
- **README.md's `src/` file list** names files by their old flat paths; step 2 left it too. Update it when the layout settles.

## Open questions

- **`state.ts` (1347 lines, 177 exports)** stays one file in `shared/state/` for now. Later it could give each module its own slice (the Calculator's `calc`, the News `feeds`), owned by that module, with `state.ts` keeping persistence and migration only. That is a separate deepening, not part of this move.
- **Module name `agents/` vs `commands/`**: CONTEXT.md calls them Commands, the code calls them agents, and `commands.ts` is the Command Palette. `agents/` keeps the code's name and avoids the clash.
- **Rust single-file modules**: this keeps them as files. If every module should be a folder on both sides, they each become `name/mod.rs`; it changes nothing else.
