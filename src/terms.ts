// Terminal sessions live outside Solid's reactivity: one xterm + one PTY per
// tab, created once and kept alive while the tab exists. Switching tabs only
// toggles visibility, so it is instant and scrollback survives.

import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Project, Tab, TabStatus, TerminalKind, TAB_COMMANDS, isRemote, isTerminal, sessionName, setLive } from "./state";
import { copyText, readImagePng, readText } from "./clipboard";

const SSH_CONNECTION_FAILED = 255;
const MAX_BACKOFF_MS = 10_000;

const DARK = {
  background: "#0e0f12",
  foreground: "#d6d8de",
  cursor: "#d6d8de",
  selectionBackground: "#3a3f4b",
  black: "#15171c",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#d6d8de",
  brightBlack: "#7d828f",
  brightWhite: "#d6d8de",
};

const LIGHT = {
  background: "#fbfbfc",
  foreground: "#23262d",
  cursor: "#23262d",
  selectionBackground: "#cfd6e6",
  black: "#23262d",
  red: "#c4314b",
  green: "#3d7a1c",
  yellow: "#9a6400",
  blue: "#2f5fc4",
  magenta: "#7c4dbd",
  cyan: "#0f7a8a",
  white: "#6b7080",
  brightBlack: "#6b7080",
  brightWhite: "#6b7080",
};

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const themeNow = () => (darkQuery.matches ? DARK : LIGHT);

/** Receives Ctrl+click links: the URL, the tab it was clicked in, and whether to use the system browser. */
let linkHandler: ((url: string, tabId: string, external: boolean) => void) | undefined;

/** Fire-and-forget invoke that logs instead of raising unhandled rejections. */
const call = (cmd: string, args: Record<string, unknown>) =>
  invoke(cmd, args).catch((e) => console.warn(`${cmd} failed:`, e));

class TermSession {
  readonly el = document.createElement("div");
  private term: Terminal;
  private fit = new FitAddon();
  private webgl?: WebglAddon;
  private ptyId?: number;
  private status: TabStatus = "connecting";
  private visible = false;
  private disposed = false;
  private backoff = 1000;
  private lastSize = "";
  /** When the last Ctrl+V this class handled happened, so its native paste event is dropped. */
  private ownPasteAt = Number.NEGATIVE_INFINITY;
  /** Input typed before pty_spawn resolves (e.g. xterm's reply to ConPTY's startup DSR query). */
  private pending: string[] = [];
  private observer = new ResizeObserver(() => this.refit());

  constructor(private project: Project, private tab: Tab) {
    this.el.className = "term";
    this.el.style.cssText = "width:100%;height:100%";
    this.el.style.display = "none";
    parkElement().appendChild(this.el); // xterm measures fonts, so open it inside the document

    this.term = new Terminal({
      // Capped scrollback: each line costs memory per terminal.
      scrollback: 5000,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: false,
      allowProposedApi: true,
      theme: themeNow(),
    });
    this.term.loadAddon(this.fit);
    // Plain clicks do nothing; Ctrl+click opens in the canvas, Ctrl+Shift+click in the system browser.
    this.term.loadAddon(new WebLinksAddon((event, uri) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      linkHandler?.(uri, this.tab.id, event.shiftKey);
    }));
    this.term.open(this.el);
    this.installClipboard();

    this.term.onData((data) => {
      if (this.status === "exited" && data === "\r") return void this.start();
      if (this.ptyId !== undefined) call("pty_write", { id: this.ptyId, data });
      else if (this.status !== "exited") this.pending.push(data);
    });
    this.term.onBell(() => {
      if (!this.visible || !document.hasFocus()) this.update({ attention: true });
    });
    this.term.onTitleChange((title) => this.update({ title }));

