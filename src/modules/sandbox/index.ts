// Docker Sandboxes' interface: which agents run in one, making and removing a Sandboxed Worktree's
// sandbox, the Docker Window's sandbox groups, and Settings › Sandbox.

export {
  adoptSandboxes, canSandbox, ensureSandbox, hostKey, isRunning, listBoxes, mountsFor, newSandboxName, onSandboxStep,
  readySandbox, refreshSbx, relativeGitdir, removeSandbox, runsInSandbox, sandboxByDefault, sandboxFolders, sandboxOf,
  sbxReady, sbxState, setSandboxHost, startSandbox, stopSandbox,
} from "./sandbox";
export { SandboxPage } from "./SandboxSettings";
