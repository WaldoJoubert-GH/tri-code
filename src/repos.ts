// Which repo a file belongs to, for the editor's diff and the git window when a project is a
// folder of repos. A project is either a repo itself, a subfolder of one, or a folder whose
// nested repos are found by `folder_repos` (the same discovery New worktree uses).

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { type Project } from "./state";

export type RepoRef = {
  /** The repo's path relative to the project; "" when the project folder is the repo. */
  repo: string;
  /** Where git commands run. */
  cwd: string;
  /** The file's path relative to `cwd`, as git reports it. */
  rel: string;
};

export type ProjectRepos = { root: boolean; repos: string[] };

/** Bumped when HEAD may have moved (a commit, a merge), so the editor re-reads its HEAD blob. */
export const [repoEpoch, setRepoEpoch] = createSignal(0);
export const bumpRepoEpoch = () => {
  heads.clear();
  setRepoEpoch((n) => n + 1);
};

const trim = (p: string) => p.replace(/[\\/]+$/, "");
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const join = (dir: string, rel: string) => `${trim(dir)}/${rel.replace(/^[\\/]+/, "")}`;
const key = (p: Project) => `${p.host}\u0000${p.path}`;
const cache = new Map<string, Promise<ProjectRepos>>();

/** Files are under `dir` (by path, not case: Windows paths vary). */
const under = (dir: string, file: string) => {
  const d = norm(dir).toLowerCase();
  const f = norm(file).toLowerCase();
  return f === d || f.startsWith(`${d}/`);
};

const relTo = (dir: string, file: string) => norm(file).slice(norm(dir).length + 1);

/** Whether the project folder is a repo; if not, the repos nested in it (outermost only). */
export function projectRepos(p: Project): Promise<ProjectRepos> {
  const k = key(p);
  const hit = cache.get(k);
  if (hit) return hit;
  const load = (async (): Promise<ProjectRepos> => {
    try {
      const root = await invoke<boolean>("git_is_repo", { host: p.host, path: p.path });
      if (root) return { root: true, repos: [] };
    } catch { /* fall through to the folder scan */ }
    try {
      const repos = await invoke<string[]>("folder_repos", { host: p.host, path: p.path });
      return { root: false, repos };
    } catch {
      return { root: false, repos: [] };
    }
  })();
  cache.set(k, load);
  return load;
}

/** Forget the repo list (a nested repo was added, or the folder moved). */
export function invalidateRepos(p: Project) {
  cache.delete(key(p));
}

/** The repo a file belongs to, or null when it is outside every repo in the project. */
export async function repoOfFile(p: Project, file: string): Promise<RepoRef | null> {
  const { root, repos } = await projectRepos(p);
  if (root && under(p.path, file)) {
    return { repo: "", cwd: trim(p.path), rel: relTo(p.path, file) };
  }
  let best: string | undefined;
  for (const repo of repos) {
    if (!under(join(p.path, repo), file)) continue;
    if (!best || repo.length > best.length) best = repo;
  }
  if (best === undefined) return null;
  const cwd = join(p.path, best);
  return { repo: best, cwd, rel: relTo(cwd, file) };
}

/** A file at HEAD. `text` is null when HEAD or the file does not exist there yet; `from` is the
 *  path HEAD has it under when the file is the target of a staged rename. */
export type HeadFile = { text: string | null; from?: string | null };

/** HEAD blobs by host, repo and file, so switching tabs does not run `git show` (an ssh round
 *  trip on a remote host) again. Cleared when HEAD may have moved; `fresh` re-reads one. */
const heads = new Map<string, Promise<HeadFile>>();

/** The file at HEAD, cached until `bumpRepoEpoch` or a `fresh` read. */
export function headText(p: Project, ref: RepoRef, fresh = false): Promise<HeadFile> {
  const k = `${p.host}\u0000${ref.cwd}\u0000${ref.rel}`;
  const hit = heads.get(k);
  if (hit && !fresh) return hit;
  const load = invoke<HeadFile>("git_head_text", { host: p.host, path: ref.cwd, file: ref.rel });
  heads.set(k, load);
  // A failed read (an unreachable host) is tried again next time.
  load.catch(() => heads.get(k) === load && heads.delete(k));
  return load;
}
