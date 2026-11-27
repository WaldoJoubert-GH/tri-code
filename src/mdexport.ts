// Export PDF of a Markdown file (design/markdown.html, variant A): the Preview's HTML, drawn for paper,
// in a document of its own with tri-code's print CSS and then the project's (Appearance › PDF export,
// `mdExport` on the repo project). Rust prints it (mdpdf.rs): straight to a file on Windows, through the
// system print dialog elsewhere.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { enhance, renderMarkdown, titleOf } from "./shared/text/markdown";
import { type MdExport, type Project, isRemote, repoOf } from "./shared/state/state";
import { flash, showToast } from "./shared/ui/ui";

export const PAGES = { A4: "210mm 297mm", Letter: "8.5in 11in" } as const;
export const DEFAULT_MARGIN = 18;

/** Windows prints to a file with no dialog; elsewhere the system print dialog saves the PDF. */
export const directPdf = /Windows/i.test(navigator.userAgent);

/** A project's export settings: its repo's, for a Worktree. */
export const mdExportOf = (p: Project): MdExport => repoOf(p).mdExport ?? {};

/** tri-code's print CSS, under the project's. Selectors match what renderMarkdown makes. */
export const PRINT_CSS = `
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 11pt/1.55 system-ui, "Segoe UI", -apple-system, sans-serif; color: #1f2328; background: #fff; }
.md { overflow-wrap: break-word; }
.md > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 .5em; break-after: avoid; }
h1 { font-size: 20pt; }
h2 { font-size: 15pt; padding-bottom: 3pt; border-bottom: 1px solid #d0d7de; }
h3 { font-size: 12.5pt; }
h4, h5, h6 { font-size: 11pt; }
p, ul, ol, blockquote, table, pre, .mermaid, .math-block { margin: 0 0 10pt; }
ul, ol { padding-left: 20pt; }
li + li { margin-top: 2pt; }
a { color: #0969da; text-decoration: none; }
code { font: 9.5pt ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; background: #f6f8fa; border-radius: 3px; padding: 1px 4px; }
pre { background: #f6f8fa; border-radius: 6px; padding: 8pt 10pt; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { padding: 0 12pt; border-left: 3px solid #d0d7de; color: #59636e; }
table { border-collapse: collapse; break-inside: avoid; }
th, td { border: 1px solid #d0d7de; padding: 4pt 8pt; text-align: left; }
th { background: #f6f8fa; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 14pt 0; }
input[type="checkbox"] { margin-right: 5pt; }
.frontmatter { font-size: 9.5pt; }
.frontmatter th { background: none; color: #59636e; font-weight: 500; }
.frontmatter td { white-space: pre-wrap; }
.alert { border-left-color: var(--c); color: inherit; break-inside: avoid; }
.alert-title { color: var(--c); font-weight: 600; margin-bottom: 2pt; }
.alert-note { --c: #0969da; } .alert-tip { --c: #1a7f37; } .alert-important { --c: #8250df; }
.alert-warning { --c: #9a6700; } .alert-caution { --c: #cf222e; }
.mermaid { text-align: center; break-inside: avoid; }
.mermaid svg { max-width: 100%; height: auto; }
.math-block { text-align: center; }
.math-error { color: #cf222e; font-family: ui-monospace, monospace; }
.footnotes { font-size: 9.5pt; color: #59636e; border-top: 1px solid #d0d7de; margin-top: 18pt; padding-top: 6pt; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;

/** What a project's CSS box shows while it is empty. */
export const CSS_HINT = `/* Laid over tri-code's print CSS. For example:
body { font-family: Georgia, serif; }
h1 { color: #c2410c; }
.frontmatter { display: none; }
@page { @bottom-center { content: counter(page); } } */`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The page size and margin, ahead of tri-code's print CSS. */
export const baseCss = (cfg: MdExport) => `@page { size: ${PAGES[cfg.page ?? "A4"]}; margin: ${cfg.margin ?? DEFAULT_MARGIN}mm; }${PRINT_CSS}`;

/** On screen (the preview) there is no @page, so its margin pads the body instead. */
export const screenCss = (cfg: MdExport) => `@media screen { body { padding: ${cfg.margin ?? DEFAULT_MARGIN}mm; } }`;

/** The project's CSS, kept from closing its <style> early. */
export const projectCss = (cfg: MdExport) => (cfg.css ?? "").replace(/<\/style/gi, "<\\/style");

/** The whole page Rust prints (and, with `screen`, the preview shows): page size and margin,
 *  tri-code's CSS, then the project's. Each style has an id so the preview can swap one in place. */
export function printDocument(body: string, cfg: MdExport, title: string, screen = false): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style id="tri-base">${baseCss(cfg)}</style>
${screen ? `<style id="tri-screen">${screenCss(cfg)}</style>` : ""}
<style id="tri-project">${projectCss(cfg)}</style>
</head><body><article class="md">${body}</article></body></html>`;
}

/** The PDF's name beside the Markdown file. */
export const pdfName = (file: string) => (file.split(/[\\/]/).pop() ?? "export").replace(/\.(md|markdown)$/i, "") + ".pdf";

/** Export `src` (the file at `file`, as the editor holds it) to PDF with `project`'s settings. */
export async function exportMarkdownPdf(project: Project, file: string, src: string, load: (src: string) => Promise<string>): Promise<void> {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(src);
  await enhance(el, load, { dark: false });
  const name = pdfName(file);
  const html = printDocument(el.innerHTML, mdExportOf(project), titleOf(src) || name.replace(/\.pdf$/, ""));
  if (!directPdf) {
    await invoke("md_pdf", { html, path: null });
    return;
  }
  // Beside the file for a project on this machine; a remote one's folder isn't here.
  const local = !isRemote(project) && !file.startsWith("~");
  const path = await save({
    title: "Export PDF",
    defaultPath: local ? file.replace(/[^\\/]*$/, name) : name,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return;
  flash("exporting PDF…");
  await invoke("md_pdf", { html, path });
  showToast({
    msg: `Saved ${path.split(/[\\/]/).pop()}`,
    actions: [
      { label: "Open", run: () => void invoke("md_pdf_open", { path, reveal: false }).catch((e) => flash(String(e))) },
      { label: "Show in folder", run: () => void invoke("md_pdf_open", { path, reveal: true }).catch((e) => flash(String(e))) },
    ],
  });
}
