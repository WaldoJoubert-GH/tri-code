// Dropping a project: a store operation that reaches into each window kind's own bookkeeping.
// Not in state.ts, which every one of those files imports; not in Sidebar.tsx, so worktrees.ts and
// Tour.tsx can drop a project without importing the UI.

import { invoke } from "@tauri-apps/api/core";
import { type Project, isTerminal, removeProject } from "./shared/state/state";
import { closeBrowser } from "./browsers";
import { closeSession } from "./terms";
import { forgetBgImage } from "./Appearance";
import { forgetIcon } from "./shared/ui/icons";
import { forgetProject } from "./issues";
import { forgetSounds } from "./signals";

/** End a project's windows and drop everything stored for it. */
export function dropProject(p: Project) {
  for (const t of p.tabs) {
    if (t.kind === "browser") closeBrowser(t);
    else if (isTerminal(t)) closeSession(t.id);
  }
  invoke("bg_delete", { projectId: p.id }).catch((e) => console.error("bg_delete failed:", e));
  forgetBgImage(p.id);
  forgetIcon(p.id);
  forgetProject(p.id);
  forgetSounds(p.id);
  removeProject(p.id);
}
