// The editor window: the project's file tree, a tab per open file and a CodeMirror editor, with a
// rendered preview for Markdown, HTML and SVG and a player for images, video and audio. A click in
// the tree opens a preview tab (italic) that the next click replaces; a double-click, or an edit,
// keeps it. Ctrl+click opens a second editor beside this one. Chosen from design/editor.html
// (variant B). A changed file also has a Source | Diff mode comparing HEAD with the live buffer
// (design/diff.html, variant A); a drill from the git window opens either mode at a line.
//
// Each open file is an EditorState, kept per window outside the component, so switching tabs keeps
// its undo history and a closed window brought back with undo still has its unsaved edits.

import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type Project, type Tab, diffModeOf, focusTab, setEditorTab, setProjectDiffMode } from "./state";
import {
  CHANGED, type Media, type FsText, type OpenHow, closeFileInTab, dirty, docsOf, filesOf, keepPreview, loadImage, loadMedia, loadText,
  markDirty, mediaType, openFile, reloadText, saveText, textState, touchEditor,
} from "./files";
import { createState, fromBody, indentText, languageOf, showChanges, toBody } from "./cm";
import FileTree, { FileIcon, MARK_TITLE } from "./FileList";
import { fileMarks, markAt, peekStatus } from "./git";
import { enhance, hasScheme, renderMarkdown, resolvePath } from "./markdown";
import { openExternal, openUrlInProject } from "./browsers";
import { capsOf, withKey } from "./keymap";
import { flash } from "./ui";
import { type DiffMode, changeMarks, diffStats, makePatch, parseUnified, sameText } from "./diff";
import DiffView, { diffKeys, stepHunk } from "./DiffView";
import { headText, repoEpoch, repoOfFile, type RepoRef } from "./repos";
import "./files.css";

type Preview = "md" | "html" | "svg";

function previewKind(path: string): Preview | null {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  return null;
}

const name = (f: string) => f.split("/").pop() ?? f;

/** The mounted component of each editor window. A file's editor state outlives the component that
 *  built it (a window closed and brought back with undo), so its callbacks look the window up here. */
const windows = new Map<string, { update: (f: string, s: EditorState, changed: boolean) => void; save: (f: string) => void }>();

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** An image, video or audio file, played from a blob URL that is revoked when replaced or closed. */
function MediaView(props: { project: Project; path: string; media: Media; mime: string; reloads: number }): JSX.Element {
  const [url] = createResource(
    () => ({ path: props.path, mime: props.mime, n: props.reloads }),
    (s) => loadMedia(props.project, s.path, s.mime),
  );
  createEffect(() => {
    const u = url.latest;
    if (u) onCleanup(() => URL.revokeObjectURL(u));
  });
  const failed = () => flash(`can't play ${props.path}`);
  return (
    <Show when={!url.error} fallback={<div class="fnote bad">{String(url.error)}</div>}>
      <Show when={url.latest} fallback={<div class="fnote">Loading…</div>}>
        {(u) => (
          <div class="fmedia">
            {props.media === "image" ? (
              <img src={u()} alt={props.path} />
            ) : props.media === "video" ? (
              <video src={u()} controls onError={failed} />
            ) : (
              <audio src={u()} controls onError={failed} />
            )}
          </div>
        )}
      </Show>
    </Show>
  );
}

