# Codebase blueprint: one folder per module, `shared/` for cross-module use

Status: in progress. Steps 1 (back-edges), 2 (`src/shared/`), 3 (leaf modules), 4 (inner modules) and 5 (`src/app/`) of the [Migration order](#migration-order) are done: `src/` holds only `app/`, `shared/` and `modules/`. Left: splitting `styles.css`, `canvas.css` and `files.css` (see [CSS](#css)), and the Rust side (step 6).

Before step 1 `src/` was flat: 193 files, with every window, dialog, store and helper side by side. `src-tauri/src/` is flat too, apart from `db/`. This blueprint gives each module a folder and an **interface** (its `index.ts` / `mod.rs`), and puts what several modules use in `shared/`.

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
| `shared/state/` | `state.ts`, `movetab.test.ts`, `resume.test.ts`, `pageprofiles.test.ts` | The app store; every module reads it. Since step 4 it also holds `dropProject` and the `onProjectDropped` hook (see Back-edges). |
| `shared/ui/` | `ui.ts` (flash, toast, ask, clock), `Modal.tsx`, `ctxmenu.tsx`, `lucide.tsx`, `icons.tsx`, `fileicons.ts`, `favicons.ts`, `clipboard.ts`, `enterkey.ts`, and the tests of the last three | The UI kit: dialogs, menus, icons, copy. |
| `shared/keys/` | `keymap.ts`, `modkey.ts`, `hints.ts`, `Keys.tsx`, `keys.test.ts`, `hints.test.ts` | The Keymap, Hotkey Modifier, Hold Hints and Keycap: drawn by every module. |
| `shared/text/` | `diff.ts`, `DiffView.tsx`, `diff.css`, `markdown.ts`, `csv.ts`, `branchname.ts`, and the tests of `diff`, `markdown`, `csv` | Pure parsers used by 2+ modules (diff: Editor, Git, state; csv: Editor, Database). |
| `shared/codemirror/` | `cm.ts`, `langs.ts`, `grammars.ts`, `grammars.json`, `textmate.ts`, `tmparser.ts`, `LangPicker.tsx`, `LangSettings.tsx`, `grammars.test.ts`, `tmparser.test.ts` | The CodeMirror kit and Grammar Catalog: Editor, Database and Calculator all build editors on it. |
| `shared/` (top) | `look.ts`, `backdrop.ts` (each with its test), `preview.ts`, `scope.ts`, `sigs.ts`, `nav.ts`, `urls.ts`, `links.ts`, `links.test.ts`, `restart.test.ts`, `layout.test.ts` | Look, Backdrop, preview flags, Command Scope, the signal rules, and app-level navigation (see Back-edges). `restart.test.ts` (step 5) tests `busySignals` in `sigs.ts`, so it sits here rather than with `RestartDialog.tsx`. `urls.ts` also holds `NOT_HTTP` (step 3): the Docker Window and Remote Tunnels (`tunnelmap.ts`) both use it. `nav.ts` also holds the New window menu's state and `runHotkey` (step 4). `links.ts` (step 4): which Linked Folder root a path is under, asked by the Editor, the Database Window, Remote Control and Welcome. |

Done in step 2. `preview.test.ts` tests the preview flag through `sandbox.ts` (`sandboxOf`, `runsInSandbox`), so it moved to `modules/sandbox/` in step 3. `projects.ts` is gone (step 4): `dropProject` is in `shared/state/`.

### `src/modules/`

| Module | Files |
|---|---|
| `terminal/` | `terms.ts`, `agentwin.ts`, `demo.ts` |
| `agents/` (Commands; `Agent` in code) | `agents.ts`, `agentkeys.ts`, `agenttarget.ts`, `agentsetup.ts`, `AgentsPanel.tsx`, `AgentSettings.tsx`, `SetupBanner.tsx`, `agents.css`, `agentsetup.css` |
| `signals/` | `signals.ts`, `SignalSettings.tsx`, `SoundSelect.tsx` |
| `browser/` | `browsers.ts`, `profiles.tsx`, `debugmenu.tsx`, `downloads.tsx`, `favs.tsx`, `tunnels.ts`, `tunnelmap.ts`, `tunnelui.tsx`, `shots.ts` |
| `editor/` | `Editor.tsx`, `FileList.tsx`, `files.ts`, `MdPaper.tsx`, `mdexport.ts`, then its part of `files.css` once that is split |
| `linked-folders/` | `LinkFolder.tsx` (`links.ts` went to `shared/` in step 4) |
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

Each module's tests sit with it. Step 3 also moved `preview.test.ts` to `sandbox/`, and split `links.test.ts`'s `connOf` case into a new `db/db.test.ts` (see [step 3](#step-3-leaf-modules)). Done in steps 3 and 4.

### `src/app/`

`index.tsx`, `App.tsx`, `Canvas.tsx`, `tabs.tsx`, `layout.ts`, `layout.test.ts`, `Sidebar.tsx`, `commands.ts`, `hotkeys.ts`, `Palette.tsx`, `About.tsx`, `Feedback.tsx`, `RestartDialog.tsx`, `updater.ts`, `styles.css`, `canvas.css`, `files.css` (the last three until the CSS split), `__selftest.ts`, `vite-env.d.ts`, plus:

- `app/settings/`: `Settings.tsx`, `Backup.tsx`, `config.ts`, `config.test.ts`, `HotkeySettings.tsx`
- `app/cli/`: `cli.ts`, `cli.test.ts`, `clipaths.ts`, `CliSettings.tsx` (the tri Command)

Done in step 5; see [Step 5: app](#step-5-app).

## Example tree

The frontend after the move and the CSS split. Each module also gets a new `index.ts`, its interface (marked ◆). Until the split, `app/` still holds `styles.css` and `files.css` whole, and `canvas.css` with the browser's and issues' rules, in place of `app.css`, `palette.css` and `settings.css`.

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
│   ├── updater.ts
│   ├── __selftest.ts
│   ├── vite-env.d.ts             Vite types, __APP_VERSION__
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
│   ├── restart.test.ts           busySignals, for the restart-to-update prompt
│   ├── nav.ts                    the Settings page, New window menu, runHotkey
│   ├── urls.ts                   normalizeUrl
│   ├── links.ts                  Linked Folder roots (with links.test.ts)
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
    ├── linked-folders/           LinkFolder.tsx, linked-folders.css
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
export { default as IssuesPanel } from "./IssuesPanel";
export { dev, devOf, inProgress, isActive, openIssuePanel, slugOf, sourcesOf, stateOf, /* …and the time tracking */ } from "./issues";
```

`git.ts` then imports `from "../issues"`, never `"../issues/issues"`. An `index.ts` whose export list keeps growing marks a shallow module worth a second look.

## Back-edges to cut first

These imports break rules 3 and 4 today. Each needs a small change before (or as) its files move.

| Edge | Fix |
|---|---|
| `state.ts` → `news/newsdata` (`NewsFeed` type) | Done: `NewsFeed` is defined in `state.ts`; `newsdata.ts` re-exports it. |
| `worktrees.ts`, `Tour.tsx` → `Sidebar` (`dropProject`) | Done: first moved to `src/projects.ts`; in step 4 `dropProject` went to `shared/state` with an `onProjectDropped(fn)` hook. The browser (closes its pages), terminal (sessions), Appearance (`bg_delete` and the image), `shared/ui/icons` (`forgetIcon`), issues and signals each register their cleanup at load, and `projects.ts` is gone. |
| `NewsPanel`, `NewWorktree`, `profiles`, `debugmenu`, `Sidebar`, `SandboxSettings`, `App`, `commands`, `hotkeys` → `Settings` | Done: `src/shared/nav.ts` holds the whole Settings page state (`SettingsPage`, `settingsPage`, `openSettings`, `closeSettings`, `toggleSettings`, `settingsOpen`, `hotkeysOpen`, `toggleHotkeys`); `Settings.tsx` exports only `SettingsDialog`. |
| `cli`, `LinkFolder`, `Welcome`, `Tour`, `Sidebar` → `OpenProject` (`openProjectDialog`, `openFolder`, `FolderPicker`) | Fine once `OpenProject` is `environments/`' interface. `FolderPicker` is used by Linked Folders too: export it from `environments/index.ts`. |
| `signals` ↔ `phone` (`pushSignal` / `sigOf`) | Done: `signals` exposes `onAlert(fn)` and `phone` registers with it at load; `phone` takes `sigOf` from `sigs.ts`. |
| `agents`, `AgentsPanel`, `phoneask` ↔ `browser` (`normalizeUrl` one way; `agentsetup`, `agenttarget` the other) | Done: `normalizeUrl` is in `src/shared/urls.ts`. The browser → agents direction stays (Select element sends to an agent). |
| `envlock` → `issues` (`clock`) | Done: `clock`, `setClock`, `startClock` are in `ui.ts`. |
| `terms` → `signals` → `phone` → `terms` (cycle) | Cut by the `onAlert` change above. |
| `tour` → `hotkeys` (`runHotkey`), `tabs` (`tabMenuOpen`, `toggleTabMenu`) | Done in step 4: the New window menu's signal (`tabMenu`, `tabMenuOpen`, `closeTabMenu`, `toggleTabMenu`) is in `shared/nav.ts`; `runHotkey` there calls the runner `hotkeys.ts` registers at load (`setHotkeyRunner`). |
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
- **`keys.test.ts`** checks that no file except `app/styles.css` styles a `kbd`. After the split that should be `shared/keys/keys.css`. The test already reads `src/` recursively (step 2).
- **Class names stay global.** Moving files doesn't scope anything. That's fine for now, since most modules already prefix their classes (`.db-`, `.git-`, `.dock-`). The enforcement test could later check that a module's CSS only uses its own prefix, but that's out of scope here.
- `src-tauri/phone/app.css` (the phone page) is not part of the Vite build and stays where it is. Its header comment names `src/app/styles.css` since step 5; it needs the new paths again after the split.

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

- `index.html`: `/src/index.tsx` → `/src/app/index.tsx` (done in step 5).
- `scripts/grammar-catalog.ts`: writes `../src/shared/codemirror/grammars.json` (done in step 2).
- `keys.test.ts`: walks all of `src/` recursively, by paths relative to `src/` (done in step 2). Its "only `styles.css` styles a kbd" rule names `app/styles.css` since step 5: change it to `shared/keys/keys.css` when `styles.css` is split.
- File-header comments naming `src/X.tsx` (most CSS files, several tests) and CONTEXT.md's file references: update in the same PR as each move.

## Enforcement

Add `src/shared/layout.test.ts` (bun test) that reads every `.ts`/`.tsx` under `src/`, parses its relative imports and fails when:

- a file in `shared/` imports from `modules/` or `app/` (on since step 2, as "imports only from `src/shared/`", which also catches a file still flat in `src/`);
- a file in `modules/` imports from `app/` (on since step 4, as "imports nothing under `src/` outside `shared/` and `modules/`", so the `app/` files still at the root count; an explicit allowlist in the test holds the edges not cut yet). Since step 5 a separate check says it outright: nothing in `shared/` or `modules/` resolves into `src/app/`, with the same allowlist;
- a file in `modules/a/` imports a path inside `modules/b/` other than the folder itself (`../b`) or its `index.ts` (on since step 3);
- a file outside `modules/` imports a path inside `modules/x/` other than the folder or its `index.ts`, CSS included (on since step 3, while `app/` and the inner modules are still flat in `src/`);
- a `src/` file sits outside `app/`, `shared/` and `modules/` (on since step 5: `src/` holds no other folder, and no `.ts`, `.tsx` or `.css` file beside them, unless the test's `ROOT_ALLOWED` list names it; the list is empty).

The step 3 checks also assert that the modules are there (all 23 since step 4), each with an `index.ts`, and that files outside `modules/` import them, so they can't pass on an empty scan. The step 5 checks likewise assert that `app/index.tsx` exists, that `app/` has more than 20 files importing both `shared/` and the modules, that the scan of `shared/` and `modules/` sees more than 150 files, and that `src/` holds the three folders.

## Migration order

One PR per step; each ends with `bun run typecheck`, `bun test ./src/`, `cargo check` and a launch.

1. **Cut the back-edges** above, in place, with no moves. Small, reviewable, and it makes every later move mechanical. Done.
2. **`shared/`**: move the shared files and fix imports. Add the enforcement test with only the `shared/` rule on. Done: no shared file imported a root one, so nothing had to change but paths.
3. **Leaf modules** (nothing else imports them except `app/`): `calc`, `monitor`, `news`, `docker`, `media`, `usage`, `db`, `sandbox`, `welcome`, `tour`. Done; see [Step 3: leaf modules](#step-3-leaf-modules).
4. **Inner modules**: `issues`, `git`, `linked-folders`, `editor`, `environments`, `worktrees`, `leftovers`, `signals`, `phone`, `agents`, `terminal`, `browser`, `appearance`. Turn on the cross-module rule. Done; see [Step 4: inner modules](#step-4-inner-modules).
5. **`app/`** last, then turn on the last rule. Done; see [Step 5: app](#step-5-app).
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
- **Leaves still import root files** that become other modules in step 4: `news/` and `docker/` import `browsers`; `db/` imports `links`; `welcome/` imports `agentsetup`, `agents`, `signals`, `SoundSelect`, `EnvDialog`, `OpenProject` and `links`; `tour/` imports `OpenProject`, `projects`, `terms`, and the `app/` files `hotkeys` and `tabs` (see Back-edges). Step 4 turns these into folder imports as each one moves (done; `projects`, `hotkeys` and `tabs` were cut instead).
- **bun can't load a `.tsx`** (Solid's JSX has no runtime under `bun test`). An `index.ts` that re-exports a component therefore can't be imported by anything a test loads. Two tests broke on it: `tunnelmap.test.ts` (fixed by moving `NOT_HTTP` to `shared/urls.ts`) and `links.test.ts`'s `connOf` case (moved to `modules/db/db.test.ts`, which imports `./db` from inside the module). Rule for later steps: a test of a module's logic lives in the module and imports its files directly; a tested pure file elsewhere takes what it needs from `shared/`, not from a module whose interface carries a component.
- **CSS order moved twice.** An `index.ts` loads all of a module's files, so `SandboxSettings.tsx` (and `sandbox.css`) now loads with `App.tsx`'s import of `sandbox/` rather than with Settings, and `SheetView.tsx` with `sheet.css` left the lazy Editor chunk for the main one (Canvas imports `DbPanel` through `db/`). Diffing the built CSS before and after: those two blocks moved and nothing else changed; neither shares a selector of equal specificity with a rule it now precedes.
- **README.md's `src/` file list** names files by their old flat paths; step 2 left it too. Update it when the layout settles. (Done in step 4.)

### Step 4: inner modules

Done one module per commit, each passing `bun run typecheck` and `bun test ./src/`; the back-edge cuts, the enforcement test and the CSS fix are their own commits. Every outside import goes through the folder, default-exported components are re-exported by name, and `index.ts` lists only what files outside the module imported on the day.

| Module | `index.ts` exports | Imported from |
|---|---|---|
| `issues/` (16) | `IssuesPanel`, `dev`, `devOf`, `formatHm`, `formatHms`, `inProgress`, `isActive`, `issueKey`, `loadDev`, `openIssuePanel`, `panelTitle`, `runningEntry`, `slugOf`, `sourcesOf`, `stateOf`, `todayTotal` | App, Canvas, Sidebar, commands, hotkeys, tabs, **git, worktrees** |
| `git/` (21) | `GitPanel`, types `Change`, `FileMark`, `GitStatus`, `RepoStatus`, `RepoRef`; `branchStatus`, `fileMarks`, `folderStatus`, `gitOf`, `ignoredAt`, `isStaged`, `isUnstaged`, `markAt`, `openGitPanel`, `peekStatus`, `repoRoot`, `unpushed`, `headText`, `repoEpoch`, `repoOfFile` | App, Canvas, Sidebar, commands, hotkeys, tabs, **editor, worktrees, phone** |
| `linked-folders/` (4) | `LinkFolderDialog`, `closeLinkDialog`, `linkDialogOpen`, `openLinkDialog` | App, commands, hotkeys, **editor** |
| `editor/` (14) | `Editor` (lazy), `FileIcon`, `iconOpts`, types `FsList`, `FsText`; `dirtyCount`, `dropEditor`, `filesOf`, `openEditor`, `openFile`, `CSS_HINT`, `DEFAULT_MARGIN`, `PAGES`, `printDocument` | Canvas, Palette, Settings, commands, hotkeys, tabs, cli, `__selftest`, **git, phone, appearance** |
| `environments/` (14) | `EnvDialog`, `closeEnvDialog`, `envDialogOpen`, `openEnvDialog`, `FolderPicker`, `OpenProjectDialog`, `closeOpenProject`, `openFolder`, `openProjectDialog`, `openProjectOpen`, `PinPad`, `envLocked`, `lockEnv`, `syncEnvs` | App, Sidebar, Settings, commands, hotkeys, cli, **linked-folders, leftovers, phone, tour, welcome** |
| `worktrees/` (13) | `NewWorktreeDialog`, `WorktreeDialog`, `openWorktreeDialog`, `startAgentWorktrees`, `adoptWorktrees`, `closeNewWorktree`, `labelOf`, `loadWorktrees`, `newWorktreeOpen`, `openNewWorktree`, `removeWorktree`, `renameWorktree`, `tileLabel` | App, Sidebar, commands, hotkeys, **git, leftovers, phone** |
| `leftovers/` (14) | `LeftoverCount`, `LeftoversChip`, `LeftoversPopover`, `closeLeftovers`, `endHolders`, `endLeftover`, `holderLine`, `holdersOf`, `leftoversOpen`, `rescanSoon`, `samePath`, `scanLeftovers`, `staleCheckouts`, `watchLeftovers` | App, Sidebar, hotkeys, **terminal, worktrees** |
| `signals/` (21) | `SignalsForm`, `SignalsPopover`, `closeSignals`, `signalsOpen`, `toggleSignals`, `SoundSelect`, `EVENTS`, `SIG_TEXT`, `applySignalColors`, `nextSignal`, `onAlert`, `onSignal`, `playFor`, `playSound`, `reloadSound`, `sigOf`, `sigSummary`, `soundFor`, `soundName`, `toggleDnd`, `topSig` | App, Canvas, Sidebar, Settings, Backup, commands, hotkeys, tabs, **agents, appearance, phone, terminal, welcome** |
| `phone/` (3) | `RemotePage`, `phoneStatus`, `startPhoneSync` | App, Settings |
| `agents/` (26) | `AgentsPage`, `AgentsPanel`, `SetupBanner`, `seedAgentKeys`, `agentForKey`, `hotkeyKeys`, `hotkeyProblem`, `launchAgent`, `looksLikeUrl`, `newShell`, `offeredIn`, `offeredTogether`, `openAgentsPanel`, `recording`, `scopeLabel`, `setRecording`, `installAgent`, `refreshSetup`, `setupBusy`, `setupError`, `setupStatus`, `startAgentSetup`, `agentTarget`, `agentWindows`, `rememberAgent`, `trackAgentFocus` | App, Canvas, Palette, Settings, HotkeySettings, commands, hotkeys, tabs, **browser, issues, welcome, worktrees** |
| `terminal/` (17) | `startAgentWindows`, `applyTerminalClear`, `applyTerminalLook`, `askDemo`, `closeSession`, `ensureSession`, `focusSession`, `followAfterTurn`, `hasSelection`, `mountSession`, `moveSessions`, `pasteText`, `rehomeSession`, `screenTail`, `sendText`, `setLinkHandler`, `unmountSession` | App, Canvas, Palette, hotkeys, **browser, environments, issues, phone, tour, worktrees** |
| `browser/` (64) | `browsers.ts` 29 (pages and webviews: `placeBrowser`, `navigateBrowser`, `closeBrowser`, `openUrlInProject`, `openExternal`, `setBrowsersCovered`/`Overlaid`/`Suspended`, …), `profiles` 8, `favs` 7, `tunnelui` 7, `downloads` 6, `debugmenu` 4, `tunnels` 2 (`fwdOfPage`, `heldBy`), `tunnelmap` 1 (`fileUrlOf`) | App, Canvas, Sidebar, Settings, Feedback, hotkeys, tabs, **agents, docker, editor, git, issues, news** |
| `appearance/` (7) | `AppearancePopover`, `Backdrop`, `appearanceOpen`, `closeAppearance`, `openAppearance`, `setBgImage`, `toggleAppearance` | App, Sidebar, Backup, commands, hotkeys |

Module → module edges, all through `index.ts`, none new (each was a file-level import before the move; step 4 removed `db`, `phone` and `welcome` → `linked-folders` by moving `links.ts` to `shared/`):

- `agents` → `browser`, `signals`, `welcome`
- `appearance` → `editor`, `signals`
- `browser` → `agents`, `terminal`
- `docker` → `browser`, `sandbox`
- `editor` → `browser`, `db`, `git`, `linked-folders`
- `environments` → `terminal`
- `git` → `browser`, `editor`, `issues`, `worktrees`
- `issues` → `agents`, `browser`, `terminal`
- `leftovers` → `environments`, `worktrees`
- `linked-folders` → `environments`
- `news` → `browser`
- `phone` → `editor`, `environments`, `git`, `signals`, `terminal`, `worktrees`
- `terminal` → `leftovers`, `sandbox`, `signals`
- `tour` → `environments`, `terminal`
- `welcome` → `agents`, `environments`, `signals`, `tour`
- `worktrees` → `agents`, `git`, `issues`, `leftovers`, `sandbox`, `terminal`

Cycles among them (all older than the move): `agents` ↔ `browser`, `agents` ↔ `welcome`, `editor` ↔ `git`, `git` ↔ `worktrees`, `leftovers` ↔ `worktrees`, and `terminal` → `leftovers` → `worktrees` → `terminal`. They work because every crossing is a function called later, not a value read at load, but each is a seam worth a second look.

What turned out different from the plan:

- **`links.ts` went to `shared/`, not `linked-folders/`.** `db.ts`'s test needs `linkAt`, and through `linked-folders/index.ts` it would load `LinkFolder.tsx`, which bun can't (step 3's rule). Four modules (Editor, Database, Remote Control, Welcome) ask which root a path is under, so it is shared by rule 3 anyway. `linked-folders/` is just the dialog.
- **`git.ts`'s tests stub the issue store.** `git.ts` takes `devOf`, `inProgress` and `slugOf` from `issues/` for its ✦ drafts, and that index carries `IssuesPanel.tsx`. `marks.test.ts` and `gitmarks.test.ts` `mock.module("../issues", …)` before a dynamic `import("./git")`; they don't draft. Splitting the drafts out of `git.ts` would let them import it plainly.
- **The Editor stays lazy.** `editor/index.ts` exports `Editor = lazy(() => import("./Editor"))`, so Canvas imports it from the folder and CodeMirror still loads with the first editor window (the `Editor-*.js` chunk is the same size before and after).
- **Back-edges into the app files, cut:** the Tour's `runHotkey` and New window menu (to `shared/nav.ts`) and `dropProject` (to `shared/state`, with `onProjectDropped`). The hook runs each module's cleanup in registration order, then `removeProject`, so the project is still in the store while they run. One difference from the old loop: a project's browser windows are all closed before its terminals (or the other way round, by load order) rather than interleaved by tab; each close is independent. App imports every registering module at startup (browser, terminal, appearance, issues, signals through their folders, `shared/ui/icons` directly), before any project can be dropped.
- **Allowlisted:** `editor/Editor.tsx` and `editor/FileList.tsx` → `../../files.css`. `files.css` also styles the palette, About and Settings, so it stays at the root until the CSS split. No other module imports an app file.
- **CSS order.** An `index.ts` loads all of its module's files, so App's first imports (Feedback → `browser/` → `agents/` → `AgentSettings` → `welcome/` → …) now pull in most modules' CSS before `Canvas.tsx` loads `canvas.css`. Diffing the built CSS against the build before step 4 (same 2,967 blocks, same multiset): `welcome.css` and `files.css` moved from the end to before `diff.css`/`git.css`, and `agentsetup.css` up to just after `agents.css`. Two of those flips changed the cascade: `.fnote` (`files.css` 12px vs `canvas.css` 11px) and `.lucide.spin` (`git.css` vs `canvas.css`), so `index.tsx` now imports `canvas.css` right after `styles.css`, restoring both. With that, the remaining moved blocks (`welcome.css`, `files.css`, `agentsetup.css` earlier; `sandbox.css` after `canvas.css`) share no selector of equal specificity on the same element with a rule they now precede or follow; the only shared classes are state classes (`.on`, `.sel`, `.primary`) under different window prefixes.
- **Old paths left on purpose:** `docs/diff-view-progress.md` is a dated progress log and keeps its flat paths, as it did through step 2.

### Step 5: app

Three move commits (the app shell with the three stylesheets and the entry point, then `app/settings/`, then `app/cli/`), each passing `bun run typecheck` and `bun test ./src/`, then the enforcement commit. Nothing but import paths changed in the moved files: no module imported an app file except the two allowlisted `files.css` edges, so no back-edge had to be cut.

- **`restart.test.ts` went to `shared/`, not `app/`.** It imports only `shared/state` and `shared/sigs` and tests `busySignals` (rule 6: tests sit beside the code they test). `RestartDialog.tsx` itself is untested.
- **`vite-env.d.ts` moved to `app/`.** It is an ambient declaration file (`/// <reference types="vite/client" />` and `__APP_VERSION__`), and tsconfig's `"include": ["src"]` picks it up anywhere under `src/`, so `tsc` sees it in `app/` as it did at the root. That left nothing for the root allowlist.
- **The stylesheets moved whole** into `app/` (`styles.css`, `canvas.css`, `files.css`): they are app-owned until the split. `index.tsx` still imports `styles.css` then `canvas.css` first. The allowlisted edges are now `modules/editor/Editor.tsx` and `FileList.tsx` → `../../app/files.css`, and `keys.test.ts`'s kbd rule names `app/styles.css`.
- **Paths outside `src/`:** `index.html` loads `/src/app/index.tsx`; the header of `src-tauri/phone/app.css` names `src/app/styles.css`. `vite.config.ts`, `tauri.conf.json` (`frontendDist`, `devUrl`), `package.json` scripts (`bun test ./src/`), `scripts/`, `mcp/` and `.vscode/` name no file in `src/`. `src-tauri/src/tour.rs`'s `src/App.tsx` and `src/Settings.tsx`, the Terminal's demo lines and `favicons.test.ts`'s URL are sample text about another project, not paths into this one.
- **CSS order unchanged.** The built CSS is byte-identical to the build of step 4's last commit (same file hash, 2,967 blocks in the same order): every stylesheet is still imported by the same files in the same order, only from new paths.

## Open questions

- **`state.ts` (1347 lines, 177 exports)** stays one file in `shared/state/` for now. Later it could give each module its own slice (the Calculator's `calc`, the News `feeds`), owned by that module, with `state.ts` keeping persistence and migration only. That is a separate deepening, not part of this move.
- **Module name `agents/` vs `commands/`**: CONTEXT.md calls them Commands, the code calls them agents, and `commands.ts` is the Command Palette. `agents/` keeps the code's name and avoids the clash.
- **Rust single-file modules**: this keeps them as files. If every module should be a folder on both sides, they each become `name/mod.rs`; it changes nothing else.
