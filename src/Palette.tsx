// Command Palette (Alt+X): one box that runs any command by name. The empty box lists recent
// picks, then every command by group; typing fuzzy-matches titles (and, failing that, the muted
// hint: a window's process title or a project's path). Enter runs the highlighted command.

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { type Command, commands } from "./commands";
import { type Match, fuzzy } from "./GoToFile";
import { activeProject, focusedTab } from "./state";
import { focusSession } from "./terms";
import { Icon } from "./lucide";
import "./files.css";

const [open, setOpen] = createSignal(false);

export const paletteOpen = open;
export const closePalette = () => setOpen(false);
export const togglePalette = () => setOpen(!open());

/** Command ids picked from the palette, newest first. Not persisted. */
let recent: string[] = [];

type Row = { c: Command; m?: Match; recent?: boolean };

const MAX_RESULTS = 60;

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function Palette() {
  const onDown = (e: PointerEvent) => {
    if (open() && !(e.target as Element).closest(".pal")) closePalette();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  return (
    <Show when={open()}>
      <Box />
    </Show>
  );
}

function Box() {
  const [q, setQ] = createSignal("");
  const [hi, setHi] = createSignal(0);
  let listEl!: HTMLDivElement;

  // Built once per opening: the commands close over the project and window focused right now.
  const all = commands();

  const rows = createMemo<Row[]>(() => {
    const query = q().trim();
    if (!query) {
      const byId = new Map(all.map((c) => [c.id, c]));
      const rec = recent.map((id) => byId.get(id)).filter((c): c is Command => !!c).slice(0, 5);
      return [...rec.map((c) => ({ c, recent: true })), ...all.map((c) => ({ c }))];
    }
    const boost = new Set(recent.slice(0, 5));
    const hits: (Row & { score: number })[] = [];
    for (const c of all) {
      const m = fuzzy(query, c.title);
      const h = m || !c.hint ? null : fuzzy(query, c.hint);
      if (!m && !h) continue;
      hits.push({ c, m: m ?? undefined, score: (m ? m.score : h!.score - 10) + (boost.has(c.id) ? 4 : 0) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
  });

  createEffect(on(q, () => setHi(0)));
  createEffect(on(hi, (i) => listEl?.querySelector(`[data-k="${i}"]`)?.scrollIntoView({ block: "nearest" })));

  function pick(r: Row | undefined) {
    if (!r) return;
    recent = [r.c.id, ...recent.filter((id) => id !== r.c.id)].slice(0, 10);
    closePalette();
    r.c.run();
    // Unless the command focused something (a window, a dialog), give the keys back to the terminal.
    requestAnimationFrame(() => {
      const p = activeProject(), f = p && focusedTab(p);
      if (f && (!document.activeElement || document.activeElement === document.body)) focusSession(f.id);
    });
  }

  const onKey = (e: KeyboardEvent) => {
    const n = rows().length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setHi(n ? (hi() + 1) % n : 0);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setHi(n ? (hi() + n - 1) % n : 0);
    else if (e.key === "PageDown") setHi(Math.min(n - 1, hi() + 10));
    else if (e.key === "PageUp") setHi(Math.max(0, hi() - 10));
    else if (e.key === "Enter") pick(rows()[hi()]);
    else return;
    e.preventDefault();
  };

  const Item = (rp: { r: Row; k: number; group: boolean }) => {
    const idx = new Set(rp.r.m?.idx ?? []);
    const c = rp.r.c;
    return (
      <button
        type="button"
        class="grow prow"
        classList={{ hi: rp.k === hi() }}
        data-k={rp.k}
        role="option"
        aria-selected={rp.k === hi()}
        onMouseMove={() => hi() !== rp.k && setHi(rp.k)}
        onClick={() => pick(rp.r)}
      >
        <Show when={c.icon && c.icon.length > 1} fallback={<span class="pg">{c.icon}</span>}>
          <Icon name={c.icon!} size={14} class="pg" />
        </Show>
        <span class="gn">{[...c.title].map((ch, i) => (idx.has(i) ? <mark>{ch}</mark> : ch))}</span>
        <span class="ph">{rp.group ? <><b>{c.group}</b>{c.hint ? ` · ${c.hint}` : ""}</> : c.hint}</span>
        <Show when={c.keys}>{(keys) => <span class="pk"><For each={keys()}>{(k) => <kbd>{k}</kbd>}</For></span>}</Show>
      </button>
    );
  };

  return (
    <div class="gtf pal" role="dialog" aria-label="Command palette">
      <div class="gin">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m3 4 4 4-4 4M8.5 12h5" /></svg>
        <input
          ref={(el) => requestAnimationFrame(() => el.focus())}
          spellcheck={false}
          autocomplete="off"
          placeholder={activeProject() ? `Run a command, open a window or switch project` : "Run a command"}
          aria-label="Search commands"
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={onKey}
        />
        <Show when={activeProject()}>{(p) => <span class="scope">{p().name}</span>}</Show>
      </div>
      <div class="glist" role="listbox" ref={listEl}>
        <Show when={rows().length} fallback={<div class="gnone">No command matches “{q()}”</div>}>
          {(() => {
            // The empty box lists by group with a header each; search results are one ranked list.
            if (q().trim()) return <For each={rows()}>{(r, i) => <Item r={r} k={i()} group />}</For>;
            return (
              <For each={rows()}>
                {(r, i) => {
                  const prev = rows()[i() - 1];
                  const head = r.recent ? (i() === 0 ? "Recent" : "") : !prev || prev.recent || prev.c.group !== r.c.group ? r.c.group : "";
                  return <>{head && <h5>{head}</h5>}<Item r={r} k={i()} group={false} /></>;
                }}
              </For>
            );
          })()}
        </Show>
      </div>
      <div class="gfoot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>Enter</kbd> run</span>
        <span><kbd>Esc</kbd> close</span>
        <span class="src">{q().trim() ? `${rows().length} of ${all.length}` : all.length} commands</span>
      </div>
    </div>
  );
}
