// The diff body: unified (stacked) or split (side by side), from a unified patch. One renderer
// for the git window and the editor's own changes view, so both read the same.
// Chosen from design/diff.html (variant A): the toggle is in the header the caller draws.

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import {
  type DiffMode, type Row, type SplitRow, MAX_DIFF_LINES, parseUnified, pairMarks, splitRows,
} from "./diff";
import "./diff.css";

export type Drill = (line: number, hunk: number, how: { diff: boolean }) => void;

/** What Alt+D (keymap "diff") does in each window, by tab id; false lets the key through. */
export const diffKeys = new Map<string, () => boolean>();

/** Where `el` sits in `scroll`'s viewport, in px from its top. */
const offsetIn = (scroll: HTMLElement, el: Element) => el.getBoundingClientRect().top - scroll.getBoundingClientRect().top;

/** Bring the next (1) or previous (-1) hunk to the top of the diff, from where it is scrolled to now. */
export function stepHunk(scroll: HTMLElement, d: 1 | -1): HTMLElement | null {
  const heads = [...scroll.querySelectorAll<HTMLElement>(".dv-hunk")];
  // A header within a few px of the top (its own margin) counts as the one shown now.
  const to = d > 0 ? heads.find((h) => offsetIn(scroll, h) > 10) : heads.reverse().find((h) => offsetIn(scroll, h) < -2);
  if (!to) return null;
  scroll.scrollTop += offsetIn(scroll, to);
  return to;
}

