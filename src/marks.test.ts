// bun test: the editor's git marks for the file tree and tabs (fileMarks / markAt in src/git.ts).

import { describe, expect, test } from "bun:test";
import { type Change, fileMarks, markAt, setBranchStatus, setFolderStatus } from "./git";
import type { Project } from "./state";

const ch = (path: string, x: string, y: string): Change => ({ path, x, y });
const status = (files: Change[]) => ({ branch: "main", upstream: null, ahead: 0, behind: 0, base: "main", files, commits: [] });

describe("fileMarks", () => {
  test("files, folders and an untracked folder in a repo project", () => {
    const p = { id: "p1", host: "local", path: "C:\\work\\app\\" } as Project;
    setBranchStatus(p.id, status([ch("src/a.ts", ".", "M"), ch("src/new.ts", "A", "."), ch("src/lib/x.ts", "U", "U"), ch("tmp/", "?", "?")]));
    const m = fileMarks(p);
    expect(markAt(m, "C:\\work\\app/src/a.ts")).toBe("M");
    expect(markAt(m, "C:/work/app/src/new.ts")).toBe("A");
    expect(markAt(m, "C:/work/app/src/lib/x.ts")).toBe("C");
    expect(markAt(m, "C:/work/app/src", true)).toBe("C");
    expect(markAt(m, "C:/work/app/src")).toBeUndefined();
    expect(markAt(m, "C:/work/app/tmp", true)).toBe("U");
    expect(markAt(m, "C:/work/app/tmp/deep/f.txt")).toBe("U");
    expect(markAt(m, "C:/work/app/README.md")).toBeUndefined();
  });

  test("a folder of repos resolves each repo's paths", () => {
    const p = { id: "p2", host: "local", path: "/home/me/code" } as Project;
    setFolderStatus(p.id, [{ repo: "api", status: status([ch("main.go", ".", "D")]) }, { repo: "web", error: "nope" }]);
    const m = fileMarks(p);
    expect(markAt(m, "/home/me/code/api/main.go")).toBe("D");
    expect(markAt(m, "/home/me/code/api", true)).toBe("D");
    expect(m.dirs.has("/home/me/code")).toBe(false);
  });

  test("a rename is R", () => {
    const p = { id: "p3", host: "local", path: "/r" } as Project;
    setBranchStatus(p.id, status([{ ...ch("b.ts", "R", "."), orig: "a.ts" }]));
    expect(markAt(fileMarks(p), "/r/b.ts")).toBe("R");
  });
});
