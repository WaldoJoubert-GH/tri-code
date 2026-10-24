// Command Palette (Alt+X, Alt+T, or a click on the project path in the toolbar): one box that
// runs any command by name and finds the project's files. The empty box lists recent picks, then
// every command by group. Typing fuzzy-matches command titles (and, failing that, the muted hint:
// a window's process title or a project's path) and the file index (git ls-files, or a walk when
// the folder is not a repo), commands first. "/", or a folder and "/", lists that folder instead.
// Enter runs the command or opens the file in the project's editor window.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { type Command, commands } from "./commands";
import { type Project, activeProject, focusTab, focusedTab, isRemote, skipFolders, space, tabName } from "./state";
import { agentTarget } from "./agents";
import { filesOf, openFile } from "./files";
import { FileIcon } from "./FileList";
import { focusSession, sendText } from "./terms";
import { flash } from "./ui";
import { Icon } from "./lucide";
import "./files.css";

type FileIndex = { files: string[]; git: boolean; truncated: boolean };
type IndexState = { loading: boolean; index?: FileIndex; error?: string };

/** Indexes by project id. A reopen shows the last one while it refreshes. */
const [indexes, setIndexes] = createStore<Record<string, IndexState>>({});

function loadIndex(p: Project) {
  if (indexes[p.id]?.loading) return;
  setIndexes(p.id, { loading: true });
  invoke<FileIndex>("project_files", { host: p.host, path: p.path, skip: skipFolders() })
    .then((index) => setIndexes(p.id, { loading: false, index, error: undefined }))
    .catch((e) => setIndexes(p.id, { loading: false, error: String(e) }));
}

const [open, setOpen] = createSignal(false);

export const paletteOpen = open;
export const closePalette = () => setOpen(false);
export function openPalette() {
  const p = activeProject();
  if (p) loadIndex(p);
  setOpen(true);
}
export const togglePalette = () => (open() ? closePalette() : openPalette());

/** Command ids picked from the box, newest first. Not persisted. */
let recentCommands: string[] = [];
/** Files picked from the box, newest first, per project. Not persisted. */
const recentFiles = new Map<string, string[]>();

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const relTo = (p: Project, abs: string) => {
  const root = p.path.endsWith("/") ? p.path : `${p.path}/`;
  return abs.startsWith(root) ? abs.slice(root.length) : null;
};

export type Match = { score: number; idx: number[] };

/** The query's letters in order. Runs, word starts and a hit inside the file name score higher. */
export function fuzzy(q: string, path: string): Match | null {
  const ql = q.toLowerCase(), pl = path.toLowerCase(), base = path.lastIndexOf("/") + 1;
  const run = (from: number): Match | null => {
    const idx: number[] = [];
    let j = from, score = 0, prev = -2;
    for (const c of ql) {
      const k = pl.indexOf(c, j);
      if (k < 0) return null;
      const start = k === 0 || "/._- ".includes(path[k - 1]) || (path[k] !== pl[k] && path[k - 1] === pl[k - 1]);
      score += 1 + (k === prev + 1 ? 5 : 0) + (start ? 3 : 0);
      idx.push(k);
      prev = k;
      j = k + 1;
    }
    return { score: score - path.length * 0.05, idx };
  };
  const inName = q.includes("/") ? null : run(base);
  return inName ? { ...inName, score: inName.score + 10 } : run(0);
}

type CmdRow = { kind: "cmd"; c: Command; m?: Match; recent?: boolean };
type FileRow = { kind: "file"; path: string; dir: boolean; m?: Match; open: boolean; recent?: boolean };
type Row = CmdRow | FileRow;
/** One run of rows under a header ("" for none). */
type Section = { head: string; rows: Row[] };
type View = { browse?: string; sections: Section[] };

