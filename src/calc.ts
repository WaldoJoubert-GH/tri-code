// Opening the Calculator Window. The window is CalcPanel.tsx, the Tape's maths calcdata.ts and its
// highlighting and answers calclang.ts.

import { type Project, addTab, focusTab } from "./state";

/** Open or focus the project's Calculator Window. */
export function openCalcPanel(project: Project): string {
  const existing = project.tabs.find((t) => t.kind === "calc");
  const id = existing?.id ?? addTab(project.id, "calc");
  focusTab(project.id, id);
  return id;
}
