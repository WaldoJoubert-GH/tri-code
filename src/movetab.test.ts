// bun test: moving a window to another project (state.moveTab). Its terminal has to keep attaching
// to the session it started with, and the project it left has to focus something else.

import { beforeEach, describe, expect, test } from "bun:test";
import { type Project, type Tab, app, moveTab, piCanFollow, sessionName, setApp } from "./state";

const space = () => ({ layout: "master", ratio: 0.55 });
const term = (id: string): Tab => ({ id, kind: "term", space: 0, cmd: "claude" }) as Tab;
const project = (id: string, tabs: Tab[], focus?: string, ws = 0) =>
  ({ id, name: id, host: "local", path: "~", tabs, ws, spaces: [{ ...space(), focus }, space(), space(), space()] }) as unknown as Project;
const p = (id: string) => app.projects.find((x) => x.id === id)!;
const tab = (project: string, id: string) => p(project).tabs.find((t) => t.id === id)!;

beforeEach(() => {
  setApp("projects", [project("tri", [term("a"), term("b")], "b"), project("wt", [term("c")], "c", 2)]);
});

describe("piCanFollow", () => {
  const resume = { kind: "pi", id: "abc" };

  test("a plain pi with a session can be restarted elsewhere", () => {
    expect(piCanFollow({ cmd: "pi", resume })).toBe(true);
    expect(piCanFollow({ cmd: "pi.cmd --model opus", resume })).toBe(true);
  });

  test("anything resume.rs would run as typed can't: it would lose the conversation", () => {
    for (const cmd of ["pi --no-session", "pi -c", "pi --fork=x", "pi && echo hi", "pi\nnpm test", "my-pi", ""]) {
      expect(piCanFollow({ cmd, resume })).toBe(false);
    }
  });

  test("no session of pi's, or a one-shot window, can't", () => {
    expect(piCanFollow({ cmd: "pi" })).toBe(false);
    expect(piCanFollow({ cmd: "pi", resume: { kind: "claude", id: "abc" } })).toBe(false);
    expect(piCanFollow({ cmd: "pi", resume, once: true })).toBe(false);
  });
});

describe("moveTab", () => {
  test("the tab lands on the target's active workspace, focused", () => {
    moveTab("tri", "wt", "b");
    expect(p("tri").tabs.map((t) => t.id)).toEqual(["a"]);
    expect(p("wt").tabs.map((t) => t.id)).toEqual(["c", "b"]);
    expect(tab("wt", "b").space).toBe(2);
    expect(p("wt").spaces[2].focus).toBe("b");
  });

  test("the project it left focuses the window before it", () => {
    moveTab("tri", "wt", "b");
    expect(p("tri").spaces[0].focus).toBe("a");
  });

  test("the session name stays the one it started with, through a second move", () => {
    const started = sessionName(p("tri"), tab("tri", "b"));
    moveTab("tri", "wt", "b");
    expect(sessionName(p("wt"), tab("wt", "b"))).toBe(started);
    moveTab("wt", "tri", "b");
    expect(sessionName(p("tri"), tab("tri", "b"))).toBe(started);
  });

  test("a tab that never moved keeps its usual name", () => {
    expect(sessionName(p("tri"), tab("tri", "a"))).toBe("tri-tri-a");
  });

  test("moving to its own project, or a tab that isn't there, does nothing", () => {
    moveTab("tri", "tri", "b");
    moveTab("tri", "wt", "nope");
    expect(p("tri").tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(p("wt").tabs.map((t) => t.id)).toEqual(["c"]);
    expect(tab("tri", "b").session).toBeUndefined();
  });
});
