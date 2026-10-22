# Changelog

Each release's section becomes its GitHub Release notes, and tri-code shows this file in the About dialog. Add a `## <version>` section above the newest one before tagging.

## 0.1.29 — 2026-10-22

- The files window and file windows are now one editor window per project (`Alt+E`): the file tree, a tab per open file and a real code editor (CodeMirror), with syntax colours for the common languages, search (`Ctrl+F`), multiple cursors, folding and bracket matching. Markdown, HTML and SVG still show rendered, with Source to edit them; images, video and audio still play.
- One click in the tree, or Go to File, opens a preview tab (in italics) that the next file replaces. Double-click it or start typing to keep it. `Ctrl`+click opens a second editor beside.
- The status bar shows the line and column, indentation, line endings and language. Files with Windows line endings or a BOM are saved the way they were read.
- Saving won't overwrite a file that changed on disk since you opened it (an agent wrote to it) without asking, on your machine or over ssh.
- Move a line with `Ctrl+Shift+↑/↓` (`Alt+↑/↓` move between windows).
- The "Opening a file" setting is gone, and with it Settings' General page. Open files windows become editors; open file windows become editors with the tree hidden (▤ shows it).

## 0.1.28 — 2026-10-21

- Worktrees for any folder. New worktree on a folder that isn't a git repo (several repos side by side, or no git at all) copies it to `<folder>.worktrees/<branch>`, so it shows and works like any other worktree; the folder's own row reads `base`. Each repo inside it becomes a git worktree on the same branch, and `node_modules`, `target`, `.venv` and other build folders are skipped, so install again in the copy. Finish (the × on its row) copies the files that changed outside git back, asks which side wins for a file changed in both, removes the nested worktrees (a branch that isn't merged stays) and deletes the copy.
- Open project lists VS Code `.code-workspace` files above the folders; opening one opens the folder it is in.
- Every hotkey can be changed in Settings › Hotkeys (the `?` button, or `Alt+/`): pick whether window hotkeys start with `Alt` or `Cmd` / `Win` / `Super`, click a key to rebind it, `+` to add another, Swap when the key is taken, and ↺ or Reset all to go back. It replaces the old hotkey overlay.
- Settings is now a dialog with General, Windows and Hotkeys pages.
- Closing a window is now `Alt+W`, and New worktree `Alt+Shift+W`.
- macOS builds are signed ad hoc, so Gatekeeper no longer reports them as damaged. On macOS the menu bar keeps only About, Quit and Edit, so `Cmd+W`, `Cmd+M` and `Cmd+H` stay free for hotkeys when Cmd is the modifier.

## 0.1.27 — 2026-10-21

- The status line shows the active project's branch on the left: `*` when it has uncommitted changes, ↑/↓ against its upstream, and counts like `git status --short` (`+` added, `~` modified, `−` deleted, `?` untracked). Hover for the files, click to open the git window. It refreshes when you switch project, when tri-code regains focus, and every 10s (30s over ssh).
- Window title bars show the window's icon in colour instead of a dot: an agent's own icon, or the panel's (globe, git branch, folder tree…). A terminal's icon is green when running, amber while reconnecting and red once exited.
- The gap between windows moved from the status line to Appearance. `Alt+,` and `Alt+.` still step it.

## 0.1.26 — 2026-10-21

- The issues panel isn't only for Plane any more. Tick any mix of Plane, GitHub Issues and Local issues from ⚙ in its toolbar (a project with none set up starts there); they show in one list, with Sentry beside them, and `f` filters by source. Existing Plane projects carry on unchanged.
- GitHub Issues use `gh` on the project's machine with the login it already has, so tri-code needs no token. They show as `#231`, with Open, In Progress, Closed and Not planned; In Progress is a label (`in progress` unless you name another), added to the repo the first time it's needed. Labels and text comments work too.
- Local issues need no account: they live in the project's `.dev/local-issues.json`. Give them a prefix (`TODO-3`) or leave it empty for plain numbers.
- With more than one source on, `n` asks for a title and Tab picks where the new issue goes. Timers and the In Progress chips work for issues from any source.
- Changing an issue's state shows the new state with a spinner until it's saved.
- The state and label dropdowns close when you click outside them or switch windows.

## 0.1.25 — 2026-10-21

- Browser windows show a thin line under the address bar while a page loads (on the title bar for web apps that hide it), so a slow click no longer looks like nothing happened. Quick loads under 150 ms show nothing.
- Type any gap between windows, from 0 to 64 px, in Settings or the status line. `Alt+,` and `Alt+.` still step through the presets.
- Settings › Carousel gutter: how wide the space each side of the centred window is in the carousel layout, where its neighbours peek. Leave it empty for the old automatic width; 0 hides the neighbours.
- The Settings icon at the foot of the sidebar is centred.

## 0.1.24 — 2026-10-21

- Choose what opening a file does when a file window is already open: replace its file, open a new window, add it as a tab, or open a preview that the next file replaces until you keep it (double-click its name, or start editing). The first time, the file window asks, with "remember". Change it later from ⋯ in any file window, or from Settings.
- Settings, at the foot of the sidebar (or `Alt+X` › Settings): opening files and the gap between windows, for every project.
- Ctrl+click in the files window opens a file in a new window. A file that's already open is focused instead of opened again.
- Go to File finds gitignored files like `.env`. Whole ignored folders such as `node_modules` stay out.
- Drag a project in the sidebar to reorder it within its environment. Its worktrees move with it.

## 0.1.23 — 2026-10-21

- ssh environments that need a key file. In New environment, paste the ssh command you use in a terminal (`ssh -i key.pem user@host`, with `-p` and `-o` too) or fill in the Key file field; tri-code uses that key, and only that key, for every terminal, git and file call to the host. A failed test says what to try: the key, its passphrase (add it with `ssh-add`), or file permissions that are too open.
- Lock an ssh environment with a PIN. Turn on "Lock with PIN" when you add it and pick how long an unlock lasts. While it's locked, its projects show a PIN pad instead of their windows, its terminals don't start, and tri-code won't connect to it. The lock in its sidebar header shows the state; click it to lock again now. Restarting tri-code locks it again.
- Project icons can be any lucide icon: the Appearance panel's Glyph tab is now Icon, with 32 to pick from and a search over the full set.
- The status bar timer follows the project you switch to. The hotkey hints and the focused-window info are gone from the status line.

## 0.1.22 — 2026-10-20

- A tour for new users. The first launch opens a sample project with claude part-way through a task, a dev server, the files window and pi waiting on workspace 2, and walks through eight stops: projects, workspaces, windows, Go to File, agent signals, the status line, Appearance and the Command Palette. Most stops have something to try and tick once you have; pi asks you something on cue so you can see a signal arrive and jump to it with `Alt+U`. The sample agents are recordings, so nothing runs. Close the `tour` project when you're done, and replay it any time from `Alt+X` › Take the tour.
- Web apps: set up a browser window like an agent. In the agents window (`Alt+;`), type an address where the command goes and the row becomes a web app, with its own name, icon, `Alt` hotkey and place in the `+` menu. Its windows open at that address and carry its name and icon. "app" mode hides the address and favourites bars (⋯ in the title bar shows them). Your project's favourites are offered as web apps to add.
- Minimise a window: the – in its title bar or `Alt+N` takes it off the canvas without closing it, and the others tile into its space. Its tab stays in the toolbar, dimmed; click it, or focus it any other way, to bring it back where it was. `Alt+Shift+N` brings back the last one. The session keeps running, and a signal still shows on the dimmed tab.

## 0.1.21 — 2026-10-20

- The file window shows images, and plays video and audio (mp4, webm, mp3 and more), locally and over ssh, instead of saying "Binary file". SVGs get a Preview next to Source and Edit.
- New app icon.

## 0.1.20 — 2026-10-20

- Each review note in the git window has a Copy button in place of "Send to claude"; it puts the note on the clipboard, ready to paste wherever you want it.

## 0.1.19 — 2026-10-20

- Typing an address into a new browser window or tab and pressing Enter loads it the first time; before, it opened a blank page and needed a second Enter.

## 0.1.18 — 2026-10-20

- Worktrees: run agents on several branches of one repo at once. `Alt+W` (or the branch-plus icon on a project's row) makes a new checkout on its own branch, in a folder next to the repo, optionally named after an In Progress issue, and opens claude in it. Each worktree sits under its repo in the sidebar with its own windows, workspaces, colour and signal badge; on the collapsed sidebar each one is a small tile under the project's icon, so you can see which branch needs you.
- The git window works in a worktree as it does in the repo; merging deletes the remote branch, and "Remove worktree" closes its windows and deletes its folder and branch.

## 0.1.17 — 2026-10-19

- Agent signals work on Windows. tri-code now ships Windows Terminal's ConPTY, which passes agents' status reports through to the terminal; the one built into Windows dropped them, so no badges, sounds or notifications showed up.

## 0.1.16 — 2026-10-19

- Agent signals. claude and pi now tell tri-code whether they are working, waiting for you, done or failed, with no setup on their side. A dot on the project's icon, its workspace number and the window's tab shows it, and the title bar says it in words ("needs you · 2m ago"). The status line counts them across every project; click the counts or press `Alt+U` to go to the next agent that needs you.
- When an agent you aren't looking at needs input, finishes or fails, tri-code plays a sound and shows a desktop notification. The bell in the status line sets a sound for each, when to alert (when away, always, or badge only), volume, and Do not disturb. Appearance › Signals overrides them per project, and you can upload your own sound.
- Works locally and over ssh or shpool; tmux drops the signals, so remote sessions running inside tmux only get the terminal bell.

## 0.1.15 — 2026-10-19

- The toolbar starts with the workspaces, then the layout buttons, then the window tabs. The gap setting moved to the bottom-left of the status bar.

## 0.1.14 — 2026-10-19

- Select element works on sites that block inline styles, such as claude.ai and GitHub; its bar, boxes and composer showed up unstyled there.

## 0.1.13 — 2026-10-19

- Select element: the crosshair in a browser window's address row lets you click elements (Shift adds more) or drag an area, describe the change, and type it into your agent window with Enter, or send it with Ctrl+Enter. The agent gets each element's selector, HTML, main styles and text, and its component and source file when the dev build has them.

## 0.1.12 — 2026-10-19

- Browser windows have tabs. Ctrl+click or middle-click a link to open it in a background tab; `target=_blank` links open a tab and show it. The tabs sit in the window's title bar once there are two; `+` adds a blank one.
- Ctrl+click on a link in a terminal opens a new tab in the browser window instead of replacing its page.
- Sign-in and payment popups open in their own window, so signing in with GitHub and the like works.

## 0.1.11 — 2026-10-19

- The sidebar's project tiles and environment icons are the same size open or collapsed, and nothing shifts when it collapses, expands or peeks.

## 0.1.10 — 2026-10-19

- Edit any text file in its file window: Edit, then Save (or Ctrl+S); Revert discards. Preview shows unsaved edits.
- Markdown preview: relative images load, links to other files open them, `#heading` links scroll, and the scrollbar sits at the window edge.

## 0.1.9 — 2026-10-18

- The window title and the status bar show the running version.
- About dialog (click the version, or "About tri-code" in `Alt+X`): check for updates now and read the changelog.

## 0.1.8 — 2026-10-18

- Hover the collapsed sidebar to peek at the full project list.
- Environments can have a display name (double-click the header) and an icon.

## 0.1.7 — 2026-10-18

- Command Palette (`Alt+X`): run any command by name.

## 0.1.6 — 2026-10-17

- Agents window: add custom terminal apps and give them hotkeys.

## 0.1.5 — 2026-10-17

- Go to File (`Alt+T`): search and browse project files from the toolbar path.

## 0.1.4 — 2026-10-16

- The folder picker shows dot-folders and has a drive switcher.

## 0.1.3 — 2026-10-16

- SVG logos and favicons are picked up anywhere in a project.

## 0.1.2 — 2026-10-16

- Every platform's build uploads to one release.

## 0.1.1 — 2026-10-16

- First release: installers for Windows and macOS, and installed copies update themselves from GitHub.
