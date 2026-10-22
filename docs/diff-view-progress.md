# Diff views — progress and handoff

Status: **feature-complete for the first pass's follow-ups; unit and Rust tests pass, the UI was driven
end to end in headless Chromium with a mocked backend. Not yet run in a live Tauri window.** This
note is for whoever picks the work up next.

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

## Second pass (2026-10-22)

The ten follow-ups from the first pass, in order:

1. **Real app.** Not run in a live Tauri window (this box has no display). Instead the built
   frontend was driven in headless Chromium with a mocked `invoke`, diffs produced by real
   `git diff --no-index`: git window (unified, split, keys, rename, deleted file), drill into the
   editor, typing, `Alt+D`, and a three-repo folder. The backend's new paths are covered by
   `cargo test` against real temp repos (below). Still to do by hand: ssh hosts, `gh`, and focus
   handling in the real webview. See "Quick manual check".
2. **Change bars, done.** `cm.ts` has a `cm-changes` gutter (a `StateField` of markers, mapped
   through edits); `diff.ts` `changeMarks` turns hunks into add / mod / del lines. The editor
   recomputes them 200 ms after the last edit with a zero-context `makePatch(…, timeout 150 ms)`,
   so a huge rewrite gives up instead of blocking. A new file (nothing at HEAD) gets no bars.
3. **Per-file stats, done.** `STATUS_CMDS` also runs `diff --numstat -z` (index and worktree), so
   each `Change` carries `index` / `work` `[added, removed]` at no extra round trip; the rows show
   `+n −n`. Untracked and binary files show none.
4. **Folder status cost, done.** Locally the repos run side by side (6 threads at a time), each
   repo's commands still sequential. Remote stays one ssh `multi` batch. `folder_statuses` is a
   plain function so it can be tested.
5. **Folder edge cases.** Duplicate folder names show the repo's relative path (picker, header,
   commit box). The repo menu scrolls (max 60vh); the accordion already scrolled. A repo that
   disappears or has no HEAD reads as an error or empty log for that repo only. The editor's
   repo list (`repos.ts`) is invalidated when the git window sees the set of repos change.
   Not done: non-git files in a folder (Finish for a folder copy).
6. **HEAD cache, done.** `headText` caches per host + repo + file; `bumpRepoEpoch` clears it.
   Switching tabs or saving no longer runs `git show`; focusing the editor re-reads only the
   shown file, keeping the old HEAD on screen meanwhile (no flicker).
7. **Renames, done for staged renames.** `Change.orig` comes from porcelain v2; `git_diff` passes
   `-M -- orig new` so the git window shows a rename as one (and "Renamed from …, no content
   change" when it is pure). `git_head_text` falls back to `diff --cached -M --name-status
   --relative` and returns `from`; the editor strip reads `HEAD:old → buffer`. An *unstaged*
   rename is still a deletion plus an untracked file, as git sees it. Double-clicking a deleted
   file now says why nothing opens.
8. **Tests, done.** `bun run test` (`src/diff.test.ts`, 18 tests: parser, stats, alignment,
   fallback, word marks, CRLF/BOM, change marks). Test files are excluded from `tsc`, since there are
   no bun types. Rust: numstat, rename source, porcelain orig, and a two-repo
   `folder_statuses` test with a staged rename and line counts.
9. **Polish.** The hunk arrows are one bordered control; the editor's Diff button shows how many
   changed regions there are; the diff headers shed labels in a narrow pane (container queries)
   and the file name ellipsises instead of running under `+n −n`.
10. **Keys, done.** Keymap action `diff`, `Alt+D`: Source ⇄ Diff in the editor (the diff opens at
    the cursor line), or the selected file's editor diff from the git window. Inside a focused
    diff: `J`/`K` (or arrows) a line, `N`/`P` (or `]`/`[`) a hunk, `Enter` opens the line
    (`Shift+Enter` in the editor's diff), `U`/`S` orientation.

Found on the way: three global classes (`.add` in styles.css, `.split` in canvas.css, `.grow` in
files.css) were also matching diff elements. Split view's added-only rows rendered as flex
buttons, and `.dv-content.split` became `position: absolute` over the rows, which swallowed
double-clicks. The rows are `s-add` / `s-del`, side by side is `.sbs`, and the editor's spacer
is `.ediff-sp`.

## Still open

- A live run on Windows/macOS and over ssh (item 1).
- An unstaged rename (delete + untracked) is not paired.
- Folder copies' non-git files are not part of the git window.
- The git window's diff and the editor's diff are separate scrollers; a hunk position is not
  carried across a drill beyond the line.

## Quick manual check

1. `bun run tauri dev`.
2. Open a repo project, `Alt+C`, select a changed file: toggle Unified/Split, use the hunk arrows,
   double-click a line → the editor opens at that line; click `Diff` in the git header → the editor
   opens its HEAD → buffer diff.
3. In the editor, edit the file without saving; switch to Diff: the unsaved line is in the patch.
   Double-click a line in the diff → back to Source at that line.
4. In the editor's Source, the gutter shows green / amber bars and a red caret for changes since
   HEAD; `Alt+D` switches to Diff and back. In a diff, `N`, `J`, `Enter` land on the line.
5. Open a folder project containing two repos with changes: the git window shows the repo picker and
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

second pass:
src/cm.ts (change gutter), src/diff.test.ts, src/hotkeys.ts, src/keymap.ts (Alt+D), tsconfig.json
```
