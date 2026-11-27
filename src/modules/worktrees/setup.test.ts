import { describe, expect, test } from "bun:test";
import { setupCommand, setupLines } from "./setup";

const vars = { repo: "C:/Users/me/tri-code", worktree: "C:/Users/me/tri-code.worktrees/fix", branch: "fix" };

describe("setupLines", () => {
  test("fills in the variables and drops blank lines", () => {
    expect(setupLines("bun install\r\n\n  cp {repo}/.env {worktree}/.env  \n", vars)).toEqual([
      "bun install",
      "cp C:/Users/me/tri-code/.env C:/Users/me/tri-code.worktrees/fix/.env",
    ]);
  });

  test("leaves an unknown name as typed", () => {
    expect(setupLines("echo {nope} {branch}", vars)).toEqual(["echo {nope} fix"]);
  });
});

describe("setupCommand", () => {
  test("joins lines so the first failure stops it and leaves a shell", () => {
    const cmd = setupCommand(["bun install", "cp a b"], false);
    expect(cmd).not.toContain("\n");
    expect(cmd.startsWith("{ bun install; } && { cp a b; } || {")).toBe(true);
    expect(cmd).toContain('exec "${SHELL:-/bin/sh}" -l');
  });

  test("on Windows, runs the lines in PowerShell, encoded", () => {
    const cmd = setupCommand(["bun install", "cp {x} .env"], true);
    expect(cmd).not.toContain("\n");
    const b64 = cmd.replace("powershell -NoLogo -EncodedCommand ", "");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ps = new TextDecoder("utf-16le").decode(bytes);
    expect(ps.split("\n")).toEqual([
      "bun install",
      expect.stringContaining("if (-not $?)"),
      "cp {x} .env",
      expect.stringContaining("exit 1"),
    ]);
  });
});