export default function Editor(props: { project: Project; tab: Tab; focused: boolean }): JSX.Element {
  const tabId = props.tab.id;
  const mine = docsOf(tabId);
  const path = () => props.tab.path ?? "";
  const files = () => filesOf(props.tab);
  const text = () => textState(props.project, path());
  const media = () => (path() ? mediaType(path()) : null);
  const kind = () => previewKind(path());

  let host!: HTMLDivElement;
  let treeEl: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  /** The file the view shows now, or "" while it shows nothing. */
  let current = "";

  /** Bumped on every edit, so the preview and status bar re-read the document. */
  const [rev, setRev] = createSignal(0);
  /** The shown file's doc is ready in the view. */
  const [ready, setReady] = createSignal("");
  const [cursor, setCursor] = createSignal({ line: 1, col: 1, sel: 0 });
  /** Preview or source, per file; Markdown, HTML and SVG start as preview. */
  const [modes, setModes] = createStore<Record<string, "preview" | "source" | "diff">>({});
  const previewing = () => !!kind() && (modes[path()] ?? "preview") === "preview";
  const diffing = () => modes[path()] === "diff";
  /** Bumped by Reload so a media file is read again. */
  const [reloads, setReloads] = createSignal(0);

  const doc = () => (rev(), ready() === path() ? mine.get(path()) : undefined);
  const isDirty = (f: string) => !!dirty[tabId]?.[f];

  const showCursor = (s: EditorState) => {
    const r = s.selection.main, line = s.doc.lineAt(r.head);
    const sel = s.selection.ranges.reduce((n, x) => n + Math.abs(x.to - x.from), 0);
    setCursor({ line: line.number, col: r.head - line.from + 1, sel });
  };

  const onUpdate = (f: string, s: EditorState, changed: boolean) => {
    const d = mine.get(f);
    if (!d) return;
    d.state = s;
    if (changed) {
      const mod = !s.doc.eq(d.base);
      markDirty(tabId, f, mod);
      // An edit keeps a preview tab, so the next file can't replace the edits.
      if (mod) keepPreview(props.project, props.tab, f);
      setRev((n) => n + 1);
    }
    if (f === current) showCursor(s);
  };

  /** Put `f`'s doc in the view, remembering where the one shown before was scrolled. */
  const show = (f: string) => {
    if (!view) return;
    const prev = mine.get(current);
    if (prev && current !== f) prev.top = view.scrollDOM.scrollTop;
    const d = mine.get(f);
    if (!d) return;
    if (view.state !== d.state) view.setState(d.state);
    current = f;
    setReady(f);
    showCursor(d.state);
    requestAnimationFrame(() => view && (view.scrollDOM.scrollTop = d.top));
  };

  /** Read file `f` into a new doc (or a doc over the one there is), then show it if it's still the one wanted. */
  const build = async (f: string, file: FsText) => {
    const body = toBody(file.text ?? "");
    const state = await createState({
      path: f, body, readOnly: file.truncated,
      save: () => windows.get(tabId)?.save(f),
      onUpdate: (s, changed) => windows.get(tabId)?.update(f, s, changed),
    });
    mine.set(f, { state, body, base: state.doc, stamp: file.stamp, top: mine.get(f)?.top ?? 0 });
    markDirty(tabId, f, false);
    if (f === path()) show(f);
    setRev((n) => n + 1);
  };

  onMount(() => {
    view = new EditorView({ parent: host });
    windows.set(tabId, { update: onUpdate, save: (f) => void save(f) });
  });
  onCleanup(() => {
    windows.delete(tabId);
    const d = mine.get(current);
    if (d && view) d.top = view.scrollDOM.scrollTop;
    view?.destroy();
  });

  // Load the shown file, and show it once it's read. A file read again (Reload, the tree's ⟳) replaces
  // its doc, unless it has edits: those stay, and saving them asks first.
  createEffect(on(
    () => [path(), text()?.file] as const,
    ([f, file]) => {
      if (!f || media()) return;
      loadText(props.project, f);
      if (!file || file.binary) return;
      const d = mine.get(f);
      if (!d) return void build(f, file);
      if (d.saving || d.stamp === file.stamp) return show(f);
      if (isDirty(f)) {
        flash(`${name(f)} changed on disk; your edits are kept`);
        return show(f);
      }
      void build(f, file);
    },
  ));

  // Drop the docs of files closed out of the window.
  createEffect(() => {
    const held = new Set(files());
    for (const f of [...mine.keys()]) {
      if (held.has(f)) continue;
      mine.delete(f);
      markDirty(tabId, f, false);
    }
  });

  // The window takes focus: the editor if a file is open in it, else the tree.
  createEffect(() => {
    if (!props.focused) return;
    touchEditor(tabId);
    requestAnimationFrame(() => {
      if (document.activeElement && (host.contains(document.activeElement) || treeEl?.contains(document.activeElement))) return;
      if (showingEditor()) view?.focus();
      else treeEl?.focus();
    });
  });

  const marks = createMemo(() => fileMarks(props.project));

  const showingEditor = () => !!path() && !media() && !previewing() && !diffing() && ready() === path() && !!text()?.file && !text()!.file!.binary;
  // The view measures itself; one shown again after being hidden (or a window made visible) re-measures.
  createEffect(on(showingEditor, (on) => on && view?.requestMeasure()));

  async function save(f: string) {
    const d = mine.get(f);
    if (!d || d.saving || !isDirty(f)) return;
    const snapshot = d.state.doc;
    const write = (stamp: string | null) => saveText(props.project, f, fromBody(d.body, snapshot), stamp);
    d.saving = true;
    try {
      let next: string;
      try {
        next = await write(d.stamp);
      } catch (e) {
        if (String(e) !== CHANGED) throw e;
        if (!confirm(`${name(f)} changed on disk since it was opened (an agent may have written to it).\n\nOverwrite it with your version?`)) return;
        next = await write(null);
      }
      d.stamp = next;
      d.base = snapshot;
      markDirty(tabId, f, !d.state.doc.eq(snapshot));
      flash(`saved ${name(f)}`);
      void peekStatus(props.project, true);
    } catch (e) {
      flash(`save failed: ${e}`);
    } finally {
      d.saving = false;
    }
  }

  const reload = () => {
    const f = path();
    if (!f) return;
    if (media()) return setReloads((n) => n + 1);
    if (isDirty(f) && !confirm(`Discard your changes to ${name(f)}?`)) return;
    mine.delete(f);
    markDirty(tabId, f, false);
    setReady("");
    reloadText(props.project, f);
  };

  const closeFile = (f: string) => {
    if (isDirty(f) && !confirm(`Discard your changes to ${name(f)}?`)) return;
    closeFileInTab(props.project, props.tab, f);
  };

  const open = (f: string, how: OpenHow & { focus?: boolean }) => {
    openFile(props.project, f, { ...how, from: tabId });
    if (how.focus) requestAnimationFrame(() => view?.focus());
  };

  const pick = (f: string) => {
    setEditorTab(props.project.id, tabId, { path: f });
    focusTab(props.project.id, tabId);
  };

  // ---- previews -----------------------------------------------------------------------------

  const source = () => (rev(), mine.get(path())?.state.doc.toString() ?? text()?.file?.text ?? "");

  // ---- the file's changes, for Source | Diff ------------------------------------------------

  /** HEAD's text for this file, when it is in a repo; `text` null means new / untracked (all added),
   *  and `from` is the path HEAD has it under after a staged rename. */
  type Head = { key: string; ref: RepoRef; text: string | null; from?: string | null };
  const [head, setHead] = createSignal<Head | null>(null);
  const [headTried, setHeadTried] = createSignal("");
  const [headNote, setHeadNote] = createSignal("");
  const [focusLine, setFocusLine] = createSignal<number | undefined>();
  const [paneW, setPaneW] = createSignal(0);
  const [queued, setQueued] = createSignal<number | null>(null);
  const [headTick, setHeadTick] = createSignal(0);
  let mainEl: HTMLDivElement | undefined;
  let diffEl: HTMLDivElement | undefined;
  let headSeq = 0;

  // HEAD can move while the editor is not looking (a commit in the git window, an agent's checkout).
  createEffect(on(() => props.focused, (f) => { if (f) setHeadTick((n) => n + 1); }, { defer: true }));

  // HEAD comes from a per-file cache (repos.ts), so switching tabs is free. Focus re-reads the shown
  // file, keeping the old HEAD on screen until the new one is in.
  createEffect(on(
    () => [path(), text()?.file?.binary, text()?.file?.truncated, repoEpoch(), headTick()] as const,
    async ([f, binary, truncated, , tick], prev) => {
      const seq = ++headSeq;
      const fresh = !!prev && prev[0] === f && prev[4] !== tick;
      if (!prev || prev[0] !== f) {
        setHead(null);
        setHeadTried("");
        setHeadNote("");
      }
      if (!f || media() || binary) return;
      if (truncated || (text()?.file?.size ?? 0) > 1_500_000) {
        setHeadTried(f);
        setHeadNote("This file is too large to diff.");
        return;
      }
      try {
        const ref = await repoOfFile(props.project, f);
        if (seq !== headSeq) return;
        if (!ref) {
          setHeadTried(f);
          setHeadNote("This file is not in a git repository.");
          return;
        }
        const at = await headText(props.project, ref, fresh);
        if (seq !== headSeq) return;
        setHead({ key: f, ref, text: at.text, from: at.from });
        setHeadNote("");
        setHeadTried(f);
      } catch (e) {
        if (seq !== headSeq) return;
        setHead(null);
        setHeadTried(f);
        setHeadNote(String(e));
      }
    },
  ));

  // Source mode's change bars: HEAD against the live doc, a moment after the last edit. A new
  // file (nothing at HEAD) gets none rather than one long green bar.
  let barsTimer = 0;
  /** How many changed regions the bars show, for the Diff button. */
  const [barCount, setBarCount] = createSignal(0);
  createEffect(() => {
    rev();
    const f = path();
    const h = head();
    window.clearTimeout(barsTimer);
    if (!view || !f || ready() !== f) return;
    if (!h || h.key !== f || h.text === null) {
      if (headTried() === f) {
        setBarCount(0);
        setBars(f, null);
      }
      return;
    }
    const was = h.text;
    barsTimer = window.setTimeout(() => {
      if (!view || current !== f) return;
      const patch = makePatch(h.ref.rel, was, view.state.doc.toString(), 150);
      const hunks = patch === undefined ? [] : parseUnified(patch);
      setBarCount(hunks.length);
      setBars(f, patch === undefined ? null : changeMarks(hunks));
    }, 200);
  });
  onCleanup(() => window.clearTimeout(barsTimer));

  /** Put the bars in the view, and in the file's kept state so showing it again keeps them. */
  const setBars = (f: string, m: ReturnType<typeof changeMarks> | null) => {
    if (!view || current !== f) return;
    showChanges(view, m);
    const d = mine.get(f);
    if (d) d.state = view.state;
  };

  /** The live doc against HEAD, so unsaved edits are part of the patch. */
  const diffable = () => {
    const h = head();
    if (!h || h.key !== path()) return false;
    const src = source();
    return h.text === null ? src.length > 0 : !sameText(src, h.text);
  };

  const patch = createMemo(() => {
    if (!diffing()) return "";
    const h = head();
    if (!h || h.key !== path()) return undefined;
    return makePatch(h.from ?? h.ref.rel, h.text ?? "", source());
  });
  const patchHunks = createMemo(() => (patch() ? parseUnified(patch()!) : []));
  const patchStats = createMemo(() => diffStats(patchHunks()));

  const wantedMode = (): DiffMode => diffModeOf(props.project);
  const diffMode = (): DiffMode => (wantedMode() === "unified" || (paneW() > 0 && paneW() < 660) ? "unified" : "split");
  const setDiffMode = (m: DiffMode) => setProjectDiffMode(props.project.id, m);

  // A clean file has nothing to diff: go back to the source instead of an empty pane.
  createEffect(() => {
    if (!diffing()) return;
    const h = head();
    if (!h || h.key !== path()) return;
    if (!diffable()) setModes(path(), "source");
  });

  const applyJump = (line: number) => {
    const d = mine.get(path());
    if (!view || !d || !showingEditor()) return;
    const n = Math.min(Math.max(1, line), view.state.doc.lines);
    const pos = view.state.doc.line(n).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    setQueued(null);
    setFocusLine(undefined);
    if (props.focused) view.focus();
  };

  // A queued drill waits for the file's doc to be in the view.
  createEffect(() => {
    const line = queued();
    if (line == null || !showingEditor()) return;
    requestAnimationFrame(() => applyJump(line));
  });

  // A drill from the git window (or the editor's own diff): show source or diff, then jump.
  createEffect(on(() => props.tab.at?.seq, () => {
    const at = props.tab.at;
    const f = path();
    if (!at || !f) return;
    if (at.mode === "diff") {
      setModes(f, "diff");
      setFocusLine(at.line);
    } else {
      setModes(f, "source");
      setFocusLine(undefined);
      setQueued(at.line);
    }
    setEditorTab(props.project.id, tabId, { at: undefined });
  }));

  // Alt+D (keymap "diff"): Source ⇄ Diff for a changed file.
  onMount(() => {
    diffKeys.set(tabId, () => {
      const f = path();
      if (!f) return false;
      if (diffing()) {
        setModes(f, "source");
        requestAnimationFrame(() => view?.focus());
        return true;
      }
      if (!diffable()) return false;
      // The diff opens where the cursor is.
      setFocusLine(cursor().line);
      setModes(f, "diff");
      requestAnimationFrame(() => diffEl?.focus());
      return true;
    });
    onCleanup(() => diffKeys.delete(tabId));
  });

  onMount(() => {
    if (!mainEl) return;
    const ro = new ResizeObserver(([entry]) => setPaneW(entry.contentRect.width));
    ro.observe(mainEl);
    onCleanup(() => ro.disconnect());
  });

  const diffPane = () => {
    const h = head();
    if (!h) return <div class="fnote">{headTried() === path() ? headNote() || "Checking HEAD…" : "Checking HEAD…"}</div>;
    return (
      <div class="ediff">
        <div class="ediff-head">
          <Show when={h.ref.repo}><span class="fchip">{h.ref.repo}</span></Show>
          <span class="fchip on" title={h.from ? `Renamed from ${h.from} (staged)` : undefined}>
            {h.from ? `HEAD:${h.from} → buffer` : h.text === null ? "new file → buffer" : "HEAD → buffer"}
          </span>
          <span class="ediff-stat"><i class="p">+{patchStats().added}</i> <i class="m">−{patchStats().removed}</i></span>
          <span class="fnote-inline">{patchHunks().length} hunk{patchHunks().length === 1 ? "" : "s"}</span>
          <span class="ediff-sp" />
          <button class="ehunk" title="Previous hunk (P)" disabled={!patchHunks().length} onClick={() => diffEl && stepHunk(diffEl, -1)}>⌃</button>
          <button class="ehunk" title="Next hunk (N)" disabled={!patchHunks().length} onClick={() => diffEl && stepHunk(diffEl, 1)}>⌄</button>
          <div class="seg" role="group" aria-label="Diff orientation">
            <button aria-pressed={diffMode() === "unified"} title="A stacked diff" onClick={() => setDiffMode("unified")}>☰<span class="lbl"> Unified</span></button>
            <button
              aria-pressed={diffMode() === "split"}
              title={wantedMode() === "split" && diffMode() === "unified" ? "Split needs about 660px: this pane shows unified" : "Side by side"}
              onClick={() => setDiffMode("split")}
            >▥<span class="lbl"> Split</span></button>
          </div>
        </div>
        <DiffView
          text={patch()}
          mode={diffMode()}
          focusLine={focusLine()}
          onMode={setDiffMode}
          onDrill={(line) => { setModes(path(), "source"); setFocusLine(undefined); setQueued(line); }}
          ref={(el) => (diffEl = el)}
        />
      </div>
    );
  };

  const openLink = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    if (hasScheme(href)) return openExternal(href);
    const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
    const target = href.startsWith("#") ? path() : resolvePath(path(), props.project.path, href);
    if (target !== path()) return openFile(props.project, target, { from: tabId, beside: e.ctrlKey || e.metaKey });
    if (!hash) return;
    let id = hash;
    try { id = decodeURIComponent(hash); } catch { /* keep it as written */ }
    const root = e.currentTarget as HTMLElement;
    const el = root.querySelector(`[id="${CSS.escape(id)}"]`) ?? root.querySelector(`[id="${CSS.escape(id.toLowerCase())}"]`);
    if (el) el.scrollIntoView({ block: "start" });
    else flash(`no heading #${id}`);
  };

  /** Best-effort `file://` URL for the local HTML "open in a browser window" button. */
  const fileUrl = () => {
    const p = text()?.file?.path;
    if (!p || p.startsWith("~")) return "";
    let s = p.replace(/\\/g, "/");
    if (/^[a-zA-Z]:/.test(s)) s = `/${s}`;
    return `file://${s.startsWith("/") ? "" : "/"}${s}`;
  };

  const markdown = (src: string) => {
    const el = (<div class="md" innerHTML={renderMarkdown(src)} />) as HTMLElement;
    enhance(el, (src) => loadImage(props.project, resolvePath(path(), props.project.path, src)));
    return <div class="mdscroll" onClick={openLink}>{el}</div>;
  };

  /** What shows instead of the editor: a note, a preview or media; null when the editor shows. */
  const other = createMemo<JSX.Element | null>(() => {
    if (!path()) {
      const k = capsOf("go-to-file");
      return (
        <div class="fempty">
          <p>No file open.</p>
          <p>Pick one in the tree{k ? <>, or press <kbd>{k.join("+")}</kbd></> : ""}.</p>
        </div>
      );
    }
    const m = media();
    if (m) return <MediaView project={props.project} path={path()} media={m[0]} mime={m[1]} reloads={reloads()} />;
    const st = text();
    if (st?.error) return <div class="fnote bad">{st.error}</div>;
    const f = st?.file;
    if (!f) return <div class="fnote">{st?.loading ? "Loading…" : "No file."}</div>;
    if (f.binary) return <div class="fnote">Binary file · {bytes(f.size)}</div>;
    if (diffing()) return diffPane();
    if (!previewing()) return ready() === path() ? null : <div class="fnote">Loading…</div>;
    const t = source();
    if (!t) return <div class="fnote">Empty file.</div>;
    if (kind() === "md") return markdown(t);
    if (kind() === "html") return <iframe class="htm" sandbox="allow-scripts allow-forms allow-modals" srcdoc={t} title={path()} />;
    return <div class="fmedia"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(t)}`} alt={path()} /></div>;
  });

  // ---- chrome -------------------------------------------------------------------------------

  const rel = () => {
    const root = props.project.path.replace(/[\\/]+$/, "");
    return path().startsWith(`${root}/`) ? path().slice(root.length + 1) : path();
  };
  const tree = () => props.tab.tree !== false;
  const setTree = (on: boolean) => {
    setEditorTab(props.project.id, tabId, { tree: on ? undefined : false });
    if (on) requestAnimationFrame(() => treeEl?.focus());
  };

  return (
    <div class="edwin" classList={{ notree: !tree() }}>
      <Show when={tree()}>
        <div class="edtree">
          <FileTree project={props.project} shown={path() || undefined} open={open} ref={(el) => (treeEl = el)} />
        </div>
      </Show>
      <div class="edmain" ref={(el) => (mainEl = el)}>
        <div class="ftabs" role="tablist">
          <button class="ftree-tg" title={tree() ? "Hide the file tree" : "Show the file tree"} aria-pressed={tree()} onClick={() => setTree(!tree())}>
            ▤
          </button>
          <For each={files()}>
            {(f) => (
              <span
                class="ft"
                classList={{ on: f === path(), pv: props.tab.preview === f }}
                data-g={markAt(marks(), f)}
                role="tab"
                aria-selected={f === path()}
                title={[f, markAt(marks(), f) && MARK_TITLE[markAt(marks(), f)!], props.tab.preview === f && "preview: double-click to keep"].filter(Boolean).join(" · ")}
                onClick={() => pick(f)}
                onDblClick={() => keepPreview(props.project, props.tab, f)}
                onAuxClick={(e) => e.button === 1 && closeFile(f)}
              >
                <FileIcon name={f} dir={false} />
                <span class="ftn">{name(f)}</span>
                <button
                  classList={{ dirty: isDirty(f) }}
                  title={isDirty(f) ? "Modified · close" : "Close"}
                  aria-label={`Close ${f}`}
                  onClick={(e) => (e.stopPropagation(), closeFile(f))}
                >
                  <span class="dot">●</span><span class="x">✕</span>
                </button>
              </span>
            )}
          </For>
        </div>
        <Show when={path()}>
          <div class="crumbs">
            <span class="cpath" title={path()}>
              <For each={rel().split("/")}>
                {(part, i) => (
                  <>
                    <Show when={i() > 0}><i>›</i></Show>
                    <span classList={{ last: i() === rel().split("/").length - 1 }}>{part}</span>
                  </>
                )}
              </For>
            </span>
            <Show when={text()?.file && !text()!.file!.binary && (!!kind() || diffable() || diffing())}>
              <div class="seg" role="group" aria-label="View mode">
                <Show when={kind()}>
                  <button aria-pressed={previewing()} onClick={() => setModes(path(), "preview")}>Preview</button>
                </Show>
                <button
                  aria-pressed={!previewing() && !diffing()}
                  onClick={() => (setModes(path(), "source"), requestAnimationFrame(() => view?.focus()))}
                >Source</button>
                <Show when={diffable()}>
                  <button aria-pressed={diffing()} title={withKey("HEAD → buffer", "diff")} onClick={() => setModes(path(), "diff")}>
                    Diff<Show when={barCount()}><span class="segn">{barCount()}</span></Show>
                  </button>
                </Show>
              </div>
            </Show>
            <Show when={kind() === "html" && props.project.host === "local" && fileUrl()}>
              <button title="Open in a browser window (relative assets load there)" onClick={() => openUrlInProject(props.project.id, fileUrl(), tabId)}>
                Open ↗
              </button>
            </Show>
            <Show when={isDirty(path())}>
              <button class="fsave" title="Save (Ctrl+S)" onClick={() => void save(path())}>Save</button>
            </Show>
            <button title={isDirty(path()) ? "Reload (discards changes)" : "Reload"} onClick={reload}>⟳</button>
          </div>
        </Show>
        <div class="edbody">
          <div class="cmhost" ref={host} style={{ display: showingEditor() ? undefined : "none" }} />
          {other()}
        </div>
        <Show when={path() && !media()}>
          <div class="estatus">
            <Show when={doc()}>
              {(d) => (
                <>
                  <Show when={showingEditor()}>
                    <span>Ln {cursor().line}, Col {cursor().col}{cursor().sel ? ` (${cursor().sel} selected)` : ""}</span>
                  </Show>
                  <span>{indentText(d().body.indent)}</span>
                  <span>{d().body.bom ? "UTF-8 with BOM" : "UTF-8"}</span>
                  <span>{d().body.eol === "\r\n" ? "CRLF" : "LF"}</span>
                </>
              )}
            </Show>
            <span>{languageOf(path())?.name ?? "Plain text"}</span>
            <span class="sp" />
            <Show when={text()?.file}>
              {(f) => <span classList={{ warn: f().truncated }}>{bytes(f().size)}{f().truncated ? " · truncated, read-only" : ""}</span>}
            </Show>
            <Show when={isDirty(path())}><span class="mod">modified</span></Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
