// The Editor Window's Table mode (design/csv-xlsx.html, variant C): a CSV or TSV file as an
// editable grid over the text buffer (csv.ts), and a workbook (.xlsx, .xls, .ods) as read-only
// sheets read through Rust (db/sheet.rs). "Open in Database" takes either to a Database Window
// for SQL. Rows are drawn only where the grid is scrolled to, so a 1 MB file stays quick.

import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "./state";
import { type Change, addRowChange, columnNames, deleteRowChange, isNumber, parseCsv, setCellChange } from "./csv";
import { type Cell, cellText } from "./dbsql";
import { copyText } from "./clipboard";
import { flash } from "./ui";
import "./db.css";
import "./sheet.css";

/** Row height in px: `.sheet-grid td` is drawn to exactly this. */
const ROW = 24;
/** Rows drawn above and below what is on screen. */
const OVERSCAN = 12;

type GridCol = { name: string; type?: string };

type GridProps = {
  cols: GridCol[];
  rows: number;
  /** A cell's text, or null for an empty one. */
  cell: (r: number, c: number) => string | null;
  /** What the row-number column shows. */
  label: (r: number) => string;
  /** Why a cell can't be edited, or null when it can. */
  locked: (r: number, c: number) => string | null;
  onEdit?: (r: number, c: number, value: string) => void;
  empty: string;
  /** The text an empty cell shows: blank in a CSV, NULL in a workbook. */
  nul: string;
};

