// Linked Folders: other folders a project shows beside its own, as extra roots of the Editor
// Window's tree and in Go to File. Each lives on the project's host, or (a project on an ssh
// Environment) on this machine. Files carry only their path, so the root a path falls under says
// which host reads and writes it. A Worktree shows its repo's links. Chosen from
// design/linked-folders.html (variant A).

import { type LinkedFolder, type Project, app, repoOf } from "./state";

/** The project's own folder or one of its Linked Folders. */
export type Root = { id: string; name: string; host: string; path: string; link?: LinkedFolder };

const norm = (p: string) => p.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
/** Windows paths are compared without case. */
const fold = (p: string) => (/^[a-zA-Z]:/.test(p) ? p.toLowerCase() : p);

/** Whether `path` is `dir` or inside it. */
export function within(dir: string, path: string): boolean {
  const d = fold(norm(dir)), f = fold(norm(path));
  return f === d || f.startsWith(d.endsWith("/") ? d : `${d}/`);
}

/** `path` relative to `dir` ("" for `dir` itself); assumes `within(dir, path)`. */
export function relIn(dir: string, path: string): string {
  const d = norm(dir), f = norm(path);
  return f.length <= d.length ? "" : f.slice(d.endsWith("/") ? d.length : d.length + 1);
}

/** The host a link's files are on: this machine, or the project's. */
export const linkHost = (p: Project, l: LinkedFolder) => (l.local ? "local" : p.host);

/** Settings › Files › Linked folders. Off, nothing shows them; their links are kept. */
export const linksOn = () => app.settings.linkedFolders !== false;

/** A project's Linked Folders, in tree order (a Worktree's are its repo's); none while turned off. */
export const linksOf = (p: Project): LinkedFolder[] => (linksOn() ? repoOf(p).links ?? [] : []);

const toRoots = (p: Project, links: LinkedFolder[]): Root[] => [
  { id: "", name: p.name, host: p.host, path: p.path },
  ...links.map((l) => ({ id: l.id, name: l.name, host: linkHost(p, l), path: l.path, link: l })),
];

/** The project's folder first, then each Linked Folder shown. */
export const rootsOf = (p: Project): Root[] => toRoots(p, linksOf(p));

/** The root `path` is under: the deepest one that holds it, else the project's own folder. Counts
 *  links while turned off too, so a file still open from one is read and saved on the right host. */
export function rootAt(p: Project, path: string): Root {
  const roots = toRoots(p, repoOf(p).links ?? []);
  let best = roots[0];
  let bestLen = -1;
  for (const r of roots) {
    if (!path || !within(r.path, path)) continue;
    const n = norm(r.path).length;
    if (n > bestLen) (best = r), (bestLen = n);
  }
  return best;
}

/** Which host reads and writes `path`. */
export const hostAt = (p: Project, path: string) => rootAt(p, path).host;
/** The Linked Folder `path` is in, if it is in one. */
export const linkAt = (p: Project, path: string) => rootAt(p, path).link;

/** `p` as if the root were the project: for what works on a project's folder (repo lookups). */
export const asProject = (p: Project, r: Root): Project => (r.link ? { ...p, host: r.host, path: r.path } : p);

/** The name a new link gets: the folder's, made unique among the project's roots. */
export function linkName(p: Project, path: string, skip?: string): string {
  const base = norm(path).split("/").filter(Boolean).pop()?.replace(/:$/, "") || "folder";
  const taken = new Set(rootsOf(p).filter((r) => r.id !== skip).map((r) => r.name.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}`;
  return name;
}

/** Why `path` can't be linked to `p`, or "" when it can. */
export function linkProblem(p: Project, path: string, local: boolean, skip?: string): string {
  if (!path) return "Pick a folder";
  const host = local ? "local" : p.host;
  for (const r of rootsOf(p)) {
    if (r.id === skip || r.host !== host) continue;
    if (within(r.path, path) && norm(r.path).length === norm(path).length) {
      return r.link ? `Already linked as ${r.name}` : "That is the project's own folder";
    }
  }
  if (host === p.host && within(p.path, path)) return "That folder is inside the project already";
  return "";
}
