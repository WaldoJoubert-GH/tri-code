// The Backdrop Effect: a project's background redrawn on a canvas through Zeron's dither or halftone,
// laid over the picture at a strength. The presets are drawn here as BACKGROUNDS (Appearance.tsx) draws them in CSS.
//
// zeronDither and zeronHalftone are ported from Zeron (https://github.com/zeronsh/zeron, commit 35561ea):
// crates/ui/src/new_thread_background_effects.rs and apps/zgx/ui/ds/effects.luau.
//
// MIT License
//
// Copyright (c) 2026 Wing
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial
// portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
// EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
// IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

export type FxKind = "dither" | "halftone";
/** A project's Backdrop Effect. Strength 0..100 (0 is off); `tone: "accent"` draws in the accent alone. */
export type Fx = { kind: FxKind; strength: number; tone?: "accent" };

/**
 * Transparency: how much of the backdrop shows through, 0..85 (percent) for panel windows and for
 * terminals. `blur` frosts what shows through; `chrome` lets the sidebar, toolbar and status line
 * show it too, at the panels' value. Browser windows are native webviews and stay solid.
 */
export type Clear = { panels: number; terms: number; blur?: boolean; chrome?: boolean };
export const CLEAR_MAX = 85;

/** The classes and CSS variables on .app for a project's Transparency (styles.css draws them). */
export function clearLook(c: Clear | undefined): { classes: Record<string, boolean>; vars: Record<string, string> } {
  const panels = Math.max(0, Math.min(CLEAR_MAX, c?.panels ?? 0)), terms = Math.max(0, Math.min(CLEAR_MAX, c?.terms ?? 0));
  return {
    classes: {
      "see-panels": panels > 0,
      "see-terms": terms > 0,
      "see-chrome": panels > 0 && !!c?.chrome,
      "see-blur": (panels > 0 || terms > 0) && !!c?.blur,
    },
    vars: { "--see-panels": `${100 - panels}%`, "--see-terms": `${100 - terms}%` },
  };
}

/** Pixels as ImageData holds them: RGBA, row by row. */
export type Pixels = { width: number; height: number; data: Uint8ClampedArray };
type Rgb = [number, number, number];

/** Cell sizes in CSS pixels, as Zeron's: 2 for the dither, 4 for the halftone. */
export const FX_CELL: Record<FxKind, number> = { dither: 2, halftone: 4 };
/** Zeron draws its halftone at a share of the strength: it covers the picture's whole surface, not its bright cells. */
const HALFTONE_SHARE = 0.8;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export const fxOn = (fx: Fx | undefined): fx is Fx => !!fx && fx.strength > 0;

/**
 * Square cells `pitch` pixels across, each taking the picture's colour at its centre. Where its
 * brightest channel passes the cell's 4 x 4 Bayer threshold it is lifted to its full value, else it is
 * that colour at 8%. Laid over the picture at `strength` (0..1), so the picture still shows through.
 */
export function zeronDither(img: Pixels, pitch: number, strength: number, accent?: Rgb) {
  const { width: w, height: h, data: d } = img;
  pitch = Math.max(1, Math.round(pitch));
  for (let cy = 0; cy * pitch < h; cy++) {
    for (let cx = 0; cx * pitch < w; cx++) {
      const px = Math.min(w - 1, cx * pitch + (pitch >> 1)), py = Math.min(h - 1, cy * pitch + (pitch >> 1));
      const o = (py * w + px) * 4, r = d[o], g = d[o + 1], b = d[o + 2], peak = Math.max(r, g, b);
      const bright = peak / 255 > (BAYER[(cy % 4) * 4 + (cx % 4)] + 0.5) / 16;
      let dr: number, dg: number, db: number;
      if (accent) {
        const k = bright ? 1 : 0.08;
        [dr, dg, db] = [accent[0] * k, accent[1] * k, accent[2] * k];
      } else {
        const gain = bright ? 255 / Math.max(peak, 1) : 0.08;
        [dr, dg, db] = [r * gain, g * gain, b * gain];
      }
      fill(d, w, cx * pitch, cy * pitch, Math.min(w, (cx + 1) * pitch), Math.min(h, (cy + 1) * pitch), () => [dr, dg, db], strength);
    }
  }
}

/**
 * Square cells `pitch` pixels across, each a round dot of the colour at its centre, wider where the
 * picture is brighter (in the light, where it is darker), on paper: black in the dark, white in the light.
 */
export function zeronHalftone(img: Pixels, pitch: number, strength: number, light: boolean, accent?: Rgb) {
  const { width: w, height: h, data: d } = img, paper = light ? 255 : 0;
  pitch = Math.max(2, Math.round(pitch));
  for (let cy = 0; cy * pitch < h; cy++) {
    for (let cx = 0; cx * pitch < w; cx++) {
      const mx = (cx + 0.5) * pitch, my = (cy + 0.5) * pitch;
      const o = (Math.min(h - 1, Math.floor(my)) * w + Math.min(w - 1, Math.floor(mx))) * 4;
      let lum = (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255;
      if (light) lum = 1 - lum;
      const radius = pitch * 0.5 * (0.3 + 0.7 * Math.sqrt(lum));
      const [cr, cg, cb] = accent ?? [d[o], d[o + 1], d[o + 2]];
      fill(d, w, cx * pitch, cy * pitch, Math.min(w, (cx + 1) * pitch), Math.min(h, (cy + 1) * pitch), (x, y) => {
        const cover = Math.max(0, Math.min(1, radius - Math.hypot(x + 0.5 - mx, y + 0.5 - my) + 0.5));
        return [paper + (cr - paper) * cover, paper + (cg - paper) * cover, paper + (cb - paper) * cover];
      }, strength);
    }
  }
}

/** Mix the colour `at` gives each pixel of a cell over the picture at `k`. */
function fill(d: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number, at: (x: number, y: number) => Rgb, k: number) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4, [r, g, b] = at(x, y);
      d[i] += (r - d[i]) * k;
      d[i + 1] += (g - d[i + 1]) * k;
      d[i + 2] += (b - d[i + 2]) * k;
    }
  }
}

