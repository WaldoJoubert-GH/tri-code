# Diff views — progress and handoff

Status: **feature works in the preview harness and compiles; not yet exercised in a running Tauri app
or covered by automated tests.** This note is for whoever picks the work up next.

Reference design: `design/diff.html` (gitignored, present in this worktree). Variant **A** was chosen:
`Source | Diff` in the editor's breadcrumb bar, plus the git window's unified/split diff and
line-level drill-down. The same prototype also covers a **folder of repos** (repo picker, accordion,
one active repo).

## What is in place

### Shared diff renderer

- `src/diff.ts`
  - `parseUnified` → hunks with both side numbers.
  - `diffStats`, `firstChange`.
  - `splitRows` with an order-preserving alignment that pairs a deletion run with the additions it
    resembles (shared tokens / common edges), so an extra comment does not shift every paired row.
    Large rewrites fall back to a deletion block beside an addition block.
  - `pairMarks` for the word/token tint in paired rows.
  - `makePatch` (jsdiff `createTwoFilesPatch`) for the editor's `HEAD → buffer` diff; normalises CRLF
    and BOM so a CRLF checkout does not look wholly changed.
  - `normalizeText` / `sameText`.
- `src/DiffView.tsx` + `src/diff.css`
  - Unified (stacked) and split (side by side) from one parse.
  - Fixed 4000-line cap; click selects a line, double-click drills.
  - Optional `focusLine` scrolls a drilled line into view; `ref` gives the parent the scroller for
    hunk navigation.
- Dependency: `diff@^9` (`package.json`, `bun.lock`).

### Git window (`src/GitPanel.tsx`, `src/git.css`)

- Diff header: path (dir ellipsised, basename kept), `+n −n`, hunk `⌃/⌄`, `Unified / Split`, `↗ Editor`
  and `Diff`.
- Orientation is persisted per project (`Project.diffMode`, `setProjectDiffMode`). Split falls back to
  unified under ~660px (ResizeObserver on the right pane).
- Double-click a diff line → `openFile(project, absPath, { at: { line, mode } })`; normal opens source,
  Shift+double-click opens the editor's diff. Deleted files are not drillable; double-click on a
  deleted file row is a no-op.
- Commit view uses the same renderer with the project orientation (no drill).
- Removed the old string-diff component and its CSS.

### Folder of repos

- `src-tauri/src/folders.rs`: `repos_in(host, path)` extracted from `folder_repos` (outermost,
  depth-limited) for reuse.
- `src-tauri/src/git.rs`
  - `folder_status(host, path)` → `RepoStatus { repo, status?, error? }` per nested repo. All repos run
    in one `multi` batch via `git -C <repo> …`, so a remote folder is one ssh round trip.
  - `git_status` refactored through `status_from`.
  - `git_is_repo` (one `rev-parse --is-inside-work-tree`) and `git_head_text` (HEAD blob via
    `git show HEAD:./<rel>`, with missing-HEAD/new-file detected and real errors returned).
- `src/repos.ts`: `projectRepos` (repo root vs nested list, cached), `repoOfFile` by longest prefix,
  `headText`, and `repoEpoch`/`bumpRepoEpoch` so the editor re-reads HEAD after a commit/merge.
- `src/git.ts`
  - `GitUi` gains `repos`, `repo` (active relative path), `repoError`, `msgs` (commit draft per repo).
  - `Sel` gains `repo`; `refresh` detects a root repo or falls back to `folder_status`; every diff,
    stage, commit, push, PR, merge and ✦ draft uses the active repo's cwd (`argsAt`).
  - Per-repo selection, message, PR state and commit detail; switching a file activates its repo.
  - Status line: `folderStatus` store; folder poll throttled to 30s.
- `src/GitPanel.tsx`
  - Header repo picker + menu for >1 repo; one-repo folders get a repo chip.
  - Repo accordion: active repo expands its staged/changes/commits; inactive repos show branch + a
    short changed-file peek.
  - Commit box names its target repo; `N repos` chip in the header; repo errors are per repo.
- `src/App.tsx`
  - Status line renders one repo as before, several as `n repos` + aggregated counts, with a popover
    listing each repo's branch and change count. Polling `peekStatus` sets `folderStatus`.

### Editor (`src/Editor.tsx`, `src/files.ts`, `src/state.ts`)

- `Source | Diff` in the breadcrumbs for files with changes (plus Preview for md/html/svg). The Diff
  mode compares **HEAD → the live buffer**, so unsaved edits are included.
