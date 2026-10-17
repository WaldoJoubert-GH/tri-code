# tri-code

A minimal agent development environment. The left sidebar lists projects grouped by host (`local` or an ssh destination); the rest of the window is a tiled canvas of Windows. See the README for the layout.

## Shared `.dev/` contract

tri-code is the third client of a project's **Dev Directory** (`.dev/`). The other two are pi-todos (a pi extension) and dev-hub (a Claude Code mod). pi-todos' `CONTEXT.md` is the source of the domain language; these terms are the ones tri-code uses for the same files.

**Dev Directory** (`.dev/`):
The per-project, gitignored folder shared by the three clients: `config.json`, `issues.json`, `plane-states.json`, `plane-labels.json`, `time-entries.json`, `sentry/<id>.json`, and `plane/comments/<issue>.json`. Read and written on the project's host.
_Avoid_: Data dir, cache dir.

**Dev Client**:
A tool that reads and writes a project's Dev Directory. tri-code is one, alongside pi-todos and dev-hub. Clients must not keep their own copy of the shared data.

**Issues File** (`issues.json`):
The unified list of Plane Issues and pulled Sentry Issues, with a `source` discriminator. A Plane sync rewrites only the Plane half and preserves the Sentry entries, the same way pi-todos' `replacePlaneIssues` does.

**Issues Panel**:
A canvas Window, one per project, that renders the project's Dev Directory as a list and a full-width drill-down. New `TabKind` `"issues"`. Plain HTML, not a terminal, so plain keys drive it while it is focused. Addressed with `Alt+I`.

**Slug-ID**:
`<Project Identifier>-<sequence_id>` for a Plane Issue (e.g. `TRI-12`); `S-<sentry_id>` for a Sentry Issue. The stable key for selection, copy and the "send to agent" text.

**State Pill**:
A Plane State rendered with its State Hex as the fill and black or white text by relative luminance. The fill does not follow the theme. In the panel it is also the control that opens the State Dropdown.

**State Dropdown**:
The popup anchored under a State Pill that lists every workspace State grouped by State Group. `d` opens it; arrows move, Enter confirms and PATCHes Plane.
_Avoid_: State picker, status menu.

**Label**:
A workspace-scoped Plane label: an id, a name and a colour. Cached in `plane-labels.json`, carried on an Issue as label ids. `l` opens a multi-select dropdown; each toggle PATCHes Plane and keeps the dropdown open.

**Comment**:
A Plane work item comment: an author, a timestamp, `comment_html` and its images. Cached in `plane/comments/<issue>.json`. Images are uploaded as Plane assets and referenced from the `comment_html`; reading them needs the token, so they are inlined as `data:` URLs for the panel.

**Running Entry**:
The single un-stopped Time Entry across the workspace. Shown on the row, in the In Progress chips and in the status line; persisted in `time-entries.json`.

**In Progress Chip**:
A toolbar chip for each Plane Issue whose State is named exactly `"In Progress"`, the running one first then by priority. Two chips show, then `+N`. A click drills into that issue in the Issues Panel.

**Environment**:
Where projects run: `local`, or an ssh destination (an alias from `~/.ssh/config` or `user@host`). Kept as an ordered list in `state.json`, so one can exist with no projects; the sidebar shows one section per Environment. A project's `host` is its Environment.
_Avoid_: Host group, machine, server.

**Open Project Dialog**:
The `Alt+O` dialog: Environments on the left (with "New environment"), a Folder Picker on the right. Opening a folder that is already a project focuses it.
_Avoid_: Add project form, folder browser.

**Go to File**:
The `Alt+T` box under the toolbar path (a click on the path opens it too). One field that searches the project's File Index by fuzzy match and, when it is empty or ends in `/`, lists that folder. Opens the pick in the project's `file` Window.
_Avoid_: Quick open, file palette, Ctrl+P.

**File Index**:
A project's files for Go to File, as relative paths: `git ls-files --cached --others --exclude-standard` on the project's host, or a walk that skips dependency folders when the folder is not a repo. Fetched each time the box opens; the last one shows meanwhile.

**Folder Picker**:
The path field that is also the folder list: typing filters, `Enter` goes in or opens, `Backspace` on empty goes up, a `~` or `/` path jumps.

**Project Icon**:
What the sidebar draws for a project: a logo file from the project, an uploaded image, a glyph or the first letter. **Auto** is tri-code's pick (the first logo found, else the letter); any other choice in the Appearance panel is an override until "reset to auto".

**Tab Strip**:
The leftmost toolbar group: the active workspace's Windows in tiling order, the focused one underlined, then `+`. A strip tab only focuses a Window that already exists, so nothing is created or moved by clicking one; Windows on other workspaces are not listed.
_Avoid_: Tab bar (there is no tab bar), window list, tab buttons.

**New Window Menu**:
The popup under the Tab Strip's `+`: one row per `TabKind`, each with the key that also opens it (`Alt+Enter`, `Alt+B`, `Alt+I`, `Alt+E`). Issues and Files open or focus their one-per-project Window rather than adding a second one.

**Git Window**:
A canvas Window, one per project, that takes the current branch from changes to a merged PR: stage, commit, push, open a PR, merge. New `TabKind` `"git"`, addressed with `Alt+C`. Runs git and gh on the project's host. Chosen from design/git.html (variant B).
_Avoid_: Source control panel, VCS view.

**Draft** (✦):
Text that `claude -p` writes for the user to edit before it is used: a commit message, a PR title and body, or a Review. Shown tinted until edited; never committed, pushed or posted unseen.

**Context Chip**:
One input a Draft is given, shown under "✦ reads" and switched off with a click: the diff, the linked In Progress issue, the recent commit subjects, CONTEXT.md.

**Review**:
A Draft over the whole branch diff before merging: findings as `fix`, `note` or `ok`, each with a location. "Send to claude" types a finding into the project's agent window, not submitted.

**Favourite**:
A page a project keeps for its browser windows: a URL and a name, in `state.json` under the project (`favs`). The star in a browser's address field (or `Ctrl+D`) adds one; they show on the bar under the address and as tiles on a blank browser window. Per project, not global, since each project has its own dev server and tracker.
_Avoid_: Bookmark.