/** Fade the picture towards `to` by `k` (0..1): the Dim, done in the pixels so the effect dithers it too. */
export function dimPixels(img: Pixels, to: Rgb, k: number) {
  const d = img.data;
  if (k <= 0) return;
  for (let i = 0; i < d.length; i += 4) {
    d[i] += (to[0] - d[i]) * k;
    d[i + 1] += (to[1] - d[i + 1]) * k;
    d[i + 2] += (to[2] - d[i + 2]) * k;
  }
}

/** Run a project's effect over its picture. `scale` is device pixels per CSS pixel. */
export function applyFx(img: Pixels, fx: Fx, accent: string, light: boolean, scale: number) {
  const k = Math.max(0, Math.min(100, fx.strength)) / 100;
  const tint = fx.tone === "accent" ? hexRgb(accent) : undefined;
  const pitch = Math.round(FX_CELL[fx.kind] * scale);
  if (fx.kind === "halftone") zeronHalftone(img, pitch, k * HALFTONE_SHARE, light, tint);
  else zeronDither(img, pitch, k, tint);
}

export function hexRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = (hex: string, a: number) => {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

/** The theme colours the presets use, read from the page. */
export type BackdropTokens = { canvas: string; dusk: [string, string, string, string] };

function ellipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string, clear: string, stop: number, W: number, H: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, color);
  g.addColorStop(stop, clear);
  g.addColorStop(1, clear);
  ctx.fillStyle = g;
  ctx.fillRect(-cx / rx, -cy / ry, W / rx, H / ry);
  ctx.restore();
}

export type BackdropJob = {
  bg: string;
  accent: string;
  dim: number;
  fx: Fx;
  image?: HTMLImageElement;
  /** CSS pixels */
  width: number;
  height: number;
  /** device pixels per CSS pixel */
  scale: number;
  light: boolean;
  tokens: BackdropTokens;
};

/** Draw a project's background on `canvas` at device resolution, dim it, then run its effect over it. */
export function paintBackdrop(canvas: HTMLCanvasElement, j: BackdropJob) {
  const w = Math.max(1, Math.round(j.width * j.scale)), h = Math.max(1, Math.round(j.height * j.scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.setTransform(w / j.width, 0, 0, h / j.height, 0, 0);
  drawPreset(ctx, j.bg, j.accent, j.width, j.height, j.tokens, j.image);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  dimPixels(img, hexRgb(j.tokens.canvas), j.dim / 100);
  applyFx(img, j.fx, j.accent, j.light, j.scale);
  ctx.putImageData(img, 0, 0);
}

/** Draw a background preset (or the uploaded `image`) in CSS pixels, as its CSS in BACKGROUNDS looks. */
export function drawPreset(ctx: CanvasRenderingContext2D, bg: string, accent: string, W: number, H: number, t: BackdropTokens, image?: CanvasImageSource & { width: number; height: number }) {
  const clear = rgba(accent, 0);
  ctx.fillStyle = t.canvas;
  ctx.fillRect(0, 0, W, H);
  if (bg === "aurora") {
    ellipse(ctx, 0.12 * W, 0.08 * H, 0.6 * W, 0.8 * H, rgba(accent, 0.48), clear, 0.7, W, H);
    ellipse(ctx, 0.92 * W, 0.95 * H, 0.5 * W, 0.7 * H, rgba(accent, 0.32), clear, 0.7, W, H);
  } else if (bg === "blueprint") {
    ellipse(ctx, 0.5 * W, 0, 0.8 * W, 0.8 * H, rgba(accent, 0.12), clear, 1, W, H);
    ctx.fillStyle = rgba(accent, 0.13);
    for (let x = 0; x < W; x += 32) ctx.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 32) ctx.fillRect(0, y, W, 1);
  } else if (bg === "rings") {
    ctx.strokeStyle = rgba(accent, 0.22);
    ctx.lineWidth = 1;
    const cx = 0.78 * W, cy = 1.15 * H, max = Math.hypot(W, H) * 1.3;
    for (let r = 26.5; r < max; r += 27) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (bg === "dusk") {
    // linear-gradient(185deg, …): the line runs through the centre, long enough to reach the corners
    const a = (185 * Math.PI) / 180, len = Math.abs(W * Math.sin(a)) + Math.abs(H * Math.cos(a));
    const dx = (Math.sin(a) * len) / 2, dy = (-Math.cos(a) * len) / 2;
    const g = ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
    [0, 0.4, 0.72, 1].forEach((at, i) => g.addColorStop(at, t.dusk[i]));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else if (bg === "image" && image && image.width && image.height) {
    // center / cover
    const k = Math.max(W / image.width, H / image.height), w = image.width * k, h = image.height * k;
    ctx.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
  }
}
