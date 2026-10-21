// The file window: one file, as source, in an editor, or — for Markdown and HTML —
// a rendered preview. Unsaved edits are a draft that every mode shows, so Preview
// reflects them before Save. The body is a memo so switching modes swaps the DOM.
// In Tabs mode it holds several files in a tab strip; in Preview mode it can be the
// preview window, which the next file replaces. Its ⋯ menu changes the mode, and the
// first time a second file opens it asks how (see Settings.tsx).

import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { type Project, type Tab, app } from "./state";
import {
  type Media, answerAsk, ask, cancelAsk, closeFileInTab, filesOf, keepPreview, loadImage, loadMedia, loadText, mediaType, openFile,
  reloadText, saveText, setFileOpen, textState,
} from "./files";
import { FILE_OPEN, toggleSettings } from "./Settings";
import { codeHtml } from "./code";
import { enhance, hasScheme, renderMarkdown, resolvePath } from "./markdown";
import { openExternal, openUrlInProject } from "./browsers";
import { flash } from "./ui";
import "./files.css";

type Preview = "md" | "html" | "svg";

function previewKind(path: string): Preview | null {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  return null;
}

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
  const failed = () => {
    flash(`can't play ${props.path}`);
  };
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

export default function FileView(props: { project: Project; tab: Tab }): JSX.Element {
  const path = () => props.tab.path ?? "";
  const state = () => textState(props.project, path());
  const [mode, setMode] = createSignal<"auto" | "preview" | "source" | "edit">("auto");
  /** Unsaved text by path, so switching tabs keeps each file's edits. */
  const [drafts, setDrafts] = createStore<Record<string, string | undefined>>({});
  /** Unsaved text of the file shown, or null when the editor matches the file. */
  const draft = () => drafts[path()] ?? null;
  const setDraft = (v: string | null) => setDrafts(path(), v ?? undefined);
  const [menu, setMenu] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  /** Bumped by Reload so a media file is read again. */
  const [reloads, setReloads] = createSignal(0);
  const media = () => mediaType(path());

  createEffect(() => {
    if (path() && !media()) loadText(props.project, path());
  });
  // A reused window, or another tab, gets a new path: start it in the default mode again.
  createEffect(on(path, () => setMode("auto"), { defer: true }));
  // Editing a preview keeps it, so the next file can't replace the edits.
  createEffect(() => { if (draft() !== null && props.tab.preview) keepPreview(props.project, props.tab); });
  // A file closed (or replaced) out of the window drops its draft.
  createEffect(() => {
    const held = new Set(filesOf(props.tab));
    for (const k of Object.keys(drafts)) if (!held.has(k) && drafts[k] !== undefined) setDrafts(k, undefined);
  });

  const onDown = (e: PointerEvent) => {
    if (menu() && !(e.target as Element).closest(".fmenu, .fmore")) setMenu(false);
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));
  const asking = () => {
    const a = ask();
    return a && a.tabId === props.tab.id ? a : null;
  };
  const closeFile = (f: string) => {
    if (drafts[f] !== undefined && !confirm(`Discard your changes to ${f.split("/").pop()}?`)) return;
    closeFileInTab(props.project, props.tab, f);
  };

  const kind = () => previewKind(path());
  const previewing = () => !!kind() && (mode() === "auto" || mode() === "preview");
  /** Only a whole text file can be edited: saving a truncated one would cut it short. */
  const editable = () => {
    const f = state()?.file;
    return !!f && !f.binary && !f.truncated;
  };
  const text = () => draft() ?? state()?.file?.text ?? "";

  const save = async () => {
    const d = draft(), f = path();
    if (d === null || saving()) return;
    setSaving(true);
    try {
      await saveText(props.project, f, d);
      // the tab strip may show another file by now
      if (drafts[f] === d) setDrafts(f, undefined);
      flash("saved");
    } catch (e) {
      flash(`save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };
  const reload = () => {
    if (media()) return setReloads((n) => n + 1);
    setDraft(null);
    reloadText(props.project, path());
  };

  const onEditKey = (e: KeyboardEvent) => {
    const ta = e.currentTarget as HTMLTextAreaElement;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end");
      setDraft(ta.value);
    }
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
    if (target !== path()) return openFile(props.project, target, props.tab.id);
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
    const p = state()?.file?.path;
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

  const body = createMemo<JSX.Element>(() => {
    const st = state();
    if (st?.error) return <div class="fnote bad">{st.error}</div>;
    const f = st?.file;
    if (!f) return <div class="fnote">{st?.loading ? "Loading…" : "No file."}</div>;
    if (f.binary) return <div class="fnote">Binary file · {bytes(f.size)}</div>;
    if (mode() === "edit" && editable())
      return (
        <textarea
          class="fedit"
          spellcheck={false}
          value={text()}
          onInput={(e) => setDraft(e.currentTarget.value === f.text ? null : e.currentTarget.value)}
          onKeyDown={onEditKey}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
      );
    const t = text();
    if (!t) return <div class="fnote">Empty file.</div>;
    if (previewing() && kind() === "md") return markdown(t);
    if (previewing() && kind() === "html")
      return <iframe class="htm" sandbox="allow-scripts allow-forms allow-modals" srcdoc={t} title={path()} />;
    if (previewing() && kind() === "svg")
      return <div class="fmedia"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(t)}`} alt={path()} /></div>;
    return <pre class="code" innerHTML={codeHtml(t)} />;
  });

  return (
    <div class="filev">
      <div class="fbar">
        <span
          class="path"
          classList={{ pv: !!props.tab.preview }}
          title={props.tab.preview ? `${path()} · preview: double-click to keep` : path()}
          onDblClick={() => keepPreview(props.project, props.tab)}
        >
          {path()}
        </span>
        <Show when={props.tab.preview}>
          <span class="pvtag">preview</span>
          <button title="Keep this file open: the next file opens a new preview" onClick={() => keepPreview(props.project, props.tab)}>Keep</button>
        </Show>
        <Show when={state()?.file}>
          {(f) => (
            <span class="fmeta">
              {bytes(f().size)}{f().truncated ? " · truncated" : ""}
              <Show when={draft() !== null}><b class="fdirty"> · modified</b></Show>
            </span>
          )}
        </Show>
        <Show when={draft() !== null}>
          <button class="fsave" title="Save (Ctrl+S)" disabled={saving()} onClick={save}>{saving() ? "Saving…" : "Save"}</button>
          <button title="Discard changes" onClick={() => setDraft(null)}>Revert</button>
        </Show>
        <Show when={kind() || editable()}>
          <div class="seg" role="group" aria-label="View mode">
            <Show when={kind()}>
              <button aria-pressed={previewing()} onClick={() => setMode("preview")}>Preview</button>
            </Show>
            <button aria-pressed={!previewing() && mode() !== "edit"} onClick={() => setMode("source")}>Source</button>
            <Show when={editable()}>
              <button aria-pressed={mode() === "edit"} onClick={() => setMode("edit")}>Edit</button>
            </Show>
          </div>
        </Show>
        <Show when={kind() === "html" && props.project.host === "local" && fileUrl()}>
          <button
            title="Open in a browser window (relative assets load there)"
            onClick={() => openUrlInProject(props.project.id, fileUrl(), props.tab.id)}
          >
            Open ↗
          </button>
        </Show>
        <button title={draft() !== null ? "Reload (discards changes)" : "Reload"} onClick={reload}>⟳</button>
        <button class="fmore" title="Opening files" aria-label="Opening files" aria-expanded={menu()} onClick={() => setMenu(!menu())}>⋯</button>
      </div>
      <Show when={menu()}>
        <div class="fmenu" role="menu">
          <h6>Opening a file</h6>
          <For each={FILE_OPEN}>
            {(o) => (
              <button role="menuitemradio" aria-checked={app.settings.fileOpen === o.mode} title={o.help} onClick={() => (setFileOpen(o.mode), setMenu(false))}>
                <span class="ck">{app.settings.fileOpen === o.mode ? "✓" : ""}</span>{o.name}
              </button>
            )}
          </For>
          <hr />
          <button role="menuitem" onClick={() => (setMenu(false), toggleSettings())}><span class="ck" />Settings…</button>
        </div>
      </Show>
      <Show when={asking()}>
        {(a) => {
          let remember!: HTMLInputElement;
          const name = (f: string) => f.split("/").pop();
          const go = (how: "window" | "tabs" | "reuse" | "preview") => answerAsk(how, remember.checked);
          return (
            <div class="fask" role="dialog" aria-label="Open file">
              <p>Open <code>{name(a().path)}</code> with <code>{name(path())}</code> open?</p>
              <div class="opts">
                <button class="primary" onClick={() => go("window")} ref={(el) => queueMicrotask(() => el.focus())}>Beside it</button>
                <button onClick={() => go("tabs")}>As a tab</button>
                <button onClick={() => go("reuse")}>Replace {name(path())}</button>
                <button onClick={() => go("preview")}>Preview</button>
                <button class="x" title="Cancel (Esc)" aria-label="Cancel" onClick={cancelAsk}>✕</button>
              </div>
              <label><input type="checkbox" ref={remember} checked /> Remember (change it from ⋯ or Settings)</label>
            </div>
          );
        }}
      </Show>
      <Show when={filesOf(props.tab).length > 1}>
        <div class="ftabs" role="tablist">
          <For each={filesOf(props.tab)}>
            {(f) => (
              <span
                class="ft"
                classList={{ on: f === path() }}
                role="tab"
                aria-selected={f === path()}
                title={f}
                onClick={() => openFile(props.project, f)}
                onAuxClick={(e) => e.button === 1 && closeFile(f)}
              >
                {f.split("/").pop()}
                <Show when={drafts[f] !== undefined}><b class="fdirty">●</b></Show>
                <button title="Close" aria-label={`Close ${f}`} onClick={(e) => (e.stopPropagation(), closeFile(f))}>✕</button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={media()} fallback={body()}>
        {(m) => <MediaView project={props.project} path={path()} media={m()[0]} mime={m()[1]} reloads={reloads()} />}
      </Show>
    </div>
  );
}
