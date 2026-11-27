// The ignored files New worktree can copy into a new checkout (git/ignored.rs lists them): which start
// ticked, and how the dialog shows and filters them. Chosen from design/worktree-gitignore.html (variant B).

/** One file `ignored_files` found in the repo's folder (git/ignored.rs `IgnoredFile`). */
export type IgnoredFile = { path: string; size: number };
/** What a repo project keeps from the last Create (state.ts `copyIgnored`). */
export type CopyIgnored = { ticked: string[]; known: string[] };

/** Files over this show their size in the warning colour: slow to copy. */
export const BIG = 50 * 1024 * 1024;

export const isEnvFile = (path: string) => /(^|\/)\.env[^/]*$/.test(path);

/** With nothing saved yet: `.env*` and `.dev/*.conf.json` are wanted, databases and data are a choice. */
export const tickedByDefault = (path: string) => isEnvFile(path) || /^\.dev\/[^/]+\.conf\.json$/.test(path);

/** The files that start ticked: as last saved, a file new since then as its default would be,
 *  except that only a new `.env*` is assumed wanted. */
export function startingTicks(files: IgnoredFile[], saved?: CopyIgnored): string[] {
  return files
    .filter(({ path }) => (!saved ? tickedByDefault(path) : saved.known.includes(path) ? saved.ticked.includes(path) : isEnvFile(path)))
    .map((f) => f.path);
}

/** The files shown for a search (anywhere in the path, any case), optionally only ticked ones. */
export function filterIgnored(files: IgnoredFile[], query: string, ticked: Set<string>, onlyTicked: boolean): IgnoredFile[] {
  const q = query.trim().toLowerCase();
  return files.filter((f) => (!q || f.path.toLowerCase().includes(q)) && (!onlyTicked || ticked.has(f.path)));
}

/** `412 B`, `3.4 MB`, `142 MB`. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const [n, unit] = bytes < 1024 ** 2 ? [bytes / 1024, "KB"] : bytes < 1024 ** 3 ? [bytes / 1024 ** 2, "MB"] : [bytes / 1024 ** 3, "GB"];
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${unit}`;
}

/** A path split for its chip: the folder is dimmed, the name stands out. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}