function Grid(props: GridProps): JSX.Element {
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [sel, setSel] = createSignal({ r: 0, c: 0 });
  const [editing, setEditing] = createSignal<{ r: number; c: number; init?: string } | null>(null);

  onMount(() => {
    const ro = new ResizeObserver(([e]) => setHeight(e.contentRect.height));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  const first = () => Math.max(0, Math.floor(top() / ROW) - OVERSCAN);
  const last = () => Math.min(props.rows, Math.ceil((top() + height()) / ROW) + OVERSCAN);
  const shown = createMemo(() => Array.from({ length: Math.max(0, last() - first()) }, (_, i) => first() + i));

  const scrollTo = (r: number) => {
    const y = r * ROW;
    // The header row is sticky: keep the cell below it.
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW * 2 > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW * 2 - el.clientHeight;
    requestAnimationFrame(() => el.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${sel().c}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };
  const move = (dr: number, dc: number) => {
    const r = Math.max(0, Math.min(props.rows - 1, sel().r + dr));
    const c = Math.max(0, Math.min(props.cols.length - 1, sel().c + dc));
    setSel({ r, c });
    scrollTo(r);
  };
  const startEdit = (init?: string) => {
    const { r, c } = sel();
    if (r >= props.rows || !props.onEdit) return;
    const why = props.locked(r, c);
    if (why) return void flash(why);
    setEditing({ r, c, init });
  };
  const commit = (value: string | null, then?: () => void) => {
    const e = editing();
    setEditing(null);
    if (e && value !== null) props.onEdit?.(e.r, e.c, value);
    then?.();
    el.focus({ preventScroll: true });
  };

  const onKey = (e: KeyboardEvent) => {
    if (editing() || e.altKey) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void copyText(props.cell(sel().r, sel().c) ?? "");
      return;
    }
    if (mod) return;
    const keys: Record<string, () => void> = {
      ArrowUp: () => move(-1, 0), ArrowDown: () => move(1, 0), ArrowLeft: () => move(0, -1), ArrowRight: () => move(0, 1),
      Home: () => move(0, -1e9), End: () => move(0, 1e9), PageUp: () => move(-Math.floor(height() / ROW), 0), PageDown: () => move(Math.floor(height() / ROW), 0),
      Enter: () => startEdit(), F2: () => startEdit(),
      Delete: () => (props.onEdit && !props.locked(sel().r, sel().c) ? props.onEdit(sel().r, sel().c, "") : undefined),
    };
    const k = keys[e.key];
    if (k) { e.preventDefault(); k(); return; }
    // Typing over a cell starts an edit with what was typed.
    if (e.key.length === 1 && props.onEdit) { e.preventDefault(); startEdit(e.key); }
  };

  return (
    <div class="db-grid sheet-grid" ref={el} tabindex="0" onScroll={(e) => setTop(e.currentTarget.scrollTop)} onKeyDown={onKey}>
      <table>
        <thead>
          <tr>
            <th class="rn">#</th>
            <For each={props.cols}>
              {(c) => <th><div class="h">{c.name}<Show when={c.type}><span class="t">{c.type!.toLowerCase()}</span></Show></div></th>}
            </For>
          </tr>
        </thead>
        <tbody>
          <tr class="sg-pad" style={{ height: `${first() * ROW}px` }} />
          <For each={shown()}>
            {(r) => (
              <tr>
                <td class="rn">{props.label(r)}</td>
                <For each={props.cols}>
                  {(_, ci) => {
                    const v = () => props.cell(r, ci());
                    const isEd = () => editing()?.r === r && editing()?.c === ci();
                    return (
                      <td
                        data-r={r}
                        data-c={ci()}
                        classList={{ sel: sel().r === r && sel().c === ci(), nul: v() === null, num: v() !== null && isNumber(v()!), editing: isEd() }}
                        title={(v()?.length ?? 0) > 40 ? v()! : undefined}
                        onClick={() => setSel({ r, c: ci() })}
                        onDblClick={() => { setSel({ r, c: ci() }); startEdit(); }}
                      >
                        <Show when={isEd()} fallback={v() ?? props.nul}>
                          <CellEdit
                            value={editing()?.init ?? v() ?? ""}
                            select={editing()?.init === undefined}
                            onDone={(t) => commit(t)}
                            onTab={(t, back) => commit(t, () => { move(0, back ? -1 : 1); startEdit(); })}
                            onEnter={(t) => commit(t, () => move(1, 0))}
                          />
                        </Show>
                      </td>
                    );
                  }}
                </For>
              </tr>
            )}
          </For>
          <tr class="sg-pad" style={{ height: `${Math.max(0, props.rows - last()) * ROW}px` }} />
        </tbody>
      </table>
      <Show when={!props.rows}><div class="db-dim center">{props.empty}</div></Show>
    </div>
  );
}

function CellEdit(props: { value: string; select: boolean; onDone: (t: string | null) => void; onTab: (t: string, back: boolean) => void; onEnter: (t: string) => void }): JSX.Element {
  let el!: HTMLInputElement;
  let done = false;
  const finish = (f: () => void) => { if (!done) { done = true; f(); } };
  onMount(() => {
    el.focus();
    if (props.select) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  });
  return (
    <input
      ref={el}
      value={props.value}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); finish(() => props.onEnter(el.value)); }
        if (e.key === "Escape") { e.preventDefault(); finish(() => props.onDone(null)); }
        if (e.key === "Tab") { e.preventDefault(); finish(() => props.onTab(el.value, e.shiftKey)); }
      }}
      onBlur={() => finish(() => props.onDone(el.value))}
    />
  );
}

// ── CSV ─────────────────────────────────────────────────────────────

const DELIM_NAME: Record<string, string> = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" };

