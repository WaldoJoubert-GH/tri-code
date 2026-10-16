// Claude plan usage in the status line: the 5-hour session and weekly limits,
// fetched by the `claude_usage` command with Claude Code's own login.

import { invoke } from "@tauri-apps/api/core";
import { Show, createSignal, onCleanup, onMount } from "solid-js";

type Window = { percent: number; resetsAt: string | null };
type Usage = { session: Window | null; weekly: Window | null };

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

export default function ClaudeUsage() {
  const [usage, setUsage] = createSignal<Usage | null>(null);
  const [error, setError] = createSignal("");

  const refresh = () =>
    invoke<Usage>("claude_usage")
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
    <button class="usage" title={error() ? `Claude usage unavailable: ${error()}` : "Claude usage · click to refresh"} onClick={refresh}>
      <span class="who">Claude</span>
      <Show when={usage()} fallback={<span class="na">{error() ? "unavailable" : "…"}</span>}>
        {(u) => (
          <>
            <Show when={u().session}>{(w) => <Meter label="session" w={w()} />}</Show>
            <Show when={u().weekly}>{(w) => <Meter label="week" w={w()} />}</Show>
          </>
        )}
      </Show>
    </button>
  );
}
