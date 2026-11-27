// The Welcome window's rules (Welcome.tsx): the agents it knows how to offer, how one becomes a
// Command, and what it says about each. Pure, so bun test can run it (welcomedata.test.ts).
// Chosen from design/new-user.html (variant A).

import type { Agent } from "../../shared/state/state";

export type Platform = "windows" | "mac" | "linux";

/** An agent or terminal app the Welcome window offers. `id` is the Command's id once added, so the
 *  built-in claude, pi and shell keep theirs. */
export type Known = {
  id: string;
  /** What the + menu calls it, and the command it runs ("" for the login shell). */
  name: string;
  command: string;
  /** A lucide icon name. */
  icon: string;
  title: string;
  blurb: string;
  /** "agent" in the agents list, "app" under Also in the + menu. */
  kind: "agent" | "app";
  /** Can take tri-code's agent-windows server (agentsetup.ts). */
  server?: "claude" | "pi";
  /** Reports working, needs you, done and failed (the Program Status Protocol). */
  signals?: boolean;
  /** Has plan meters in the status line. */
  usage?: boolean;
  /** The line that installs it, per platform; none means "see its site". */
  install?: Partial<Record<Platform, string>>;
};

const npm = (pkg: string) => ({ windows: `npm install -g ${pkg}`, mac: `npm install -g ${pkg}`, linux: `npm install -g ${pkg}` });

export const KNOWN: Known[] = [
  {
    id: "claude", name: "claude", command: "claude", icon: "asterisk", title: "Claude Code", blurb: "Anthropic's coding agent",
    kind: "agent", server: "claude", signals: true, usage: true,
    install: { windows: "irm https://claude.ai/install.ps1 | iex", mac: "curl -fsSL https://claude.ai/install.sh | bash", linux: "curl -fsSL https://claude.ai/install.sh | bash" },
  },
  {
    id: "pi", name: "pi", command: "pi", icon: "pi", title: "pi", blurb: "A minimal coding agent, for any model",
    kind: "agent", server: "pi", signals: true, install: npm("@mariozechner/pi-coding-agent"),
  },
  { id: "codex", name: "codex", command: "codex", icon: "bot", title: "Codex CLI", blurb: "OpenAI's coding agent", kind: "agent", install: npm("@openai/codex") },
  { id: "gemini", name: "gemini", command: "gemini", icon: "sparkles", title: "Gemini CLI", blurb: "Google's coding agent", kind: "agent", install: npm("@google/gemini-cli") },
  { id: "shell", name: "shell", command: "", icon: "square-terminal", title: "Shell", blurb: "A plain terminal in the project", kind: "app" },
  {
    id: "lazygit", name: "lazygit", command: "lazygit", icon: "git-branch", title: "lazygit", blurb: "A terminal UI for git", kind: "app",
    install: { windows: "winget install -e --id=JesseDuffield.lazygit", mac: "brew install lazygit" },
  },
];

/** Node runs the agent-windows server. */
export const NODE_INSTALL: Partial<Record<Platform, string>> = { windows: "winget install -e --id=OpenJS.NodeJS.LTS", mac: "brew install node" };

export const platform = (ua: string): Platform => (/Windows/i.test(ua) ? "windows" : /Mac/i.test(ua) ? "mac" : "linux");

/** The commands to look for on PATH: each known one with a command, plus the user's own that are a
 *  bare word (`codex --full-auto` looks for `codex`). The login shell needs no lookup. */
export function lookups(agents: readonly Pick<Agent, "command" | "url">[]): string[] {
  const words = [...KNOWN.map((k) => k.command), ...agents.filter((a) => a.url === undefined).map((a) => firstWord(a.command))];
  return [...new Set(words.filter((w) => /^[\w.-]+$/.test(w)))];
}

/** The program a command line runs: its first word, unless it is several lines (a script). */
export const firstWord = (command: string) => (command.includes("\n") ? "" : command.trim().split(/\s+/)[0] ?? "");

/** A known agent as a Command for the + menu. */
export const commandOf = (k: Known): Agent => ({ id: k.id, name: k.name, command: k.command, icon: k.icon });

/** The user's own entry as a Command: a web app when it is an address, else a terminal Command
 *  named after its program when no name is given. undefined when there's nothing to add. */
export function ownCommand(name: string, command: string, id: string, isUrl: (s: string) => boolean): Agent | undefined {
  const cmd = command.trim();
  if (!cmd) return undefined;
  const label = name.trim() || (isUrl(cmd) ? cmd.replace(/^https?:\/\//, "").split(/[/:]/)[0] : firstWord(cmd));
  return isUrl(cmd) ? { id, name: label, command: "", url: cmd, icon: "globe" } : { id, name: label, command: cmd, icon: "bot" };
}

export type Found = "checking" | "yes" | "no";

/** What the row says about an agent being on this machine. The shell is always there. */
export function foundOf(k: Known, present: Record<string, boolean> | null): Found {
  if (!k.command) return "yes";
  if (!present) return "checking";
  return present[k.command] ? "yes" : "no";
}

/** Why the agent can't take the server yet, or "" when it can. */
export function serverBlocker(found: Found, node: boolean | undefined): string {
  if (found !== "yes") return "once it's installed";
  if (node === false) return "needs Node on PATH to run";
  return "";
}
