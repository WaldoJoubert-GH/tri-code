// Terminal sessions live outside Solid's reactivity: one xterm + one PTY per
// tab, created once and kept alive while the tab exists. Switching tabs only
// toggles visibility, so it is instant and scrollback survives.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { takeAgentReq } from "./agentwin";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { AgentState, Live, Project, Tab, TabStatus, app, becomeShell, isRemote, isTerminal, live, markTyped, removeTab, repoOf, sessionName, setLive, setTabResume } from "./state";
import { terminalFont } from "./look";
import { onSignal } from "./signals";
import { copyText, readImagePng, readText } from "./clipboard";
import { Demo, playDemo } from "./demo";
import { isKey } from "./keymap";

const SSH_CONNECTION_FAILED = 255;
const MAX_BACKOFF_MS = 10_000;
/** How long pi gets to end its turn before it follows its tab to a Worktree anyway. */
const FOLLOW_TIMEOUT_MS = 30_000;

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
/** The colours for the theme on <html> (look.ts), which only follows the OS when none is forced. */
const themeNow = () => {
  const forced = document.documentElement.dataset.theme;
  return (forced ? forced === "dark" : darkQuery.matches) ? DARK : LIGHT;
};

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
  /** A multi-line command's lines, still to be typed into its login shell ("" once typed). */
  private script: string;
  /** Set while this tab's pi is finishing its turn before it follows the tab (followAfterTurn). */
  private turnEnded?: () => void;
  private followTimer?: ReturnType<typeof setTimeout>;
  /** For the next start only: the session pi copies into this folder. */
  private forkFrom?: string;
  /** Which start() is current: a PTY from an earlier one is ignored. */
  private run = 0;
  private retry?: ReturnType<typeof setTimeout>;
  /** Whether the project's Transparency lets the backdrop through this terminal (see setClear). */
  private clear = false;
  /** Writing output from before this page. xterm answers the probes and reports in it as if they
   *  were new, so its replies are dropped and those handlers stay quiet until it is done. */
  private replaying = false;
  /** Attached to a running program: it should redraw once this window has its real size. */
  private redraw = false;

  constructor(private project: Project, private tab: Tab) {
    // One line runs as the PTY's program; several are typed into a login shell, so a `cd` or
    // `export` carries on to the next line and the window ends in that shell.
    const cmd = tab.cmd?.trim() ?? "";
    const multi = cmd.includes("\n");
    this.cmd = multi ? "" : cmd;
    this.script = multi && !tab.typed ? cmd : "";
    this.el.className = "term";
    this.el.style.cssText = "width:100%;height:100%";
    this.el.style.display = "none";
    parkElement().appendChild(this.el); // xterm measures fonts, so open it inside the document

    this.clear = seesThrough(project);
    this.term = new Terminal({
      // Capped scrollback: each line costs memory per terminal.
      scrollback: 5000,
      fontFamily: terminalFont(app.settings.fontMono),
      fontSize: 13,
      cursorBlink: false,
      allowProposedApi: true,
      // Only when asked: a transparent canvas renders glyphs without the background behind them.
      allowTransparency: this.clear,
      theme: this.theme(),
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
      if (this.replaying) return;
      if (this.status === "exited" && data === "\r") return void this.start();
      this.write(data);
    });
    this.term.onBell(() => {
      if (!this.replaying && (!this.visible || !document.hasFocus())) this.update({ attention: true });
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
      if (this.replaying) return true; // an old copy must not take over the clipboard now
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

  /** Type the script's lines once the shell has printed something, each submitted with Enter. */
  private typeScript() {
    const lines = this.script.split("\n").map((l) => l.trimEnd());
    this.script = "";
    this.write(lines.map((l) => `${l}\r`).join(""));
    markTyped(this.project.id, this.tab.id);
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
      if (this.replaying) return true;
      if (data.startsWith("?")) {
        this.term.input("\x1b]7501;?\x1b\\", false);
        this.update({ ready: true });
        return true;
      }
      const r = parseReport(data);
      if (r) this.report(r.state, r.msg);
      return true;
    });
  }

  /** What the program last reported while no app was open. It's old news, so it makes no sound. */
  private restoreReport(data: string) {
    const r = parseReport(data);
    if (r && ["working", "blocked", "done", "error"].includes(r.state)) {
      this.update({ agent: { state: r.state as AgentState, msg: r.msg, at: Date.now(), seen: false } });
    }
  }

  /** Writes what the terminal printed before this page. Resolves once xterm has taken it all in. */
  private replay(recent: string) {
    const bytes = Uint8Array.from(atob(recent), (c) => c.charCodeAt(0));
    if (!bytes.length) return Promise.resolve();
    this.replaying = true;
    return new Promise<void>((done) => this.term.write(bytes, () => {
      this.replaying = false;
      done();
    }));
  }

  /** Store a report; a change of state may sound and notify. idle and clear drop it. */
  private report(state: string, msg: string) {
    const prev = live[this.tab.id]?.agent;
    if (state !== "working" && state !== "blocked" && state !== "done" && state !== "error") {
      if (prev) this.update({ agent: undefined });
      this.turnEnded?.();
      return;
    }
    const looking = this.visible && document.hasFocus();
    this.update({ agent: { state: state as AgentState, msg, at: prev?.state === state ? prev.at : Date.now(), seen: looking } });
    if (prev?.state !== state) onSignal(this.project.id, this.tab, state as AgentState, msg, looking);
    if (state !== "working" && state !== "blocked") this.turnEnded?.();
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

  /** Its tab moved to another project (state.moveTab). The program keeps running where it is. */
  rehome(project: Project) {
    this.project = project;
  }

  /** pi can't change folder while it runs, so once this turn ends it starts over in the project's
   *  folder, on a copy of its conversation. It may never report the end (or may ignore being told to
   *  stop), so a timeout does it instead, unless it is waiting on you. */
  followAfterTurn() {
    const go = () => {
      this.cancelFollow();
      this.restartForked();
    };
    const wait = () => {
      this.followTimer = setTimeout(() => (live[this.tab.id]?.agent?.state === "blocked" ? wait() : go()), FOLLOW_TIMEOUT_MS);
    };
    this.turnEnded = go;
    wait();
  }

  private cancelFollow() {
    this.turnEnded = undefined;
    clearTimeout(this.followTimer);
  }

  private restartForked() {
    const old = this.tab.resume;
    if (this.disposed || this.ptyId === undefined || old?.kind !== "pi") return;
    const pty = this.ptyId;
    this.run++;
    this.ptyId = undefined;
    call("pty_kill", { id: pty });
    this.forkFrom = old.id;
    setTabResume(this.project.id, this.tab.id, { kind: "pi", id: crypto.randomUUID() });
    this.update({ agent: undefined });
    this.status = "connecting";
    this.term.write(`\r\n\x1b[90m[restarting pi in ${this.project.path}]\x1b[0m\r\n`);
    void this.start();
  }

  /** Its Environment now points at another destination: end the session on the old host and start
   *  this terminal's command over on the new one. Resolves once the old session is dealt with. */
  async moveFrom(oldHost: string) {
    if (this.disposed || this.tab.demo) return;
    const pty = this.ptyId;
    this.run++;
    this.ptyId = undefined;
    clearTimeout(this.retry);
    if (pty !== undefined) call("pty_kill", { id: pty });
    const ended = call("remote_kill_session", { host: oldHost, session: sessionName(this.project, this.tab) });
    const cmd = this.tab.cmd?.trim() ?? "";
    const multi = cmd.includes("\n");
    this.cmd = multi ? "" : cmd;
    this.script = multi ? cmd : "";
    this.backoff = 1000;
    this.status = "connecting";
    setTabResume(this.project.id, this.tab.id, undefined);
    this.term.write(`\r\n\x1b[90m[moved from ${oldHost} to ${this.project.host}, restarting]\x1b[0m\r\n`);
    void this.start();
    await ended;
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
    const run = ++this.run;

    // Output waits for the spawn's answer: if that attached to a running terminal, what it printed
    // earlier goes first. A chunk can arrive before the answer does.
    let held: Uint8Array[] | undefined = [];
    const show = (bytes: Uint8Array) => {
      if (this.status !== "running") {
        this.update({ status: "running" });
        this.backoff = 1000;
      }
      if (this.script) this.typeScript();
      this.term.write(bytes);
    };
    const onData = new Channel<ArrayBuffer | number[]>();
    onData.onmessage = (chunk) => {
      if (run !== this.run) return;
      const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : Uint8Array.from(chunk);
      if (held) held.push(bytes);
      else show(bytes);
    };
    // The exit waits behind any held output too, as it did behind the output itself.
    const onExit = new Channel<number>();
    let exitCode: number | undefined;
    onExit.onmessage = (code) => {
      if (run !== this.run) return;
      if (held) exitCode = code;
      else this.exited(code);
    };

    const { cols, rows } = this.term;
    const remote = isRemote(this.project);
    // pi takes its session id up front; Claude's arrives from its hook once it has started.
    if (!remote && !this.tab.resume && !this.tab.once && /^pi(\.cmd|\.exe)?(\s|$)/.test(this.cmd)) {
      setTabResume(this.project.id, this.tab.id, { kind: "pi", id: crypto.randomUUID() });
    }
    const resume = !remote && this.cmd && !this.tab.once ? this.tab.resume : undefined;
    if (resume && this.run === 1) await resumeSlot();
    if (run !== this.run || this.disposed) return;
    const fork = this.forkFrom;
    this.forkFrom = undefined;
    try {
      const started = await invoke<Started>("pty_spawn", {
        spec: {
          host: this.project.host,
          cwd: this.project.path,
          cmd: this.cmd || null,
          session: sessionName(this.project, this.tab),
          resume: resume ? { kind: resume.kind, id: resume.id, fork: fork ?? null } : null,
        },
        cols,
        rows,
        onData,
        onExit,
        // Whose window this is: the agent endpoint scopes what a terminal's agent can see by it.
        owner: {
          project: this.project.id,
          tab: this.tab.id,
          name: this.tab.name ?? "shell",
          by: this.tab.by ?? null,
          req: takeAgentReq(this.tab.id) ?? null,
        },
      });
      // Closed, or moved to another host, while this was starting.
      const { id } = started;
      if (this.disposed || run !== this.run) return void call("pty_kill", { id });
      this.ptyId = id;
      this.update({ pty: this.ptyId });
      if (started.recent !== null) {
        // Attached: nothing is left to start, and a running program may print nothing at all.
        this.script = "";
        this.update({ status: "running" });
        await this.replay(started.recent);
        if (started.report) this.restoreReport(started.report);
        this.lastSize = "";
        this.redraw = true;
      } else {
        // The tab is usually shown and fitted while the spawn is in flight, and
        // refit skips the resize until there is an id; send the real size now.
        this.lastSize = `${cols}x${rows}`;
      }
      const waiting = held;
      held = undefined;
      for (const bytes of waiting) show(bytes);
      if (exitCode !== undefined) return this.exited(exitCode);
      this.refit();
      // Output can arrive before the id does; Windows ConPTY prints nothing
      // until xterm answers its cursor-position query, so flush that now.
      const queued = this.pending.join("");
      this.pending = [];
      if (queued) this.write(queued);
    } catch (e) {
      if (run !== this.run) return;
      this.term.write(`\r\n\x1b[31m${e}\x1b[0m\r\n`);
      this.exited(-1);
    }
  }

  private exited(code: number) {
    this.ptyId = undefined;
    this.cancelFollow();
    if (this.disposed) return;
    this.update({ pty: undefined });
    if (isRemote(this.project) && code === SSH_CONNECTION_FAILED) {
      const secs = Math.round(this.backoff / 1000);
      this.term.write(`\r\n\x1b[33m[connection lost, reconnecting in ${secs}s]\x1b[0m\r\n`);
      this.update({ status: "reconnecting" });
      this.retry = setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      return;
    }
    if (this.cmd && this.tab.once && code === 0) {
      // A Worktree's setup that finished: nothing left to see.
      removeTab(this.project.id, this.tab.id);
      return closeSession(this.tab.id);
    }
    if (this.cmd) {
      // An agent quit: restarting it rarely helps, so carry on in a plain shell.
      this.term.write(`\r\n\x1b[90m[${this.tab.name ?? "agent"} exited with code ${code}, starting a shell]\x1b[0m\r\n`);
      this.update({ agent: undefined, ready: undefined });
      // Quitting on purpose ends the conversation. A failed resume, or being killed by a shutdown,
      // doesn't: the tab stays an agent and tries again at the next launch.
      if (code === 0 || !this.tab.resume) becomeShell(this.project.id, this.tab.id);
      this.cmd = "";
      return void this.start();
    }
    if (this.status === "running") {
      // The shell was exited: close its window. One that never started stays open to show why.
      removeTab(this.project.id, this.tab.id);
      return closeSession(this.tab.id);
    }
    this.term.write(`\r\n\x1b[90m[exited with code ${code}, press Enter to restart]\x1b[0m\r\n`);
    this.update({ status: "exited", agent: undefined, ready: undefined });
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.el.style.display = visible ? "" : "none";
    if (visible) {
      // WebGL only for visible terminals: browsers cap live GL contexts (~16)
      // and each one holds GPU memory.
      if (!this.webgl) this.loadWebgl();
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
    this.term.options.theme = this.theme();
  }

  /** The theme's colours; with no background of its own when the backdrop shows through (the window paints it). */
  private theme() {
    const t = themeNow();
    return this.clear ? { ...t, background: "rgba(0, 0, 0, 0)", cursorAccent: t.background } : t;
  }

  followClear() {
    this.setClear(seesThrough(this.project));
  }

  /** Follow the project's Transparency. The WebGL renderer reads allowTransparency when it starts, so restart it. */
  setClear(clear: boolean) {
    if (clear === this.clear) return;
    this.clear = clear;
    this.term.options.allowTransparency = clear;
    if (this.webgl) {
      this.dropWebgl();
      this.loadWebgl();
    }
    this.applyTheme();
  }

  private loadWebgl() {
    try {
      this.webgl = new WebglAddon();
      this.webgl.onContextLoss(() => this.dropWebgl());
      this.term.loadAddon(this.webgl);
    } catch {
      this.webgl = undefined; // falls back to the DOM renderer
    }
  }

  /** A new font has a new cell size, so the columns and rows that fit change too. */
  applyFont() {
    const font = terminalFont(app.settings.fontMono);
    if (this.term.options.fontFamily === font) return;
    this.term.options.fontFamily = font;
    this.refit();
  }

  private dropWebgl() {
    this.webgl?.dispose();
    this.webgl = undefined;
  }

  private refit() {
    if (!this.visible || !this.fit.proposeDimensions()) return;
    this.fit.fit();
    const { cols, rows } = this.term;
    const size = `${cols}x${rows}`;
    // Recent output can start mid-sequence, and a program only redraws when its size changes.
    if (this.redraw && this.ptyId !== undefined && !phoneHeld.has(this.ptyId) && cols > 1) {
      this.redraw = false;
      const id = this.ptyId;
      this.lastSize = size;
      call("pty_resize", { id, cols: cols - 1, rows });
      setTimeout(() => call("pty_resize", { id, cols: this.term.cols, rows: this.term.rows }), 60);
      return;
    }
    // A phone watching this PTY has given it the phone's size until it lets go.
    if (size === this.lastSize || this.ptyId === undefined || phoneHeld.has(this.ptyId)) return;
    this.lastSize = size;
    call("pty_resize", { id: this.ptyId, cols: this.term.cols, rows: this.term.rows });
  }

  /** The last phone stopped watching: give the PTY this window's size back. */
  restoreSize(pty: number) {
    if (this.ptyId !== pty) return;
    this.lastSize = `${this.term.cols}x${this.term.rows}`;
    call("pty_resize", { id: pty, cols: this.term.cols, rows: this.term.rows });
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

/** What `pty_spawn` did. `recent` is set when it attached to a terminal that was already running. */
type Started = { id: number; recent: string | null; report: string | null };

/** Resumed agents start one at a time, a little apart, so a launch doesn't spawn them all at once. */
const RESUME_GAP_MS = 150;
let nextResume = 0;
function resumeSlot() {
  const at = Math.max(Date.now(), nextResume);
  nextResume = at + RESUME_GAP_MS;
  return new Promise((done) => setTimeout(done, at - Date.now()));
}

/** An OSC 7501 report: `state=working:app=pi:msg=<base64>`. Records with an `id` describe sub-tasks,
 *  so only the root one counts. */
function parseReport(data: string): { state: string; msg: string } | undefined {
  const f = Object.fromEntries(data.split(":").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  if (f.id !== undefined) return undefined;
  let msg = "";
  try {
    msg = f.msg ? decodeBase64(f.msg) : "";
  } catch {
    msg = "";
  }
  return { state: f.state, msg };
}

/** OSC 52 payloads are UTF-8 text encoded as base64. */
function decodeBase64(b64: string): string {
  const binary = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

const sessions = new Map<string, TermSession>();

/** PTYs a phone is watching (phone.rs), which keep the phone's size meanwhile. */
const phoneHeld = new Set<number>();
listen<{ pty: number; held: boolean }>("phone-hold", ({ payload }) => {
  if (payload.held) return void phoneHeld.add(payload.pty);
  phoneHeld.delete(payload.pty);
  for (const s of sessions.values()) s.restoreSize(payload.pty);
}).catch((e) => console.warn("phone-hold unavailable:", e));

/** Claude's hook reported its session id (agent_windows.rs): the tab keeps it to reopen the conversation. */
listen<{ tab: string; kind: string; id: string }>("agent-session", ({ payload }) => {
  const p = app.projects.find((x) => x.tabs.some((t) => t.id === payload.tab));
  if (p) setTabResume(p.id, payload.tab, { kind: payload.kind, id: payload.id });
}).catch((e) => console.warn("agent-session unavailable:", e));

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

/** Settings › Appearance changed: give every terminal the theme and font now in force. */
export function applyTerminalLook() {
  for (const s of sessions.values()) {
    s.applyTheme();
    s.applyFont();
  }
}

/** Whether a terminal of `project` lets the backdrop through: its repo's Transparency, as the backdrop is the repo's. */
const seesThrough = (project: Project) => (repoOf(project).clear?.terms ?? 0) > 0;

/** A project's Transparency changed: let every terminal follow. Reads the store, so an effect calling it re-runs on a change. */
export function applyTerminalClear() {
  for (const s of sessions.values()) s.followClear();
}

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

/** Start this tab's pi over in its project's folder once its turn ends. */
export function followAfterTurn(tabId: string): void {
  sessions.get(tabId)?.followAfterTurn();
}

/** A terminal's tab moved to `project`: its session follows. */
export function rehomeSession(tabId: string, project: Project): void {
  sessions.get(tabId)?.rehome(project);
}

/** Restart these terminals after their Environment moved off `oldHost` (state.moveEnvironment). */
export async function moveSessions(tabIds: string[], oldHost: string): Promise<void> {
  await Promise.all(tabIds.map((id) => sessions.get(id)?.moveFrom(oldHost)));
}

export function closeSession(tabId: string) {
  sessions.get(tabId)?.dispose();
  sessions.delete(tabId);
}

export function setLinkHandler(fn: (url: string, tabId: string, external: boolean) => void): void {
  linkHandler = fn;
}
