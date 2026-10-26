// bun test: which Commands an agent may open as a window (agentwin.ts). Only terminal Commands with
// the Agent toggle on, that the project offers; a worktree gets its repo's Commands.

import { beforeEach, describe, expect, test } from "bun:test";
import { type Agent, type Project, app, setApp } from "./state";
import { agentRunsIn } from "./agentwin";

const project = (id: string, host: string, parent?: string) => ({ id, name: id, host, path: "~", tabs: [], ...(parent ? { parent } : {}) }) as unknown as Project;

beforeEach(() => {
  setApp("projects", [project("tri", "local"), project("tri-wt", "local", "tri"), project("api", "devbox")]);
  setApp("agents", [
    { id: "claude", name: "claude", command: "claude", icon: "asterisk", agentRun: true },
    { id: "dev", name: "dev server", command: "bun run dev", icon: "rocket", scope: { project: "tri" }, agentRun: true },
    { id: "off", name: "deploy", command: "bun run deploy", icon: "rocket", scope: { project: "tri" } },
    { id: "docs", name: "docs", command: "", url: "http://localhost:3000", icon: "globe", agentRun: true },
  ] as Agent[]);
});

const byId = (id: string) => app.agents.find((a) => a.id === id)!;
const p = (id: string) => app.projects.find((x) => x.id === id)!;

describe("agent windows", () => {
  test("only a Command with the Agent toggle on may be opened", () => {
    expect(agentRunsIn(p("tri"), byId("dev"))).toBe(true);
    expect(agentRunsIn(p("tri"), byId("off"))).toBe(false);
  });

  test("a web app is never opened for an agent", () => {
    expect(agentRunsIn(p("tri"), byId("docs"))).toBe(false);
  });

  test("a Command must be offered by the project to be opened there", () => {
    expect(agentRunsIn(p("api"), byId("dev"))).toBe(false);
    expect(agentRunsIn(p("api"), byId("claude"))).toBe(true);
  });

  test("a worktree gets its repo's Commands", () => {
    expect(agentRunsIn(p("tri-wt"), byId("dev"))).toBe(true);
  });
});
