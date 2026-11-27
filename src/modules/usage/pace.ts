// The weekly pace target: how much of a weekly limit you mean to have used by now, given a daily
// budget (Settings › Windows › Status line). Days count from the week's start, which is 7 days
// before it resets, not from local midnight.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** % of the weekly limit allowed by `now`: `daily` × days into the week, capped at 100. "day" counts
 *  the current day in full (the line jumps at each day boundary); "smooth" counts it by the minute.
 *  Undefined when there is no target, or no reset time to measure the week from. */
export function weekTarget(daily: number | undefined, resetsAt: string | null, now: number, pace: "day" | "smooth" = "day"): number | undefined {
  if (!daily || daily <= 0 || !resetsAt) return undefined;
  const reset = Date.parse(resetsAt);
  if (Number.isNaN(reset)) return undefined;
  const elapsed = Math.min(WEEK_MS, Math.max(0, WEEK_MS - (reset - now)));
  const days = pace === "smooth" ? elapsed / DAY_MS : Math.min(7, Math.floor(elapsed / DAY_MS) + 1);
  return Math.min(100, daily * days);
}
