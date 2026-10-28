// Which agent signal a window shows right now, and which of them a restart would cut short.
// Kept free of UI imports so the rules can be tested on their own (restart.test.ts).

import { type AgentState, type Tab, app, live } from "./state";

/** What a window signals now. `working` only badges the tab strip, title bar and status line. */
export type Sig = AgentState;

/** Blocked until answered, done and error until seen, working while it runs. A bell in a plain shell counts as blocked. */
export function sigOf(t: Tab): Sig | null {
  const l = live[t.id];
  const a = l?.agent;
  if (a?.state === "blocked" || a?.state === "working") return a.state;
  if (a && !a.seen) return a.state;
  return l?.attention ? "blocked" : null;
}

/**
 * Every agent signal the restart would cut short: working, needs you, or failed.
 * A finished agent (done) is left out; nothing is running or waiting on it.
 */
export function busySignals(): Sig[] {
  return app.projects
    .flatMap((p) => p.tabs)
    .map(sigOf)
    .filter((s): s is Sig => s !== null && s !== "done");
}
