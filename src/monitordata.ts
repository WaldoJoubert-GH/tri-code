// The Monitor Window's data: what a sample from src-tauri/src/monitor.rs looks like, and the pure
// parts of showing it (the process tree, sorting, the project scope, numbers and graph paths).

export type Proc = {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  user: string;
  /** Percent of one core, as top counts it. */
  cpu: number;
  /** Resident bytes. */
  mem: number;
  /** Unix seconds. */
  start: number;
  /** With the pid, names this process and no other; `monitor_end` checks it. */
  born: number;
  cwd: string | null;
  /** In the project's folder. */
  mine: boolean;
  guard: "tri-code" | "system" | null;
};

export type Disk = { mount: string; total: number; used: number; read: number | null; write: number | null };

export type Snapshot = {
  os: string;
  hostName: string;
  uptime: number;
  load: [number, number, number] | null;
  cpu: number;
  cores: number[];
  mhz: number | null;
  memTotal: number;
  memUsed: number;
  memCached: number;
  swapTotal: number;
  swapUsed: number;
  rx: number;
  tx: number;
  disks: Disk[];
  procs: Proc[];
};

/** Samples the graphs keep. */
export const HISTORY = 60;

/** `hist` with `v` on the end, as long as HISTORY at most. */
export function pushed(hist: number[], v: number): number[] {
  const out = hist.length >= HISTORY ? hist.slice(hist.length - HISTORY + 1) : hist.slice();
  out.push(v);
  return out;
}

export type SortKey = "cpu" | "mem" | "pid" | "name" | "user" | "up";
export type Scope = "all" | "mine";
export type Row = { p: Proc; /** Tree lines before the name, "" in a flat list. */ prefix: string };

/** What a column sorts by. A higher value is first unless `asc`. */
const KEY: Record<SortKey, (p: Proc) => number | string> = {
  cpu: (p) => p.cpu,
  mem: (p) => p.mem,
  pid: (p) => p.pid,
  name: (p) => p.name.toLowerCase(),
  user: (p) => p.user.toLowerCase(),
  up: (p) => -p.start,
};
/** The way a column sorts when first picked: numbers biggest first, words A to Z. */
export const firstAsc = (k: SortKey) => k === "name" || k === "user" || k === "pid";

/** Children by parent pid. A parent that isn't in `procs`, or a process that is its own, makes a root (0). */
function childrenOf(procs: Proc[]): Map<number, Proc[]> {
  const ids = new Set(procs.map((p) => p.pid));
  const kids = new Map<number, Proc[]>();
  for (const p of procs) {
    const parent = p.ppid !== p.pid && ids.has(p.ppid) ? p.ppid : 0;
    const list = kids.get(parent);
    if (list) list.push(p);
    else kids.set(parent, [p]);
  }
  return kids;
}

/** Everything `pid` started, and what they started, in `procs`. */
export function descendants(procs: Proc[], pid: number): Proc[] {
  const kids = childrenOf(procs);
  const out: Proc[] = [];
  const seen = new Set([pid]);
  const walk = (id: number) => {
    for (const c of kids.get(id) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      walk(c.pid);
    }
  };
  walk(pid);
  return out;
}

/** The project's processes: the ones in its folder and everything they started. */
export function projectPids(procs: Proc[]): Set<number> {
  const out = new Set<number>();
  for (const p of procs) {
    if (!p.mine || out.has(p.pid)) continue;
    out.add(p.pid);
    for (const d of descendants(procs, p.pid)) out.add(d.pid);
  }
  return out;
}

export const matches = (p: Proc, q: string) => `${p.pid} ${p.name} ${p.cmd} ${p.user}`.toLowerCase().includes(q);

/** The rows to show, in order. A search lists matches flat, since their parents may not match. */
export function rowsOf(procs: Proc[], o: { scope: Scope; find: string; tree: boolean; sort: SortKey; asc: boolean }): Row[] {
  let list = procs;
  if (o.scope === "mine") {
    const mine = projectPids(procs);
    list = list.filter((p) => mine.has(p.pid));
  }
  const q = o.find.trim().toLowerCase();
  if (q) list = list.filter((p) => matches(p, q));
  const key = KEY[o.sort];
  const cmp = (a: Proc, b: Proc) => {
    const x = key(a), y = key(b);
    const r = x < y ? -1 : x > y ? 1 : a.pid - b.pid;
    return o.asc ? r : -r;
  };
  if (!o.tree || q) return list.slice().sort(cmp).map((p) => ({ p, prefix: "" }));
  const kids = childrenOf(list);
  const out: Row[] = [];
  const seen = new Set<number>();
  const add = (p: Proc, lead: string, last: boolean, depth: number) => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    out.push({ p, prefix: depth ? lead + (last ? "└─ " : "├─ ") : "" });
    const cs = (kids.get(p.pid) ?? []).slice().sort(cmp);
    const next = depth ? lead + (last ? "   " : "│  ") : "";
    cs.forEach((c, i) => add(c, next, i === cs.length - 1, depth + 1));
  };
  for (const p of (kids.get(0) ?? []).slice().sort(cmp)) add(p, "", true, 0);
  return out;
}

// ── numbers ──────────────────────────────────────────────────────────

const UNITS = ["B", "KB", "MB", "GB", "TB"];
export function bytes(n: number): string {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${UNITS[i]}`;
}
export const perSec = (n: number) => `${bytes(n)}/s`;

/** "3d 4h", "2h 5m", "4m 10s". */
export function duration(s: number): string {
  s = Math.max(0, Math.floor(s));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The colour a load reads as: calm, busy or flat out. */
export const tone = (pct: number) => (pct >= 85 ? "var(--bad)" : pct >= 60 ? "var(--warn)" : "var(--ok)");

/** An area graph of `vals` in a 100×`h` box (stretched to fit): the line, and the area under it, or
 *  above it when `down` hangs it from the top. */
export function graphPaths(vals: number[], h: number, max: number, down = false): { line: string; area: string } {
  const v = vals.length > 1 ? vals : [vals[0] ?? 0, vals[0] ?? 0];
  const n = v.length;
  const y = (x: number) => {
    const t = (Math.min(1, Math.max(0, x / (max || 1))) * (h - 1));
    return (down ? t : h - t).toFixed(1);
  };
  // The newest sample is always at the right edge, so a short history grows from the right.
  const x = (i: number) => (100 - ((n - 1 - i) / (HISTORY - 1)) * 100).toFixed(2);
  const pts = v.map((p, i) => `${x(i)},${y(p)}`);
  const base = down ? 0 : h;
  return { line: `M${pts.join("L")}`, area: `M${x(0)},${base}L${pts.join("L")}L100,${base}Z` };
}
