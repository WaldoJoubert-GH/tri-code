// bun test: which window an arrow key (and a Hold Hint) calls the neighbour in each layout.

import { describe, expect, test } from "bun:test";
import { type Rect, neighbour, tile } from "./layout";

const at = (rects: Rect[], x: number, y: number, w: number, h: number): Rect[] => [...rects, { x, y, w, h }];

describe("neighbour", () => {
  test("master: the stack is to the right, never above or below the main window", () => {
    const { rects } = tile(3, "master", 0.6, 1200, 800, 12);
    expect(neighbour(rects, 0, 1, 0)).toBe(1);
    expect(neighbour(rects, 0, -1, 0)).toBe(-1);
    expect(neighbour(rects, 0, 0, -1)).toBe(-1);
    expect(neighbour(rects, 0, 0, 1)).toBe(-1);
  });

  test("master: the stack moves up and down, and sideways back to the main window", () => {
    const { rects } = tile(3, "master", 0.6, 1200, 800, 12);
    expect(neighbour(rects, 1, 0, 1)).toBe(2);
    expect(neighbour(rects, 1, 0, -1)).toBe(-1);
    expect(neighbour(rects, 2, 0, -1)).toBe(1);
    expect(neighbour(rects, 2, -1, 0)).toBe(0);
    expect(neighbour(rects, 1, 1, 0)).toBe(-1);
  });

  test("grid: rows move sideways, columns up and down, never diagonally", () => {
    const { rects } = tile(4, "grid", 0.6, 1200, 800, 12);
    expect(neighbour(rects, 0, 1, 0)).toBe(1);
    expect(neighbour(rects, 0, 0, 1)).toBe(2);
    expect(neighbour(rects, 0, 1, 1)).toBe(-1); // no diagonal
    expect(neighbour(rects, 3, 0, -1)).toBe(1);
    expect(neighbour(rects, 3, -1, 0)).toBe(2);
    expect(neighbour(rects, 2, 1, 0)).toBe(3);
    expect(neighbour(rects, 1, 0, 1)).toBe(3);
  });

  test("mono carousel: the peeks are left and right, and nothing is above", () => {
    const { rects } = tile(3, "mono", 0.6, 1200, 800, 12, -1, 1);
    expect(neighbour(rects, 1, -1, 0)).toBe(0);
    expect(neighbour(rects, 1, 1, 0)).toBe(2);
    expect(neighbour(rects, 1, 0, -1)).toBe(-1);
    expect(neighbour(rects, 1, 0, 1)).toBe(-1);
  });

  test("hidden windows (a zero-size rect) are not neighbours", () => {
    const rects = at([{ x: 12, y: 12, w: 500, h: 700 }], 512, 12, 0, 700);
    expect(neighbour(rects, 0, 1, 0)).toBe(-1);
  });

  test("a rect that only touches at a corner is not a neighbour", () => {
    const rects = [{ x: 0, y: 0, w: 400, h: 300 }, { x: 412, y: 312, w: 400, h: 300 }];
    expect(neighbour(rects, 0, 1, 0)).toBe(-1);
    expect(neighbour(rects, 0, 0, 1)).toBe(-1);
  });
});
