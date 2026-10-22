// Unified diff text → hunks → aligned rows, shared by the git window and the editor's own
// changes view. Git hands us a patch; the editor builds one with `makePatch` first.
// Chosen from design/diff.html (variant A).

import { createTwoFilesPatch } from "diff";

export type DiffMode = "unified" | "split";

export type Row = {
  t: " " | "+" | "-";
  text: string;
  old: number | null;
  new: number | null;
};

export type Hunk = { head: string; oldStart: number; newStart: number; rows: Row[] };

export type SplitRow = {
  left?: Row;
  right?: Row;
  kind: "ctx" | "mod" | "add" | "del";
  /** The new-side line a drill from this row opens: its own line, else the next surviving one. */
  anchor: number;
};

export type DiffStats = { added: number; removed: number };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
/** More than this is more than the window can usefully show or diff in the editor. */
export const MAX_DIFF_LINES = 4000;

/** Split `git diff` output (or `makePatch` output) into hunks, numbering both sides. */
export function parseUnified(text: string): Hunk[] {
  const out: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    const m = HUNK.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { head: line, oldStart: oldNo, newStart: newNo, rows: [] };
      out.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith("\\")) continue;
    const t = line[0];
    if (t !== " " && t !== "+" && t !== "-") {
      hunk = null;
      continue;
    }
    hunk.rows.push({
      t,
      text: line.slice(1),
      old: t === "+" ? null : oldNo++,
      new: t === "-" ? null : newNo++,
    });
  }
  return out;
}

export function diffStats(hunks: Hunk[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const r of h.rows) {
      if (r.t === "+") added++;
      else if (r.t === "-") removed++;
    }
  }
  return { added, removed };
}

/** The first added line, else the first hunk's start. Where "open in the editor" lands. */
export function firstChange(hunks: Hunk[]): number | null {
  for (const h of hunks) for (const r of h.rows) if (r.t === "+" && r.new) return r.new;
  return hunks[0]?.newStart ?? null;
}

/** The new-side line an edit starts at, for a deleted line: the next surviving line. */
export function firstLine(hunks: Hunk[]): number | null {
  return firstChange(hunks) ?? hunks[0]?.oldStart ?? null;
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]+/g) ?? []);

/** How alike two changed lines are: shared tokens, or a common start/end. */
function similar(a: string, b: string): number {
  if (a === b) return 1;
  const A = words(a);
  const B = words(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  // Jaccard, not containment: a short line such as `headers: authHeaders(token)` is contained
  // in a long `fetch(...)` line and would otherwise steal it from the line it really replaces.
  const token = inter / Math.max(1, A.size + B.size - inter);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const edge = (p + s) / Math.max(1, Math.max(a.length, b.length));
  return Math.max(token, edge);
}

/**
 * Order-preserving alignment of a deletion run and the additions after it. Pairing by index
 * shifts every row when one side has an extra comment line; matching the lines that resemble
 * each other leaves the comment on its own side.
 */
function alignRows(dels: Row[], adds: Row[]): SplitRow[] {
  const n = dels.length;
  const m = adds.length;
  // A rewrite of a whole block is not worth a quadratic alignment: show the deletions
  // beside the additions, as an editor would.
  if (n * m > 250_000) {
    return [
      ...dels.map((left): SplitRow => ({ left, kind: "del", anchor: 0 })),
      ...adds.map((right): SplitRow => ({ right, kind: "add", anchor: 0 })),
    ];
  }
  const GAP = 0.45;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] - GAP;
  for (let j = 1; j <= m; j++) dp[0][j] = dp[0][j - 1] - GAP;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = similar(dels[i - 1].text, adds[j - 1].text);
      dp[i][j] = Math.max(
        dp[i - 1][j - 1] + (s >= 0.22 ? s : -1),
        dp[i - 1][j] - GAP,
        dp[i][j - 1] - GAP,
      );
    }
  }
  const rows: SplitRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const s = similar(dels[i - 1].text, adds[j - 1].text);
      if (s >= 0.22 && Math.abs(dp[i][j] - (dp[i - 1][j - 1] + s)) < 1e-9) {
        rows.push({ left: dels[i - 1], right: adds[j - 1], kind: "mod", anchor: 0 });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && (j === 0 || Math.abs(dp[i][j] - (dp[i - 1][j] - GAP)) < 1e-9)) {
      rows.push({ left: dels[i - 1], kind: "del", anchor: 0 });
      i--;
    } else {
      rows.push({ right: adds[j - 1], kind: "add", anchor: 0 });
      j--;
    }
  }
  return rows.reverse();
}

/** A hunk's rows as side-by-side lines; context lines sit on both sides. */
export function splitRows(hunk: Hunk): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: Row[] = [];
  let adds: Row[] = [];

  const flush = () => {
    out.push(...alignRows(dels, adds));
    dels = [];
    adds = [];
  };

  for (const r of hunk.rows) {
    if (r.t === "-") {
      dels.push(r);
      continue;
    }
    if (r.t === "+") {
      adds.push(r);
      continue;
    }
    flush();
    out.push({ left: r, right: r, kind: "ctx", anchor: r.new ?? hunk.newStart });
  }
  flush();
  return rowsAnchored(out, hunk);
}

/** Give every deletion-only row the next surviving new-side line as its drill target. */
function rowsAnchored(rows: SplitRow[], hunk: Hunk): SplitRow[] {
  let nextNew = hunk.newStart;
  for (const row of rows) {
    if (row.right?.new != null) {
      row.anchor = row.right.new;
      nextNew = row.right.new + 1;
    } else if (row.left && !row.right) {
      row.anchor = nextNew;
    }
  }
  return rows;
}

/** The common prefix / changed middle / common suffix of two paired lines, for the word tint. */
export function pairMarks(a: string, b: string): { a: [string, string, string]; b: [string, string, string] } | null {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const cut = (x: string): [string, string, string] => [x.slice(0, p), x.slice(p, x.length - s), x.slice(x.length - s)];
  const [ap, am, as] = cut(a);
  const [bp, bm, bs] = cut(b);
  if (!am.length && !bm.length) return null;
  return { a: [ap, am, as], b: [bp, bm, bs] };
}

/** A patch from two texts, for the editor's HEAD → buffer diff.
 *  Normalise EOLs and drop a BOM: the editor's doc is always LF, while HEAD may be CRLF. */
export function normalizeText(s: string): string {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const t = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  return t.split(CR + LF).join(LF).split(CR).join(LF);
}

export const sameText = (a: string, b: string) => normalizeText(a) === normalizeText(b);

export function makePatch(path: string, oldText: string, newText: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, normalizeText(oldText), normalizeText(newText), "", "", { context: 3 });
}
