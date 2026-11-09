// bun test: which windows count as agents, and which one "send to agent" picks (src/agenttarget.ts).

import { beforeEach, describe, expect, test } from "bun:test";
import { type Project, type Tab, live, setApp, setLive } from "./state";
import { agentTarget, agentWindows, rememberAgent } from "./agenttarget";

const term = (id: string, cmd: string, space = 0, extra: Partial<Tab> = {}) => ({ id, kind: "term", space, cmd, ...extra }) as Tab;
const project = (tabs: Tab[], ws = 0) => ({ id: "p", name: "p", host: "local", path: "~", tabs, ws, spaces: [{}, {}] }) as unknown as Project;

beforeEach(() => {
  for (const k of Object.keys(live)) setLive(k, undefined as never);
  setApp("projects", []);
});

describe("agentWindows", () => {
  test("claude and pi count; shells, dev servers and tools don't", () => {
    const p = project([term("sh", ""), term("dev", "bun dev"), term("lg", "lazygit"), term("c", "claude --continue"), term("pi", "pi.cmd")]);
    expect(agentWindows(p).map((t) => t.id)).toEqual(["c", "pi"]);
  });

  test("any program that answered the signal probe or reported counts", () => {
    const p = project([term("codex", "codex"), term("wrap", "my-agent")]);
    setLive("codex", { status: "running", attention: false, title: "", ready: true });
    setLive("wrap", { status: "running", attention: false, title: "", agent: { state: "working", msg: "", at: 0, seen: true } });
    expect(agentWindows(p).map((t) => t.id)).toEqual(["codex", "wrap"]);
  });

  test("a worktree's setup window never counts", () => {
    expect(agentWindows(project([term("s", "claude", 0, { once: true })]))).toEqual([]);
  });
});

describe("agentTarget", () => {
  test("not the dev server on this workspace, even when it comes first", () => {
    const p = project([term("dev", "bun dev"), term("c", "claude", 1)]);
    expect(agentTarget(p, "browser")?.id).toBe("c");
  });

  test("the focused agent, else the last one focused or chosen, else this workspace's, else the newest", () => {
    const p = { ...project([term("a", "claude", 1), term("b", "claude"), term("c", "pi", 1)]), id: "q" } as Project;
    expect(agentTarget(p, "c")?.id).toBe("c");
    expect(agentTarget(p, "browser")?.id).toBe("b");
    rememberAgent("q", "a");
    expect(agentTarget(p, "browser")?.id).toBe("a");
    expect(agentTarget({ ...p, id: "r", ws: 1 } as Project, undefined)?.id).toBe("a");
    expect(agentTarget({ ...p, id: "r", tabs: p.tabs.filter((t) => t.id !== "b") } as Project, undefined)?.id).toBe("c");
  });
});
