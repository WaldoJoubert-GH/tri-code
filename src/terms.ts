// Terminal sessions live outside Solid's reactivity: one xterm + one PTY per
// tab, created once and kept alive while the tab exists. Switching tabs only
// toggles visibility, so it is instant and scrollback survives.

import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { AgentState, Live, Project, Tab, TabStatus, becomeShell, isRemote, isTerminal, live, removeTab, sessionName, setLive } from "./state";
import { onSignal } from "./signals";
import { copyText, readImagePng, readText } from "./clipboard";
import { Demo, playDemo } from "./demo";
import { isKey } from "./keymap";

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
  /** PTY writes in order: pty_write is async, and the reply to a program's probe must reach it before xterm's DA1 reply. */
  private writes: Promise<unknown> = Promise.resolve();
  /** The tour's sample project: a scripted session in place of the PTY. */
  private demo?: Demo;
  /** What the PTY runs ("" = login shell); cleared once an agent quits. */
  private cmd: string;

  constructor(private project: Project, private tab: Tab) {
    this.cmd = tab.cmd?.trim() ?? "";
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
    this.installProgramStatus();

    this.term.onData((data) => {
      if (this.demo) return this.demo.input(data);
      if (this.status === "exited" && data === "\r") return void this.start();
      this.write(data);
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
      if (isKey("copy", e) && this.term.hasSelection()) {
        copyText(this.term.getSelection());
        return false;
      }
      if (mod && e.code === "Insert" && this.term.hasSelection()) {
        copyText(this.term.getSelection());
        return false;
      }
      if (isKey("paste", e) || (e.shiftKey && e.code === "Insert")) {
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

  private write(data: string) {
    const id = this.ptyId;
    if (id !== undefined) this.writes = this.writes.then(() => call("pty_write", { id, data }));
    else if (this.status !== "exited") this.pending.push(data);
  }

  /**
   * OSC 7501, the Program Status Protocol: claude and pi send `ESC ] 7501 ; ? ST` at startup and
   * report their state only once the terminal echoes it. Reports are `state=working:app=pi:msg=<base64>`;
   * records with an `id` describe sub-tasks, so only the root one (no id) is kept.
   */
  private installProgramStatus() {
    this.term.parser.registerOscHandler(7501, (data) => {
      if (data.startsWith("?")) {
        this.term.input("\x1b]7501;?\x1b\\", false);
        return true;
      }
      const f = Object.fromEntries(data.split(":").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
      if (f.id !== undefined) return true;
      let msg = "";
      try {
        msg = f.msg ? decodeBase64(f.msg) : "";
      } catch {
        msg = "";
      }
      this.report(f.state, msg);
      return true;
    });
  }

  /** Store a report; a change of state may sound and notify. idle and clear drop it. */
  private report(state: string, msg: string) {
    const prev = live[this.tab.id]?.agent;
    if (state !== "working" && state !== "blocked" && state !== "done" && state !== "error") {
      if (prev) this.update({ agent: undefined });
      return;
    }
    const looking = this.visible && document.hasFocus();
    this.update({ agent: { state: state as AgentState, msg, at: prev?.state === state ? prev.at : Date.now(), seen: looking } });
    if (prev?.state !== state) onSignal(this.project.id, this.tab, state as AgentState, msg, looking);
  }

  /** On screen in a focused app: a bell or a finished report has been seen. */
  see() {
    if (!this.visible || !document.hasFocus()) return;
    const l = live[this.tab.id];
    if (l?.attention) this.update({ attention: false });
    if (l?.agent && !l.agent.seen) this.update({ agent: { ...l.agent, seen: true } });
  }

  private update(patch: Partial<Live>) {
    if (this.disposed) return;
    if (patch.status) this.status = patch.status;
    setLive(this.tab.id, (prev) => ({ ...{ status: this.status, attention: false, title: "" }, ...prev, ...patch }));
  }

  private async start() {
    if (this.disposed) return;
    if (this.tab.demo) {
      this.demo = playDemo(this.tab.demo, this.project.path, (s) => this.term.write(s));
      this.update({ status: "running" });
      return;
    }
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

    const { cols, rows } = this.term;
    try {
      this.ptyId = await invoke<number>("pty_spawn", {
        spec: {
          host: this.project.host,
          cwd: this.project.path,
          cmd: this.cmd || null,
          session: sessionName(this.project, this.tab),
        },
        cols,
        rows,
        onData,
        onExit,
      });
      if (this.disposed) return void call("pty_kill", { id: this.ptyId });
      // The tab is usually shown and fitted while the spawn is in flight, and
      // refit skips the resize until there is an id; send the real size now.
      this.lastSize = `${cols}x${rows}`;
      this.refit();
      // Output can arrive before the id does; Windows ConPTY prints nothing
      // until xterm answers its cursor-position query, so flush that now.
      const queued = this.pending.join("");
      this.pending = [];
      if (queued) this.write(queued);
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
    if (this.cmd) {
      // An agent quit: restarting it rarely helps, so carry on in a plain shell.
      this.term.write(`\r\n\x1b[90m[${this.tab.name ?? "agent"} exited with code ${code}, starting a shell]\x1b[0m\r\n`);
      this.update({ agent: undefined });
      becomeShell(this.project.id, this.tab.id);
      this.cmd = "";
      return void this.start();
    }
    if (this.status === "running") {
      // The shell was exited: close its window. One that never started stays open to show why.
      removeTab(this.project.id, this.tab.id);
      return closeSession(this.tab.id);
    }
    this.term.write(`\r\n\x1b[90m[exited with code ${code}, press Enter to restart]\x1b[0m\r\n`);
    this.update({ status: "exited", agent: undefined });
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
      this.see();
    } else {
      this.dropWebgl();
    }
  }

  hasSelection() {
    return this.term.hasSelection();
  }

  focus() {
    this.term.focus();
  }

  askDemo() {
    this.demo?.ask();
  }

  /** Paste `text` as the terminal would (bracketed when the app asks), so its newlines do not submit. */
  paste(text: string) {
    // Without bracketed paste every newline would arrive as Enter, so keep it to one line.
    this.term.paste(this.term.modes.bracketedPasteMode ? text : text.replace(/\s*\n\s*/g, " "));
  }

  /** Type `text` into the terminal without submitting (used by "send to agent"). */
  sendText(text: string) {
    this.write(text);
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
    this.demo?.stop();
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

// Coming back to tri-code counts as looking at the windows on screen.
window.addEventListener("focus", () => {
  for (const s of sessions.values()) s.see();
});

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

/** Is text selected in a tab's terminal? */
export function hasSelection(tabId: string): boolean {
  return sessions.get(tabId)?.hasSelection() ?? false;
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

/** Paste multi-line text into a terminal without submitting it. */
export function pasteText(tabId: string, text: string): boolean {
  const s = sessions.get(tabId);
  if (!s) return false;
  s.paste(text);
  return true;
}

/** The tour: make a scripted pi stop and ask for permission. */
export function askDemo(tabId: string) {
  sessions.get(tabId)?.askDemo();
}

export function closeSession(tabId: string) {
  sessions.get(tabId)?.dispose();
  sessions.delete(tabId);
}

export function setLinkHandler(fn: (url: string, tabId: string, external: boolean) => void): void {
  linkHandler = fn;
}
