import { describe, expect, test } from "bun:test";
import type { Project } from "./state";
import { editorPath, ownerOf, samePath, within } from "./clipaths";

const proj = (id: string, path: string, more: Partial<Project> = {}) => ({ id, host: "local", path, ...more }) as Project;

describe("tri paths", () => {
  test("Windows paths match whatever the case and slashes", () => {
    expect(samePath(String.raw`C:\Users\me\Proj`, "c:/users/me/proj/")).toBe(true);
    expect(samePath("/home/me/Proj", "/home/me/proj")).toBe(false);
  });

  test("a folder holds itself and what is under it, not a sibling with the same start", () => {
    expect(within(String.raw`C:\code\app\src\a.ts`, String.raw`C:\code\app`)).toBe(true);
    expect(within(String.raw`C:\code\app`, String.raw`C:\code\app`)).toBe(true);
    expect(within(String.raw`C:\code\app2\a.ts`, String.raw`C:\code\app`)).toBe(false);
  });

  test("the deepest local project wins, so a Worktree beats its repo", () => {
    const projects = [
      proj("repo", String.raw`C:\code\app`),
      proj("wt", String.raw`C:\code\app\nested`),
      proj("remote", String.raw`C:\code\app\nested\deeper`, { host: "box" }),
      proj("tour", String.raw`C:\code\app\nested\deeper`, { sample: true }),
    ];
    expect(ownerOf(projects, String.raw`C:\code\app\nested\deeper\x.ts`)?.id).toBe("wt");
    expect(ownerOf(projects, String.raw`C:\code\app\x.ts`)?.id).toBe("repo");
    expect(ownerOf(projects, String.raw`C:\elsewhere\x.ts`)).toBeUndefined();
  });

  test("the editor gets the project's folder, then the path inside it with forward slashes", () => {
    expect(editorPath(proj("p", String.raw`C:\code\app`), String.raw`C:\code\app\src\main.rs`)).toBe(String.raw`C:\code\app` + "/src/main.rs");
    expect(editorPath(proj("p", "/home/me/app/"), "/home/me/app/src/main.rs")).toBe("/home/me/app/src/main.rs");
  });
});
