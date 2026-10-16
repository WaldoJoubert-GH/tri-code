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
