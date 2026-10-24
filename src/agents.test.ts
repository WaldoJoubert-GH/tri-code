// bun test: which commands a project offers, and the name and hotkey rules across scopes (src/scope.ts).

import { beforeEach, describe, expect, test } from "bun:test";
import { type Agent, type Project, app, setApp } from "./state";
import { chordHolder, nameProblem, offeredIn, reaches, replaceNote, scopesOverlap } from "./scope";

const project = (id: string, host: string, parent?: string) => ({ id, name: id, host, path: "~", tabs: [], ...(parent ? { parent } : {}) }) as unknown as Project;
const A1 = () => ({ code: "Digit1" });

beforeEach(() => {
  setApp("projects", [project("tri", "local"), project("tri-wt", "local", "tri"), project("api", "devbox")]);
  setApp("agents", [
    { id: "claude", name: "claude", command: "claude", icon: "asterisk", hotkey: A1() },
    { id: "shell", name: "shell", command: "", icon: "square-terminal" },
    { id: "dev", name: "dev", command: "bun install\nbun run tauri dev", icon: "rocket", scope: { project: "tri" } },
    { id: "gpu", name: "claude", command: "source .venv/bin/activate\nclaude", icon: "sparkles", scope: { env: "devbox" }, hotkey: A1() },
    { id: "logs", name: "logs", command: "tail -f app.log", icon: "scroll-text", scope: { env: "devbox" } },
  ] as Agent[]);
});

const byId = (id: string) => app.agents.find((a) => a.id === id)!;
const p = (id: string) => app.projects.find((x) => x.id === id)!;
const names = (id: string) => offeredIn(p(id)).map((a) => a.id);

describe("scope", () => {
  test("a project gets the global commands, its environment's and its own, in list order", () => {
    expect(names("tri")).toEqual(["claude", "shell", "dev"]);
    expect(names("api")).toEqual(["shell", "gpu", "logs"]);
  });

  test("a worktree gets its repo project's commands", () => {
    expect(reaches(byId("dev"), p("tri-wt"))).toBe(true);
    expect(names("tri-wt")).toEqual(["claude", "shell", "dev"]);
  });

  test("the narrower command of the same name replaces the wider one, there only", () => {
    expect(replaceNote(byId("gpu"), p("api"))).toContain("replaces");
    expect(replaceNote(byId("claude"), p("api"))).toContain("instead");
    expect(replaceNote(byId("claude"), p("tri"))).toBe("");
  });

  test("scopes overlap when some project could offer both", () => {
    expect(scopesOverlap(undefined, { env: "devbox" })).toBe(true);
    expect(scopesOverlap({ env: "local" }, { env: "devbox" })).toBe(false);
    expect(scopesOverlap({ env: "local" }, { project: "tri" })).toBe(true);
    expect(scopesOverlap({ env: "devbox" }, { project: "tri" })).toBe(false);
  });
});

describe("names and hotkeys", () => {
  test("a name is taken once per scope", () => {
    expect(nameProblem(byId("gpu"))).toBe("");
    setApp("agents", (list) => [...list, { id: "x", name: "Logs", command: "", icon: "bot", scope: { env: "devbox" } }]);
    expect(nameProblem(byId("x"))).toContain("has this name");
  });

  test("a replacement may keep the chord of the command it replaces", () => {
    expect(chordHolder(byId("gpu"))).toBeUndefined();
  });

  test("two commands offered together can't share a chord; the first keeps it", () => {
    setApp("agents", (a) => a.id === "logs", "hotkey", A1());
    expect(chordHolder(byId("logs"))?.id).toBe("gpu");
    setApp("agents", (a) => a.id === "dev", "hotkey", { code: "Digit2" });
    setApp("agents", (a) => a.id === "logs", "hotkey", { code: "Digit2" });
    expect(chordHolder(byId("logs"))).toBeUndefined();
  });
});
