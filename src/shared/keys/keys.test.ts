// bun test: every key the app draws is the one keycap (Keys.tsx, `kbd` in src/app/styles.css).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitKeys } from "./keymap";

const src = join(import.meta.dir, "..", "..");
/** Every file under src/ ending in `ext`, as a path relative to src/ with forward slashes. */
const files = (ext: string) =>
  (readdirSync(src, { recursive: true }) as string[])
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.endsWith(ext));
const read = (f: string) => readFileSync(join(src, f), "utf8");

describe("the keycap", () => {
  test("only Keys.tsx writes a <kbd>, so no key can look different", () => {
    const tsx = files(".tsx");
    expect(tsx).toContain("shared/keys/Keys.tsx");
    const others = tsx.filter((f) => f !== "shared/keys/Keys.tsx" && /<kbd[\s>]/.test(read(f)));
    expect(others).toEqual([]);
  });

  test("only app/styles.css styles a kbd, so no panel can restyle one", () => {
    const css = files(".css");
    expect(css).toContain("app/styles.css");
    expect(css.length).toBeGreaterThan(10);
    const others = css.filter((f) => f !== "app/styles.css" && /\bkbd\b[^{}]*\{/.test(read(f).replace(/:has\([^)]*\)/g, "")));
    expect(others).toEqual([]);
  });

  test("a chord written as text splits into its keys", () => {
    expect(splitKeys("Ctrl+Shift+↵")).toEqual(["Ctrl", "Shift", "↵"]);
    expect(splitKeys("F2")).toEqual(["F2"]);
    expect(splitKeys("Ctrl++")).toEqual(["Ctrl", "+"]);
    expect(splitKeys("+")).toEqual(["+"]);
  });
});
