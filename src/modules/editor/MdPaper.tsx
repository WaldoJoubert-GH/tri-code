// The Markdown preview with the project's export CSS (Appearance › PDF export › Use in the preview):
// the same document Export PDF prints (mdexport.ts), in an iframe so the project's CSS can't reach
// the app. The iframe runs no script; the app reads its document to follow links. A change to the
// CSS swaps the iframe's style in place, so the page doesn't reload or lose its scroll.

import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { enhance, renderMarkdown, titleOf } from "../../shared/text/markdown";
import { baseCss, printDocument, projectCss, screenCss } from "./mdexport";
import type { MdExport } from "../../shared/state/state";

export function MdPaper(props: {
  src: string;
  cfg: MdExport;
  load: (src: string) => Promise<string>;
  /** A link was clicked; `root` is the iframe's document, for `#heading` links. */
  onLink: (href: string, ctrl: boolean, root: ParentNode) => void;
}) {
  let frame!: HTMLIFrameElement;
  const [body, setBody] = createSignal<string | null>(null);
  let seq = 0;

  // Drawn off-screen first (math, diagrams, images), then shown in one go.
  createEffect(on(() => props.src, async (src) => {
    const mine = ++seq;
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(src);
    await enhance(el, props.load, { dark: false });
    if (mine === seq) setBody(el.innerHTML);
  }));
  onCleanup(() => seq++);

  // A new body loads the page again, keeping where it was scrolled to.
  let scrollY = 0;
  createEffect(on(body, (b) => {
    if (b === null) return;
    scrollY = frame.contentWindow?.scrollY ?? scrollY;
    frame.srcdoc = printDocument(b, props.cfg, titleOf(props.src), true);
  }));

  // The CSS, page and margin change in place.
  createEffect(() => {
    const cfg = props.cfg;
    const doc = frame.contentDocument;
    const set = (id: string, css: string) => {
      const s = doc?.getElementById(id);
      if (s && s.textContent !== css) s.textContent = css;
    };
    set("tri-base", baseCss(cfg));
    set("tri-screen", screenCss(cfg));
    set("tri-project", projectCss(cfg));
  });

  const onLoad = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    frame.contentWindow?.scrollTo(0, scrollY);
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element).closest?.("a");
      if (!a) return;
      e.preventDefault();
      props.onLink(a.getAttribute("href") ?? "", e.ctrlKey || e.metaKey, doc);
    });
  };

  return (
    <iframe
      class="mdpaper"
      ref={frame}
      // Same origin so the app can read it; no allow-scripts, so nothing in it runs.
      sandbox="allow-same-origin"
      title="Preview with the project's export CSS"
      onLoad={onLoad}
    />
  );
}
