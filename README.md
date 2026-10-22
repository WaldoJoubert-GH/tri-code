<img src="assets/icon.svg" width="64" height="64" alt="">

# tri-code

tri-code is a minimal agent development environment. The left sidebar lists projects grouped by host (`local` or an ssh destination). Each project has terminal tabs that run an agent: `claude` (Claude Code), `pi`, a plain shell, or any terminal app you add. Local tabs run in a local PTY. Remote tabs run the system `ssh` client and attach to a persistent session on the remote host, so agents survive network drops and app restarts. The app is built with Tauri v2 (Rust), SolidJS, and xterm.js. Projects and tabs are saved to `state.json` in the Tauri app config directory.

![A claude tab, the git window and a shell tiled in one project](docs/screenshots/hero.png)

## Screenshots

**Agents side by side.** claude, pi, the issues panel and a shell tiled in the grid layout. The sidebar groups projects by environment, local or ssh.

![Grid layout with claude, pi, issues and a shell](docs/screenshots/grid.png)

**Git window.** Stage files, read the diff, browse recent commits, and draft the commit message with ✦ from the diff, the In Progress issue and the commit style.

![Git window with staged and unstaged changes and a diff](docs/screenshots/git.png)

**Editor.** The project's file tree, a tab per file and a CodeMirror editor: syntax colours for the common languages, search, multi-cursor, folding. Markdown, HTML and SVG also show rendered. One click opens a preview tab that the next click replaces; double-click or edit to keep it, `Ctrl`+click for a second editor beside. Saving won't overwrite a file an agent changed since you opened it without asking.

![Files window with the README previewed](docs/screenshots/files.png)

**Open project.** Pick an environment, then type to filter folders. Git repositories are marked.

![The Open project dialog](docs/screenshots/open.png)

## Windows development setup

