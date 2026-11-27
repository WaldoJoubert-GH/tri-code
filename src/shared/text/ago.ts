// How long ago something happened, worded by the platform (Intl) rather than by hand, so every
// window says it the same way. English to match the rest of the UI.
//
//   age(at)          "now", "5m", "3h", "2d"                  a chip beside a name
//   ago(at)          "now", "5m ago", "3h ago", "2d ago"      a status line
//   ago(at, "long")  "now", "5 minutes ago", "2 days ago"     a sentence

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Unit = "minute" | "hour" | "day";

/** The largest whole unit in `ms`, or null under a minute. */
function span(ms: number): [number, Unit] | null {
  if (ms < MIN) return null;
  if (ms < HOUR) return [Math.floor(ms / MIN), "minute"];
  if (ms < DAY) return [Math.floor(ms / HOUR), "hour"];
  return [Math.floor(ms / DAY), "day"];
}

const rel = {
  narrow: new Intl.RelativeTimeFormat("en", { style: "narrow" }),
  long: new Intl.RelativeTimeFormat("en", { style: "long" }),
};
const now0 = new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(0, "second"); // "now"
const dur = new Intl.DurationFormat("en", { style: "narrow" });

/** "now", "5m", "3h", "2d": the time since `at` (ms since the epoch), without "ago". */
export function age(at: number, now = Date.now()): string {
  const s = span(Math.max(0, now - at));
  return s ? dur.format({ [`${s[1]}s`]: s[0] }) : now0;
}

/** "now", "5m ago", "3h ago", "2d ago"; with `long`, "5 minutes ago". `at` is ms since the epoch. */
export function ago(at: number, style: "narrow" | "long" = "narrow", now = Date.now()): string {
  const s = span(Math.max(0, now - at));
  return s ? rel[style].format(-s[0], s[1]) : now0;
}
