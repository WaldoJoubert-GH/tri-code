import { describe, expect, test } from "bun:test";
import { type Proc, HISTORY, bytes, descendants, duration, graphPaths, projectPids, pushed, rowsOf } from "./monitordata";

const proc = (pid: number, ppid: number, name: string, more: Partial<Proc> = {}): Proc => ({
  pid, ppid, name, cmd: name, user: "w", cpu: 0, mem: 0, start: 1000 + pid, born: pid, cwd: null, mine: false, guard: null, ...more,
});

// init ─┬─ shell ─── vite ─── esbuild
//       ├─ editor
//       └─ tsc (in the project, its parent gone)
const procs = [
  proc(1, 0, "init", { cpu: 1 }),
  proc(10, 1, "shell", { cpu: 2 }),
  proc(11, 10, "vite", { cpu: 30, mine: true }),
  proc(12, 11, "esbuild", { cpu: 5 }),
  proc(20, 1, "editor", { cpu: 50 }),
  proc(30, 1, "tsc", { cpu: 10, mine: true }),
];
const opts = { scope: "all" as const, find: "", tree: true, sort: "cpu" as const, asc: false };

describe("the process list", () => {
  test("a tree puts children under parents, busiest first among siblings", () => {
    const rows = rowsOf(procs, opts);
    expect(rows.map((r) => r.prefix + r.p.name)).toEqual(["init", "├─ editor", "├─ tsc", "└─ shell", "   └─ vite", "      └─ esbuild"]);
  });

  test("a flat list sorts everything together", () => {
    expect(rowsOf(procs, { ...opts, tree: false }).map((r) => r.p.pid)).toEqual([20, 11, 30, 12, 10, 1]);
    expect(rowsOf(procs, { ...opts, tree: false, sort: "name", asc: true }).map((r) => r.p.name)).toEqual(["editor", "esbuild", "init", "shell", "tsc", "vite"]);
  });

  test("this project is what runs in its folder and what that started; their parents become roots", () => {
    expect([...projectPids(procs)].sort((a, b) => a - b)).toEqual([11, 12, 30]);
    const rows = rowsOf(procs, { ...opts, scope: "mine" });
    expect(rows.map((r) => r.prefix + r.p.name)).toEqual(["vite", "└─ esbuild", "tsc"]);
  });

  test("a search lists matches flat, by pid, name, command or user", () => {
    expect(rowsOf(procs, { ...opts, find: "ES" }).map((r) => [r.p.name, r.prefix])).toEqual([["esbuild", ""]]);
    expect(rowsOf(procs, { ...opts, find: "20" }).map((r) => r.p.name)).toEqual(["editor"]);
  });

  test("a process that is its own parent, or a loop, doesn't hang the tree", () => {
    const odd = [proc(5, 5, "self"), proc(6, 7, "a"), proc(7, 6, "b")];
    expect(rowsOf(odd, opts).map((r) => r.p.name)).toEqual(["self"]);
    expect(descendants(odd, 6).map((p) => p.name)).toEqual(["b"]);
  });

  test("descendants go all the way down", () => {
    expect(descendants(procs, 10).map((p) => p.pid)).toEqual([11, 12]);
    expect(descendants(procs, 12)).toEqual([]);
  });
});

describe("numbers", () => {
  test("bytes and durations read short", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(300 * 1024 * 1024)).toBe("300 MB");
    expect(bytes(17.4 * 1024 ** 3)).toBe("17.4 GB");
    expect(duration(3 * 86400 + 4 * 3600 + 59)).toBe("3d 4h");
    expect(duration(7500)).toBe("2h 5m");
    expect(duration(250)).toBe("4m 10s");
  });

  test("a history keeps the newest HISTORY samples", () => {
    let h: number[] = [];
    for (let i = 0; i < HISTORY + 5; i++) h = pushed(h, i);
    expect(h.length).toBe(HISTORY);
    expect(h[0]).toBe(5);
    expect(h.at(-1)).toBe(HISTORY + 4);
  });

  test("a graph ends at the right edge and grows from there", () => {
    const g = graphPaths([0, 100], 10, 100);
    expect(g.line.endsWith("L100.00,1.0")).toBe(true);
    expect(g.area.startsWith("M98.31,10")).toBe(true);
    expect(graphPaths([50], 10, 100, true).line).toBe("M98.31,4.5L100.00,4.5");
  });
});
