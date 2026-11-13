// Preview features: work that ships turned off, for whoever wants to try it. Settings › Preview
// lists them, each with its own switch, off until turned on (state.ts `settings.preview`).

import { app } from "./state";

export type PreviewId = "sandbox";

export const PREVIEWS: { id: PreviewId; name: string; icon: string; about: string }[] = [
  {
    id: "sandbox",
    name: "Sandboxed Worktrees",
    icon: "shield",
    about:
      "Run a worktree's claude in a Docker Sandbox: a small VM that sees only the worktree and its repo's .git, on this machine or an ssh host. Adds the Sandbox toggle to New worktree and the Sandbox page here. Off, worktrees that have a sandbox run claude on the host until it is on again.",
  },
];

/** Whether preview feature `id` is turned on. */
export const previewOn = (id: PreviewId) => app.settings.preview?.[id] === true;

/** Sandboxed Worktrees are on. Off, they are hidden everywhere and a Worktree that has a sandbox
 *  runs its agents on the host (sandbox.ts `sandboxOf`); its sandbox is kept for when it is on again. */
export const sandboxPreview = () => previewOn("sandbox");
