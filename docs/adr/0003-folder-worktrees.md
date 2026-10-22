# 0003. A folder that isn't a repo gets worktrees by copying

Date: 2026-10-21

## Status

Accepted.

## Context

Worktrees (`git worktree add` into `<repo>.worktrees/<branch>`) let several agents work on one project at once, but only when the project's folder is a git repo. A folder of several repos side by side (often with a VS Code `.code-workspace` in it) or a folder with no git at all had nothing. We first tried opening a `.code-workspace` as a group of projects, one per folder it lists (design/code-workspaces.html), and dropped it: it splits one piece of work across several projects. The second prototype (design/folder-worktrees.html) kept the folder as one plain project and made New worktree work for any folder.

## Decision

1. **A folder opens as one plain project.** Open Project lists `.code-workspace` files beside the folders; picking one opens the folder it is in. Nothing in the file is read.

2. **New worktree on a folder that isn't a repo copies it** to the same `<folder>.worktrees/<branch>`, so the sidebar shows standard repos, monorepos and plain folders the same way. Whether the folder is a repo is what `git worktree list` says.

3. **Repos nested in the folder become git worktrees, not copies.** The copy leaves them out and runs `git worktree add -b <branch>` in each, from what it has checked out. Their commits are then on branches the original repos already have, so they can be pushed and merged as usual, and nothing is lost when the copy is deleted. Copying them whole (with `.git`) would keep commits only in the copy.

4. **Rebuildable folders are skipped**: `node_modules`, `target`, `.venv`, `venv`, `__pycache__`, `.next`, `.turbo`, `.gradle`. You install again in the copy.

5. **Finishing copies back what git can't carry.** When the copy is made, a hash of every other file goes in `<folder>.worktrees/.<branch>.copy.json`. Finish compares the copy and the folder with it: a file changed only in the copy is copied back, one deleted only in the copy is deleted, and one changed on both sides is a conflict, where you pick which version wins (there is no git to merge them). Then the nested worktrees are removed (`--force`, after warning about uncommitted changes), their branch is deleted where git says it is merged, and the copy and its snapshot are deleted.

6. **The copying runs on the project's host**: `std::fs` locally, one `sh` script over ssh (`tar` to copy, `cksum` to hash) remotely, in `src-tauri/src/folders.rs`.

## Consequences

- A Worktree gains `copy: { repos }`. `removeWorktree` finishes a copy instead of removing a git worktree; the sidebar's × and the palette say "Finish".
- A copy's git window shows nothing at its top level, which isn't a repo. Each nested repo is reached through a terminal for now.
- Files a nested repo ignores (`.env`, local config) are not in its worktree, the same as for any git worktree.
- A folder that sits inside a bigger repo counts as a repo, as it did before.
