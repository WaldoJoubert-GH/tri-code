# tri-code

A minimal agent development environment. The left sidebar lists projects grouped by host (`local` or an ssh destination); the rest of the window is a tiled canvas of Windows. See the README for the layout.

## Shared `.dev/` contract

tri-code is the third client of a project's **Dev Directory** (`.dev/`). The other two are pi-todos (a pi extension) and dev-hub (a Claude Code mod). pi-todos' `CONTEXT.md` is the source of the domain language; these terms are the ones tri-code uses for the same files.

**Dev Directory** (`.dev/`):
The per-project, gitignored folder shared by the three clients: `config.json`, `issues.json`, `plane-states.json`, `plane-labels.json`, `time-entries.json`, `sentry/<id>.json`, and `plane/comments/<issue>.json`; tri-code adds `local-issues.json`, `github-labels.json`, `github-members.json`, `plane-members.json` and `github/comments/<n>.json`. Read and written on the project's host.
_Avoid_: Data dir, cache dir.

**Dev Client**:
A tool that reads and writes a project's Dev Directory. tri-code is one, alongside pi-todos and dev-hub. Clients must not keep their own copy of the shared data.

**Issues File** (`issues.json`):
The unified list of Plane, GitHub and pulled Sentry Issues, with a `source` discriminator. A sync of one Source rewrites only that Source's entries and keeps every other one. Local Issues are not in it.

**Issue Source**:
Where a project's issues come from: Plane, GitHub or Local, any mix of them, ticked in the Issues Panel's ⚙ form and kept as `sources` in `config.json`. Sentry is pulled beside them and is not a Source. A config with a `plane` section and no `sources` means Plane alone. Chosen from design/issue-providers.html (variant B); see ADR 0002.
_Avoid_: Provider, tracker, integration.

**GitHub Issue**:
An issue of the project's GitHub repo, read and changed through `gh` on the project's host with its login. Open or closed only, so the panel maps it to four States: Open, In Progress (open with the In Progress label, `in progress` unless `github.progress_label` says otherwise), Closed and Not planned. Comments are text only.

**Local Issue**:
An issue that exists only in `.dev/local-issues.json`: a number, a title and one of four States (Todo, In Progress, Done, Cancelled). No account and no sync. Its own file because pi-todos and dev-hub rewrite `issues.json`.

**Issues Panel**:
A canvas Window, one per project, that renders the project's Dev Directory as a list and a full-width drill-down. New `TabKind` `"issues"`. Plain HTML, not a terminal, so plain keys drive it while it is focused. Addressed with `Alt+I`.

**Timeline**:
The Issues Panel's list drawn as a Gantt chart (`v` toggles it; kept per window as `timeline` on the Tab): the same filtered rows on the left, a bar per issue on the right, a line at today, Day / Week / Month zoom. A Plane Issue's Start Date and Target Date place its bar; a missing one is derived (the created date; the closed date or today) and that end fades out. Dragging a Plane bar, or either end, PATCHes both dates. GitHub and Local Issues have no dates, so their bars run created → closed or today and do not move. Chosen from design/issues-gantt.html (variant A).
_Avoid_: Gantt view, roadmap, schedule.

**Slug-ID**:
`<Project Identifier>-<sequence_id>` for a Plane Issue (e.g. `TRI-12`); `#<number>` for a GitHub Issue; `<prefix>-<number>` for a Local Issue, or the bare number when the project's Local prefix is empty; `S-<sentry_id>` for a Sentry Issue. What the user copies and sends to an agent; selection and Time Entries use the issue key (`gh231`, `lo3`, the Plane UUID).

