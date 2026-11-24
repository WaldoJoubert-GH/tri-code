// Render Markdown for the file view and for Export PDF (mdexport.ts). `marked` parses, with GitHub's
// footnotes, alerts and front matter, and `$…$` / `$$…$$` math; DOMPurify strips anything executable,
// because a repo's README must not be able to run script in the app webview, which holds the Tauri
// IPC bridge. What needs a big library (KaTeX, Mermaid, the emoji table) is drawn afterwards by
// `enhance`, into the sanitised DOM, and only imported when a file uses it.

import DOMPurify from "dompurify";
import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";
import markedFootnote from "marked-footnote";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `$$ … $$` on lines of its own: display math. */
const mathBlock: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  start: (src) => src.match(/^ {0,3}\$\$/m)?.index,
  tokenizer(src) {
    const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
    if (m) return { type: "mathBlock", raw: m[0], text: m[1].trim() };
  },
  renderer: (t) => `<div class="math-block" data-tex="${esc((t as Tokens.Generic).text)}"></div>\n`,
};

/** `$…$` inline. Like GitHub, it needs a non-space just inside each `$` and no digit after the
 *  closing one, so "costs $5 and $6" stays text. */
const mathInline: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start: (src) => src.indexOf("$"),
  tokenizer(src) {
    const m = /^\$(?!\$)(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: "mathInline", raw: m[0], text: m[1] };
  },
  renderer: (t) => `<span class="math" data-tex="${esc((t as Tokens.Generic).text)}"></span>`,
};

const md = new Marked({ gfm: true, breaks: false })
  .use(markedFootnote())
  .use({
    extensions: [mathBlock, mathInline],
    renderer: {
      // A Mermaid block stays readable source until enhance draws it.
      code(t) {
        if (t.lang?.trim().toLowerCase() !== "mermaid") return false;
        return `<pre class="mermaid-src"><code>${esc(t.text)}</code></pre>\n`;
      },
    },
  });

/** A file's YAML front matter as `key: value` rows, and the Markdown after it. Indented and list
 *  lines join the row above, so nested values show as written. */
export function splitFrontMatter(src: string): { rows: [string, string][]; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { rows: [], body: src };
  const rows: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([^\s#:][^:]*):(?:\s+(.*))?$/.exec(line);
    if (kv) rows.push([kv[1].trim(), unquote(kv[2]?.trim() ?? "")]);
    else if (line.trim() && rows.length) rows[rows.length - 1][1] += (rows[rows.length - 1][1] ? "\n" : "") + line.trim();
  }
  return { rows, body: src.slice(m[0].length) };
}
const unquote = (s: string) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);

const ALERTS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" } as const;

/** GitHub alerts: a blockquote whose first line is `[!NOTE]` (TIP, IMPORTANT, WARNING, CAUTION). */
export function alerts(html: string): string {
  return html
    .replace(/<blockquote>\s*<p>\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|<br>\n?)?/gi, (_, k: string) => {
      const kind = k.toLowerCase() as keyof typeof ALERTS;
      return `<blockquote class="alert alert-${kind}"><p class="alert-title">${ALERTS[kind]}</p><p>`;
    })
    .replace(/(<p class="alert-title">[^<]*<\/p>)<p><\/p>\s*/g, "$1\n");
}

/** The HTML for `src`, before sanitising. */
export function toHtml(src: string): string {
  const { rows, body } = splitFrontMatter(src);
  const fm = rows.length
    ? `<table class="frontmatter"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>\n`
    : "";
  return fm + alerts(md.parse(body, { async: false }) as string);
}

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(toHtml(src), { USE_PROFILES: { html: true } });
}

/** The title an export gets: front matter's `title`, else the first heading. */
export function titleOf(src: string): string {
  const { rows, body } = splitFrontMatter(src);
  return rows.find(([k]) => k.toLowerCase() === "title")?.[1] || /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/m.exec(body)?.[1] || "";
}

/** A link or image target with a scheme (`https:`, `mailto:`, `data:`…), as opposed to a path in the repo. */
export const hasScheme = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href);

/**
 * Resolve a relative link target against the Markdown file's path. A leading `/`
 * is the project root, as on GitHub. `?query` and `#fragment` are dropped.
 */
