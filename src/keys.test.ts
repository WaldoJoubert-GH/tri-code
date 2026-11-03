// bun test: every key the app draws is the one keycap (Keys.tsx, `kbd` in styles.css).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitKeys } from "./keymap";

const files = (ext: string) => readdirSync(import.meta.dir).filter((f) => f.endsWith(ext));
const read = (f: string) => readFileSync(join(import.meta.dir, f), "utf8");

describe("the keycap", () => {
  test("only Keys.tsx writes a <kbd>, so no key can look different", () => {
    const others = files(".tsx").filter((f) => f !== "Keys.tsx" && /<kbd[\s>]/.test(read(f)));
    expect(others).toEqual([]);
  });

  test("only styles.css styles a kbd, so no panel can restyle one", () => {
    const others = files(".css").filter((f) => f !== "styles.css" && /\bkbd\b[^{}]*\{/.test(read(f).replace(/:has\([^)]*\)/g, "")));
    expect(others).toEqual([]);
  });

  test("a chord written as text splits into its keys", () => {
    expect(splitKeys("Ctrl+Shift+↵")).toEqual(["Ctrl", "Shift", "↵"]);
    expect(splitKeys("F2")).toEqual(["F2"]);
    expect(splitKeys("Ctrl++")).toEqual(["Ctrl", "+"]);
    expect(splitKeys("+")).toEqual(["+"]);
  });
});
