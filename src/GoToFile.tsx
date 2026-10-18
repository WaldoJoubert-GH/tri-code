// Go to File (Alt+T, or a click on the project path in the toolbar): one box that both
// searches the project's files and browses its folders. Typing fuzzy-matches the index
// (git ls-files, or a walk when the folder is not a repo); an empty box, or one ending in
// "/", lists that folder instead. Enter opens the file in the project's `file` window.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { type Project, activeProject, focusTab, focusedTab, isRemote, projectById, space, tabName } from "./state";
import { agentTarget } from "./agents";
import { openFile } from "./files";
import { FileIcon } from "./FileList";
import { sendText } from "./terms";
import { flash } from "./ui";
import "./files.css";

type FileIndex = { files: string[]; git: boolean; truncated: boolean };
type IndexState = { loading: boolean; index?: FileIndex; error?: string };

/** Indexes by project id. A reopen shows the last one while it refreshes. */
const [indexes, setIndexes] = createStore<Record<string, IndexState>>({});

function loadIndex(p: Project) {
  if (indexes[p.id]?.loading) return;
  setIndexes(p.id, { loading: true });
  invoke<FileIndex>("project_files", { host: p.host, path: p.path })
    .then((index) => setIndexes(p.id, { loading: false, index, error: undefined }))
    .catch((e) => setIndexes(p.id, { loading: false, error: String(e) }));
}

/** Files picked from the box, newest first, per project. Not persisted. */
const recent = new Map<string, string[]>();

const [openFor, setOpenFor] = createSignal<string | null>(null);

export const goToFileOpen = () => openFor() !== null;

export function openGoToFile() {
  const p = activeProject();
  if (!p) return;
  loadIndex(p);
  setOpenFor(p.id);
}

export function closeGoToFile() {
  setOpenFor(null);
}

export function toggleGoToFile() {
  if (goToFileOpen()) closeGoToFile();
  else openGoToFile();
}

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

type Item = { path: string; dir: boolean; m?: Match; open: boolean; recent?: boolean };
type View = { mode: "browse" | "search"; dir: string; recent: Item[]; list: Item[] };

const MAX_RESULTS = 80;