    this.observer.observe(this.el);
    this.start();
  }

  /**
   * Copy and paste for the terminal.
   *
   * xterm copies and pastes through the DOM copy/paste events, but on Windows
   * WebView2 swallows the Ctrl+C / Ctrl+V accelerators before those events fire,
   * so nothing happens. Handle the keys here and use the Clipboard API directly:
   * Ctrl+C copies a selection (and still sends SIGINT when there is none) and
   * Ctrl+V pastes as if typed. A clipboard image is saved on the project's
   * host and its path pasted, which claude and pi attach as an image.
   * Shift+Enter sends ESC CR (Alt+Enter), which claude and pi read as a
   * newline; xterm would otherwise send a plain CR and submit.
   * Full-screen TUIs such as claude and pi copy through OSC 52, which xterm
   * core ignores, so forward that too.
   */
  private installClipboard() {
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.altKey) return true;
      const mod = e.ctrlKey || e.metaKey;
      if (e.shiftKey && !mod && e.key === "Enter") {
        e.preventDefault(); // no keypress, so xterm does not also send CR
        this.term.input("\x1b\r");
        return false;
      }
      if (mod && e.code === "KeyC" && this.term.hasSelection()) {
        copyText(this.term.getSelection());
        return false;
      }
      if (mod && e.code === "Insert" && this.term.hasSelection()) {
        copyText(this.term.getSelection());
        return false;
      }
      if ((mod && e.code === "KeyV") || (e.shiftKey && e.code === "Insert")) {
        // The browser may still fire a paste event for this keystroke. Mark it so
        // the listener below drops that event instead of pasting twice.
        this.ownPasteAt = performance.now();
        this.pasteClipboard();
        return false;
      }
      return true;
    });
    // Native paste (context menu, middle click) keeps working; skip only the
    // event that belongs to a Ctrl+V already handled above.
    this.el.addEventListener("paste", (e) => {
      if (performance.now() - this.ownPasteAt > 250) return;
      this.ownPasteAt = 0;
      e.preventDefault();
      e.stopPropagation();
    }, { capture: true });

    // OSC 52: how a TUI asks the terminal to set the system clipboard.
    this.term.parser.registerOscHandler(52, (data) => {
      const sep = data.indexOf(";");
      if (sep < 0) return false;
      const payload = data.slice(sep + 1).replace(/\?+$/, "");
      if (payload) copyText(decodeBase64(payload));
      return true;
    });
  }

  private async pasteClipboard() {
    const text = await readText();
    if (text) return this.term.paste(text);
    const png = await readImagePng();
    if (!png) return;
    try {
      const path = await invoke<string>("save_pasted_image", { host: this.project.host, pngBase64: png });
      this.term.paste(path.includes(" ") ? `"${path}"` : path);
    } catch (e) {
      console.warn("save_pasted_image failed:", e);
    }
  }

  private update(patch: Partial<{ status: TabStatus; attention: boolean; title: string }>) {
    if (this.disposed) return;
    if (patch.status) this.status = patch.status;
    setLive(this.tab.id, (prev) => ({ ...{ status: this.status, attention: false, title: "" }, ...prev, ...patch }));
  }

  private async start() {
    if (this.disposed) return;
    this.pending = [];
    this.update({ status: this.status === "reconnecting" ? "reconnecting" : "connecting" });

    const onData = new Channel<ArrayBuffer | number[]>();
    onData.onmessage = (chunk) => {
      if (this.status !== "running") {
        this.update({ status: "running" });
        this.backoff = 1000;
      }
      this.term.write(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : Uint8Array.from(chunk));
    };
    const onExit = new Channel<number>();
    onExit.onmessage = (code) => this.exited(code);

    this.fit.proposeDimensions(); // no-op when hidden; size is corrected on show
    try {
      this.ptyId = await invoke<number>("pty_spawn", {
        spec: {
          host: this.project.host,
          cwd: this.project.path,
          cmd: TAB_COMMANDS[this.tab.kind as TerminalKind],
          session: sessionName(this.project, this.tab),
        },
        cols: this.term.cols,
        rows: this.term.rows,
        onData,
        onExit,
      });
      if (this.disposed) return void call("pty_kill", { id: this.ptyId });
      // Output can arrive before the id does; Windows ConPTY prints nothing
      // until xterm answers its cursor-position query, so flush that now.
      const queued = this.pending.join("");
      this.pending = [];
      if (queued) call("pty_write", { id: this.ptyId, data: queued });
    } catch (e) {
      this.term.write(`\r\n\x1b[31m${e}\x1b[0m\r\n`);
      this.exited(-1);
    }
  }

  private exited(code: number) {
    this.ptyId = undefined;
    if (this.disposed) return;
    if (isRemote(this.project) && code === SSH_CONNECTION_FAILED) {
      const secs = Math.round(this.backoff / 1000);
      this.term.write(`\r\n\x1b[33m[connection lost, reconnecting in ${secs}s]\x1b[0m\r\n`);
      this.update({ status: "reconnecting" });
      setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      return;
    }
    this.term.write(`\r\n\x1b[90m[exited with code ${code}, press Enter to restart]\x1b[0m\r\n`);
    this.update({ status: "exited" });
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.el.style.display = visible ? "" : "none";
    if (visible) {
      // WebGL only for visible terminals: browsers cap live GL contexts (~16)
      // and each one holds GPU memory.
      if (!this.webgl) {
        try {
          this.webgl = new WebglAddon();
          this.webgl.onContextLoss(() => this.dropWebgl());
          this.term.loadAddon(this.webgl);
        } catch {
          this.webgl = undefined; // falls back to the DOM renderer
        }
      }
      this.refit();
      // output written while parked (display:none) is in the buffer but was never painted
      this.term.refresh(0, this.term.rows - 1);
      this.update({ attention: false });
    } else {
      this.dropWebgl();
    }
  }

  focus() {
    this.term.focus();
  }

  /** Type `text` into the terminal without submitting (used by "send to agent"). */
  sendText(text: string) {
    if (this.ptyId !== undefined) call("pty_write", { id: this.ptyId, data: text });
    else if (this.status !== "exited") this.pending.push(text);
  }

  applyTheme() {
    this.term.options.theme = themeNow();
  }

  private dropWebgl() {
    this.webgl?.dispose();
    this.webgl = undefined;
  }

  private refit() {
    if (!this.visible || !this.fit.proposeDimensions()) return;
    this.fit.fit();
    const size = `${this.term.cols}x${this.term.rows}`;
    if (size === this.lastSize || this.ptyId === undefined) return;
    this.lastSize = size;
    call("pty_resize", { id: this.ptyId, cols: this.term.cols, rows: this.term.rows });
  }

  /** Close the tab: kill the local process and, for remote tabs, the persistent session. */
  dispose() {
    this.disposed = true;
    this.visible = false;
    this.observer.disconnect();
    if (this.ptyId !== undefined) call("pty_kill", { id: this.ptyId });
    if (isRemote(this.project)) {
      call("remote_kill_session", { host: this.project.host, session: sessionName(this.project, this.tab) });
    }
    this.dropWebgl();
    this.term.dispose();
    this.el.remove();
  }
}

