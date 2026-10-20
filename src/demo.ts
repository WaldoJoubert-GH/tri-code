// The tour's scripted terminals. A demo tab plays one of these into its xterm instead of
// starting a PTY. Status goes out as real OSC 7501 reports, written into the terminal, so the
// badges, sounds and notifications are the ones a real agent gets.

import type { DemoKind } from "./state";

export type Demo = {
  /** Keys typed into the terminal. */
  input(data: string): void;
  /** pi only: stop and ask for permission, as a real agent would. */
  ask(): void;
  stop(): void;
};

const C = { dim: "\x1b[90m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", bold: "\x1b[1m", off: "\x1b[0m" };

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const report = (app: string, state: string, msg: string) => `\x1b]7501;state=${state}:app=${app}:msg=${b64(msg)}\x1b\\`;

const RECORDED = `${C.dim}This agent is a recording for the tour. Open your own project (Alt+O) to work with the real one.${C.off}`;

export function playDemo(kind: DemoKind, cwd: string, out: (s: string) => void): Demo {
  const timers: number[] = [];
  const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
  let line = "";
  let asking = false;
  const prompt = kind === "pi" ? `${C.cyan}›${C.off} ` : kind === "claude" ? `${C.blue}>${C.off} ` : "";

  if (kind === "server") {
    out(`${C.dim}${cwd} $${C.off} bun dev\r\n\r\n  ${C.green}VITE v8.0.16${C.off}  ready in 312 ms\r\n\r\n  ➜  Local:   ${C.cyan}http://localhost:5173/${C.off}\r\n`);
  } else if (kind === "claude") {
    out(`${C.magenta}✻${C.off} Welcome to ${C.bold}Claude Code${C.off}\r\n  ${C.dim}cwd: ${cwd}${C.off}\r\n\r\n${prompt}add a dark theme toggle to the settings page\r\n\r\n`);
    out(report("claude", "working", "add a dark theme toggle"));
    const step = (tool: string, what: string) => `${C.green}●${C.off} ${tool}\r\n  ${C.dim}└ ${what}${C.off}\r\n`;
    later(1500, () => out(step("Read(src/Settings.tsx)", "Read 15 lines")));
    later(3500, () => out(step("Read(src/theme.ts)", "Read 14 lines")));
    later(6000, () => out(step("Update(src/Settings.tsx)", "6 additions, 1 removal")));
    later(9000, () => out(step("Write(tests/settings.test.ts)", "Wrote 10 lines")));
    later(11000, () => out(`\r\n${C.yellow}✻ Running tests…${C.off} ${C.dim}(esc to interrupt)${C.off}\r\n`));
    later(45000, () => {
      out(`\r\n${step("Bash(bun test)", "1 passed")}\r\nSettings now has a ${C.bold}Dark theme${C.off} toggle, saved across reloads.\r\n\r\n${prompt}`);
      out(report("claude", "done", "Dark theme toggle added"));
    });
  } else {
    out(`${C.cyan}pi${C.off} ${C.dim}· ${cwd}${C.off}\r\n\r\n${C.dim}Waiting. The tour will have me ask you something.${C.off}\r\n\r\n${prompt}`);
  }

  const answer = (yes: boolean) => {
    asking = false;
    if (!yes) {
      out(`n\r\nSkipped.\r\n\r\n${prompt}`);
      out(report("pi", "done", "skipped the tests"));
      return;
    }
    out(`y\r\n${C.green}●${C.off} bun test tests/settings.test.ts\r\n`);
    out(report("pi", "working", "running the tests"));
    later(2000, () => {
      out(`  ${C.dim}└ 1 passed${C.off}\r\n\r\n${prompt}`);
      out(report("pi", "done", "tests pass"));
    });
  };

  return {
    input(data) {
      if (kind === "server" || data.startsWith("\x1b")) return;
      if (asking) {
        const k = data.toLowerCase();
        if (k === "y" || k === "\r") answer(true);
        else if (k === "n") answer(false);
        return;
      }
      for (const ch of data) {
        if (ch === "\r") {
          out(`\r\n${RECORDED}\r\n\r\n${prompt}`);
          line = "";
        } else if (ch === "\x7f") {
          if (line) out("\b \b");
          line = line.slice(0, -1);
        } else if (ch >= " ") {
          line += ch;
          out(ch);
        }
      }
    },
    ask() {
      if (kind !== "pi" || asking) return;
      asking = true;
      if (line) out("\r\n");
      line = "";
      out(`\r\n${C.bold}pi wants to run${C.off}  bun test tests/settings.test.ts\r\n  Allow? ${C.bold}[y/n]${C.off} `);
      out(report("pi", "blocked", "Allow bun test?"));
    },
    stop() {
      timers.forEach(clearTimeout);
    },
  };
}