export function resolvePath(file: string, root: string, href: string): string {
  let clean = href.replace(/[?#].*$/, "");
  try { clean = decodeURI(clean); } catch { /* keep it as written */ }
  const base = clean.startsWith("/") ? root : file.replace(/[\\/][^\\/]*$/, "");
  const parts = base.split(/[\\/]/).filter((p, i) => p || i === 0);
  for (const seg of clean.split("/")) {
    if (seg === "..") { if (parts.length > 1) parts.pop(); }
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** GitHub-style heading slug, so `[x](#some-heading)` links land. */
export const slug = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

export type EnhanceOptions = {
  /** Mermaid's dark theme: the preview follows the app, a PDF is on paper. */
  dark: boolean;
  /** Add a `#` link to each heading (the preview; not a PDF). */
  anchors?: boolean;
};

/**
 * Finish a rendered preview in place: heading ids (and anchors), emoji shortcodes, math, Mermaid
 * diagrams, and repo-relative images loaded through `load` (the webview cannot read project files).
 * Resolves once everything is drawn, so an export can wait for it.
 */
export async function enhance(el: HTMLElement, load: (src: string) => Promise<string>, opts: EnhanceOptions): Promise<void> {
  const seen = new Map<string, number>();
  for (const h of el.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    if (h.closest(".footnotes")) continue;
    const s = slug(h.textContent ?? "");
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    h.id = n ? `${s}-${n}` : s;
    if (opts.anchors) {
      const a = document.createElement("a");
      a.className = "anchor";
      a.href = `#${h.id}`;
      a.ariaHidden = "true";
      a.textContent = "#";
      h.prepend(a);
    }
  }
  const work: Promise<unknown>[] = [];
  for (const img of el.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!src || hasScheme(src) || src.startsWith("//")) continue;
    img.removeAttribute("src");
    work.push(load(src)
      .then((url) => (img.src = url))
      .catch(() => (img.alt = `${img.alt || src} (not found)`)));
  }
  work.push(emoji(el), math(el), mermaid(el, opts.dark));
  await Promise.all(work);
}

/** Text nodes outside code, where a shortcode is only text. */
function textNodes(el: HTMLElement, test: RegExp): Text[] {
  const out: Text[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("code, pre, .math, .math-block") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (test.test(n.nodeValue ?? "")) out.push(n as Text);
  return out;
}

const SHORTCODE = /:([a-z0-9_+-]+):/g;

async function emoji(el: HTMLElement) {
  const nodes = textNodes(el, /:[a-z0-9_+-]+:/);
  if (!nodes.length) return;
  const { nameToEmoji } = await import("gemoji");
  for (const n of nodes) n.nodeValue = n.nodeValue!.replace(SHORTCODE, (all, name: string) => nameToEmoji[name] ?? all);
}

/** KaTeX as MathML only: no stylesheet or fonts, so it looks the same in a PDF. */
async function math(el: HTMLElement) {
  const spots = [...el.querySelectorAll<HTMLElement>(".math, .math-block")];
  if (!spots.length) return;
  const katex = (await import("katex")).default;
  for (const s of spots) {
    const tex = s.dataset.tex ?? "";
    try {
      s.innerHTML = katex.renderToString(tex, { displayMode: s.classList.contains("math-block"), output: "mathml", throwOnError: true });
    } catch (e) {
      s.classList.add("math-error");
      s.textContent = tex;
      s.title = e instanceof Error ? e.message : String(e);
    }
  }
}

let mermaidSeq = 0;
/** Mermaid keeps its settings globally, so diagrams are drawn one at a time. */
let mermaidQueue: Promise<unknown> = Promise.resolve();

function mermaid(el: HTMLElement, dark: boolean): Promise<void> {
  const blocks = [...el.querySelectorAll<HTMLElement>("pre.mermaid-src")];
  if (!blocks.length) return Promise.resolve();
  const run = mermaidQueue.then(async () => {
    const m = (await import("mermaid")).default;
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
    for (const pre of blocks) {
      const src = pre.textContent ?? "";
      const box = document.createElement("div");
      box.className = "mermaid";
      try {
        box.innerHTML = (await m.render(`mermaid-${++mermaidSeq}`, src)).svg;
      } catch (e) {
        box.className = "mermaid mermaid-error";
        const msg = document.createElement("div");
        msg.textContent = `Mermaid: ${e instanceof Error ? e.message : String(e)}`;
        box.append(msg, pre.cloneNode(true));
      }
      pre.replaceWith(box);
    }
  });
  mermaidQueue = run.catch(() => {});
  return run;
}
