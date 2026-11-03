import { describe, expect, test } from "bun:test";
import { dropDuplicateResumes, migrate, type Tab } from "./state";

const tab = (id: string, resume?: Tab["resume"]): Tab => ({ id, kind: "term", space: 0, cmd: "claude", ...(resume ? { resume } : {}) });

describe("resume references", () => {
  test("the first tab keeps a shared conversation and the next starts new", () => {
    const tabs = [tab("a", { kind: "claude", id: "1" }), tab("b", { kind: "claude", id: "1" }), tab("c", { kind: "claude", id: "2" })];
    dropDuplicateResumes(tabs);
    expect(tabs.map((t) => t.resume?.id)).toEqual(["1", undefined, "2"]);
  });

  test("the same id under another agent is a different conversation", () => {
    const tabs = [tab("a", { kind: "claude", id: "1" }), tab("b", { kind: "pi", id: "1" })];
    dropDuplicateResumes(tabs);
    expect(tabs.map((t) => t.resume?.kind)).toEqual(["claude", "pi"]);
  });

  test("a saved reference survives loading, and duplicates are dropped across projects", () => {
    const project = (id: string, tabs: Tab[]) => ({ id, name: id, host: "local", path: "/x", tabs });
    const s = migrate({ projects: [project("p", [tab("a", { kind: "claude", id: "1" })]), project("q", [tab("b", { kind: "claude", id: "1" })])] });
    expect(s.projects[0].tabs[0].resume).toEqual({ kind: "claude", id: "1" });
    expect(s.projects[1].tabs[0].resume).toBeUndefined();
  });
});
