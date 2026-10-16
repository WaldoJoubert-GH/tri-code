// The file window: one file, as source or — for Markdown and HTML — a rendered
// preview. The mode toggle only appears for files that can preview. The body is
// a memo so switching Preview/Source swaps the DOM.

import { Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import { type Project, type Tab } from "./state";
import { loadText, reloadText, textState } from "./files";
import { codeHtml } from "./code";
import { renderMarkdown } from "./markdown";
import { openExternal, openUrlInProject } from "./browsers";
import { flash } from "./ui";
import "./files.css";

type Preview = "md" | "html";

function previewKind(path: string): Preview | null {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export default function FileView(props: { project: Project; tab: Tab }): JSX.Element {
  const path = () => props.tab.path ?? "";
  const state = () => textState(props.project, path());
  const [mode, setMode] = createSignal<"auto" | "preview" | "source">("auto");

  createEffect(() => {
    if (path()) loadText(props.project, path());
  });
  // A reused window gets a new path: start it in the default mode again.
  createEffect(on(path, () => setMode("auto"), { defer: true }));

  const kind = () => previewKind(path());
  const previewing = () => !!kind() && mode() !== "source";

  const openLink = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (!href || href.startsWith("#")) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) openExternal(href);
    else flash(`relative link: ${href}`);
  };

  /** Best-effort `file://` URL for the local HTML "open in a browser window" button. */
  const fileUrl = () => {
    const p = state()?.file?.path;
    if (!p || p.startsWith("~")) return "";
    let s = p.replace(/\\/g, "/");
    if (/^[a-zA-Z]:/.test(s)) s = `/${s}`;
    return `file://${s.startsWith("/") ? "" : "/"}${s}`;
  };

  const body = createMemo<JSX.Element>(() => {
    const st = state();
    if (st?.error) return <div class="fnote bad">{st.error}</div>;
    const f = st?.file;
    if (!f) return <div class="fnote">{st?.loading ? "Loading…" : "No file."}</div>;
    if (f.binary) return <div class="fnote">Binary file · {bytes(f.size)}</div>;
    const text = f.text ?? "";
    if (!text) return <div class="fnote">Empty file.</div>;
    if (previewing() && kind() === "md") return <div class="md" innerHTML={renderMarkdown(text)} onClick={openLink} />;
    if (previewing() && kind() === "html")
      return <iframe class="htm" sandbox="allow-scripts allow-forms allow-modals" srcdoc={text} title={path()} />;
    return <pre class="code" innerHTML={codeHtml(text)} />;
  });

  return (
    <div class="filev">
      <div class="fbar">
        <span class="path" title={path()}>{path()}</span>
        <Show when={state()?.file}>{(f) => <span class="fmeta">{bytes(f().size)}{f().truncated ? " · truncated" : ""}</span>}</Show>
        <Show when={kind()}>
          <div class="seg" role="group" aria-label="View mode">
            <button aria-pressed={mode() !== "source"} onClick={() => setMode("preview")}>Preview</button>
            <button aria-pressed={mode() === "source"} onClick={() => setMode("source")}>Source</button>
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
        <button title="Reload" onClick={() => reloadText(props.project, path())}>⟳</button>
      </div>
      {body()}
    </div>
  );
}