const MAX_COMMANDS = 8;
const MAX_FILES = 80;

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function Palette() {
  const onDown = (e: PointerEvent) => {
    if (open() && !(e.target as Element).closest(".pal, #where, #palBtn")) closePalette();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  return (
    <Show when={open()}>
      <Box project={activeProject()} />
    </Show>
  );
}

function Box(props: { project?: Project }) {
  const p = props.project;
  const [q, setQ] = createSignal("");
  const [hi, setHi] = createSignal(0);
  let input!: HTMLInputElement;
  let listEl!: HTMLDivElement;

  // Built once per opening: the commands close over the project and window focused right now.
  const all = commands();

  const state = () => (p ? indexes[p.id] : undefined);
  const files = () => state()?.index?.files ?? [];
  const fileSet = createMemo(() => new Set(files()));
  const dirs = createMemo(() => {
    const out = new Set<string>();
    for (const f of files()) {
      for (let k = f.indexOf("/"); k > 0; k = f.indexOf("/", k + 1)) out.add(f.slice(0, k));
    }
    return out;
  });
  const openPaths = () => new Set(p ? p.tabs.flatMap(filesOf).map((f) => relTo(p, f)) : []);
  const lastFiles = () => {
    if (!p) return [];
    const picked = recentFiles.get(p.id) ?? [];
    const fromTabs = p.tabs.flatMap(filesOf).map((f) => relTo(p, f)).filter((x): x is string => !!x);
    return [...new Set([...picked, ...fromTabs])].filter((f) => fileSet().has(f)).slice(0, 5);
  };

  const view = createMemo<View>(() => {
    const query = q(), opened = openPaths();
    const file = (path: string, dir: boolean, m?: Match): FileRow => ({ kind: "file", path, dir, m, open: opened.has(path) });

    // "/" lists the project root; a known folder and "/" lists that folder
    const browse = !p ? null : query === "/" ? "" : query.endsWith("/") && dirs().has(query.slice(0, -1)) ? query.slice(0, -1) : null;
    if (browse !== null) {
      const pre = browse ? `${browse}/` : "";
      const kids = (xs: Iterable<string>) => [...xs].filter((x) => x.startsWith(pre) && !x.slice(pre.length).includes("/"))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      return { browse, sections: [{ head: "", rows: [...kids(dirs()).map((d) => file(d, true)), ...kids(files()).map((f) => file(f, false))] }] };
    }

    const trimmed = query.trim();
    if (!trimmed) {
      const byId = new Map(all.map((c) => [c.id, c]));
      const rec: Row[] = [
        ...recentCommands.map((id) => byId.get(id)).filter((c): c is Command => !!c).slice(0, 5).map((c): Row => ({ kind: "cmd", c, recent: true })),
        ...lastFiles().map((f) => ({ ...file(f, false), recent: true })),
      ];
      const out: Section[] = rec.length ? [{ head: "Recent", rows: rec }] : [];
      for (const c of all) {
        const last = out[out.length - 1];
        if (last && last.head === c.group) last.rows.push({ kind: "cmd", c });
        else out.push({ head: c.group, rows: [{ kind: "cmd", c }] });
      }
      return { sections: out };
    }

    const cmdBoost = new Set(recentCommands.slice(0, 5));
    const cmds: (CmdRow & { score: number })[] = [];
    for (const c of all) {
      const m = fuzzy(trimmed, c.title);
      const h = m || !c.hint ? null : fuzzy(trimmed, c.hint);
      if (!m && !h) continue;
      cmds.push({ kind: "cmd", c, m: m ?? undefined, score: (m ? m.score : h!.score - 10) + (cmdBoost.has(c.id) ? 4 : 0) });
    }
    cmds.sort((a, b) => b.score - a.score);

    const fileBoost = new Set(lastFiles());
    const hits: (FileRow & { score: number })[] = [];
    if (p) {
      for (const [list, isDir] of [[dirs(), true], [files(), false]] as const) {
        for (const path of list) {
          const m = fuzzy(query, path);
          if (m) hits.push({ ...file(path, isDir, m), score: m.score - (isDir ? 2 : 0) + (fileBoost.has(path) ? 4 : 0) });
        }
      }
      hits.sort((a, b) => b.score - a.score);
    }

    const out: Section[] = [];
    // With no file hits the commands get the whole list
    if (cmds.length) out.push({ head: "Commands", rows: cmds.slice(0, hits.length ? MAX_COMMANDS : MAX_FILES) });
    if (hits.length) out.push({ head: "Files", rows: hits.slice(0, MAX_FILES) });
    return { sections: out };
  });
  const rows = () => view().sections.flatMap((s) => s.rows);

  createEffect(on(q, () => setHi(0)));
  createEffect(on(hi, (i) => listEl?.querySelector(`[data-k="${i}"]`)?.scrollIntoView({ block: "nearest" })));

  const setQuery = (v: string) => {
    input.value = v;
    setQ(v);
    input.focus();
  };

  const agent = () => (p ? agentTarget(p, space(p).focus) : undefined);

  function pick(r: Row | undefined, how: "reuse" | "new" | "agent" = "reuse") {
    if (!r) return;
    if (r.kind === "cmd") {
      recentCommands = [r.c.id, ...recentCommands.filter((id) => id !== r.c.id)].slice(0, 10);
      closePalette();
      r.c.run();
      // Unless the command focused something (a window, a dialog), give the keys back to the terminal.
      requestAnimationFrame(() => {
        const ap = activeProject(), f = ap && focusedTab(ap);
        if (f && (!document.activeElement || document.activeElement === document.body)) focusSession(f.id);
      });
      return;
    }
    if (!p) return;
    if (r.dir) return setQuery(`${r.path}/`);
    recentFiles.set(p.id, [r.path, ...(recentFiles.get(p.id) ?? []).filter((x) => x !== r.path)].slice(0, 5));
    closePalette();
    if (how === "agent") {
      const t = agent();
      if (!t) return flash("open an agent window first (the + menu)");
      sendText(t.id, `@${r.path} `);
      focusTab(p.id, t.id);
      return flash(`typed @${r.path} into ${tabName(t)}, not sent`);
    }
    openFile(p, join(p.path, r.path), { from: focusedTab(p)?.id, beside: how === "new", preview: how !== "new" });
  }

  const howOf = (e: KeyboardEvent | MouseEvent) => (e.ctrlKey || e.metaKey ? "new" : e.shiftKey ? "agent" : "reuse");

  const onKey = (e: KeyboardEvent) => {
    const n = rows().length, r = rows()[hi()], f = r?.kind === "file" ? r : undefined;
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setHi(n ? (hi() + 1) % n : 0);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setHi(n ? (hi() + n - 1) % n : 0);
    else if (e.key === "PageDown") setHi(Math.min(n - 1, hi() + 10));
    else if (e.key === "PageUp") setHi(Math.max(0, hi() - 10));
    else if (e.key === "Enter") pick(r, howOf(e));
    // Tab completes the highlighted file into the box; a folder then lists its contents
    else if (e.key === "Tab") { if (f) setQuery(f.dir ? `${f.path}/` : f.path); }
    else if (e.key === "ArrowRight" && atEnd && f?.dir) setQuery(`${f.path}/`);
    // Backspace (or ←) right after a "/" climbs a whole folder, not one letter; from the root, back to commands
    else if ((e.key === "Backspace" || e.key === "ArrowLeft") && atEnd && input.value.endsWith("/") && view().browse !== undefined) {
      const up = input.value.slice(0, -1);
      setQuery(up === "" ? "" : up.includes("/") ? up.slice(0, up.lastIndexOf("/") + 1) : "/");
    } else return;
    e.preventDefault();
  };

  const where = () => (p ? `${isRemote(p) ? `${p.host}:` : ""}${p.path}` : "");
  const crumbs = () => {
    const b = view().browse, parts = b ? b.split("/") : [];
    return parts.map((name, i) => ({ name, q: `${parts.slice(0, i + 1).join("/")}/` }));
  };
  const status = () => {
    const s = state();
    if (!p) return `${all.length} commands`;
    if (s?.error && !s.index) return s.error;
    if (!s?.index) return "indexing…";
    const n = s.index.files.length.toLocaleString();
    return `${all.length} commands · ${s.loading ? "refreshing · " : ""}${s.index.truncated ? "first " : ""}${n} files${s.index.git ? "" : " (not a git repo)"}${isRemote(p) ? ` on ${p.host}` : ""}`;
  };

  const Marked = (mp: { s: string; idx: Set<number>; off: number }) => (
    <>{[...mp.s].map((c, i) => (mp.idx.has(i + mp.off) ? <mark>{c}</mark> : c))}</>
  );

  const CmdItem = (rp: { r: CmdRow; k: number; group: boolean }) => {
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
        <span class="gn"><Marked s={c.title} idx={new Set(rp.r.m?.idx ?? [])} off={0} /></span>
        <span class="ph">{rp.group ? <><b>{c.group}</b>{c.hint ? ` · ${c.hint}` : ""}</> : c.hint}</span>
        <Show when={c.keys}>{(keys) => <span class="pk"><For each={keys()}>{(k) => <kbd>{k}</kbd>}</For></span>}</Show>
      </button>
    );
  };

  const FileItem = (rp: { r: FileRow; k: number }) => {
    const base = rp.r.path.lastIndexOf("/") + 1;
    const idx = new Set(rp.r.m?.idx ?? []);
    // browsing a folder the crumb already says where; Recent and search results carry their folder
    const dir = view().browse !== undefined ? "" : rp.r.path.slice(0, Math.max(0, base - 1));
    return (
      <button
        type="button"
        class="grow"
        classList={{ dir: rp.r.dir, hi: rp.k === hi() }}
        data-k={rp.k}
        role="option"
        aria-selected={rp.k === hi()}
        title={rp.r.path}
        onMouseMove={() => hi() !== rp.k && setHi(rp.k)}
        onClick={(e) => pick(rp.r, howOf(e))}
      >
        <FileIcon name={rp.r.path} dir={rp.r.dir} />
        <span class="gn"><Marked s={rp.r.path.slice(base)} idx={idx} off={base} /></span>
        <span class="gd"><bdi><Marked s={dir} idx={idx} off={0} /></bdi></span>
        <Show when={rp.r.open}><span class="gopen">open</span></Show>
      </button>
    );
  };

  const hiFile = () => rows()[hi()]?.kind === "file";

  return (
    <div class="gtf pal" role="dialog" aria-label="Command palette">
      <div class="gin">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></svg>
        <input
          ref={(el) => { input = el; requestAnimationFrame(() => el.focus()); }}
          spellcheck={false}
          autocomplete="off"
          placeholder={p ? `Run a command or search ${p.name} (/ browses folders)` : "Run a command"}
          aria-label="Search commands and files"
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={onKey}
        />
        <Show when={p}><span class="scope" title={where()}><bdi>{where()}</bdi></span></Show>
      </div>
      <Show when={view().browse !== undefined}>
        <div class="gcrumb">
          <button type="button" onClick={() => setQuery("/")}>{p!.name}</button>
          <For each={crumbs()}>{(c) => <><i>/</i><button type="button" onClick={() => setQuery(c.q)}>{c.name}</button></>}</For>
        </div>
      </Show>
      <div class="glist" role="listbox" ref={listEl}>
        {(() => {
          const v = view();
          if (!rows().length) {
            if (v.browse !== undefined) return <div class="gnone">{state()?.index ? "Empty folder" : status()}</div>;
            return <div class="gnone">Nothing matches “{q().trim()}”{p && !state()?.index ? ` (${status()})` : ""}</div>;
          }
          // The empty box lists commands by group with a header each; search results say their group inline.
          const grouped = !!q().trim() && v.browse === undefined;
          const starts = v.sections.map((_, i) => v.sections.slice(0, i).reduce((n, s) => n + s.rows.length, 0));
          return (
            <For each={v.sections}>
              {(s, si) => (
                <>
                  {s.head && <h5>{s.head}</h5>}
                  <For each={s.rows}>
                    {(r, i) => (r.kind === "cmd"
                      ? <CmdItem r={r} k={starts[si()] + i()} group={grouped} />
                      : <FileItem r={r} k={starts[si()] + i()} />)}
                  </For>
                </>
              )}
            </For>
          );
        })()}
      </div>
      <div class="gfoot">
        <span><kbd>Enter</kbd> {hiFile() ? "open" : "run"}</span>
        <Show when={hiFile()}>
          <span><kbd>Ctrl</kbd><kbd>Enter</kbd> new window</span>
          <span><kbd>Tab</kbd> complete</span>
          <Show when={agent()}>{(t) => <span><kbd>Shift</kbd><kbd>Enter</kbd> @ to {t().kind}</span>}</Show>
        </Show>
        <span><kbd>Esc</kbd> close</span>
        <span class="src" title="Files: git ls-files (tracked, new and ignored), minus the folders skipped in Settings › Files">{status()}</span>
      </div>
    </div>
  );
}
