// bun test: the folder rules of docs/blueprint.md. For now only shared/'s: it never imports
// anything outside src/shared/. The rules for modules/ and app/ are turned on as those folders appear.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const shared = import.meta.dir;

/** Every .ts/.tsx file under `dir`, as absolute paths. */
const sources = (dir: string) =>
  (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f));

/** The relative specifiers `code` imports: `from "…"`, `import "…"` and `import("…")`. */
function imports(code: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\1/g;
  return [...code.matchAll(re)].map((m) => m[2]);
}

/** The file `spec` names from `file`, trying the extensions a bare specifier can leave out. */
function resolveFrom(file: string, spec: string): string {
  const base = resolve(dirname(file), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (existsSync(p)) return p;
  return base;
}

const inside = (dir: string, p: string) => {
  const r = relative(dir, p);
  return r !== "" && !r.startsWith("..") && !/^[a-zA-Z]:/.test(r);
};

describe("src/shared/", () => {
  // This file is left out: its parser test below holds sample imports in a string.
  const files = sources(shared).filter((f) => f !== import.meta.path);

  test("is scanned: the checks below see its files", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => imports(readFileSync(f, "utf8")).length > 0)).toBe(true);
  });

  test("imports only from src/shared/", () => {
    const out: string[] = [];
    for (const f of files)
      for (const spec of imports(readFileSync(f, "utf8"))) {
        const to = resolveFrom(f, spec);
        if (!inside(shared, to)) out.push(`${relative(shared, f).replaceAll("\\", "/")} -> ${spec}`);
      }
    expect(out).toEqual([]);
  });

  test("the import parser sees every form", () => {
    const code = `import a from "./a";\nimport "./b.css";\nconst c = await import("../c");\nexport { d } from './d';\nimport x from "solid-js";`;
    expect(imports(code)).toEqual(["./a", "./b.css", "../c", "./d"]);
  });
});
