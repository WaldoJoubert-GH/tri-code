// Terminal sessions live outside Solid's reactivity: one xterm + one PTY per
// tab, created once and kept alive while the tab exists. Switching tabs only
// toggles visibility, so it is instant and scrollback survives.

import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Project, Tab, TabStatus, TAB_COMMANDS, isRemote, sessionName, setLive } from "./state";

const SSH_CONNECTION_FAILED = 255;
const MAX_BACKOFF_MS = 10_000;

const THEME = {
  background: "#0e0f12",
  foreground: "#d6d8de",
  cursor: "#d6d8de",
  selectionBackground: "#3a3f4b",
};

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
  /** Input typed before pty_spawn resolves (e.g. xterm's reply to ConPTY's startup DSR query). */
  private pending: string[] = [];
  private observer = new ResizeObserver(() => this.refit());

  constructor(private project: Project, private tab: Tab, host: HTMLElement) {
    this.el.className = "term";
    this.el.style.display = "none";
    host.appendChild(this.el);

    this.term = new Terminal({
      // Capped scrollback: each line costs memory per terminal.
      scrollback: 5000,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: false,
      allowProposedApi: true,
      theme: THEME,
    });
    this.term.loadAddon(this.fit);
    this.term.open(this.el);

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
          cmd: TAB_COMMANDS[this.tab.kind],
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
      this.term.focus();
      this.update({ attention: false });
    } else {
      this.dropWebgl();
    }
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

const sessions = new Map<string, TermSession>();


export function ensureSession(project: Project, tab: Tab, host: HTMLElement) {
  let s = sessions.get(tab.id);
  if (!s) sessions.set(tab.id, (s = new TermSession(project, tab, host)));
  return s;
}

export function closeSession(tabId: string) {
  sessions.get(tabId)?.dispose();
  sessions.delete(tabId);
}

export function showOnly(tabId: string | undefined) {
  for (const [id, s] of sessions) s.setVisible(id === tabId);
}
