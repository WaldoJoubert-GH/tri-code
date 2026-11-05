// bun test: the Backdrop Effect's pixel work (backdrop.ts), Zeron's dither and halftone.

import { describe, expect, test } from "bun:test";
import { applyFx, clearLook, dimPixels, fxOn, hexRgb, zeronDither, zeronHalftone } from "./backdrop";

/** A w x h picture of one colour. */
const flat = (w: number, h: number, [r, g, b]: number[]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4);
  return { width: w, height: h, data };
};
const px = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe("dither", () => {
  test("a bright cell is lifted to its full value, a dark one drops to 8%", () => {
    // A peak of 64 (.25) passes cell (0,0)'s threshold (0.5/16) and fails cell (1,0)'s (8.5/16).
    const img = flat(4, 2, [64, 32, 0]);
    zeronDither(img, 2, 1);
    expect(px(img, 0, 0)).toEqual([255, 128, 0, 255]);
    expect(px(img, 1, 1)).toEqual([255, 128, 0, 255]); // the same cell, 2 pixels across
    expect(px(img, 2, 0)).toEqual([5, 3, 0, 255]); // 64 * .08 and 32 * .08, rounded by the clamped array
  });

  test("strength 0 leaves the picture as it is, and half is halfway", () => {
    const img = flat(2, 2, [64, 32, 0]);
    zeronDither(img, 2, 0);
    expect(px(img, 0, 0)).toEqual([64, 32, 0, 255]);
    zeronDither(img, 2, 0.5);
    expect(px(img, 0, 0)).toEqual([160, 80, 0, 255]);
  });

  test("in the accent, bright cells are the accent and dark ones 8% of it", () => {
    const img = flat(4, 2, [64, 64, 64]);
    zeronDither(img, 2, 1, [100, 200, 50]);
    expect(px(img, 0, 0)).toEqual([100, 200, 50, 255]);
    expect(px(img, 2, 0)).toEqual([8, 16, 4, 255]);
  });

  test("a black picture stays black", () => {
    const img = flat(8, 8, [0, 0, 0]);
    zeronDither(img, 2, 1);
    expect(img.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0))).toBe(true);
  });
});

describe("halftone", () => {
  test("in the dark a black picture prints small dots of black on black paper", () => {
    const img = flat(4, 4, [0, 0, 0]);
    zeronHalftone(img, 4, 1, false);
    expect(px(img, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  test("a white picture in the dark covers its cell centre in white and leaves the corner nearer paper", () => {
    const img = flat(4, 4, [255, 255, 255]);
    zeronHalftone(img, 4, 1, false);
    expect(px(img, 1, 1)[0]).toBe(255);
    expect(px(img, 0, 0)[0]).toBeLessThan(px(img, 1, 1)[0]);
  });

  test("in the light the paper is white", () => {
    const img = flat(4, 4, [255, 255, 255]);
    zeronHalftone(img, 4, 1, true);
    // a white picture in the light is the smallest dot, so the corner is paper
    expect(px(img, 0, 0)).toEqual([255, 255, 255, 255]);
  });
});

describe("applyFx", () => {
  test("draws the halftone at 80% of the strength, as Zeron does", () => {
    const img = flat(4, 4, [0, 0, 0]);
    applyFx(img, { kind: "halftone", strength: 100 }, "#ffffff", true, 1);
    // black in the light: the biggest dot of black, on white paper at the corner, at 80%
    expect(px(img, 0, 0)[0]).toBeLessThanOrEqual(Math.round(255 * 0.8));
  });

  test("cells grow with the display scale", () => {
    const img = flat(8, 2, [64, 32, 0]);
    applyFx(img, { kind: "dither", strength: 100 }, "#000000", false, 2);
    // a 4px cell: pixel 3 shares cell 0's lift
    expect(px(img, 3, 0)).toEqual([255, 128, 0, 255]);
  });
});

test("dimPixels fades towards a colour", () => {
  const img = flat(1, 1, [200, 100, 0]);
  dimPixels(img, [0, 0, 100], 0.5);
  expect(px(img, 0, 0)).toEqual([100, 50, 50, 255]);
});

test("fxOn: unset or strength 0 is off", () => {
  expect(fxOn(undefined)).toBe(false);
  expect(fxOn({ kind: "dither", strength: 0 })).toBe(false);
  expect(fxOn({ kind: "halftone", strength: 1 })).toBe(true);
});

describe("clearLook", () => {
  test("unset is solid", () => {
    const { classes } = clearLook(undefined);
    expect(Object.values(classes).some(Boolean)).toBe(false);
  });

  test("a value is how much shows through, so the surface keeps the rest", () => {
    const { classes, vars } = clearLook({ panels: 20, terms: 0 });
    expect(classes["see-panels"]).toBe(true);
    expect(classes["see-terms"]).toBe(false);
    expect(vars["--see-panels"]).toBe("80%");
  });

  test("the sidebar and bars follow the panels, and blur needs something to see through", () => {
    expect(clearLook({ panels: 0, terms: 30, chrome: true }).classes["see-chrome"]).toBe(false);
    expect(clearLook({ panels: 10, terms: 0, chrome: true }).classes["see-chrome"]).toBe(true);
    expect(clearLook({ panels: 0, terms: 0, blur: true }).classes["see-blur"]).toBe(false);
  });

  test("values past the limit are held to it", () => {
    expect(clearLook({ panels: 200, terms: -5 }).vars).toEqual({ "--see-panels": "15%", "--see-terms": "100%" });
  });
});

test("hexRgb reads #rrggbb and gives black for anything else", () => {
  expect(hexRgb("#7aa2f7")).toEqual([0x7a, 0xa2, 0xf7]);
  expect(hexRgb("tomato")).toEqual([0, 0, 0]);
});