- Diff strip: repo chip, `HEAD → buffer`, `+n −n`, hunk count, per-project `Unified / Split`.
- Read-only diff; double-click a line switches to Source at that line.
- `OpenHow.at` + `Tab.at { line, mode, seq }`; `openFile` sets it, the editor clears it after applying.
  A queued line waits for the doc to be in the view and then selects/centres it.
- HEAD is fetched per file after `repoOfFile`; hidden for binary/truncated/>1.5 MB files; a clean file
  loses the Diff button and an active Diff mode returns to Source. Focus and `repoEpoch` re-fetch HEAD.
- Files in a folder project resolve to their own repo; the Diff strip names it. Source mode does not
  yet draw change bars in the gutter (design mentions them; not implemented).

### Docs

`README.md` and `CONTEXT.md` describe the diff modes and the "folder of repos" term.

## Verification done

- `bun run typecheck` clean.
- `bun run build` clean.
- `cargo check` clean.
- Shared `DiffView` rendered in a temporary Vite page with a realistic patch (split alignment and
  intra-line tint verified).
- `GitPanel` rendered in a temporary Vite page with a mocked Tauri `invoke`, both as a single repo and
  as a 3-repo folder (repo accordion, picker menu, per-repo diff head verified).
- `Editor` rendered in a temporary Vite page with mocked `read_file` / `git_head_text`, opening in Diff
  mode via `Tab.at` (HEAD → buffer strip and split diff verified).
- Pure parser/alignment exercised through `bun` on a sample auth-refresh patch.

The temporary harnesses were deleted. `design/diff.html` is intentionally not committed
(`design/` is gitignored).

## Known gaps / next steps (in rough order)

1. **Run it in the real Tauri app** on a repo project and on a folder project. The mocked UI tests do
   not cover real IPC, ssh paths, `gh`, or the actual editor/CodeMirror focus dance.
2. **Add source-mode change bars** (thin gutter markers for added lines and a caret for a deletion
   before a line) using the parsed hunks, likely as a CodeMirror decoration extension.
3. **Per-file stats in the git lists** (the prototype shows `+n −n` per row). Today only the selected
   file's stats are in the diff header; fetching every file's diff just for stats is too much.
4. **Folders: status cost.** Local `folder_status` runs 4 git processes per repo sequentially on each
   status poll (30s). Consider a single shell script locally, or polling only the active repo plus a
   cheaper aggregate.
5. **Folder UX edge cases:** duplicate repo basenames (use the relative path in the picker label),
   many repos (cap the accordion or make it scroll), a repo that disappears mid-refresh, repos with
   no HEAD, and a folder whose non-git files change (those belong to Finish for a folder copy).
6. **Editor HEAD performance:** `git show HEAD:./file` per opened file, no cache. On a slow ssh host the
   Diff button can take a while to appear; consider lazy-loading HEAD on first Diff click or a small
   keyed cache invalidated by `repoEpoch`.
7. **Rename/deleted edge cases:** a renamed file has no HEAD path under its new name, so the editor diff
   is currently all-added; a deleted file is blocked from drilling. Decide whether to resolve the
   rename or show a note.
8. **Tests:** add unit tests for `parseUnified` / `splitRows` / `stats` (a Vitest or `bun test` setup is
   not present yet) and a Rust test for `folder_status` with two temp repos.
9. **Remaining design polish:** the hunk arrows are subtle; the repo-menu active row and the
   `RepoSection` highlight should be checked at real widths; the editor Source/Diff segment could show
   a change count.
10. **No keyboard bindings yet** for the diff (design proposed `d`/`j`/`k`/`n`/`p`); the editor should
    use `Alt+D`-style chords rather than plain keys so CodeMirror keeps them.

## Quick manual check

1. `bun run tauri dev`.
2. Open a repo project, `Alt+C`, select a changed file: toggle Unified/Split, use the hunk arrows,
   double-click a line → the editor opens at that line; click `Diff` in the git header → the editor
   opens its HEAD → buffer diff.
3. In the editor, edit the file without saving; switch to Diff: the unsaved line is in the patch.
   Double-click a line in the diff → back to Source at that line.
4. Open a folder project containing two repos with changes: the git window shows the repo picker and
   accordion; the commit box names the active repo; switching a file switches the repo; the status
   line shows `n repos` with the hover list.

## Files changed

```
package.json, bun.lock
src-tauri/src/folders.rs, src-tauri/src/git.rs, src-tauri/src/lib.rs
src/App.tsx, src/Editor.tsx, src/GitPanel.tsx, src/git.ts, src/files.ts, src/state.ts
src/DiffView.tsx, src/diff.ts, src/repos.ts
src/diff.css, src/files.css, src/git.css, src/styles.css
README.md, CONTEXT.md
```
