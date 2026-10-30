// bun test: where the Issues Panel's Timeline puts each bar (src/timeline.ts).

import { describe, expect, test } from "bun:test";
import { type DevState, type UnifiedIssue } from "./issues";
import { dayOf, daysLate, dragged, isoOf, rangeOf, spanOf } from "./timeline";

const states = [
  { id: "t", name: "Todo", color: "#3f76ff", group: "unstarted" },
  { id: "d", name: "Done", color: "#16a34a", group: "completed" },
];

const state = { loaded: true, states, config: { sources: ["plane", "github", "local"] } } as unknown as DevState;
const today = dayOf("2026-10-30");

const plane = (over: Record<string, unknown>): UnifiedIssue => ({
  source: "plane", id: "u1", sequence_id: 1, title: "t", state_id: "t", state_group: "unstarted", link: "",
  created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-20T09:00:00Z", ...over,
}) as UnifiedIssue;

describe("dayOf / isoOf", () => {
  test("round-trip a date, and read a timestamp by its date part", () => {
    expect(isoOf(dayOf("2026-10-30"))).toBe("2026-10-30");
    expect(dayOf("2026-10-30T23:59:00Z")).toBe(dayOf("2026-10-30"));
  });
});

describe("spanOf", () => {
  test("a Plane Issue's Start and Target Dates place the bar", () => {
    const s = spanOf(state, plane({ start_date: "2026-10-26", target_date: "2026-11-09" }), today);
    expect(s).toEqual({ start: dayOf("2026-10-26"), end: dayOf("2026-11-09"), startSet: true, endSet: true });
  });

  test("a missing start is the created date; a missing target on an open issue is today", () => {
    const s = spanOf(state, plane({}), today)!;
    expect([isoOf(s.start), isoOf(s.end), s.startSet, s.endSet]).toEqual(["2026-10-01", "2026-10-30", false, false]);
  });

  test("a closed issue without a target ends on its last update", () => {
    const s = spanOf(state, plane({ state_id: "d", state_group: "completed" }), today)!;
    expect(isoOf(s.end)).toBe("2026-10-20");
  });

  test("a target before the created date still makes a bar, not a negative one", () => {
    const s = spanOf(state, plane({ target_date: "2026-09-20" }), today)!;
    expect([isoOf(s.start), isoOf(s.end)]).toEqual(["2026-09-20", "2026-10-01"]);
  });

  test("GitHub and Local issues run from created to closed or today; Sentry has no bar", () => {
    const gh = { source: "github", number: 5, title: "g", state: "closed", link: "", created_at: "2026-10-02", updated_at: "2026-10-09" } as UnifiedIssue;
    const s = spanOf(state, gh, today)!;
    expect([isoOf(s.start), isoOf(s.end)]).toEqual(["2026-10-02", "2026-10-09"]);
    expect(spanOf(state, { source: "sentry", title: "s", link: "", updated_at: "2026-10-01" } as UnifiedIssue, today)).toBeNull();
  });
});

describe("daysLate", () => {
  test("counts days past a set Target Date while open, never for a finished issue", () => {
    expect(daysLate(state, plane({ target_date: "2026-10-28" }), today)).toBe(2);
    expect(daysLate(state, plane({ target_date: "2026-11-28" }), today)).toBe(0);
    expect(daysLate(state, plane({ target_date: "2026-10-28", state_id: "d", state_group: "completed" }), today)).toBe(0);
  });
});

describe("rangeOf", () => {
  test("covers every bar and today with room, from a Monday to a Sunday", () => {
    const r = rangeOf([{ start: dayOf("2026-09-15"), end: dayOf("2026-12-01"), startSet: true, endSet: true }, null], today);
    expect(new Date(r.from * 86_400_000).getUTCDay()).toBe(1);
    expect(new Date((r.from + r.days - 1) * 86_400_000).getUTCDay()).toBe(0);
    expect(r.from).toBeLessThanOrEqual(dayOf("2026-09-08"));
    expect(r.from + r.days - 1).toBeGreaterThanOrEqual(dayOf("2026-12-15"));
  });
});

describe("dragged", () => {
  const s = { start: 10, end: 20, startSet: true, endSet: true };
  test("the body moves both ends; an end moves alone and never past the other", () => {
    expect(dragged(s, "move", 3)).toEqual({ start: 13, end: 23 });
    expect(dragged(s, "start", -2)).toEqual({ start: 8, end: 20 });
    expect(dragged(s, "start", 15)).toEqual({ start: 20, end: 20 });
    expect(dragged(s, "end", -30)).toEqual({ start: 10, end: 10 });
  });
});