/** Why a patch has no hunks to show. */
function emptyNote(text: string): string {
  if (!text) return "No changes.";
  const from = /^rename from (.*)$/m.exec(text)?.[1];
  if (from) return `Renamed from ${from}, no content change.`;
  if (/^Binary files /m.test(text)) return "Binary file changed.";
  return "Mode-only change.";
}

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
        "s-add": props.row.kind === "add",
        "s-del": props.row.kind === "del",
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
        <span class="tx"><span class="ti"><Marked parts={both()?.a} text={props.row.left?.text ?? ""} /></span></span>
      </div>
      <div class="dv-half r" classList={{ blank: !props.row.right }}>
        <span class="ln">{props.row.right?.new ?? ""}</span>
        <span class="mk">{props.row.right?.t === "+" ? "+" : ""}</span>
        <span class="tx"><span class="ti"><Marked parts={both()?.b} text={props.row.right?.text ?? ""} /></span></span>
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
  /** The U / S keys switch orientation through this. */
  onMode?: (m: DiffMode) => void;
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

  // Split: each side scrolls sideways on its own, from its own bar under the diff. The rows keep both halves
  // (so they stay lined up as the diff scrolls down); a side's text moves by --sx-l / --sx-r.
  let barL: HTMLDivElement | undefined, barR: HTMLDivElement | undefined;
  /** How far each side's longest line runs past its half, px; 0 when every line fits. */
  const [wide, setWide] = createSignal<[number, number]>([0, 0]);
  const measure = () => {
    if (!scroll || props.mode !== "split") return setWide([0, 0]);
    const side = (s: "l" | "r") => {
      const tx = scroll!.querySelector<HTMLElement>(`.dv-half.${s} > .tx`);
      if (!tx) return 0;
      let max = 0;
      for (const ti of scroll!.querySelectorAll<HTMLElement>(`.dv-half.${s} .ti`)) max = Math.max(max, ti.offsetWidth);
      return Math.max(0, Math.ceil(max - tx.clientWidth));
    };
    const w: [number, number] = [side("l"), side("r")];
    // a side that fits again has no bar to bring its text back, so put it back here
    if (!w[0]) scroll.style.setProperty("--sx-l", "0");
    if (!w[1]) scroll.style.setProperty("--sx-r", "0");
    setWide(w);
  };
  const slide = (s: "l" | "r", bar?: HTMLDivElement) => scroll?.style.setProperty(`--sx-${s}`, String(bar?.scrollLeft ?? 0));
  createEffect(on(() => props.text, () => {
    if (barL) barL.scrollLeft = 0;
    if (barR) barR.scrollLeft = 0;
    slide("l"); slide("r");
  }));
  createEffect(on(() => [model(), props.mode, props.error] as const, () => requestAnimationFrame(measure)));
  onMount(() => {
    const ro = new ResizeObserver(() => measure());
    if (scroll) ro.observe(scroll);
    onCleanup(() => ro.disconnect());
  });
  /** A sideways wheel (or Shift+wheel) over a half scrolls that side. */
  const onWheel = (e: WheelEvent) => {
    if (props.mode !== "split") return;
    // mostly-sideways only, so a diagonal trackpad swipe still scrolls down
    const dx = e.shiftKey ? e.deltaX || e.deltaY : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
    if (!dx) return;
    const bar = (e.target as Element).closest(".dv-half.r") ? barR : barL;
    if (!bar) return;
    bar.scrollLeft += dx;
    e.preventDefault();
  };

  createEffect(on(
    () => [props.focusLine, props.text, props.mode, props.error] as const,
    () => {
      const line = props.focusLine;
      if (!line || !scroll) return;
      requestAnimationFrame(() => {
        const el = scroll?.querySelector(`[data-anchor="${line}"]`);
        if (!el || !scroll) return;
        scroll.scrollTop += offsetIn(scroll, el) - scroll.clientHeight / 2;
        setSel(line);
      });
    },
  ));

  const select = (at: number) => setSel(at);
  const drill: Drill = (line, hunk, how) => props.onDrill?.(line, hunk, how);

  /** The rows in screen order, one per drill target (a deletion shares its line's). */
  const rowEls = () => {
    const seen = new Set<string>();
    return [...(scroll?.querySelectorAll<HTMLElement>(".dv-urow, .dv-srow") ?? [])].filter((el) => {
      const a = el.dataset.anchor ?? "";
      if (seen.has(a)) return false;
      seen.add(a);
      return true;
    });
  };
  const show = (el: HTMLElement) => {
    if (!scroll) return;
    const y = offsetIn(scroll, el);
    if (y < 0) scroll.scrollTop += y;
    else if (y + el.offsetHeight > scroll.clientHeight) scroll.scrollTop += y + el.offsetHeight - scroll.clientHeight;
    setSel(Number(el.dataset.anchor));
  };
  /** First changed row at or after a hunk header. */
  const changedAfter = (head: Element) => {
    for (let el = head.nextElementSibling; el && !el.classList.contains("dv-hunk"); el = el.nextElementSibling) {
      if (el.matches(".dv-urow.a, .dv-urow.d, .dv-srow.s-add, .dv-srow.s-del, .dv-srow.mod-l")) return el as HTMLElement;
    }
    return null;
  };

  /** J/K or ↓/↑ a line, N/P a hunk, Enter opens the line (Shift+Enter in the editor's diff), U/S orientation. */
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !scroll) return;
    const k = e.key.toLowerCase();
    if (k === "j" || k === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = rowEls();
      if (!rows.length) return;
      const i = rows.findIndex((el) => Number(el.dataset.anchor) === sel());
      const down = k === "j" || e.key === "ArrowDown";
      show(rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (down ? 1 : -1)))]);
    } else if (k === "n" || k === "p" || e.key === "]" || e.key === "[") {
      const head = stepHunk(scroll, k === "n" || e.key === "]" ? 1 : -1);
      const row = head && changedAfter(head);
      if (row) setSel(Number(row.dataset.anchor));
    } else if (e.key === "Enter") {
      const at = sel();
      const row = at != null ? scroll.querySelector<HTMLElement>(`[data-anchor="${at}"]`) : null;
      if (!row) return;
      drill(at!, Number(row.dataset.hunk), { diff: e.shiftKey });
    } else if ((k === "u" || k === "s") && props.onMode && !e.shiftKey) {
      props.onMode(k === "u" ? "unified" : "split");
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
    <div
      class="dv-scroll"
      tabIndex={0}
      aria-label="Diff: J and K move a line, N and P a hunk, Enter opens the line, U and S switch unified or split"
      onKeyDown={onKey}
      onWheel={onWheel}
      ref={(el) => { scroll = el; props.ref?.(el); }}
    >
      <Show when={!props.error} fallback={<div class="dv-note bad">{props.error}</div>}>
        <Show when={props.text !== undefined} fallback={<div class="dv-note">Loading…</div>}>
          <Show when={model().length} fallback={<div class="dv-note">{emptyNote(props.text ?? "")}</div>}>
            <div class="dv-content" classList={{ sbs: props.mode === "split" }}>
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
    <Show when={props.mode === "split" && (wide()[0] || wide()[1])}>
      <div class="dv-hbars">
        <div ref={barL} onScroll={() => slide("l", barL)}><div style={{ width: `calc(100% + ${wide()[0]}px)` }} /></div>
        <div ref={barR} onScroll={() => slide("r", barR)}><div style={{ width: `calc(100% + ${wide()[1]}px)` }} /></div>
      </div>
    </Show>
    </>
  );
}