/** Mount once (in App). */
export function GoToFile() {
  const onDown = (e: PointerEvent) => {
    if (goToFileOpen() && !(e.target as Element).closest(".gtf, #where")) closeGoToFile();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  return (
    <Show when={projectById(openFor() ?? "")} keyed>
      {(p) => <Box project={p} />}
    </Show>
  );
}

function Box(props: { project: Project }) {
  const p = props.project;
  const [q, setQ] = createSignal("");
  const [hi, setHi] = createSignal(0);
  let input!: HTMLInputElement;
  let listEl!: HTMLDivElement;

  const state = () => indexes[p.id];
  const files = () => state()?.index?.files ?? [];
  const fileSet = createMemo(() => new Set(files()));
  const dirs = createMemo(() => {
    const out = new Set<string>();
    for (const f of files()) {
      for (let k = f.indexOf("/"); k > 0; k = f.indexOf("/", k + 1)) out.add(f.slice(0, k));
    }
    return [...out];
  });
  const openPaths = () => new Set(p.tabs.filter((t) => t.kind === "file" && t.path).map((t) => relTo(p, t.path!)));
  const recentFiles = () => {
    const picked = recent.get(p.id) ?? [];
    const fromTabs = p.tabs.filter((t) => t.kind === "file" && t.path).map((t) => relTo(p, t.path!)).filter((x): x is string => !!x);
    return [...new Set([...picked, ...fromTabs])].filter((f) => fileSet().has(f)).slice(0, 5);
  };

  const view = createMemo<View>(() => {
    const query = q(), open = openPaths();
    const item = (path: string, dir: boolean, m?: Match): Item => ({ path, dir, m, open: open.has(path) });
    const dirSet = new Set(dirs());
    const dir = query === "" ? "" : query.endsWith("/") && dirSet.has(query.slice(0, -1)) ? query.slice(0, -1) : null;
    if (dir !== null) {
      const pre = dir ? `${dir}/` : "";
      const kids = (xs: Iterable<string>) => [...xs].filter((x) => x.startsWith(pre) && !x.slice(pre.length).includes("/"))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      return {
        mode: "browse",
        dir,
        recent: dir === "" ? recentFiles().map((f) => ({ ...item(f, false), recent: true })) : [],
        list: [...kids(dirSet).map((d) => item(d, true)), ...kids(files()).map((f) => item(f, false))],
      };
    }
    const boost = new Set(recentFiles());
    const hits: (Item & { score: number })[] = [];
    for (const [list, isDir] of [[dirs(), true], [files(), false]] as const) {
      for (const path of list) {
        const m = fuzzy(query, path);
        if (m) hits.push({ ...item(path, isDir, m), score: m.score - (isDir ? 2 : 0) + (boost.has(path) ? 4 : 0) });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return { mode: "search", dir: "", recent: [], list: hits.slice(0, MAX_RESULTS) };
  });
  const items = () => [...view().recent, ...view().list];

  createEffect(on(q, () => setHi(0)));
  createEffect(on(hi, (i) => listEl?.querySelector(`[data-k="${i}"]`)?.scrollIntoView({ block: "nearest" })));

  const setQuery = (v: string) => {
    input.value = v;
    setQ(v);
    input.focus();
  };

  const agent = () => agentTarget(p, space(p).focus);

  function pick(it: Item | undefined, how: "reuse" | "new" | "agent") {
    if (!it) return;
    if (it.dir) return setQuery(`${it.path}/`);
    recent.set(p.id, [it.path, ...(recent.get(p.id) ?? []).filter((x) => x !== it.path)].slice(0, 5));
    closeGoToFile();
    if (how === "agent") {
      const t = agent();
      if (!t) return flash("open an agent window first (the + menu)");
      sendText(t.id, `@${it.path} `);
      focusTab(p.id, t.id);
      return flash(`typed @${it.path} into ${tabName(t)}, not sent`);
    }
    openFile(p, join(p.path, it.path), focusedTab(p)?.id, how === "new");
  }

  const onKey = (e: KeyboardEvent) => {
    const n = items().length, it = items()[hi()];
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setHi(n ? (hi() + 1) % n : 0);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setHi(n ? (hi() + n - 1) % n : 0);
    else if (e.key === "Enter") pick(it, e.ctrlKey || e.metaKey ? "new" : e.shiftKey ? "agent" : "reuse");
    // Tab completes the highlighted row into the box; a folder then lists its contents
    else if (e.key === "Tab") { if (it) setQuery(it.dir ? `${it.path}/` : it.path); }
    else if (e.key === "ArrowRight" && atEnd && it?.dir) setQuery(`${it.path}/`);
    // Backspace (or ←) right after a "/" climbs a whole folder, not one letter
    else if ((e.key === "Backspace" || e.key === "ArrowLeft") && atEnd && input.value.endsWith("/")) {
      const up = input.value.slice(0, -1);
      setQuery(up.includes("/") ? up.slice(0, up.lastIndexOf("/") + 1) : "");
    } else return;
    e.preventDefault();
  };

  const place = (el: HTMLElement) => {
    const a = document.getElementById("where");
    if (!a) return;
    const r = a.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${r.bottom + 6}px`;
  };

  const where = () => `${isRemote(p) ? `${p.host}:` : ""}${p.path}`;
  const crumbs = () => {
    const parts = view().dir ? view().dir.split("/") : [];
    return parts.map((name, i) => ({ name, q: `${parts.slice(0, i + 1).join("/")}/` }));
  };
  const status = () => {
    const s = state();
    if (s?.error && !s.index) return s.error;
    if (!s?.index) return "indexing…";
    const n = s.index.files.length.toLocaleString();
    return `${s.loading ? "refreshing · " : ""}${s.index.truncated ? "first " : ""}${n} files${s.index.git ? "" : " (not a git repo)"}${isRemote(p) ? ` on ${p.host}` : ""}`;
  };

  const Row = (rp: { it: Item; k: number; browse: boolean }) => {
    const base = rp.it.path.lastIndexOf("/") + 1;
    const idx = new Set(rp.it.m?.idx ?? []);
    // browsing a folder the crumb already says where; Recent and search results carry their folder
    const dir = rp.browse && !rp.it.recent ? "" : rp.it.path.slice(0, Math.max(0, base - 1));
    const marked = (s: string, off: number) => [...s].map((c, i) => (idx.has(i + off) ? <mark>{c}</mark> : c));
    return (
      <button
        type="button"
        class="grow"
        classList={{ dir: rp.it.dir, hi: rp.k === hi() }}
        data-k={rp.k}
        role="option"
        aria-selected={rp.k === hi()}
        title={rp.it.path}
        onMouseMove={() => hi() !== rp.k && setHi(rp.k)}
        onClick={(e) => pick(rp.it, e.ctrlKey || e.metaKey ? "new" : e.shiftKey ? "agent" : "reuse")}
      >
        <FileIcon name={rp.it.path} dir={rp.it.dir} />
        <span class="gn">{marked(rp.it.path.slice(base), base)}</span>
        <span class="gd"><bdi>{marked(dir, 0)}</bdi></span>
        <Show when={rp.it.open}><span class="gopen">open</span></Show>
      </button>
    );
  };

  return (
    <div class="gtf" role="dialog" aria-label="Go to file" ref={(el) => requestAnimationFrame(() => place(el))}>
      <div class="gin">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></svg>
        <input
          ref={(el) => { input = el; requestAnimationFrame(() => el.focus()); }}
          spellcheck={false}
          autocomplete="off"
          placeholder={`Search ${p.name}, or type a folder and /`}
          aria-label="Search files"
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={onKey}
        />
        <span class="scope" title={where()}><bdi>{where()}</bdi></span>
      </div>
      <Show when={view().mode === "browse"}>
        <div class="gcrumb">
          <button type="button" onClick={() => setQuery("")}>{p.name}</button>
          <For each={crumbs()}>{(c) => <><i>/</i><button type="button" onClick={() => setQuery(c.q)}>{c.name}</button></>}</For>
        </div>
      </Show>
      <div class="glist" role="listbox" ref={listEl}>
        {(() => {
          const v = view(), browse = v.mode === "browse";
          if (!items().length) {
            return <div class="gnone">{state()?.index ? (q() ? `No file matches “${q()}”` : "Empty folder") : status()}</div>;
          }
          return (
            <>
              <Show when={v.recent.length}><h5>Recent</h5></Show>
              <For each={v.recent}>{(it, i) => <Row it={it} k={i()} browse={browse} />}</For>
              <Show when={v.recent.length && v.list.length}><h5>{p.name}</h5></Show>
              <For each={v.list}>{(it, i) => <Row it={it} k={v.recent.length + i()} browse={browse} />}</For>
            </>
          );
        })()}
      </div>
      <div class="gfoot">
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>Ctrl</kbd><kbd>Enter</kbd> new window</span>
        <span><kbd>Tab</kbd> complete</span>
        <Show when={agent()}>{(t) => <span><kbd>Shift</kbd><kbd>Enter</kbd> @ to {t().kind}</span>}</Show>
        <span class="src" title="git ls-files: tracked files plus new ones that are not ignored">{status()}</span>
      </div>
    </div>
  );
}
