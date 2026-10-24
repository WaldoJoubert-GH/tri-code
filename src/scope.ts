// Scope: which projects offer a Command (an Agent): every project, the projects on one Environment,
// or one project and its worktrees. The narrower command of the same name replaces the wider one
// where both are offered. Pure rules over the store, so bun test can run them (agents.test.ts).

import { type Agent, type Hotkey, type Project, type Scope, app, envName, projectById, repoOf } from "./state";

/** Everywhere 0, an Environment 1, a project 2. */
const rank = (s?: Scope) => (!s ? 0 : "env" in s ? 1 : 2);
const key = (a: Agent) => a.name.trim().toLowerCase();
const sameKey = (a: Hotkey, b: Hotkey) => a.code === b.code && !!a.shift === !!b.shift && !!a.ctrl === !!b.ctrl;

export const sameScope = (a?: Scope, b?: Scope) =>
  !a || !b ? !a && !b : "env" in a ? "env" in b && a.env === b.env : "project" in b && a.project === b.project;

/** Whether project `p` offers `a`. A Worktree gets its repo project's commands. */
export function reaches(a: Agent, p: Project): boolean {
  const s = a.scope;
  if (!s) return true;
  if ("env" in s) return s.env === p.host;
  return s.project === p.id || s.project === repoOf(p).id;
}

/** Whether some project could offer both. */
export function scopesOverlap(a?: Scope, b?: Scope): boolean {
  if (!a || !b) return true;
  if ("env" in a && "env" in b) return a.env === b.env;
  if ("project" in a && "project" in b) return a.project === b.project;
  const env = "env" in a ? a.env : (b as { env: string }).env;
  const proj = projectById("project" in a ? a.project : (b as { project: string }).project);
  return !proj || proj.host === env;
}

/** A narrower command of the same name that replaces `a` in `p` (or anywhere both are offered). */
function replacer(a: Agent, p?: Project): Agent | undefined {
  if (!key(a)) return;
  return app.agents.find((b) => b !== a && key(b) === key(a) && rank(b.scope) > rank(a.scope) && (p ? reaches(b, p) : scopesOverlap(a.scope, b.scope)));
}

/** What the project's + menu offers, in list order: what reaches it, less what a narrower one replaces. */
export const offeredIn = (p: Project) => app.agents.filter((a) => reaches(a, p) && !replacer(a, p));

/** "everywhere", "on devbox", "in tri-code". */
export function scopeLabel(s?: Scope): string {
  if (!s) return "everywhere";
  if ("env" in s) return `on ${envName(s.env)}`;
  return `in ${projectById(s.project)?.name ?? "a removed project"}`;
}

/** The scope's lucide icon: the Environment's own when it has one. */
export function scopeIcon(s?: Scope): string {
  if (!s) return "earth";
  if ("env" in s) return app.envStyles[s.env]?.icon ?? (s.env === "local" ? "laptop" : "server");
  return "folder";
}

/** Names are unique within a scope; the same name in a narrower scope replaces the wider one there. */
export function nameProblem(a: Agent): string {
  if (!key(a)) return "needs a name";
  return app.agents.some((b) => b.id !== a.id && key(b) === key(a) && sameScope(a.scope, b.scope)) ? `another command ${scopeLabel(a.scope)} has this name` : "";
}

/** Not a problem, just what the row does in `p`: replaces a wider one, or is replaced by a narrower one. */
export function replaceNote(a: Agent, p: Project): string {
  if (!reaches(a, p)) return "";
  const r = replacer(a, p);
  if (r) return `${p.name} uses its own “${r.name}” (${scopeLabel(r.scope)}) instead`;
  const wider = app.agents.find((b) => b !== a && key(b) === key(a) && rank(b.scope) < rank(a.scope) && reaches(b, p));
  return wider ? `replaces the “${wider.name}” that is ${scopeLabel(wider.scope)}` : "";
}

/** Whether some project's + menu offers both, so they can't share a hotkey. */
export function offeredTogether(a: Agent, b: Agent): boolean {
  return app.projects.some((p) => {
    const menu = offeredIn(p);
    return menu.includes(a) && menu.includes(b);
  });
}

/** An earlier command that keeps `a`'s chord in some project whose + menu offers both. */
export function chordHolder(a: Agent): Agent | undefined {
  const h = a.hotkey;
  if (!h) return;
  for (const p of app.projects) {
    const menu = offeredIn(p);
    const i = menu.indexOf(a);
    const b = i < 0 ? undefined : menu.slice(0, i).find((b) => b.hotkey && sameKey(b.hotkey, h));
    if (b) return b;
  }
}
