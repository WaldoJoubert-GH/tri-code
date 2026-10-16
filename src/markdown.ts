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
