// The diff body: unified (stacked) or split (side by side), from a unified patch. One renderer
// for the git window and the editor's own changes view, so both read the same.
// Chosen from design/diff.html (variant A): the toggle is in the header the caller draws.

import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import {
  type DiffMode, type Row, type SplitRow, MAX_DIFF_LINES, parseUnified, pairMarks, splitRows,
} from "./diff";
import "./diff.css";

export type Drill = (line: number, hunk: number, how: { diff: boolean }) => void;

/** The part of a paired line that actually changed. */
function Marked(props: { parts?: [string, string, string]; text: string }): JSX.Element {
  return (
    <Show when={props.parts} fallback={<>{props.text}</>}>
      {(p) => <>{p()[0]}<mark class="chg">{p()[1]}</mark>{p()[2]}</>}
    </Show>
  );
}

function UnifiedRow(props: {
  row: Row; at: number; hunk: number; selected: boolean; onSelect: (at: number) => void; onDrill: Drill;
}): JSX.Element {
  const kind = () => (props.row.t === "+" ? "a" : props.row.t === "-" ? "d" : "");
  const pick = (e: MouseEvent) => props.onDrill(props.at, props.hunk, { diff: e.shiftKey });
  return (
    <div
      class="dv-urow"
      classList={{ a: kind() === "a", d: kind() === "d", sel: props.selected }}
      data-anchor={props.at}
      data-hunk={props.hunk}
      onClick={() => props.onSelect(props.at)}
      onDblClick={(e) => { pick(e); e.preventDefault(); }}
    >
      <span class="ln">{props.row.old ?? ""}</span>
      <span class="ln">{props.row.new ?? ""}</span>
      <span class="mk">{props.row.t === "+" ? "+" : props.row.t === "-" ? "−" : ""}</span>
      <span class="tx">{props.row.text}</span>
    </div>
  );
}

function SplitRowView(props: {
  row: SplitRow; hunk: number; selected: boolean; onSelect: (at: number) => void; onDrill: Drill;
}): JSX.Element {
  const both = () => (props.row.left && props.row.right && props.row.kind === "mod"
    ? pairMarks(props.row.left.text, props.row.right.text)
    : null);
  const pick = (e: MouseEvent) => props.onDrill(props.row.anchor, props.hunk, { diff: e.shiftKey });
  return (
    <div
      class="dv-srow"
      classList={{
        "mod-l": props.row.kind === "mod",
        add: props.row.kind === "add",
        del: props.row.kind === "del",
        sel: props.selected,
      }}
      data-anchor={props.row.anchor}
      data-hunk={props.hunk}
      onClick={() => props.onSelect(props.row.anchor)}
      onDblClick={(e) => { pick(e); e.preventDefault(); }}
    >
      <div class="dv-half l" classList={{ blank: !props.row.left }}>
        <span class="ln">{props.row.left?.old ?? ""}</span>
        <span class="mk">{props.row.left?.t === "-" ? "−" : ""}</span>
        <span class="tx"><Marked parts={both()?.a} text={props.row.left?.text ?? ""} /></span>
      </div>
      <div class="dv-half r" classList={{ blank: !props.row.right }}>
        <span class="ln">{props.row.right?.new ?? ""}</span>
        <span class="mk">{props.row.right?.t === "+" ? "+" : ""}</span>
        <span class="tx"><Marked parts={both()?.b} text={props.row.right?.text ?? ""} /></span>
      </div>
    </div>
  );
}

export default function DiffView(props: {
  /** The unified patch. `undefined` means it is still loading; `""` means nothing changed. */
  text?: string;
  error?: string;
  mode: DiffMode;
  /** Scroll this new-side line into view when the patch renders (a drill from the git window). */
  focusLine?: number;
  onDrill?: Drill;
  /** Gives the caller the scroller, for its hunk navigation. */
  ref?: (el: HTMLDivElement) => void;
}): JSX.Element {
  let scroll: HTMLDivElement | undefined;
  const [sel, setSel] = createSignal<number | null>(null);

  const clipped = createMemo(() => {
    const all = (props.text ?? "").split("\n");
    return { text: all.slice(0, MAX_DIFF_LINES).join("\n"), more: all.length > MAX_DIFF_LINES };
  });
  const hunks = createMemo(() => parseUnified(clipped().text));

  /** Both orientations from one parse; unified rows carry their own drill anchor. */
  const model = createMemo(() => hunks().map((h, hi) => {
    let nextNew = h.newStart;
    const unified = h.rows.map((r) => {
      const at = r.t === "-" ? nextNew : r.new ?? nextNew;
      if (r.t !== "-" && r.new != null) nextNew = r.new + 1;
      return { row: r, at };
    });
    return { h, hi, unified, split: splitRows(h) };
  }));

  createEffect(on(() => props.text, () => setSel(null)));

  createEffect(on(
    () => [props.focusLine, props.text, props.mode, props.error] as const,
    () => {
      const line = props.focusLine;
      if (!line || !scroll) return;
      requestAnimationFrame(() => {
        const el = scroll?.querySelector(`[data-anchor="${line}"]`);
        if (el) el.scrollIntoView({ block: "center" });
      });
    },
  ));

  const select = (at: number) => setSel(at);
  const drill: Drill = (line, hunk, how) => props.onDrill?.(line, hunk, how);

  return (
    <div class="dv-scroll" ref={(el) => { scroll = el; props.ref?.(el); }}>
      <Show when={!props.error} fallback={<div class="dv-note bad">{props.error}</div>}>
        <Show when={props.text !== undefined} fallback={<div class="dv-note">Loading…</div>}>
          <Show when={model().length} fallback={<div class="dv-note">{props.text ? "Binary or mode-only change." : "No changes."}</div>}>
            <div class="dv-content" classList={{ split: props.mode === "split" }}>
              <For each={model()}>
                {(h) => (
                  <>
                    <div class="dv-hunk" data-hunk={h.hi}>{h.h.head}</div>
                    <Show
                      when={props.mode === "split"}
                      fallback={
                        <For each={h.unified}>
                          {(u) => (
                            <UnifiedRow
                              row={u.row} at={u.at} hunk={h.hi}
                              selected={sel() === u.at} onSelect={select} onDrill={drill}
                            />
                          )}
                        </For>
                      }
                    >
                      <For each={h.split}>
                        {(row) => (
                          <SplitRowView
                            row={row} hunk={h.hi}
                            selected={!!sel() && sel() === row.anchor} onSelect={select} onDrill={drill}
                          />
                        )}
                      </For>
                    </Show>
                  </>
                )}
              </For>
            </div>
            <Show when={clipped().more}>
              <div class="dv-note">… diff cut at {MAX_DIFF_LINES} lines</div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
