// Clipboard helpers.
//
// On Windows, Tauri's WebView2 swallows the Ctrl+C / Ctrl+V accelerators before
// the DOM copy/paste events fire, and xterm.js only copies or pastes through
// those events. Use the async Clipboard API directly instead; it still works in
// the webview.

/** Copy text to the system clipboard. Fails quietly when unavailable. */
export function copyText(text: string): void {
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {});
}

/** Read text from the system clipboard ("" when unavailable or denied). */
export async function readText(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

/** The clipboard's image as base64 PNG, or "" when it holds none. */
export async function readImagePng(): Promise<string> {
  try {
    for (const item of (await navigator.clipboard?.read()) ?? []) {
      if (!item.types.includes("image/png")) continue;
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        item.getType("image/png").then((blob) => reader.readAsDataURL(blob), reject);
      });
      return url.slice(url.indexOf(",") + 1);
    }
  } catch {
    // denied or unavailable
  }
  return "";
}

const editable = (el: HTMLElement | null): boolean =>
  !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");

let installed = false;

/** Current selection inside a plain input, textarea, or the document. */
function selectedText(el: HTMLElement | null): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  }
  return window.getSelection()?.toString() ?? "";
}

/**
 * Ctrl+C / Ctrl+V for everything that is not a terminal: the URL bar, project
 * inputs, and selectable overlays. Terminals run their own handler (terms.ts)
 * because xterm keeps its buffer out of the DOM.
 */
export function installClipboardFallback(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("keydown", (e) => {
    if (e.altKey || !(e.ctrlKey || e.metaKey)) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(".xterm")) return; // xterm handles its own keys
    if (e.code === "KeyC") {
      const text = selectedText(target);
      if (text) {
        e.preventDefault();
        copyText(text);
      }
    } else if (e.code === "KeyV" && editable(target)) {
      e.preventDefault();
      readText().then((text) => {
        if (text) document.execCommand("insertText", false, text);
      });
    }
  }, true);
}