1. Install Microsoft C++ Build Tools with the "Desktop development with C++" workload.
2. Install Rust via rustup, using the default MSVC toolchain (https://rustup.rs).
3. Install bun:

   ```
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

4. WebView2 is preinstalled on Windows 10/11, so nothing is needed there.

Then, from the repo root:

```
bun install
bun run tauri dev      # run the app
bun run tauri build    # build an installer
```

`.cargo/config.toml` caps build jobs at 2 so builds fit on low-RAM machines. To raise the cap, set `CARGO_BUILD_JOBS`, for example in PowerShell: `$env:CARGO_BUILD_JOBS=8; bun run tauri build`.

## Remote hosts

A remote project needs the following on the remote machine:

- Key-based ssh that works non-interactively from the Windows OpenSSH client. `ssh <host>` must not prompt for a password or passphrase. An alias from `~/.ssh/config` works as the host.
- shpool, the preferred session backend: `cargo install shpool`.
- tmux as a fallback if shpool is not installed. If neither is installed, the tab runs the command directly and does not survive disconnects.
- `claude` and/or `pi` on the PATH of the login shell (`$SHELL -l`). Commands run through the login shell, so PATH must be set in its startup files.

When ssh exits with code 255 (connection failure), the tab reconnects automatically. The retry delay starts at 1s and doubles up to 10s. Closing a remote tab also ends its remote session.

## Usage

- The first launch opens a tour: a sample project with claude at work, a dev server, the files window and pi waiting on workspace 2, and a spotlight that walks through eight stops (projects, workspaces, windows, Go to File, agent signals, the status line, Appearance and the Command Palette). Most stops have something to try, and tick once you have. Its agents are recordings played into the terminal, so nothing runs; the folder is `tour/` in the app config directory. Close the `tour` project with its ×, and replay the tour from `Alt+X` › Take the tour.
- The sidebar groups projects by environment: `local`, or an ssh destination. Add one with "⇄ Add environment": pick an alias from `~/.ssh/config` or type `user@host`. The connection is tested before the environment is added (remote hosts are listed over ssh, so key auth must work).
- Open a project with "+ Open project" or `Alt+O` (or the `+` on an environment's header). Pick the environment on the left and the folder on the right. Type to filter the folder list; `Enter` goes into the highlighted folder, or opens the folder you are in when the filter is empty; `Backspace` on an empty filter goes up; `Ctrl+Enter` opens the highlighted folder; a path starting with `~` or `/` jumps there. Git repositories are marked. A VS Code `.code-workspace` file is listed above the folders; opening it opens the folder it is in. Recent folders for the environment are listed above the picker.
- A new project is named after its folder and gets its icon from a logo file in it (`logo.svg`, `favicon.*`, `public/…`, `assets/…`, `src-tauri/icons/icon.png` and similar, with any SVG or favicon named logo/icon/brand/mark found up to four folders deep), or its first letter. Rename it by double-clicking its name, or in the Appearance panel (◐ or `Alt+P`), which also overrides the icon: another logo from the project, an uploaded image, a lucide icon or the letter.
- Open a tab with the `+` menu at the left of the toolbar; `Issues` and `Files` open their one-per-project window instead of adding a second. `Alt+Enter` opens a shell, `Alt+B` a browser, `Alt+I` issues, `Alt+E` files. On Windows, local agent tabs run through `cmd.exe /d /c`, and shell tabs (an empty command) run `powershell.exe`.
- A browser window holds pages, like browser tabs. Ctrl+click or middle-click a link to open it in a background page; a `target=_blank` link opens a page and shows it. With two or more pages the title bar shows them as tabs: click one to show it, middle-click or × to close it, `+` for a blank page. Ctrl+click a link in a terminal to open it as a new page of the project's last-used browser window. Sign-in and payment popups open in their own OS window so they can report back to the page.
- Select element (the crosshair in a browser window's address row) points an agent at part of the page. Click an element, Shift+click to add more, or drag an area; describe the change and press Enter to type it into the project's agent window (Ctrl+Enter also sends it, Esc stops). The agent gets the page address and, for each element, its selector, a short HTML snippet, its main styles and text, and the component and source file when the dev build exposes them (React before 19, Vue, Svelte). Not available on Linux, where browser windows are iframes.
- The agents window (`Alt+;`, or `+` → agents) edits the terminal apps the `+` menu offers: a name, a shell command, a [lucide](https://lucide.dev/icons) icon and an optional `Alt` hotkey each. It starts with claude, pi and shell. Rows save as you type; drag the grip to reorder the menu. A hotkey tri-code already uses, or another agent has, is flagged and ignored. Editing a command changes new windows only, and deleting an agent leaves its open windows running.
- Every hotkey can be changed in Settings › Hotkeys (the `?` button in the toolbar, or `Alt+/`). The page picks the key every window hotkey starts with (`Alt`, or `Cmd` / `Win` / `Super`) and lists every action with its keys: click a key and press a new one, or `+` to give an action another key. A key another action or agent has offers Swap; ↺ and Reset all go back to the defaults. Agents' hotkeys are listed there too.
- Run any command by name with `Alt+X` (or the prompt button next to `?` in the toolbar). The Command Palette lists everything a hotkey or menu does: new windows and agents, the focused window's actions, layouts and workspaces, appearance and open project, plus every window of the project (on any workspace) and every other project to jump to. Type to fuzzy-search; `Enter` runs the highlighted command. Each row shows its hotkey, and the commands you picked recently come first in the empty box.
- Jump to a file with `Alt+T`, or click the project path in the toolbar. Type to fuzzy-search the project's files (`git ls-files`, so new files count and ignored ones do not; a folder that is not a repo is walked, skipping `node_modules`, `target` and the like). An empty box lists recent files and the top folder; type a folder and `/` to browse it, `Tab` completes the highlighted row and `Backspace` after a `/` goes up. `Enter` opens the file in the project's editor, `Ctrl+Enter` in a new editor beside it, and `Shift+Enter` types `@path` into the project's agent window without sending it. Remote projects are indexed over ssh.
- Switch tabs by clicking a window or its tab in the toolbar. Close the focused tab with its × or `Alt+W`: it disappears right away behind a 5-second Undo, and a running tab's session ends only when the undo window closes.
- Minimise the focused window with the – in its title bar or `Alt+N`. It leaves the canvas, the others tile into its space, and its tab stays in the toolbar, dimmed, keeping its place. Click the tab (or pick it in `Alt+X`, or `Alt+Shift+N` for the last one) to bring it back where it was. The session keeps running, and an agent signal still shows on the dimmed tab.
- Worktrees let several agents work on different branches of one repo at once. `Alt+Shift+W` (or the branch-plus icon on a project's row, or "New worktree" in `Alt+X`) asks for a branch name, or names it after an In Progress issue (`tri-14-…`, so the git window links the two), runs `git worktree add` into a folder next to the repo (`<repo>.worktrees/<branch>`) on the project's host, and opens an agent in it. Each worktree is listed under its repo in the sidebar, the repo's own folder first, with its own windows, workspaces, accent and signal badge; collapsed, the rail stacks a small tile per checkout under the project's tile. A worktree uses its repo's appearance, signal settings and `.dev/` issues. Merging its PR in the git window deletes the remote branch, and "Remove worktree" (in the git window, or the × on its row) closes its windows, deletes the folder and the local branch. Each worktree needs its own dependencies installed, and its own dev server port.
- A folder that isn't a git repo (several repos side by side, or no git at all) gets worktrees too, as a copy: New worktree copies the folder to the same `<folder>.worktrees/<branch>`, adds each repo inside it back as a `git worktree` on the branch, and skips `node_modules`, `target`, `.venv` and other build folders. It is listed like any worktree, with the folder's own row as `base`. Finish (the × on its row) copies the files that changed outside git back to the folder, asks which side wins for a file changed in both, removes the nested worktrees (a branch that isn't merged stays) and deletes the copy.
- Remove a project with the × next to it in the sidebar. This closes all of its tabs. The × on an environment's header removes it with all its projects.
- Open the project's issues panel with Alt+I (or `+` → issues). It renders the project's `.dev/` folder from any mix of Issue Sources, ticked in its ⚙ form: Plane work items, the repo's GitHub Issues (through `gh` on the project's host, with its login; shown as `#231`) and Local issues kept only in `.dev/local-issues.json` (with an optional prefix, `TODO-3`, or plain numbers). Sentry items pi-todos has pulled show beside them. It is the same data pi-todos and dev-hub use, and it writes the same `issues.json`, `plane-states.json` and `plane-labels.json`, so they always agree. A remote project's `.dev/` is read and written over ssh. Plain keys drive the panel while it is focused (`j`/`k`, `Enter`, `Esc`, `d` state, `l` labels, `s` timer, `n` new and Tab to pick its Source, `f` source filter, `r` sync, `/` filter).
- Open the project's git window with `Alt+C` (or `+` → git). The left side is the commit box and the staged and unstaged files (tick a file to stage it, double-click to open it), then the recent commits: click one to read it in the right pane, its message on top and its changes below. The right side otherwise shows the selected file's diff. `Ctrl+Enter` in the message commits and `Ctrl+Shift+Enter` commits and pushes; the ▾ next to Commit also has "Commit, push & open PR". Push, PR and Merge in the header open a drawer over the diff; the open PR's checks refresh every 15s while they run. It needs `git` on the project's host, and `gh` (logged in) for PRs and merging.
- The ✦ buttons in the git window write a draft for you to edit: the commit message, the PR title and body, and a review of the whole branch before merging. They run `claude -p` in the project folder on the project's host, so they use your own Claude Code login. The chips under "✦ reads" are what the draft is given: the diff, the In Progress issue (the one named in the branch, else the first), the last commit subjects (for the style) and `CONTEXT.md`. Click one to leave it out. "Send to claude" on a review note types it into the project's agent window (any terminal with a command, not a plain shell) without sending it.
- The icon in a window's title bar is coloured by its status: grey connecting, green running, amber reconnecting, red exited. Press Enter in an exited tab to restart it.
- Ctrl+C copies the terminal selection and still sends SIGINT when nothing is selected; Ctrl+V pastes. Full-screen apps such as claude and pi capture the mouse, so hold Shift while dragging to select their text. To make a plain drag select in Claude Code's fullscreen mode, set `CLAUDE_CODE_DISABLE_MOUSE=1` (it then scrolls with PgUp/PgDn instead of the wheel).
- Agent signals: claude and pi report whether they are working, waiting for you, done or failed (the Program Status Protocol, OSC 7501), and tri-code shows it as a dot on the project's icon, its workspace number, the window's tab and a chip in its title bar. The status line counts them across every project; click the counts, or press `Alt+U`, to go to the next agent that needs you. When an agent you aren't looking at needs input, finishes or fails, tri-code plays a sound and shows a desktop notification. The bell in the status line sets the sound for each signal, when to alert (when away, always, or badge only), desktop notifications, volume and Do not disturb; Appearance › Signals overrides them per project, including a sound file of your own. No setup is needed in claude or pi. It works locally and over ssh or shpool, but not through tmux, which drops the sequences. On Windows, terminals run through the ConPTY from Windows Terminal that tri-code installs next to itself (`src-tauri/windows`), since the one built into Windows drops them too. A terminal bell from any other app still flags its tab.
- Branch status: the left end of the status line shows the active project's branch, `*` when it has uncommitted changes, ↑/↓ against its upstream, and counts like `git status --short` (`+` added, `~` modified, `−` deleted, `?` untracked). Hover for the files, click to open the git window. Nothing shows when the project is not a git repo. It refreshes when you switch project, when the window regains focus, and every 10s (30s over ssh). Chosen from design/branch-status.html (variant C).

## Releases and updates

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the Windows installers (NSIS and MSI) and the macOS apps (Apple Silicon and Intel), signs the update bundles, and publishes them as a GitHub Release. The version lives only in `package.json`; `tauri.conf.json` reads it from there.

First add a `## <version>` section to `CHANGELOG.md`: it becomes the release notes, and the build fails without it.

```
bun pm version patch          # or minor, major, or 1.2.3; commits and tags v<version>
git push --follow-tags
```

Installed copies check the latest release's `latest.json` at startup and every 6 hours, download a newer version in the background, and show "↻ Restart to update" in the status bar. Restarting ends local terminal sessions; remote tabs reattach. Dev builds never update. The window title and the status bar show the running version; click the version (or run "About tri-code" / "Check for updates" from `Alt+X`) to check now and read the changelog.

The updater checks downloads against the public key in `tauri.conf.json`. The matching private key is the `TAURI_SIGNING_PRIVATE_KEY` repository secret (kept outside the repo at `~/.tauri/tri-code.key` on the machine that made it). If the key is lost, installed copies cannot verify new releases and must be reinstalled by hand. The macOS builds are ad-hoc signed but not notarized, so Gatekeeper blocks the first launch. Open System Settings → Privacy & Security and click Open Anyway, or run `xattr -cr /Applications/tri-code.app`. Builds from before 0.1.28 were unsigned, and macOS reports them as "damaged". The `xattr` command fixes those too.

## Development

Rust tests:

```
cd src-tauri && cargo test
```

The SSH end-to-end test is ignored by default. It needs passwordless ssh and shpool on the target host, and it only runs on Unix:

```
TRI_SSH_HOST=<host> cargo test -- --ignored
```

Frontend checks: `bun run typecheck` for TypeScript and `bun run build` for a Vite build.

Layout:

`src/`

- `index.tsx`: entry point. Mounts the app and loads the xterm and app stylesheets.
- `App.tsx`: sidebar, tab bar, terminal host.
- `Sidebar.tsx`: projects grouped by environment, rename in place, and each repo's worktrees under it (stacked tiles on the rail).
- `worktrees.ts`: worktrees: `git worktree list` per repo, the branch names, create and remove; a copy for a folder that isn't a repo, and finishing it.
- `NewWorktree.tsx`: the New worktree dialog (`Alt+Shift+W`).
- `OpenProject.tsx`: the Open project dialog (`Alt+O`): environments, the folder picker, and the New environment form.
- `icons.tsx`: project icons: logo scan, auto pick, upload, and the icon face drawn in the sidebar.
- `GoToFile.tsx`: Go to File (`Alt+T`): the fuzzy search and folder browser under the toolbar path.
- `Appearance.tsx`: the Appearance panel: name, icon, accent, background, dim, and the project's Signals tab.
- `signals.ts`: agent signals: what each window signals, the sounds (synthesized, or a project's uploaded file), desktop notifications, and `Alt+U`.
- `SignalSettings.tsx`: the signals form, shared by the status line's bell (every project) and Appearance › Signals (one project).
- `keymap.ts`: the Keymap: every hotkey action, its default keys and its keys now, and matching a key press to one.
- `modkey.ts`: the Hotkey Modifier (Alt or Cmd / Win / Super).
- `hotkeys.ts`: the window keydown listener that runs Keymap actions.
- `Settings.tsx`: the Settings dialog (General, Windows, Hotkeys); `HotkeySettings.tsx` is its Hotkeys page.
- `state.ts`: Solid stores for projects, tabs, and live tab status. Loads and debounced-saves the state file.
- `terms.ts`: one xterm and one PTY per tab. Handles output, resize, reconnect backoff, bell detection, OSC 7501 agent status (answering the probe, keeping the last report), and the WebGL renderer for the visible tab only.
- `issues.ts`: the `.dev/` store, the Plane and GitHub syncs and Local issues, plus the pure helpers (each Source's States, sort order, State Pill contrast, Slug-ID).
- `IssuesPanel.tsx`: the issues window: the list, the full-width drill-down, the State Dropdown, labels, the comment thread, and the Issue Sources form.
- `updater.ts`: the update check (periodic and on demand), background download, and "Restart to update".
- `About.tsx`: the About dialog: the running version, "Check for updates", and `CHANGELOG.md`.
- `Tour.tsx`: the tour: its eight stops, the spotlight and card, the try-it checks, and the closing card.
- `demo.ts`: the tour's scripted terminals (claude, pi, a dev server), played into xterm in place of a PTY, with real OSC 7501 reports.
- `styles.css`: application styles.
- `vite-env.d.ts`: Vite type declarations.

`src-tauri/src/`

- `main.rs`: binary entry point. Hides the console window in Windows release builds.
- `lib.rs`: Tauri setup. Registers the commands and the shared PTY state.
- `dirs.rs`: folder listing for the project picker (marking git repositories, listing `.code-workspace` files), local or over ssh.
- `folders.rs`: worktrees for a folder that isn't a repo: the repos nested in it, copying it, what changed in the copy, and copying that back, local or over ssh.
- `envs.rs`: `ssh_hosts` (the `Host` aliases in `~/.ssh/config`) and `scan_logos` (logo files in a project folder, as data URLs), local or over ssh.
- `bg.rs`: background and icon images, stored as data URL files next to `state.json`.
- `devfs.rs`: `dev_read` / `dev_write` for a project's `.dev/` folder, local or over ssh, with an atomic write. The first write into a `.dev/` adds a `.gitignore` of `*` there, as pi-todos does, so the folder never ends up in git.
- `plane.rs`: the Plane.so REST calls the issues panel needs (sync, set state, set labels, create, comments, asset upload). The token is read from `~/.pi/agent/secrets/plane.json` on the project's host.
- `github.rs`: the GitHub Issues calls, through `gh` on the project's host (sync, set state, labels, create, comments). No token: gh uses the host's login.
- `remote.rs`: the shared non-interactive ssh command builder used by `dirs.rs`, `envs.rs` and `devfs.rs`.
- `pty.rs`: PTY sessions (spawn, output channel, write, resize, kill) and remote session cleanup.
- `spawn.rs`: builds the program and arguments for local and ssh tabs, including the shpool and tmux fallback. Contains the unit tests and the ignored SSH end-to-end test.
- `store.rs`: loads and atomically saves `state.json`.
- `tour.rs`: `tour_folder` writes the tour's sample files (from `src-tauri/tour/`) into the app config directory.
