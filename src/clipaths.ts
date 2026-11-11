// Path matching for the `tri` command (cli.ts). Pure, for bun test.

import { type Project, isLocalHost } from "./state";

/** Forward slashes, no trailing slash, and lowercase on a Windows path (`C:\…`), which ignores case. */
export function norm(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
}

export const samePath = (a: string, b: string) => norm(a) === norm(b);

/** Whether `path` is `dir` or inside it. */
export function within(path: string, dir: string): boolean {
  const p = norm(path), d = norm(dir);
  return p === d || p.startsWith(d.endsWith("/") ? d : `${d}/`);
}

/** The local project, not the tour's, whose folder holds `path` most closely: a Worktree beats its repo. */
export function ownerOf(projects: readonly Project[], path: string): Project | undefined {
  return projects
    .filter((p) => isLocalHost(p.host) && !p.sample && within(path, p.path))
    .sort((a, b) => norm(b.path).length - norm(a.path).length)[0];
}

/** `file` as the editor names it: the project's folder, `/`, then the path inside it. */
export function editorPath(project: Project, file: string): string {
  const rel = file.replace(/\\/g, "/").slice(norm(project.path).length).replace(/^\/+/, "");
  return `${project.path.replace(/[\\/]+$/, "")}/${rel}`;
}
