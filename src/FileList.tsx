// The editor's file tree: the project folder, directories expanded in place. A click opens a
// file in the editor's preview tab, a double-click keeps it, Ctrl+click opens it in a new editor
// beside. It follows the editor: the file shown is revealed and selected. Plain keys drive it
// while it has focus. Changed files carry their git status letter, and folders a dot for what
// they hold. New File (the header's +, or right-click) names the file in a box at the top of its
// folder; a name with slashes makes the folders too. Delete (right-click, or the Delete key)
// asks first, then sends the file or folder to the Recycle Bin, or removes it for good over ssh.
// Rename (right-click, or F2) edits the name in place.

import { For, Show, createEffect, createMemo, createSignal, on, onMount, type JSX } from "solid-js";
import { type Project, isRemote } from "./state";
import { type OpenHow, createFile, deletePath, dirState, renamePath, loadDir, refreshDir, refreshProject } from "./files";
import { openCtxMenu } from "./ctxmenu";
import { copyText } from "./clipboard";
import { ask, flash } from "./ui";
import { type FileMark, fileMarks, markAt, peekStatus } from "./git";
import "./files.css";

/** `draft` is the New File box, in the folder `path`. */
type Row = { path: string; name: string; dir: boolean; depth: number; draft?: true };

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

/** Two-letter chip in the language's colour. */
const EXT: Record<string, [string, string]> = {
  ts: ["ts", "#4d7fd6"], tsx: ["tx", "#3f9fd0"], js: ["js", "#c9a24a"], jsx: ["jx", "#3f9fd0"],
  css: ["cs", "#5aa7c9"], scss: ["sc", "#c96a9a"], html: ["<>", "#d08b4a"], json: ["{}", "#c9a24a"],
  md: ["md", "#7aa87a"], rs: ["rs", "#d08b4a"], toml: ["tm", "#c96a7a"], yaml: ["ya", "#c96a7a"],
  yml: ["ya", "#c96a7a"], sh: ["sh", "#9ece6a"], svg: ["sv", "#a97fd0"], png: ["im", "#a97fd0"],
  jpg: ["im", "#a97fd0"], jpeg: ["im", "#a97fd0"], gif: ["im", "#a97fd0"], lock: ["lk", "#8a8f9c"],
  py: ["py", "#4d7fd6"], go: ["go", "#3f9fd0"],
};

export const MARK_TITLE: Record<FileMark, string> = {
  M: "modified", A: "added", U: "untracked", D: "deleted", R: "renamed", C: "conflict",
};

export function FileIcon(props: { name: string; dir: boolean }): JSX.Element {
  if (props.dir) return <span class="fic dir" />;
  const base = props.name.split("/").pop()!;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  const [label, color] = EXT[ext] ?? ["··", "#8a8f9c"];
  return <span class="fic" style={{ "--fc": color }}>{label}</span>;
}

