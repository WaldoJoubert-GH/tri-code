// bun test: which tree rows and tabs .gitignore matches (src/git.ts ignoredAt).

import { expect, test } from "bun:test";
import { type FileMarks, ignoredAt } from "./git";

const marks = (ignored: string[]): FileMarks => ({ files: new Map(), dirs: new Map(), untracked: [], ignored: new Set(ignored) });

test("an ignored folder covers everything in it, and only it", () => {
  const m = marks(["C:/p/node_modules", "C:/p/src-tauri/target"]);
  expect(ignoredAt(m, "C:/p/node_modules")).toBe(true);
  expect(ignoredAt(m, "C:/p/node_modules/solid-js/package.json")).toBe(true);
  expect(ignoredAt(m, "C:/p/src-tauri/target/debug/tri-code.exe")).toBe(true);
  expect(ignoredAt(m, "C:/p/src-tauri")).toBe(false);
  expect(ignoredAt(m, "C:/p/node_modules_old/a.js")).toBe(false);
});

test("a single ignored file, and Windows separators", () => {
  const m = marks(["C:/p/.dev/tauri.test.conf.json"]);
  expect(ignoredAt(m, "C:\\p\\.dev\\tauri.test.conf.json")).toBe(true);
  expect(ignoredAt(m, "C:/p/.dev/config.json")).toBe(false);
  expect(ignoredAt(m, "C:/p/.dev")).toBe(false);
});

test("nothing ignored, nothing muted", () => {
  expect(ignoredAt(marks([]), "C:/p/src/a.ts")).toBe(false);
});
