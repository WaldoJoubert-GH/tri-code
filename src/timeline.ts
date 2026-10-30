// The Issues Panel's Timeline: where each issue's bar sits, in whole days. Chosen from
// design/issues-gantt.html (variant A, "split"). Pure, so it is tested without the panel.
//
// A Plane Issue's Start Date and Target Date place its bar. Where one is missing, and for
// GitHub and Local Issues, which have neither, the bar is derived: it starts on the created
// date and ends on the closed date (the last update of a closed issue) or today. Only Plane
// dates can be written back, so only Plane bars move.

import { type DevState, type UnifiedIssue, isActive } from "./issues";

const DAY = 86_400_000;

/** Whole days since 1970-01-01 for an ISO date or timestamp (its date part, as written). */
export const dayOf = (iso: string): number => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
/** The ISO date (`YYYY-MM-DD`) of a day number. */
export const isoOf = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10);
/** Today, as the panel's late check counts it. */
export const todayDay = (): number => dayOf(new Date().toISOString());

/** A bar: its first and last day (inclusive), and whether each end is a set date or derived. */
export type Span = { start: number; end: number; startSet: boolean; endSet: boolean };

export function spanOf(state: DevState | undefined, issue: UnifiedIssue, today: number): Span | null {
  if (issue.source === "sentry") return null;
  const start = issue.source === "plane" && issue.start_date ? issue.start_date : undefined;
  const target = issue.source === "plane" && issue.target_date ? issue.target_date : undefined;
  const created = issue.created_at ?? issue.updated_at;
  const s = start ? dayOf(start) : created ? dayOf(created) : undefined;
  const e = target ? dayOf(target) : isActive(state, issue) ? today : dayOf(issue.updated_at);
  if (s === undefined) return target ? { start: e, end: e, startSet: false, endSet: true } : null;
  return { start: Math.min(s, e), end: Math.max(s, e), startSet: !!start, endSet: !!target };
}

/** Days a set Target Date has passed while the issue is still open; 0 when not late. */
export function daysLate(state: DevState | undefined, issue: UnifiedIssue, today: number): number {
  if (issue.source !== "plane" || !issue.target_date || !isActive(state, issue)) return 0;
  return Math.max(0, today - dayOf(issue.target_date));
}

/** The days the Timeline shows: every bar and today, with room either side, Monday to Sunday. */
export function rangeOf(spans: (Span | null)[], today: number): { from: number; days: number } {
  let lo = today - 14, hi = today + 28;
  for (const s of spans) if (s) { lo = Math.min(lo, s.start - 7); hi = Math.max(hi, s.end + 14); }
  // 1970-01-01 was a Thursday, so day 4 is a Monday
  const from = lo - ((((lo - 4) % 7) + 7) % 7);
  const to = hi + (6 - ((((hi - 4) % 7) + 7) % 7));
  return { from, days: to - from + 1 };
}

/** What dragging a bar does, by `dd` days: the body moves both ends, an end moves only itself. */
export type Grip = "move" | "start" | "end";
export function dragged(span: Span, grip: Grip, dd: number): { start: number; end: number } {
  if (grip === "move") return { start: span.start + dd, end: span.end + dd };
  if (grip === "start") return { start: Math.min(span.start + dd, span.end), end: span.end };
  return { start: span.start, end: Math.max(span.end + dd, span.start) };
}
