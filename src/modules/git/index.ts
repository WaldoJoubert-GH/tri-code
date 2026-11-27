// The Git window's interface: the panel, opening it, a folder's status for the sidebar, the status
// line and Worktrees, the Editor's file marks and repo lookups, and the status types Remote Control
// reads.

export { default as GitPanel } from "./GitPanel";
export {
  type Change, type FileMark, type GitStatus, type RepoStatus, branchStatus, fileMarks, folderStatus, gitOf, ignoredAt,
  isStaged, isUnstaged, markAt, openGitPanel, peekStatus, repoRoot, unpushed,
} from "./git";
export { type RepoRef, headText, repoEpoch, repoOfFile } from "./repos";
