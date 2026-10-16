// Pure tiling maths: where each window of a workspace goes. No DOM, no state.

import type { Layout } from "./state";

export type Rect = { x: number; y: number; w: number; h: number };

export type Tiling = {
  /** One rect per window, in the same order as the input. */
  rects: Rect[];
  /** Grab area for the main/stack divider (master layout with 2+ windows only). */
  split?: Rect;
};

/**
 * Tile `n` windows into a `width` x `height` area, `gap` px between windows and
 * around the edge.
 * - master: window 0 takes `ratio` of the width; the rest stack evenly on the right.
 * - grid: ceil(sqrt(n)) columns; the last row stretches to fill the width.
 * `mono` (an index) gets the whole area, drawn above the others.
 */
export function tile(n: number, layout: Layout, ratio: number, width: number, height: number, gap: number, mono = -1): Tiling {
  const g = gap, ax = g, ay = g, aw = Math.max(0, width - 2 * g), ah = Math.max(0, height - 2 * g);
  const r = (x: number, y: number, w: number, h: number): Rect => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  const rects: Rect[] = [];
  let split: Rect | undefined;
  if (n === 0) return { rects };
  if (layout === "master" && n > 1) {
    const mw = (aw - g) * ratio, k = n - 1, sh = (ah - g * (k - 1)) / k;
    rects.push(r(ax, ay, mw, ah));
    for (let i = 0; i < k; i++) rects.push(r(ax + mw + g, ay + i * (sh + g), aw - mw - g, sh));
    const hit = Math.max(g, 10);
    split = r(ax + mw + g / 2 - hit / 2, ay, hit, ah);
  } else {
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), th = (ah - g * (rows - 1)) / rows;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols), inRow = row < rows - 1 ? cols : n - cols * (rows - 1), c = i - row * cols;
      const tw = (aw - g * (inRow - 1)) / inRow;
      rects.push(r(ax + c * (tw + g), ay + row * (th + g), tw, th));
    }
  }
  if (mono >= 0 && mono < n) rects[mono] = r(ax, ay, aw, ah);
  return { rects, split };
}

/** Ratio for the master split when the divider is dragged to local x. */
export function ratioAt(x: number, width: number, gap: number) {
  const aw = width - 2 * gap;
  return (x - gap - gap / 2) / (aw - gap);
}

/** Nearest rect in direction (dx, dy) from rect `from`, by centre distance, or -1. */
export function neighbour(rects: Rect[], from: number, dx: number, dy: number) {
  const f = rects[from];
  if (!f) return rects.length ? 0 : -1;
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  let best = -1, bs = Infinity;
  rects.forEach((o, i) => {
    if (i === from) return;
    const vx = o.x + o.w / 2 - cx, vy = o.y + o.h / 2 - cy;
    const along = vx * dx + vy * dy, across = Math.abs(dx ? vy : vx);
    if (along <= 1) return;
    const s = along + across * 2;
    if (s < bs) { bs = s; best = i; }
  });
  return best;
}
