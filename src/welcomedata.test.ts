// bun test: the Welcome window's rules (welcomedata.ts).

import { describe, expect, test } from "bun:test";
import { KNOWN, commandOf, firstWord, foundOf, lookups, ownCommand, platform, serverBlocker } from "./welcomedata";

const known = (id: string) => KNOWN.find((k) => k.id === id)!;
const isUrl = (s: string) => /^(https?:\/\/|localhost)/.test(s);

describe("welcome", () => {
  test("the built-in Commands keep their ids, so turning one off and on is the same row", () => {
    expect(commandOf(known("claude"))).toEqual({ id: "claude", name: "claude", command: "claude", icon: "asterisk" });
    expect(commandOf(known("shell")).command).toBe("");
  });

  test("looks up each known program once, plus the user's own bare commands", () => {
    const l = lookups([{ command: "codex --full-auto" }, { command: "aider" }, { command: "" }, { command: "x", url: "http://a" }, { command: "cd x\nmake" }]);
    expect(l).toContain("claude");
    expect(l).toContain("aider");
    expect(l.filter((c) => c === "codex")).toHaveLength(1);
    expect(l).not.toContain("");
    expect(l).not.toContain("x");
  });

  test("a script has no single program to look for", () => {
    expect(firstWord("cd web\nbun dev")).toBe("");
    expect(firstWord("  bun   dev ")).toBe("bun");
  });

  test("the shell is always found; others wait for the lookup", () => {
    expect(foundOf(known("shell"), null)).toBe("yes");
    expect(foundOf(known("pi"), null)).toBe("checking");
    expect(foundOf(known("pi"), { pi: true })).toBe("yes");
    expect(foundOf(known("pi"), { claude: true })).toBe("no");
  });

  test("the server needs the agent, then Node", () => {
    expect(serverBlocker("no", true)).toMatch(/installed/);
    expect(serverBlocker("yes", false)).toMatch(/Node/);
    expect(serverBlocker("yes", undefined)).toBe("");
    expect(serverBlocker("yes", true)).toBe("");
  });

  test("your own entry: named after its program, or a web app for an address", () => {
    expect(ownCommand("", "aider --model x", "i1", isUrl)).toEqual({ id: "i1", name: "aider", command: "aider --model x", icon: "bot" });
    expect(ownCommand("dash", "http://localhost:3000", "i2", isUrl)).toEqual({ id: "i2", name: "dash", command: "", url: "http://localhost:3000", icon: "globe" });
    expect(ownCommand("", "https://linear.app/x", "i3", isUrl)?.name).toBe("linear.app");
    expect(ownCommand("x", "  ", "i4", isUrl)).toBeUndefined();
  });

  test("platform from the user agent", () => {
    expect(platform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(platform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("mac");
    expect(platform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
});
