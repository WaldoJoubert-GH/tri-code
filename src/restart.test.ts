// bun test: which agent signals count as busy for the restart-to-update prompt (busySignals in sigs.ts).

import { beforeEach, describe, expect, test } from "bun:test";
import { type Project, type Tab, setApp, setLive, live } from "./state";
import { busySignals } from "./sigs";

const tab = (id: string) => ({ id, kind: "terminal", space: 0 }) as unknown as Tab;
const project = (id: string, tabs: Tab[]) => ({ id, name: id, host: "local", path: "~", tabs }) as unknown as Project;

beforeEach(() => {
  for (const k of Object.keys(live)) setLive(k, undefined as never);
  setApp("projects", [
    project("a", [tab("a1"), tab("a2")]),
    project("b", [tab("b1"), tab("b2")]),
  ]);
});

describe("busySignals", () => {
  test("nothing running: no busy signals", () => {
    expect(busySignals()).toEqual([]);
  });

  test("a working agent is busy", () => {
    setLive("a1", { agent: { state: "working", msg: "", at: 0, seen: true } } as never);
    expect(busySignals()).toEqual(["working"]);
  });

  test("an agent waiting for you is busy, even once seen", () => {
    setLive("b1", { agent: { state: "blocked", msg: "", at: 0, seen: true } } as never);
    expect(busySignals()).toEqual(["blocked"]);
  });

  test("a failed agent that nobody has looked at yet is busy", () => {
    setLive("a2", { agent: { state: "error", msg: "", at: 0, seen: false } } as never);
    expect(busySignals()).toEqual(["error"]);
  });

  test("a bell in a plain shell counts as needing you", () => {
    setLive("b2", { attention: true } as never);
    expect(busySignals()).toEqual(["blocked"]);
  });

  test("a finished agent is not busy, seen or not", () => {
    setLive("a1", { agent: { state: "done", msg: "", at: 0, seen: false } } as never);
    setLive("a2", { agent: { state: "done", msg: "", at: 0, seen: true } } as never);
    expect(busySignals()).toEqual([]);
  });

  test("counts every project's tabs together", () => {
    setLive("a1", { agent: { state: "working", msg: "", at: 0, seen: true } } as never);
    setLive("b1", { agent: { state: "working", msg: "", at: 0, seen: true } } as never);
    setLive("b2", { agent: { state: "blocked", msg: "", at: 0, seen: true } } as never);
    expect(busySignals().sort()).toEqual(["blocked", "working", "working"]);
  });
});