export default function FileTree(props: {
  project: Project;
  /** The file the editor shows, revealed and selected. */
  shown?: string;
  open: (path: string, how: OpenHow & { focus?: boolean }) => void;
  ref?: (el: HTMLDivElement) => void;
}): JSX.Element {
  let rootEl!: HTMLDivElement;
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [sel, setSel] = createSignal("");
  /** The folder a new file is being named in. */
  const [draft, setDraft] = createSignal<string | null>(null);
  /** The file or folder being renamed. */
  const [renaming, setRenaming] = createSignal<string | null>(null);

  const marks = createMemo(() => fileMarks(props.project));
  const markOf = (r: Row) => markAt(marks(), r.path, r.dir);
  /** A folder that holds changes shows a dot; an untracked folder, like a file, shows its letter. */
  const letter = (r: Row) => (r.dir && !markAt(marks(), r.path) ? "•" : markOf(r) === "C" ? "!" : markOf(r));
  // The status line polls only the active project; read this one's status when the tree opens.
  onMount(() => void peekStatus(props.project));

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
      if (draft() === dir) out.push({ path: dir, name: "", dir: false, depth, draft: true });
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

  // Reveal the file the editor shows: expand its folders and select it.
  createEffect(on(() => props.shown, (f) => {
    const root = props.project.path.replace(/[\\/]+$/, "");
    if (!f || !f.startsWith(`${root}/`)) return;
    const parts = f.slice(root.length + 1).split("/").slice(0, -1);
    setOpen((s) => {
      const n = new Set(s);
      let dir = root;
      for (const part of parts) n.add((dir = `${dir}/${part}`));
      return n;
    });
    setSel(f);
    requestAnimationFrame(() => rootEl?.querySelector(`[data-path="${CSS.escape(f)}"]`)?.scrollIntoView({ block: "nearest" }));
  }));

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
    // Space previews and stays in the tree; Enter opens and goes to the file; Ctrl+Enter opens it beside
    else if (e.key === "Delete") { if (at) void remove(at); }
    else if (e.key === "F2") { e.preventDefault(); if (at) setRenaming(at.path); }
    else if (e.key === " ") { e.preventDefault(); if (at && !at.dir) props.open(at.path, { preview: true }); }
    else if (e.key === "Enter") {
      if (!at) return;
      if (at.dir) toggle(at.path);
      else props.open(at.path, e.ctrlKey || e.metaKey ? { beside: true } : { preview: true, focus: true });
    }
  };

  const root = () => dirState(props.project, props.project.path);
  const dirOf = (r: Row | undefined) => (!r ? props.project.path : r.dir ? r.path : r.path.slice(0, r.path.lastIndexOf("/")));

  /** Open the New File box in `dir`, expanding it. */
  const newFile = (dir: string) => {
    if (dir !== props.project.path && !isOpen(dir)) toggle(dir);
    setDraft(dir);
  };

  const create = async (dir: string, name: string) => {
    const rel = name.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    setDraft(null);
    if (!rel) return rootEl.focus();
    if (rel.split("/").some((p) => p === "" || p === "." || p === "..")) return flash(`not a file name: ${name}`);
    const path = join(dir, rel);
    try {
      await createFile(props.project, path);
    } catch (e) {
      return flash(String(e));
    }
    // The folder and any folders made on the way are listed again and opened, so the file shows.
    const dirs = [dir];
    for (const part of rel.split("/").slice(0, -1)) dirs.push(join(dirs[dirs.length - 1], part));
    for (const d of dirs) refreshDir(props.project, d);
    setOpen((s) => new Set([...s, ...dirs.slice(1)]));
    props.open(path, { focus: true });
  };

  const remove = async (r: Row) => {
    const what = `${r.dir ? "the folder " : ""}${relOf(r.path)}${r.dir ? " and everything in it" : ""}`;
    const note = isRemote(props.project) ? `It is on ${props.project.host}, so this can't be undone.` : "It goes to the Recycle Bin.";
    if (!await ask(`Delete ${what}?\n\n${note}`)) return;
    try {
      await deletePath(props.project, r.path);
    } catch (e) {
      return flash(`delete failed: ${e}`);
    }
    flash(`deleted ${r.name}`);
    refreshDir(props.project, dirOf({ ...r, dir: false }));
    rootEl.focus();
  };

  const rename = async (r: Row, name: string) => {
    const to = name.trim();
    setRenaming(null);
    rootEl.focus();
    if (!to || to === r.name) return;
    if (/[\\/]/.test(to) || to === "." || to === "..") return flash(`not a file name: ${to}`);
    const parent = dirOf({ ...r, dir: false });
    const path = join(parent, to);
    try {
      await renamePath(props.project, r.path, path);
    } catch (e) {
      return flash(`rename failed: ${e}`);
    }
    refreshDir(props.project, parent);
    // A renamed folder stays open, and so do the folders open inside it.
    const moved = (p: string) => (p === r.path ? path : p.startsWith(`${r.path}/`) ? path + p.slice(r.path.length) : p);
    setOpen((s) => new Set([...s].map(moved)));
    setSel(path);
  };

  const relOf = (f: string) => f.slice(props.project.path.replace(/[\\/]+$/, "").length + 1);
  const onMenu = (e: MouseEvent) => {
    const el = rowOf(e);
    const r = el ? rows().find((x) => !x.draft && x.path === el.dataset.path) : undefined;
    if (r) setSel(r.path);
    openCtxMenu(e, [
      { label: "New File…", run: () => newFile(dirOf(r)) },
      "sep",
      ...(r ? [
        { label: "Copy Path", run: () => copyText(r.path) },
        { label: "Copy Relative Path", run: () => copyText(relOf(r.path)) },
        "sep" as const,
        { label: "Rename…", kbd: "F2", run: () => setRenaming(r.path) },
        { label: "Delete", kbd: "Delete", run: () => void remove(r) },
        "sep" as const,
      ] : []),
      { label: "Refresh", run: () => refreshProject(props.project) },
    ]);
  };

  const where = () => `${isRemote(props.project) ? `${props.project.host}:` : ""}${props.project.path}`;
  const rowOf = (e: MouseEvent) => (e.target as HTMLElement).closest<HTMLElement>("[data-path]");

  return (
    <div class="ftreewrap">
      <div class="fthead">
        <span class="proj" title={where()}>{props.project.name}</span>
        <button title="New file" onClick={() => newFile(dirOf(rows().find((r) => r.path === sel())))}>+</button>
        <button title="Refresh (reloads the whole tree and open files)" onClick={() => refreshProject(props.project)}>⟳</button>
      </div>
      <div
        class="ftree"
        ref={(el) => ((rootEl = el), props.ref?.(el))}
        tabIndex={0}
        onKeyDown={onKey}
        onContextMenu={onMenu}
        onClick={(e) => {
          const el = rowOf(e);
          if (!el) return;
          const path = el.dataset.path!;
          setSel(path);
          if (el.dataset.dir === "1") toggle(path);
          else props.open(path, e.ctrlKey || e.metaKey ? { beside: true } : { preview: true });
        }}
        onDblClick={(e) => {
          const el = rowOf(e);
          if (el && el.dataset.dir !== "1") props.open(el.dataset.path!, { focus: true });
        }}
      >
        <Show
          when={rows().length}
          fallback={<div class="fnote">{root()?.error ?? (root()?.loading ? "Loading…" : "Empty folder")}</div>}
        >
          <For each={rows()}>
            {(r) => r.draft ? (
              <div class="frow fdraft" style={{ "padding-left": `${6 + r.depth * 12}px` }}>
                <span class="fchev" />
                <FileIcon name="" dir={false} />
                <input
                  aria-label={`New file in ${r.path}`}
                  placeholder="file name (a/b.ts makes folders)"
                  ref={(el) => requestAnimationFrame(() => el.focus())}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") void create(r.path, e.currentTarget.value);
                    else if (e.key === "Escape") (setDraft(null), rootEl.focus());
                  }}
                  onBlur={(e) => draft() === r.path && void create(r.path, e.currentTarget.value)}
                />
              </div>
            ) : (
              <div
                class="frow"
                data-g={markOf(r)}
                classList={{ sel: r.path === sel(), dir: r.dir, shown: r.path === props.shown }}
                data-path={r.path}
                data-dir={r.dir ? "1" : "0"}
                title={markOf(r) ? `${r.name} · ${letter(r) === "•" ? "has changes" : MARK_TITLE[markOf(r)!]}` : undefined}
                style={{ "padding-left": `${6 + r.depth * 12}px` }}
              >
                <span class="fchev">{r.dir ? (isOpen(r.path) ? "▾" : "▸") : ""}</span>
                <FileIcon name={r.name} dir={r.dir} />
                <Show when={renaming() === r.path} fallback={<span class="fname">{r.name}</span>}>
                  <input
                    class="fren"
                    aria-label={`Rename ${r.name}`}
                    value={r.name}
                    ref={(el) => requestAnimationFrame(() => {
                      el.focus();
                      // Like VS Code, the name is selected without its extension.
                      const dot = r.dir ? -1 : r.name.lastIndexOf(".");
                      el.setSelectionRange(0, dot > 0 ? dot : r.name.length);
                    })}
                    onClick={(e) => e.stopPropagation()}
                    onDblClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") void rename(r, e.currentTarget.value);
                      else if (e.key === "Escape") (setRenaming(null), rootEl.focus());
                    }}
                    onBlur={(e) => renaming() === r.path && void rename(r, e.currentTarget.value)}
                  />
                </Show>
                <Show when={markOf(r)}>
                  <span class="fmark">{letter(r)}</span>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