/** OSC 52 payloads are UTF-8 text encoded as base64. */
function decodeBase64(b64: string): string {
  const binary = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

const sessions = new Map<string, TermSession>();

/** Hidden container that holds the elements of sessions that are not mounted. */
let park: HTMLElement | undefined;
function parkElement() {
  if (!park) {
    park = document.createElement("div");
    park.id = "term-park";
    park.style.display = "none";
    document.body.appendChild(park);
  }
  return park;
}

// One listener for the whole app: follow the OS light/dark setting live.
darkQuery.addEventListener("change", () => {
  for (const s of sessions.values()) s.applyTheme();
});

/** Create the session for a terminal tab once; it starts parked until mounted. */
export function ensureSession(project: Project, tab: Tab): void {
  if (!isTerminal(tab) || sessions.has(tab.id)) return;
  sessions.set(tab.id, new TermSession(project, tab));
}

/** Move a session's element into `el` and show it. */
export function mountSession(tabId: string, el: HTMLElement): void {
  const s = sessions.get(tabId);
  if (!s) return;
  el.appendChild(s.el);
  s.setVisible(true);
}

/** Hide a session and move its element back into the park container (the PTY keeps running). */
export function unmountSession(tabId: string): void {
  const s = sessions.get(tabId);
  if (!s) return;
  s.setVisible(false);
  parkElement().appendChild(s.el);
}

export function focusSession(tabId: string): void {
  sessions.get(tabId)?.focus();
}

/** Type text into a tab's PTY without a newline. Returns false if it has no session. */
export function sendText(tabId: string, text: string): boolean {
  const s = sessions.get(tabId);
  if (!s) return false;
  s.sendText(text);
  return true;
}

export function closeSession(tabId: string) {
  sessions.get(tabId)?.dispose();
  sessions.delete(tabId);
}

export function setLinkHandler(fn: (url: string, tabId: string, external: boolean) => void): void {
  linkHandler = fn;
}
