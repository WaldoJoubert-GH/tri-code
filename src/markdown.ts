// Render Markdown for the file view. `marked` parses; DOMPurify strips anything
// executable, because a repo's README must not be able to run script in the app
// webview, which holds the Tauri IPC bridge.

import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
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
const slug = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

/**
 * Finish a rendered preview in place: give headings their anchor ids and load
 * repo-relative images through `load` (the webview cannot read project files).
 */
export function enhance(el: HTMLElement, load: (src: string) => Promise<string>): void {
  const seen = new Map<string, number>();
  for (const h of el.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    const s = slug(h.textContent ?? "");
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    h.id = n ? `${s}-${n}` : s;
  }
  for (const img of el.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!src || hasScheme(src) || src.startsWith("//")) continue;
    img.removeAttribute("src");
    load(src)
      .then((url) => (img.src = url))
      .catch(() => (img.alt = `${img.alt || src} (not found)`));
  }
}
