// Plan usage in the status line, under each app's own icon: the 5-hour session and
// weekly limits of Claude (`claude_usage`) and of Command Code (`command_code_usage`,
// whose credit pool comes with it), each read with that app's own login. Command
// Code's block stays hidden until it has numbers, since most machines have no login.

import { invoke } from "@tauri-apps/api/core";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./lucide";

type Window = { percent: number; resetsAt: string | null };
/** Command Code's pool: dollars left, and the plan's grant they come out of. */
type Credits = { remaining: number; total: number };
type Usage = { session: Window | null; weekly: Window | null; credits?: Credits };

const POLL_MS = 5 * 60_000;
// Ticks every minute so reset countdowns stay current between fetches.
const [now, setNow] = createSignal(Date.now());

/** "2h 14m", "3d 4h", or "" when unknown or past. */
function untilReset(at: string | null): string {
  if (!at) return "";
  const mins = Math.round((Date.parse(at) - now()) / 60_000);
  if (!(mins > 0)) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "$52.7", "$70": a tenth below $100, whole dollars above it. */
const money = (n: number) => `$${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10}`;

function Meter(props: { label: string; w: Window }) {
  const pct = () => Math.round(props.w.percent);
  const level = () => (pct() >= 90 ? "bad" : pct() >= 70 ? "warn" : "ok");
  const reset = () => untilReset(props.w.resetsAt);
  return (
    <span class="meter" data-level={level()} title={`${props.label}: ${pct()}% used${reset() ? `, resets in ${reset()}` : ""}`}>
      {props.label}
      <i style={{ "--pct": `${Math.min(100, pct())}%` }} />
      <b>{pct()}%</b>
      <Show when={reset()}>
        <em>{reset()}</em>
      </Show>
    </span>
  );
}

/** The credit pool, drawn like the limits: the bar fills as it is spent, the text says what is left. */
function CreditsMeter(props: { c: Credits }) {
  const spent = () => (props.c.total > 0 ? Math.min(100, Math.max(0, ((props.c.total - props.c.remaining) / props.c.total) * 100)) : 0);
  const level = () => (spent() >= 90 ? "bad" : spent() >= 70 ? "warn" : "ok");
  const title = () => `credits: $${props.c.remaining.toFixed(2)} left of $${props.c.total.toFixed(2)}`;
  return (
    <span class="meter" data-level={level()} title={title()}>
      <i style={{ "--pct": `${spent()}%` }} />
      <b>{money(props.c.remaining)}</b>
      <em>/{money(props.c.total)}</em>
    </span>
  );
}

export default function ClaudeUsage() {
  return <Meters name="Claude" icon="asterisk" load={() => invoke<Usage>("claude_usage")} />;
}

/** Command Code's limits, from the billing surface its own `/usage` reads. Quiet: an app you may
 *  not be signed in to, so it says nothing until it has numbers. */
export const CommandCodeUsage = () => (
  <Meters name="Command Code" icon="command" load={() => invoke<Usage>("command_code_usage")} quiet />
);

/** One provider's meters: fetched on mount, every 5 minutes, and on click. `quiet` renders nothing
 *  until it has data, so a missing login is not an error on screen. */
function Meters(props: { name: string; icon: string; load: () => Promise<Usage>; quiet?: boolean }) {
  const [usage, setUsage] = createSignal<Usage | null>(null);
  const [error, setError] = createSignal("");

  const refresh = () =>
    props
      .load()
      .then((u) => {
        setUsage(u);
        setError("");
      })
      .catch((e) => setError(String(e)));

  onMount(() => {
    refresh();
    const poll = setInterval(refresh, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => {
      clearInterval(poll);
      clearInterval(clock);
    });
  });

  return (
    <Show when={!props.quiet || usage()}>
      <button
        class="usage"
        aria-label={`${props.name} usage`}
        title={error() ? `${props.name} usage unavailable: ${error()}` : `${props.name} usage · click to refresh`}
        onClick={refresh}
      >
        <span class="who">
          <Icon name={props.icon} size={12} />
        </span>
        <Show when={usage()} fallback={<span class="na">{error() ? "unavailable" : "…"}</span>}>
          {(u) => (
            <>
              <Show when={u().session}>{(w) => <Meter label="session" w={w()} />}</Show>
              <Show when={u().weekly}>{(w) => <Meter label="week" w={w()} />}</Show>
              <Show when={u().credits}>{(c) => <CreditsMeter c={c()} />}</Show>
            </>
          )}
        </Show>
      </button>
    </Show>
  );
}