/** A CSV buffer as a table. Edits come back as changes to the text. */
export function CsvTable(props: { text: string; path: string; readOnly: boolean; onChange: (ch: Change) => void }): JSX.Element {
  const csv = createMemo(() => parseCsv(props.text, props.path));
  const skip = () => (csv().header ? 1 : 0);
  const rows = () => csv().rows.length - skip();
  const cols = createMemo(() => columnNames(csv()).map((name) => ({ name })));
  const [selRow, setSelRow] = createSignal<number | null>(null);
  const change = (ch: Change | null) => ch && props.onChange(ch);
  const locked = () => (props.readOnly ? "This file is too large to edit here: open it in the Database Window" : null);

  return (
    <div class="sg-wrap" onClick={(e) => { const td = (e.target as HTMLElement).closest("td[data-r]"); if (td) setSelRow(Number(td.getAttribute("data-r"))); }}>
      <Grid
        cols={cols()}
        rows={rows()}
        cell={(r, c) => { const f = csv().rows[r + skip()]?.fields[c]; return f && f.text !== "" ? f.text : null; }}
        label={(r) => String(r + 1)}
        locked={locked}
        onEdit={props.readOnly ? undefined : (r, c, v) => change(setCellChange(csv(), r + skip(), c, v))}
        empty={csv().header ? "No rows under the header. Add one below." : "Empty file."}
        nul=""
      />
      <div class="sg-bar">
        <span>{rows().toLocaleString()} {rows() === 1 ? "row" : "rows"} × {csv().width} {csv().width === 1 ? "column" : "columns"}</span>
        <span>·</span>
        <span>{DELIM_NAME[csv().delim] ?? "delimited"}{csv().header ? " · header row" : " · no header row"}</span>
        <span class="db-grow" />
        <Show when={!props.readOnly}>
          <button class="db-btn" title="Add a row at the end" onClick={() => change(addRowChange(props.text, csv()))}>+ Row</button>
          <button
            class="db-btn"
            disabled={selRow() === null || selRow()! >= rows()}
            title="Delete the selected row"
            onClick={() => { const r = selRow(); if (r !== null) { change(deleteRowChange(props.text, csv(), r + skip())); setSelRow(null); } }}
          >− Row</button>
        </Show>
      </div>
    </div>
  );
}

// ── workbooks ───────────────────────────────────────────────────────

type BookSheet = { name: string; columns: { name: string; type: string }[]; rows: Cell[][]; total: number };
type Book = { label: string; sheets: BookSheet[] };

/** A workbook's sheets, read-only, with a tab per sheet. */
export function BookView(props: { project: Project; path: string; reloads: number; onOpenDb: () => void }): JSX.Element {
  const [book] = createResource(() => ({ path: props.path, n: props.reloads }), (s) => invoke<Book>("sheet_read", { host: props.project.host, path: s.path }));
  const [pick, setPick] = createSignal(0);
  const sheet = () => book.latest?.sheets[Math.min(pick(), (book.latest?.sheets.length ?? 1) - 1)];
  const locked = () => "Excel files open read-only: open it in the Database Window to query it";
  return (
    <Show when={!book.error} fallback={<div class="fnote bad">{String(book.error)}</div>}>
      <Show when={book.latest} fallback={<div class="fnote">Reading…</div>}>
        {(b) => (
          <div class="sg-wrap">
            <Show when={sheet()} fallback={<div class="fnote">No cells in this workbook.</div>}>
              {(s) => (
                <>
                  <Grid
                    cols={s().columns}
                    rows={s().rows.length}
                    cell={(r, c) => { const v = s().rows[r]?.[c] ?? null; return v === null ? null : cellText(v); }}
                    label={(r) => String(r + 1)}
                    locked={locked}
                    empty="Empty sheet."
                    nul="NULL"
                  />
                  <Show when={s().total > s().rows.length}>
                    <div class="sg-more">Showing the first {s().rows.length.toLocaleString()} of {s().total.toLocaleString()} rows. <button class="db-btn" onClick={props.onOpenDb}>Open in Database</button> to see them all.</div>
                  </Show>
                </>
              )}
            </Show>
            <div class="sg-sheets" role="tablist">
              <For each={b().sheets}>
                {(sh, i) => (
                  <button role="tab" aria-selected={sheet()?.name === sh.name} onClick={() => setPick(i())}>
                    {sh.name}<span class="n">{sh.total.toLocaleString()}</span>
                  </button>
                )}
              </For>
              <span class="db-grow" />
              <span class="sg-label">{b().label} · read-only</span>
            </div>
          </div>
        )}
      </Show>
    </Show>
  );
}
