// The files window: a tree of the project folder. Directories expand in place;
// clicking a file shows it in the project's `file` window. Plain keys drive it
// while the window is focused.

import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import { type Project, type Tab, isRemote } from "./state";
import { dirState, loadDir, openFile, refreshProject } from "./files";
import "./files.css";

type Row = { path: string; name: string; dir: boolean; depth: number };

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

/** Two-letter chip in the language's colour. */
const EXT: Record<string, [string, string]> = {
  ts: ["ts", "#4d7fd6"], tsx: ["tx", "#3f9fd0"], js: ["js", "#c9a24a"], jsx: ["jx", "#3f9fd0"],
  css: ["cs", "#5aa7c9"], scss: ["sc", "#c96a9a"], html: ["<>", "#d08b4a"], json: ["{}", "#c9a24a"],
  md: ["md", "#7aa87a"], rs: ["rs", "#d08b4a"], toml: ["tm", "#c96a7a"], yaml: ["ya", "#c96a7a"],
  yml: ["ya", "#c96a7a"], sh: ["sh", "#9ece6a"], svg: ["sv", "#a97fd0"], png: ["im", "#a97fd0"],
  jpg: ["im", "#a97fd0"], jpeg: ["im", "#a97fd0"], gif: ["im", "#a97fd0"], lock: ["lk", "#8a8f9c"],
};

export function FileIcon(props: { name: string; dir: boolean }): JSX.Element {
  if (props.dir) return <span class="fic dir" />;
  const base = props.name.split("/").pop()!;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  const [label, color] = EXT[ext] ?? ["··", "#8a8f9c"];
  return <span class="fic" style={{ "--fc": color }}>{label}</span>;
}

export default function FileList(props: { project: Project; tab: Tab; focused: boolean }): JSX.Element {
  let rootEl!: HTMLDivElement;
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [sel, setSel] = createSignal("");

  const isOpen = (p: string) => open().has(p);
  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const seen = new Set<string>();
    const walk = (dir: string, depth: number) => {
      if (seen.has(dir)) return; // a symlink loop would otherwise recurse forever
      seen.add(dir);
      for (const e of dirState(props.project, dir)?.list?.entries ?? []) {
        const path = join(dir, e.name);
        out.push({ path, name: e.name, dir: e.dir, depth });
        if (e.dir && isOpen(path)) walk(path, depth + 1);
      }
    };
    walk(props.project.path, 0);
    return out;
  });

  // Load the root, and every directory the user has expanded.
  createEffect(() => {
    loadDir(props.project, props.project.path);
    for (const p of open()) loadDir(props.project, p);
  });

  createEffect(() => {
    if (props.focused) requestAnimationFrame(() => rootEl?.focus());
  });

  const move = (i: number) => {
    const list = rows();
    if (!list.length) return;
    const at = Math.max(0, Math.min(list.length - 1, i));
    setSel(list[at].path);
    rootEl.querySelector<HTMLElement>(`[data-path="${CSS.escape(list[at].path)}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKey = (e: KeyboardEvent) => {
    const list = rows();
    const i = list.findIndex((r) => r.path === sel());
    const at = list[i];
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(i + 1); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); move(i - 1); }
    else if (e.key === "ArrowRight" || e.key === "l") { if (at?.dir && !isOpen(at.path)) toggle(at.path); }
    else if (e.key === "ArrowLeft" || e.key === "h") { if (at?.dir && isOpen(at.path)) toggle(at.path); }
    else if (e.key === "Enter") { if (at) at.dir ? toggle(at.path) : openFile(props.project, at.path, props.tab.id); }
  };

  const where = () => `${isRemote(props.project) ? `${props.project.host}:` : ""}${props.project.path}`;
  const root = () => dirState(props.project, props.project.path);

  return (
    <div class="filewin">
      <div class="fbar">
        <span class="proj">{props.project.name}</span>
        <span class="path" title={where()}>{where()}</span>
        <button title="Refresh (reloads the whole tree and open files)" onClick={() => refreshProject(props.project)}>⟳</button>
      </div>
      <div
        class="ftree"
        ref={rootEl}
        tabIndex={0}
        onKeyDown={onKey}
        onClick={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
          if (!el) return;
          const path = el.dataset.path!;
          setSel(path);
          if (el.dataset.dir === "1") toggle(path);
          else openFile(props.project, path, props.tab.id);
        }}
      >
        <Show
          when={rows().length}
          fallback={<div class="fnote">{root()?.error ?? (root()?.loading ? "Loading…" : "Empty folder")}</div>}
        >
          <For each={rows()}>
            {(r) => (
              <div
                class="frow"
                classList={{ sel: r.path === sel(), dir: r.dir }}
                data-path={r.path}
                data-dir={r.dir ? "1" : "0"}
                style={{ "padding-left": `${6 + r.depth * 14}px` }}
              >
                <span class="fchev">{r.dir ? (isOpen(r.path) ? "▾" : "▸") : ""}</span>
                <FileIcon name={r.name} dir={r.dir} />
                <span class="fname">{r.name}</span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
