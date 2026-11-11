// bun test: the weekly pace target (src/pace.ts).

import { describe, expect, test } from "bun:test";
import { weekTarget } from "./pace";

const H = 3_600_000;
const now = Date.parse("2026-11-11T12:00:00Z");
const resetIn = (h: number) => new Date(now + h * H).toISOString();

describe("weekTarget", () => {
  test("off without a daily target or a reset time", () => {
    expect(weekTarget(undefined, resetIn(100), now)).toBeUndefined();
    expect(weekTarget(0, resetIn(100), now)).toBeUndefined();
    expect(weekTarget(14, null, now)).toBeUndefined();
    expect(weekTarget(14, "nonsense", now)).toBeUndefined();
  });

  test("per day counts the current day in full", () => {
    // Resets in 4d 11h: 2d 13h into the week, so day 3.
    expect(weekTarget(14, resetIn(107), now)).toBe(42);
    // Just reset: day 1's allowance.
    expect(weekTarget(14, resetIn(167.9), now)).toBe(14);
    // Last day.
    expect(weekTarget(14, resetIn(1), now)).toBe(98);
  });

  test("smooth counts by the minute", () => {
    expect(weekTarget(14, resetIn(108), now, "smooth")).toBeCloseTo(35);
    expect(weekTarget(14, resetIn(168), now, "smooth")).toBe(0);
  });

  test("caps at 100, and clamps a reset that is past or more than a week out", () => {
    expect(weekTarget(20, resetIn(1), now)).toBe(100);
    expect(weekTarget(14, resetIn(-5), now)).toBe(98);
    expect(weekTarget(14, resetIn(200), now)).toBe(14);
  });
});
