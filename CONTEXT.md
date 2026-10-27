# tri-code

A minimal agent development environment. The left sidebar lists projects grouped by host (`local` or an ssh destination); the rest of the window is a tiled canvas of Windows. See the README for the layout.

## Shared `.dev/` contract

tri-code is the third client of a project's **Dev Directory** (`.dev/`). The other two are pi-todos (a pi extension) and dev-hub (a Claude Code mod). pi-todos' `CONTEXT.md` is the source of the domain language; these terms are the ones tri-code uses for the same files.

**Dev Directory** (`.dev/`):
The per-project, gitignored folder shared by the three clients: `config.json`, `issues.json`, `plane-states.json`, `plane-labels.json`, `time-entries.json`, `sentry/<id>.json`, and `plane/comments/<issue>.json`; tri-code adds `local-issues.json`, `github-labels.json` and `github/comments/<n>.json`. Read and written on the project's host.
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

**Slug-ID**:
`<Project Identifier>-<sequence_id>` for a Plane Issue (e.g. `TRI-12`); `#<number>` for a GitHub Issue; `<prefix>-<number>` for a Local Issue, or the bare number when the project's Local prefix is empty; `S-<sentry_id>` for a Sentry Issue. What the user copies and sends to an agent; selection and Time Entries use the issue key (`gh231`, `lo3`, the Plane UUID).

**State Pill**:
A State rendered with its State Hex as the fill (a GitHub or Local Issue's States have fixed colours) and black or white text by relative luminance. The fill does not follow the theme. In the panel it is also the control that opens the State Dropdown.

**State Dropdown**:
The popup anchored under a State Pill that lists every State of the issue's Source grouped by State Group. `d` opens it; arrows move, Enter confirms and PATCHes Plane, runs `gh`, or rewrites `local-issues.json`.
_Avoid_: State picker, status menu.

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
An ssh Environment can also carry a key file, port and `-o` options (`envSsh`, applied to every ssh call to that host; New environment takes a pasted `ssh -i key user@host` command) and a **PIN Lock** (`envLocks`).

**PIN Lock**:
A 4–8 digit PIN on an Environment. Locked, its projects show the PIN pad instead of the canvas, its terminals don't start, and Rust refuses ssh to it. An unlock lasts the chosen minutes; a restart locks again. A gate in tri-code, not encryption of the key.
_Avoid_: Password, vault.
_Avoid_: Host group, machine, server.

**Open Project Dialog**:
The `Alt+O` dialog: Environments on the left (with "New environment"), a Folder Picker on the right. Opening a folder that is already a project focuses it.
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
A canvas Window (`TabKind` `"editor"`, `Alt+E`) with the project's file tree, a tab per open file, a CodeMirror 6 editor and a status bar; Markdown, HTML and SVG also show rendered, media files play. Replaced the Files and File Windows; chosen from design/editor.html (variant B). A file opens in the Editor Window it was picked from, else the one used last; `Ctrl`+click opens a second one beside. A changed file also has a **Diff** mode beside Source, comparing `HEAD` with the live buffer (unsaved edits and all), unified or side by side; chosen from design/diff.html (variant A). Source marks the same changes with bars in the gutter. No extension host: language smarts are to come from language servers run on the project's host.
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

**File Index**:
A project's files for Go to File, as relative paths: `git ls-files --cached --others --exclude-standard` on the project's host plus the ignored files, walking into wholly ignored folders but not the skipped ones (Settings › Files; by default dependency and build folders like `node_modules`, `.venv`, `target`), or a walk that skips the same folders when the folder is not a repo. Fetched each time the box opens; the last one shows meanwhile.

**Folder Picker**:
The path field that is also the folder list: typing filters, `Enter` goes in or opens, `Backspace` on empty goes up, a `~` or `/` path jumps.

**Project Icon**:
What the sidebar draws for a project: a logo file from the project, an uploaded image, a lucide icon or the first letter. **Auto** is tri-code's pick (the first logo found, else the letter); any other choice in the Appearance panel is an override until "reset to auto".

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
Pointing an agent at part of a Page: an overlay that `src-tauri/src/pick.js` draws inside the page (tri-code's own HTML cannot paint over a native webview). The picked elements and areas, with the user's comment, become text pasted into the project's agent window (the one "send to agent" uses); Ctrl+Enter also submits it. Text only for now: no screenshot.
_Avoid_: Inspector, element picker (in UI text).

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
Another checkout of a project's repo on its own branch, made with `git worktree add` in a folder next to the repo (`<repo>.worktrees/<branch>`) on the project's host. In tri-code it is a Project with a `parent` (the repo's project), a `branch` and maybe an `issue` Slug-ID: it has its own windows, workspaces, accent and Agent Signals, and takes its repo's icon, background, Alert settings and Dev Directory. The sidebar lists every checkout under the repo's row, the repo's own folder first; the collapsed rail stacks a small tile per checkout under the project tile (an issue number, or the branch's first letters). `Alt+Shift+W` makes one. Chosen from design/worktrees.html (variant A, "stack" rail).
_Avoid_: Branch (a Worktree is on one, but switching branch is not what it does), sub-project, workspace (that is the Alt+1–4 canvas).

**Folder Copy**:
A Worktree of a folder that isn't a git repo (several repos side by side, or no git at all): the folder copied to the same `<folder>.worktrees/<branch>`, so it looks and works like any other Worktree. Each repo nested in the folder is left out of the copy and added back as a git worktree on the branch; `node_modules`, `target`, `.venv` and other build folders are skipped. A snapshot of the other files is kept beside it (`.<branch>.copy.json`). **Finish** (its ×) copies what changed outside git back to the folder, asks which side wins for a file changed in both, removes the nested worktrees (keeping a branch that isn't merged) and deletes the copy. In the sidebar the folder's own row reads `base`. Stored as `copy: { repos }` on the Worktree. The Worktree's **label** (sidebar row, tile, tooltip, Finish) is its `title` when the user set one (a pinned name, shown with ◆), else the branch its nested repos are on (the most of them; `≠` when they differ), else the folder's name when it has no repos. Start next feature branches every clean nested repo from `origin/<default>`. Chosen from design/folder-worktrees.html; see ADR 0003.
_Avoid_: Clone, snapshot, sandbox.

**Favourite**:
A page a project keeps for its browser windows: a URL and a name, in `state.json` under the project (`favs`). The star in a browser's address field (or `Ctrl+D`) adds one; they show on the bar under the address and as tiles on a blank browser window. Per project, not global, since each project has its own dev server and tracker.
_Avoid_: Bookmark.
