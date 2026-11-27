// bun test: the diff parser, split alignment and change marks (src/diff.ts).

import { describe, expect, test } from "bun:test";
import { changeMarks, diffStats, firstChange, makePatch, pairMarks, parseUnified, sameText, splitRows } from "./diff";

const PATCH = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -10,7 +10,8 @@ export async function refresh(token: string) {",
  "   const url = `${API}/refresh`;",
  "-  const res = await fetch(url, { method: \"POST\" });",
  "+  // Send the token so the server can rotate it.",
  "+  const res = await fetch(url, { method: \"POST\", headers: authHeaders(token) });",
  "   if (!res.ok) throw new Error(\"refresh failed\");",
  "-  return res.json();",
  "+  return (await res.json()) as Session;",
  "   }",
  " ",
  "@@ -40,3 +41,2 @@ export function logout() {",
  "   clear();",
  "-  location.reload();",
  "   }",
  "\\ No newline at end of file",
].join("\n");

describe("parseUnified", () => {
  const hunks = parseUnified(PATCH);

  test("splits hunks and skips the file header and no-newline note", () => {
    expect(hunks.length).toBe(2);
    expect(hunks[0].oldStart).toBe(10);
    expect(hunks[0].newStart).toBe(10);
    expect(hunks[1].rows.map((r) => r.t).join("")).toBe(" - ");
  });

  test("numbers both sides", () => {
    const rows = hunks[0].rows;
    expect(rows[0]).toEqual({ t: " ", text: "  const url = `${API}/refresh`;", old: 10, new: 10 });
    expect(rows[1]).toMatchObject({ t: "-", old: 11, new: null });
    expect(rows[2]).toMatchObject({ t: "+", old: null, new: 11 });
    expect(rows[3]).toMatchObject({ t: "+", old: null, new: 12 });
    expect(rows[4]).toMatchObject({ t: " ", old: 12, new: 13 });
    expect(hunks[1].rows[1]).toMatchObject({ t: "-", old: 41, new: null });
  });

  test("an empty or binary patch has no hunks", () => {
    expect(parseUnified("")).toEqual([]);
    expect(parseUnified("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ")).toEqual([]);
  });
});

describe("stats and first change", () => {
  const hunks = parseUnified(PATCH);

  test("counts added and removed lines", () => {
    expect(diffStats(hunks)).toEqual({ added: 3, removed: 3 });
  });

  test("first change is the first added line, else the hunk start", () => {
    expect(firstChange(hunks)).toBe(11);
    expect(firstChange(parseUnified("@@ -3,2 +3,1 @@\n a\n-b"))).toBe(3);
    expect(firstChange([])).toBeNull();
  });
});

describe("splitRows", () => {
  test("pairs a line with the one it resembles; an extra comment stays on its own side", () => {
    const rows = splitRows(parseUnified(PATCH)[0]);
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "add", "mod", "ctx", "mod", "ctx", "ctx"]);
    expect(rows[1].right?.text).toContain("Send the token");
    expect(rows[2].left?.text).toContain("fetch(url, { method: \"POST\" })");
    expect(rows[2].right?.text).toContain("authHeaders(token)");
  });

  test("a deleted line drills to the next surviving new-side line", () => {
    const rows = splitRows(parseUnified(PATCH)[1]);
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "del", "ctx"]);
    expect(rows[1].anchor).toBe(42);
  });

  test("unrelated lines are not paired", () => {
    const rows = splitRows(parseUnified("@@ -1,1 +1,1 @@\n-alpha beta gamma\n+zzz 123 !!!")[0]);
    expect(rows.map((r) => r.kind)).toEqual(["del", "add"]);
  });

  test("a huge rewrite falls back to a deletion block beside an addition block", () => {
    const n = 600;
    const body = [
      `@@ -1,${n} +1,${n} @@`,
      ...Array.from({ length: n }, (_, i) => `-old ${i}`),
      ...Array.from({ length: n }, (_, i) => `+new ${i}`),
    ].join("\n");
    const rows = splitRows(parseUnified(body)[0]);
    expect(rows.length).toBe(2 * n);
    expect(rows[0].kind).toBe("del");
    expect(rows[n].kind).toBe("add");
  });
});

describe("pairMarks", () => {
  test("marks the changed middle of both lines", () => {
    expect(pairMarks("return res.json();", "return res.text();")).toEqual({
      a: ["return res.", "json", "();"],
      b: ["return res.", "text", "();"],
    });
  });

  test("identical lines have nothing to mark", () => {
    expect(pairMarks("same", "same")).toBeNull();
  });
});

describe("makePatch", () => {
  test("CRLF and a BOM at HEAD do not make every line look changed", () => {
    const head = "﻿one\r\ntwo\r\nthree\r\n";
    const buf = "one\ntwo\nTHREE\n";
    const hunks = parseUnified(makePatch("f.txt", head, buf));
    expect(diffStats(hunks)).toEqual({ added: 1, removed: 1 });
    expect(sameText(head, "one\ntwo\nthree\n")).toBe(true);
  });

  test("a new file is all added", () => {
    expect(diffStats(parseUnified(makePatch("n.ts", "", "a\nb\n")))).toEqual({ added: 2, removed: 0 });
  });

  test("with a timeout it still returns a patch for a small pair", () => {
    expect(makePatch("f", "a\n", "b\n", 100)).toContain("@@");
  });
});

describe("changeMarks", () => {
  test("added, changed and deleted lines from a git patch", () => {
    expect(changeMarks(parseUnified(PATCH))).toEqual({ add: [], mod: [11, 12, 14], del: [42] });
  });

  test("additions alone are added; a deletion alone marks the line after it", () => {
    const head = "a\nb\nc\nd\ne\n";
    const buf = "a\nNEW\nb\nc\ne\n";
    expect(changeMarks(parseUnified(makePatch("f", head, buf, 100)!))).toEqual({ add: [2], mod: [], del: [5] });
  });

  test("a deletion at the start or the end of the file", () => {
    expect(changeMarks(parseUnified(makePatch("f", "x\na\nb\n", "a\nb\n", 100)!)).del).toEqual([1]);
    expect(changeMarks(parseUnified(makePatch("f", "a\nb\nx\n", "a\nb\n", 100)!)).del).toEqual([3]);
  });

  test("a changed line, with zero context", () => {
    expect(changeMarks(parseUnified(makePatch("f", "a\nb\nc\n", "a\nB\nc\n", 100)!))).toEqual({ add: [], mod: [2], del: [] });
  });
});