**State Pill**:
A State rendered with its State Hex as the fill (a GitHub or Local Issue's States have fixed colours) and black or white text by relative luminance. The fill does not follow the theme. In the panel it is also the control that opens the State Dropdown.

**State Dropdown**:
The popup anchored under a State Pill that lists every State of the issue's Source grouped by State Group. `d` opens it; arrows move, Enter confirms and PATCHes Plane, runs `gh`, or rewrites `local-issues.json`.
_Avoid_: State picker, status menu.

**Assignee**:
A person an issue is assigned to: a Plane member (the user id on the issue, named from `plane-members.json`) or a GitHub login, which is its own name (the repo's assignable logins, from `github-members.json`). A Local Issue has none. Shown as avatars on the row; the New Issue modal picks them from the Source's members.

**Label**:
A workspace-scoped Plane label: an id, a name and a colour. Cached in `plane-labels.json`, carried on an Issue as label ids. `l` opens a multi-select dropdown; each toggle PATCHes Plane and keeps the dropdown open.

**Comment**:
A Plane work item comment: an author, a timestamp, `comment_html` and its images. Cached in `plane/comments/<issue>.json`. Images are uploaded as Plane assets and referenced from the `comment_html`; reading them needs the token, so they are inlined as `data:` URLs for the panel.

**Running Entry**:
The single un-stopped Time Entry across the workspace. Shown on the row, in the In Progress chips and in the status line; persisted in `time-entries.json`.

**In Progress Chip**:
A toolbar chip for each issue, from any ticked Source, whose State is named exactly `"In Progress"`, the running one first then by priority. Two chips show, then `+N`. A click drills into that issue in the Issues Panel.

**Environment**:
Where projects run: `local`, or an ssh destination (an alias from `~/.ssh/config` or `user@host`). Kept as an ordered list in `state.json`, so one can exist with no projects; the sidebar shows one section per Environment. A project's `host` is its Environment. Each can have a display name (double-click its header) and a lucide icon (click the icon); both are labels only, kept in `envStyles` by host, so a rename never changes where projects run.
An ssh Environment can also carry a key file, port and `-o` options (`envSsh`, applied to every ssh call to that host; the destination field takes a pasted `ssh -i key user@host` command) and a **PIN Lock** (`envLocks`).
**The Environment dialog** is one form for New environment (the sidebar's Add environment, or Open project's "+ New environment") and Edit environment (right-click a header). A changed connection is tested first, and a failed test can still be saved. While an Environment is locked only its name and icon can change; changing or removing a PIN asks for the current one. Giving an Environment a new destination **moves** it: the host is its key, so its projects, Worktrees, name, ssh options, PIN, recents and scoped Commands follow, its sessions on the old host end, and its terminals restart on the new one. Folders keep their paths. Chosen from design/environment-dialog.html.

**PIN Lock**:
A 4–8 digit PIN on an Environment. Locked, its projects show the PIN pad instead of the canvas, its terminals don't start, and Rust refuses ssh to it. An unlock lasts the chosen minutes; a restart locks again. A gate in tri-code, not encryption of the key.
_Avoid_: Password, vault.
_Avoid_: Host group, machine, server.

**Open Project Dialog**:
The `Alt+O` dialog: Environments on the left (with "New environment", which opens the Environment dialog over it and comes back to what it added), a Folder Picker on the right. Opening a folder that is already a project focuses it.
_Avoid_: Add project form, folder browser.

**Tour**:
The first-launch walkthrough (`Tour.tsx`): a spotlight over the real app and a card with eight stops, most with something to try that ticks once done. Runs in the Sample Project. `toured` in `state.json` records that it was finished or skipped; a state file from before the tour counts as toured. Chosen from design/onboarding.html (variant D).
_Avoid_: Onboarding wizard, coach marks.

**Sample Project**:
The `tour` project (`sample: true`), in `tour/` under the app config dir. Its terminals are Demo Tabs: scripted sessions (`demo.ts`) that write OSC 7501 reports into xterm, so signals, badges and notifications behave as for a real agent. Not added to Recent; closing it loses nothing.

**Go to File**:
The file half of the Command Palette (`Alt+T` and a click on the toolbar path open it too). Searches the project's File Index by fuzzy match and, when the query is `/` or a folder and `/`, lists that folder. Opens the pick in a Preview Tab of the project's Editor Window (`Ctrl+Enter`: a new Editor Window beside).
_Avoid_: Quick open, file palette, Ctrl+P.

**Editor Window**:
A canvas Window (`TabKind` `"editor"`, `Alt+E`) with the project's file tree, a tab per open file, a CodeMirror 6 editor and a status bar; Markdown, HTML and SVG also show rendered, media files play, and a Spreadsheet File shows as a table. Replaced the Files and File Windows; chosen from design/editor.html (variant B). A file opens in the Editor Window it was picked from, else the one used last; `Ctrl`+click opens a second one beside. A changed file also has a **Diff** mode beside Source, comparing `HEAD` with the live buffer (unsaved edits and all), unified or side by side; chosen from design/diff.html (variant A). Source marks the same changes with bars in the gutter. No extension host: language smarts are to come from language servers run on the project's host.
_Avoid_: Files window, file viewer, IDE.

**Preview Tab**:
The Editor Window's italic tab for a file opened with one click (or from Go to File); the next file opened that way replaces it. A double-click or an edit keeps it.
_Avoid_: Temporary tab.

**Stamp**:
A file's modification time and size when the editor read it. Saving sends it back, and a file changed since (an agent wrote to it) is not overwritten without asking.

**Command Palette**:
The `Alt+X` (or `Alt+T`) box under the toolbar that runs any Command by name and opens files (Go to File). The empty box lists recent picks, Commands and files, then every Command by group; typing fuzzy-matches Command titles and the File Index together, Commands first. Built from `commands.ts` each time it opens, so it only offers what applies now (no "Make main" outside Main + stack). A Command with a hotkey runs the same function the hotkey does.
_Avoid_: Command menu, launcher, Ctrl+Shift+P (tri-code binds only Alt chords).

**Hotkey Modifier**:
The key every window hotkey starts with: Alt by default, or Cmd (Super / Win off macOS) in Settings › Hotkeys (`modkey.ts`). The other key is left to the terminal. With Cmd, Cmd+C and Cmd+X copy and cut while text is selected, and no hotkey can take Cmd+A, V, Z or Q.
_Avoid_: Leader key, prefix.

**Keymap**:
Every action a hotkey runs (focus left, close window, go to workspace 2, copy, ...), with its default keys and the keys it has now (`keymap.ts`). An action can have several keys or none; Settings › Hotkeys changes them and only the changed ones are saved, as `settings.hotkeys`. Window actions are Hotkey Modifier chords; the text actions (copy, paste, favourite) are plain Ctrl / Cmd chords. Labels and tooltips print an action's current first key, so they follow a rebind. Agents keep their own one hotkey, which may not be a Keymap action's.
_Avoid_: Keybindings, shortcuts (in code and docs; the UI says hotkeys).

**Hold Hints**:
While the Hotkey Modifier is held with no other key for 120 ms, each control's icon turns into its Keycaps in the same box, so nothing is added to it or covered: the workspaces, layout, palette, Hotkeys, Appearance, sidebar, Open project, the rows either side of the active project, New worktree, and the window Shift+N would bring back. A control with only a label (Diff, the next-signal count) draws its key beside it. On the focused window, N, F and W take the place of its – ▢ ×, with M when it can become the main window. Each window it can jump to carries a large key and its swap key; a native browser window takes its key in its title bar instead, because its page draws above HTML. The New Window Menu opens under its `+` with each row's icon turned into its keys, hiding only the webviews it overlaps; a key pressed during the hold closes it so the result shows, while Shift or Ctrl alone leaves it open. The status line lists the keys with no control: shell, workspace steps, gap, swap, send and split, giving up room from the right in a narrow window. A flash message takes its place while it shows. In the sidebar and toolbar, what has no key steps back. Editor and Text keys are not modifier chords and are not drawn. They stay for as long as the hold lasts. Letting go hides them; a chord pressed inside those 120 ms runs as always and draws nothing (`hints.ts`). They follow Settings › Hotkeys and the tiling, so a direction with no window that way has none.

**Keycap**:
How the app draws a key, everywhere: on a control, in a panel's footer, in a dialog, in Settings. One key per cap, with Shift, Enter and Backspace as the symbols a keyboard prints (`Keys.tsx`, `kbd` in `styles.css`; `keys.test.ts` fails if any other file draws or restyles one). Settings › Appearance › Keys makes them neutral or the project's accent colour. Tooltips and text inputs can't hold a Keycap and still write keys as text.
_Avoid_: Chip, kbd.
_Avoid_: Cheat sheet, overlay, tooltip (it is not a tooltip and does not wait for hover).

**File Index**:
A project's files for Go to File, as relative paths: `git ls-files --cached --others --exclude-standard` on the project's host plus the ignored files, walking into wholly ignored folders but not the skipped ones (Settings › Files; by default dependency and build folders like `node_modules`, `.venv`, `target`), or a walk that skips the same folders when the folder is not a repo. Fetched each time the box opens; the last one shows meanwhile.

**tri Command**:
Opening from a terminal, as `code .` does: `tri .` or `tri <folder>` opens that folder as a project, or shows it when it already is one; `tri <file>[:line[:col]]` opens the file in the Editor Window of the deepest project that holds it (a Worktree before its repo), else of a new project at its repo or folder. Local paths only. `tri` is a script that starts tri-code's exe; a running tri-code takes the paths and the caller's folder from that second launch (single instance), and the UI opens them once loaded (`cli.rs`, `cli.ts`). Settings › Command line writes it (`tri.cmd` in the app's `bin` folder, put on the user PATH, on Windows; `~/.local/bin/tri` elsewhere), and tri-code's own terminals get that folder on PATH at once. A debug build is not single instance, so it only takes paths when it starts.
_Avoid_: CLI (in UI text), shell command, launcher.

**Folder Picker**:
The path field that is also the folder list: typing filters, `Enter` goes in or opens, `Backspace` on empty goes up, a `~` or `/` path jumps.

**Project Icon**:
What the sidebar draws for a project: a logo file from the project, an uploaded image, a lucide icon or the first letter. **Auto** is tri-code's pick (the first logo found, else the letter); any other choice in the Appearance panel is an override until "reset to auto".

**Look**:
The theme (System, Light or Dark) and the two fonts, Interface and Code, set in Settings › Appearance for the whole app (`look.ts`). A project's name, icon, accent, Backdrop, Backdrop Effect and Transparency are not part of it; they are in the project's Appearance panel. A saved font that isn't installed stays saved and the default shows until it is.

**Backdrop**:
What a project's windows sit on: its background (a preset drawn from the accent, or an uploaded image) with its Dim. A Worktree shows its repo's. It fills the canvas, or the whole window when Transparency takes in the sidebar and bars.
_Avoid_: Wallpaper.

**Backdrop Effect**:
The Backdrop redrawn through Zeron's Dither or Halftone (`backdrop.ts`, ported under its MIT notice), laid over the picture at a Strength from 0 (off) to 100; in the picture's colours or the accent's alone. Drawn on a canvas, with the Dim in its pixels, so it runs again on a resize or a theme change.
_Avoid_: Filter, shader.

**Transparency**:
How much of the Backdrop shows through panel windows and through terminals, each 0 to 85%, per project; optionally frosted (Blur) and taken into the sidebar, toolbar and status line at the panels' value. Browser windows stay solid: they are native webviews over the page.
_Avoid_: Opacity (the text stays opaque), glass.

**Configuration Export**:
One JSON file (`format: "tri-code-config"`) holding the sections picked in Settings › Backup: Preferences (`settings`, `notify`, `gap`), Commands, Browser Profiles (names and colours only, never cookies or passwords), Environments (with `envSsh`) and Projects (place and appearance, with their uploaded backgrounds, icons and sounds inlined as data URLs). Made for moving to a new machine (`config.ts`). Worktrees, the Sample Project, window layouts, PIN Locks and Remote Control pairing are left out. **Import** previews each section, then merges: entries with a matching id are replaced, a project at the same host and path keeps its windows and takes the file's appearance, anything else is added, nothing is deleted. Read through the same `migrate()` as `state.json`, so older exports keep working.
_Avoid_: Backup file, settings sync, profile (a Browser Profile is something else).

**Tab Strip**:
The leftmost toolbar group: the active workspace's Windows in tiling order, the focused one underlined, then `+`. A strip tab only focuses a Window that already exists (bringing back a Minimised one), so nothing is created or moved by clicking one; Windows on other workspaces are not listed.
_Avoid_: Tab bar (there is no tab bar), window list, tab buttons.

**Minimised Window**:
A Window taken off the canvas with – or `Alt+N`. It keeps its place in tiling order and its tab in the Tab Strip, dimmed; the tiler, the mono carousel and `Alt+H/J/K/L` skip it. Focusing it in any way (its tab, the palette, `Alt+U`, `Alt+Shift+N`) brings it back. Stored as `min` (when) on the Tab. Chosen from design/minimise.html (variant A, "strip").
_Avoid_: Hidden window, docked, collapsed.

**New Window Menu**:
The popup under the Tab Strip's `+`: one row per Command the project is offered (with its hotkey), in the list's order, then one per panel kind with the key that also opens it (`Alt+B`, `Alt+I`, `Alt+E`, `Alt+C`, `Alt+;`). Issues, Git and Commands open or focus their one-per-project Window rather than adding a second one; the Editor focuses the Editor Window used last.

**Command**:
A terminal app the New Window Menu offers: a name, a shell command (empty = the login shell), a lucide icon, an optional Alt hotkey, a Scope and optional signal sounds. Still `Agent` in code, in `state.json` as `agents` (one ordered list, which is the menu's order), seeded with claude, pi and shell. A command of several lines is a script: its window opens a login shell and types the lines in one after another, once (`typed` on the tab), so a `cd` or `export` carries on and the window ends in whatever the last line runs. Its sounds replace the project's for that signal (a built-in or off); unset follows the project. A terminal Window (`TabKind` `"term"`) remembers its Command and the command it was launched with, so editing a Command changes only new Windows and deleting one leaves its Windows running. "Send to agent" targets terminals with a command, never a plain shell.
_Avoid_: Agent (in the UI), Terminal kind, profile (a Browser Profile), preset, palette command (a Command Palette entry).

**Scope**:
Which projects offer a Command: everywhere (unset), every project on one Environment (`{ env: host }`), or one project and its Worktrees (`{ project: id }`). A narrower Command of the same name replaces the wider one where both are offered (devbox's `claude` replaces the global one in devbox's projects); names are unique within a scope. Two Commands some project's menu offers together can't share a hotkey; the first in the list keeps it (`scope.ts`).
_Avoid_: Visibility, filter.

**Web App**:
A Command with a URL instead of a command: it opens a browser window at that address, and the window takes its name and icon as a terminal takes its Command's. Same list, menu row, Scope and hotkeys as the other Commands; typing an address in the Commands Window's Command cell makes one. "app" hides the window's address and favourites bars (⋯ in its title bar shows them). The Commands Window offers the project's Favourites as Web Apps to add. Chosen from design/webapps.html (variant A).
_Avoid_: Bookmark, site, browser profile (a Web App can use a Browser Profile, but isn't one).

**Commands Window**:
A canvas Window, one per project, that edits the Command list as a table: icon, name, command or URL (a script folds to its first line until focused), Scope, sounds, hotkey; rows save as you type. Drag a grip (or ↑ / ↓ on a focused grip) to reorder, the copy button or `Ctrl+D` to duplicate. Commands the project isn't offered stay listed, dimmed. Formerly the Agents Window; still `TabKind` `"agents"`, addressed with `Alt+;`. Chosen from design/commands.html (variant A), after design/agents.html (variant B).
_Avoid_: Settings page, preferences.

**Git Window**:
A canvas Window, one per project, that takes the current branch from changes to a merged PR: stage, commit, push, open a PR, merge. New `TabKind` `"git"`, addressed with `Alt+C`. Runs git and gh on the project's host. Chosen from design/git.html (variant B); its diff reads Unified or Split and drills into the Editor Window (design/diff.html, variant A).
_Avoid_: Source control panel, VCS view.

**Folder of Repos**:
A Project whose folder is not itself a repo but holds nested repos (`folder_repos`, outermost only). One Git Window shows them in an accordion with an active repo; the active repo owns the commit box, commits, PR and push, while the editor finds a file's repo by the longest path prefix. The status line shows one repo as before, several as `n repos · n changed`. Not called a workspace, which is one of the four window spaces.

**Draft** (✦):
Text that a Draft Command writes for the user to edit before it is used: a commit message, a PR title and body, or a Review. Shown tinted until edited; never committed, pushed or posted unseen.

**Draft Command**:
The shell command that writes a Draft, one per kind (commit message, pull request, review), set in Settings › Git and `claude -p` until changed. It gets the prompt on stdin and its stdout is the Draft; it runs in the project folder on the project's host, through the login shell, as an agent's command does.
_Avoid_: Agent (a terminal Command), model, draft agent.

**Context Chip**:
One input a Draft is given, shown under "✦ reads" and switched off with a click: the diff, the linked In Progress issue, the recent commit subjects, CONTEXT.md.

**Review**:
A Draft over the whole branch diff before merging: findings as `fix`, `note` or `ok`, each with a location. "Send to claude" types a finding into the project's agent window, not submitted.

**Page**:
One page of a browser window, with its own native webview so it keeps its state while hidden. Stored on the browser Tab as `pages` and the shown `page`. With two or more, the window's title bar shows them as tabs. A page's Ctrl+click or middle-click opens a background Page after it; `target=_blank` and `window.open` open one and show it; a sized `window.open` (a sign-in popup) is a real OS window instead, so `window.opener` works. A terminal's Ctrl+click adds a Page to the project's last-used browser window.
_Avoid_: Browser tab (a Tab is a canvas window), sub-tab.

**Browser Profile**:
Whose cookies, sign-ins, saved passwords, autofill and history a browser window uses: a name, a lucide avatar and a colour over a webview data folder of its own (`<app_local_data_dir>/profiles/<id>`; on macOS a WKWebView data store). Global, in `state.json` as `profiles`, seeded with Personal (`default`), which keeps the data from before profiles and can't be deleted. A project picks one (`Project.profile`, a Worktree uses its repo's; unset is Settings' default), a window can use another (`Tab.profile`), and a Web App can pin one. Switching a window's profile reopens all its Pages in the new one. The avatar in the nav bar switches it; Settings › Browser names, colours and deletes them, with Save passwords and Autofill forms per profile. WebView2 saves and fills passwords itself; on macOS, whose web view can't, tri-code does (`passwords.rs`): a script in its own WebKit content world reports sign-ins, a bar under the address offers Save, and logins go to the Keychain, one item per profile. Profiles need macOS 14 (the first with separate web view data stores); before that, and on Linux, every window uses the default. Once there are two, browser windows show a band in their profile's colour. Chosen from design/browser-profiles.html (variant B).
_Avoid_: Account, session, container, identity.

**Select element**:
Pointing an agent at part of a Page: an overlay that `src-tauri/src/pick.js` draws inside the page (tri-code's own HTML cannot paint over a native webview). The picked elements and areas, with the user's comment, become text pasted into an agent window with Send or Enter (Shift+Enter is a new line). It is never submitted: the user edits it in the agent and sends it from there. Copy puts the same text on the clipboard instead. Its keys are drawn as tri-code's Keycap, in the colours tri-code passes in, since the page can't use the app's stylesheet. The composer's "→" menu lists the project's agent windows (with their Agent Signal, last message and workspace), the one "send to agent" uses chosen, then New claude and New pi, which start one in the project and paste once it answers the signal probe. With no agent open, new claude is chosen. Text only for now: no screenshot. Chosen from design/select-element-target.html (variant A).
_Agent window_: a terminal that answered the signal probe or reported, has a conversation to resume, or runs claude or pi (`isAgentWindow`). Plain shells and Commands like a dev server or lazygit are not; "send to agent" never types into them. It prefers the focused agent window, then the one last focused or chosen in the project.
_Avoid_: Inspector, element picker (in UI text).

**Download**:
A file a Page saves, always to the user's Downloads folder under a free name (`report (1).pdf`). `src-tauri/src/downloads.rs` reports each one as a `browser-download` event; the browser window lists this run's downloads under a button in its nav row, and the newest shows in a strip under the nav that pushes the page down (HTML can't paint over the webview). On Windows it hooks WebView2 for progress and Cancel, which also hides WebView2's own flyout; on macOS only the start and the end are known.
_Avoid_: Transfer.

**Agent Signal**:
What an agent says it is doing: `working`, `blocked` (needs you), `done` or `error`, reported over OSC 7501 (the Program Status Protocol) and kept on the tab's live state. tri-code answers the probe claude and pi send at startup; they report nothing until it does. A `done` or `error` stays until its window has been on screen in a focused app; `blocked` stays until the agent reports something else. The loudest signal (blocked, then error, then done, then working) marks the project's icon and the workspace number; a project or workspace whose agents are only working shows a spinning ring there. The tab and title bar also show `working`. Their colours are set in Settings › Signals: working is blue, the rest follow the theme. A terminal bell from any other app counts as `blocked`.
_Avoid_: Notification (that is the desktop popup), attention, status (a tab's status is its connection).

**Alert**:
What a signal does beyond its badges: the project's sound for it and a desktop notification. When to alert is "away" (only while you aren't looking at that window), "always" or "badge only". App-wide settings sit behind the bell in the status line (`app.notify`); a project overrides any of them in Appearance › Signals (`project.notify`), and Do not disturb makes every project badge only.
_Avoid_: Notification settings, ping.

**Remote Control**:
The agents on your phone. Turned on in Settings › Remote, it serves a phone page from tri-code itself (`phone.rs`, on `127.0.0.1:7520`) and puts it on the tailnet with `tailscale serve` at `https://<machine>.<tailnet>.ts.net:7443`, never on the LAN. Web Push needs HTTPS, hence Tailscale. The phone lists each project's agent windows (plain shells left out, locked Environments hidden) with their Agent Signals, and shows one agent's live terminal with quick keys and a line to type into. While a phone watches a terminal, its PTY takes the phone's size; the desktop window gets its size back when the last phone stops watching. Stays on across restarts until turned off. Chosen from design/remote-control.html (connection A, desktop B, phone list A).
_Avoid_: Remote (that is an ssh Environment), mobile app, web UI.

**Paired Phone**:
A browser that paired with a six-character code from Settings › Remote (QR code or typed, valid ten minutes) and holds a device token; tri-code keeps only the token's hash, in `phone.json` beside its VAPID key. On an iPhone the Home Screen app pairs on first launch, since it doesn't share storage with Safari. Forget revokes it and closes its socket.

**Phone Push**:
A Web Push of an Alert to every Paired Phone that allowed notifications, sent straight to the phone's push service (Apple's, Google's), encrypted for it and signed with the VAPID key. It goes out whenever the desktop alerts, so it follows the project's Alert setting and Do not disturb, and covers needs input, done and errors unless Settings › Remote unticks some. A tap opens that agent's terminal.
_Avoid_: Notification (that is the desktop popup).

**Feedback**:
A bug report or idea for tri-code itself, written in the popover behind the status line's speech bubble (or "Report a bug or suggest a feature" in the Command Palette). It becomes an issue on tri-code's GitHub repo, filed with the local `gh` login and labelled `bug` or `enhancement` when GitHub allows; without gh, GitHub's new-issue form opens prefilled. The version and OS go with it unless clicked off. Chosen from design/support-widget.html (variant A).
_Avoid_: Support ticket, bug reporter.

**Worktree**:
Another checkout of a project's repo on its own branch, made with `git worktree add` in a folder next to the repo (`<repo>.worktrees/<branch>`) on the project's host. In tri-code it is a Project with a `parent` (the repo's project), a `branch` and maybe an `issue` Slug-ID: it has its own windows, workspaces, accent and Agent Signals, and takes its repo's icon, background, Alert settings and Dev Directory. The sidebar lists every checkout under the repo's row, the repo's own folder first; the collapsed rail stacks a small tile per checkout under the project tile (an issue number, or the branch's first letters). `Alt+Shift+W` makes one. A new branch starts with the repo's **branch prefix** (`waldo/`), the start of the dialog's name field, saved on the repo's project (`branchPrefix`) when you press Create; an existing branch is checked out as it is, and Start next feature uses the prefix too. The folder and the sidebar label leave the prefix out (`waldo/fix-sync` lives in `<repo>.worktrees/fix-sync` and reads `fix-sync`); the tooltip shows the whole branch. Chosen from design/worktree-prefix.html (variant A). The dialog's **Setup** is a script run once in the new checkout, in a window of its own (kept per repo as `setup` on the repo's project, so the next one starts with it), and **and open** picks the Commands to open beside it; they all start together. `{repo}`, `{worktree}` and `{branch}` in it become the project's folder, the new checkout's and the branch. Its lines run as one command that stops at the first failure: the window closes when it succeeds (`Tab.once`), and a failure leaves a shell in the new checkout. On Windows it runs in PowerShell, so `cp`, `mv` and `rm` work as on a Mac (setup.ts). Chosen from design/worktrees.html (variant A, "stack" rail); setup from design/worktree-commands.html (variant D).
A Worktree or a project can be **Pinned**: it then also shows in the Pinned list at the top of the sidebar, above every Environment, a Worktree with its repo's name (and Environment, when remote) after its label, a project with its icon and its branch; a pinned Worktree's row in the repo's list keeps a pin. Pinning is from a Worktree row's pin button, the right-click menu of any project or Worktree row, or the Command Palette; removing or finishing it drops the pin. Stored as `pinned` (project ids, in pin order) in `state.json`. A pinned one on a locked Environment stays in the list, dimmed, and opens the PIN pad. The project right-click menu also has New worktree, Appearance and Open folder location (Reveal in Finder on a Mac; local projects only), so the collapsed rail can reach them; a Worktree's has Open folder location too. Chosen from design/worktree-pins.html (variant A).
An agent can ask for one with `create_worktree` (mcp/README.md): tri-code makes it in a git repo with the repo's saved setup and moves the agent's window there. Claude keeps running and changes folder itself; pi is restarted there when its turn ends, on a fork of its conversation. The view follows only if that project was on screen.
_Avoid_: Branch (a Worktree is on one, but switching branch is not what it does), sub-project, workspace (that is the Alt+1–4 canvas).

**Folder Copy**:
A Worktree of a folder that isn't a git repo (several repos side by side, or no git at all): the folder copied to the same `<folder>.worktrees/<branch>`, so it looks and works like any other Worktree. Each repo nested in the folder is left out of the copy and added back as a git worktree on the branch; `node_modules`, `target`, `.venv` and other build folders are skipped. A snapshot of the other files is kept beside it (`.<branch>.copy.json`). **Finish** (its ×) copies what changed outside git back to the folder, asks which side wins for a file changed in both, removes the nested worktrees (keeping a branch that isn't merged) and deletes the copy. In the sidebar the folder's own row reads `base`. Stored as `copy: { repos }` on the Worktree. The Worktree's **label** (sidebar row, tile, tooltip, Finish) is its `title` when the user set one (a name you gave it, shown with ◆), else the branch its nested repos are on (the most of them; `≠` when they differ), else the folder's name when it has no repos. Start next feature branches every clean nested repo from `origin/<default>`. Chosen from design/folder-worktrees.html; see ADR 0003.
_Avoid_: Clone, snapshot, sandbox.

**Leftover**:
Something tri-code started that outlived its window and still holds a place: a **ghost terminal** (a terminal-host session no tab has), a **stray process** (a program in a project's folder whose parent is gone, like a dev server an agent backgrounded), a **remote session** (a `tri-*` shpool or tmux session on an ssh host no tab has), a **leftover checkout** (a folder in `<repo>.worktrees/` git no longer lists, what a removal that couldn't finish leaves) or a **prunable entry** (a worktree git lists whose folder is gone, holding its branch). A row it holds shows a count (click for the list); a leftover checkout is a dashed row under its repo with a ×; the status line shows `N left behind` while there are any, for every project and host. Read when the app gains focus and after a window closes, at most every 30s (`leftovers.ts`, `leftovers.rs`). Remove worktree reads its folder fresh, lists what will end with it, ends it, and names a program that isn't tri-code's (an editor) without ending it; if the folder still can't be deleted, it names what has it open and offers to end that and try again. Only what tri-code started, or what sits in a project's folder with its parent gone, is ever listed. Remote stray processes are not looked for yet. Chosen from design/orphans.html (variant B).
_Avoid_: Orphan, zombie (in UI text).

**Favourite**:
A page a project keeps for its browser windows: a URL and a name, in `state.json` under the project (`favs`). The star in a browser's address field (or `Ctrl+D`) adds one; they show on the bar under the address and as tiles on a blank browser window. Per project, not global, since each project has its own dev server and tracker.
_Avoid_: Bookmark.

**Database Window**:
A canvas Window, one per Connection, for browsing, querying and editing a project's database: a schema tree and Data, Query and Structure views. New `TabKind` `"db"`. Plain HTML; `Alt+Shift+D` addresses the most recent. Postgres, SQLite (local projects only) and MongoDB. See ADR 0004. It also opens a Spreadsheet File.
_Avoid_: DB client, db viewer, studio.

**Spreadsheet File**:
A CSV or TSV file, or an Excel / OpenDocument workbook (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods`), shown as tables. In the Editor Window a CSV opens in **Table** mode beside Source and Diff: the grid is a view of the text buffer (`csv.ts`), so a cell edit replaces just that field and saving, Diff, undo and the modified dot work as for any edit. A workbook opens as read-only sheets with a tab per sheet. **Open in Database ↗** opens a Database Window on the file (`db` is `sheet:<path>`, never saved to `databases.json`): Rust reads it on the project's host, so ssh projects work, and loads it into an in-memory SQLite, one table per CSV or sheet, with column types guessed from the cells (`db/sheet.rs`). There a CSV's Apply writes the file back with its own delimiter, line endings and BOM, untouched rows byte for byte, after checking its Stamp; Query runs on the copy and saves nothing. Workbooks stay read-only: writing one back would lose its formatting and formulas. Files up to 50 MB. Chosen from design/csv-xlsx.html (variant C).
_Avoid_: Spreadsheet connection, data file, import (nothing is imported: the file stays the source).

**Connection**:
A saved database target of a project, in `.dev/databases.json` (written only by tri-code): a name, a kind (`postgres`, `sqlite`, `mongo`), a target (a `.env` variable, or a URL whose password lives in `~/.tri-code/secrets/databases.json` on the host), `via` (`direct`, or `host` for an ssh tunnel), `readOnly` and an optional `prod` tag. Opening one makes a Session.
_Avoid_: Datasource, database (the Connection points at one).

**Docker Window**:
A canvas Window, one per project, for what is running on the project's host: containers and their ports over one log pane. Picking a stack follows its compose logs (chips show or hide each service), picking a container follows its own. New `TabKind` `"docker"`, addressed with `Alt+Y`. Runs the `docker` CLI on the project's host, so an ssh Environment works the same way; `docker events` keeps the list live. Each container and stack can be started and stopped; stopping one that isn't the project's asks first. Running containers list first and stopped ones last, within a stack and across stacks, after the project's own. A search over the list matches name, stack, image, state or port, and only narrows the rows: the selection and its logs stay. Chosen from design/docker.html (variant A).
_Avoid_: Docker dashboard, container view.

**Monitor Window**:
A canvas Window, one per project, showing what the project's host is doing, in the manner of btop: CPU (total history and each core), memory and swap, network, and disks, over a live list of every process. New `TabKind` `"monitor"`, addressed with `Alt+M`. This machine is read through sysinfo. An ssh Environment is read from `/proc` (so it must be Linux) over one ssh connection that prints a sample each interval (1, 2 or 5 s; pausable). The list is a tree or flat, sorts by any column, and "This project" narrows it to processes in the project's folder (the same test Leftovers uses) plus what they started. Ending a process asks once in a strip under the list, then ends it with everything it started. That is TERM, then KILL for what's left (`taskkill /T /F` on Windows), and only if the pid still belongs to the same process. tri-code itself, its terminal host, the ssh feeding the window and init or the OS's own processes aren't offered. Chosen from design/monitor.html (variant A).
_Avoid_: Task manager, system monitor, top (in UI text).

**Stack**:
The containers of one compose project (its `com.docker.compose.project` label). A stack is the project's when its `com.docker.compose.project.working_dir` is the project's folder or under it, so each Worktree has its own; "All on host" adds every other stack and the containers compose didn't start. Unticking Show stopped hides clean exits (0 or 143: a finished migration, `docker compose stop`); any other exit always shows.
_Avoid_: Compose group, service group.

**Port Chip**:
A container's port in the Docker Window. A published port opens a Page, or copies its address when the container's port is known not to speak HTTP (Postgres, Redis and the like). On an ssh Environment the first click opens an `ssh -L` tunnel, which lasts until the window closes. A dashed chip is exposed only inside the Docker network and does nothing.

**Remote Tunnel**:
How a browser window in a project on an ssh Environment reaches that host: there `localhost:5173` (or `127.0.0.1`, `0.0.0.0`) is the remote's port, and a `file:///…` address the remote's file (`file:///~/…` under its home). Each opens a Forward (`forward.rs`): an `ssh -L` tunnel to the port, on the same port here when it is free so the origin stays `localhost:5173` (cookies, hot reload, sign-in redirects), else on a free one; or, for a file, `python3 -m http.server` started on the remote in the project's folder (the file's own folder when it is outside the project) and tunnelled the same way. One Forward per host and target, shared by every page using it. The page keeps the remote address, so the address bar, Favourites and a restart see that; the webview loads the local one (`tunnelmap.ts`). A chip at the start of the address field names the Environment and opens a popover (ports, state, Copy local address, Reconnect). While a Forward opens for the first time, or after it failed ("nothing is listening"), the window shows that in place of the page and retries every few seconds; a dropped one reconnects on its old port with a bar over the page, then reloads it. A Forward no page uses closes 30 s later. `Alt+Enter` in the address field opens an address on this machine instead (`here` on the Page, chip "this machine"). A new tab lists what of the user's listens on the remote (`ss`, or `lsof` on macOS) and the project's HTML files; a remote terminal's Ctrl+click, the Editor's Open ↗ on an HTML file and Open in system browser go through the same tunnels. Chosen from design/remote-tunnels.html.
_Avoid_: Port forward (in UI text), proxy.

**Pending Edit**:
A cell change, new row or deleted row in a Database Window that is staged and highlighted but not written. Apply shows the statements and runs them all in one transaction; a row is found by its primary key, `rowid` or `_id`, and an edit fails if the cell changed underneath.
_Avoid_: Draft, unsaved change.
