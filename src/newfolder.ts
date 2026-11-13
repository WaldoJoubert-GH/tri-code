// The pure parts of the Open project dialog's New folder and Clone tabs: what counts as a
// repository URL, the folder name a clone gets, whether a name can be made, and folding git's
// progress output into lines and a percentage. The Rust side is newfolder.rs.

/** A piece of git's output; `partial` ones are progress the next piece redraws. */
export type CloneLine = { text: string; partial: boolean };

/** https/ssh/git/file URLs, and scp-style `user@host:path`. */
export function isRepoUrl(s: string): boolean {
  const u = s.trim();
  return /^(https?|ssh|git|file):\/\/\S+$/.test(u) || /^[\w.-]+@[\w.-]+:\S+$/.test(u);
}

/** The folder `git clone` would make: the URL's last part without `.git`. */
export function repoFolder(url: string): string {
  const u = url.trim().replace(/[/\\]+$/, "").replace(/\.git$/, "");
  return u.split(/[/:\\]/).pop() ?? "";
}

/** The URL without its scheme or `.git`, for showing. */
export const shortUrl = (url: string) => url.trim().replace(/^[a-z]+:\/\//, "").replace(/\.git$/, "");

/** Why `name` can't be made in a folder holding `dirs`, or "" when it can. Matches newfolder.rs `check_name`. */
export function nameProblem(name: string, dirs: string[], caseless: boolean): string {
  if (!name) return "";
  if (name.trim() !== name.trimStart() || name === "." || name === ".." || /[ .]$/.test(name) || /[\\/:*?"<>|\x00-\x1f]/.test(name))
    return "not a valid folder name";
  const same = (d: string) => (caseless ? d.toLowerCase() === name.toLowerCase() : d === name);
  return dirs.some(same) ? "already exists" : "";
}

/** Windows paths compare names without case. */
export const caselessPath = (path: string) => /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\");

const KEEP = 200;

/** Add a batch to the log: a partial line is replaced by whatever comes next. */
export function addLines(log: CloneLine[], batch: CloneLine[]): CloneLine[] {
  const out = log.slice();
  for (const l of batch) {
    if (out.length && out[out.length - 1].partial) out[out.length - 1] = l;
    else out.push(l);
  }
  return out.length > KEEP ? out.slice(-KEEP) : out;
}

/** The latest progress meter in the log: its phase ("Receiving objects") and percent. */
export function progress(log: CloneLine[]): { phase: string; pct: number } | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const m = /^(?:remote: )?([A-Z][\w ]+):\s+(\d{1,3})%/.exec(log[i].text);
    if (m) return { phase: m[1], pct: Math.min(100, Number(m[2])) };
  }
  return null;
}
