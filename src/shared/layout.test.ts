// bun test: the folder rules of docs/blueprint.md. shared/ never imports anything outside src/shared/,
// and a module is entered only through its folder (its index.ts), from another module or from a file
// outside modules/. The rules for app/ (no module imports it; nothing sits outside app/, shared/ and
// modules/) are turned on in later steps, once app/ exists.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const shared = import.meta.dir;
const src = dirname(shared);
const modules = join(src, "modules");

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

/** The module `p` sits in (`modules/<name>/…`), or undefined outside modules/. */
const moduleOf = (p: string) => (inside(modules, p) ? relative(modules, p).split(/[\\/]/)[0] : undefined);

/** Whether `from` may import `to`: a file inside a module only from that module, or through the module's folder (its index.ts). */
function crossesSeam(from: string, to: string): boolean {
  const target = moduleOf(to);
  if (target === undefined || moduleOf(from) === target) return false;
  const dir = join(modules, target);
  return ![dir, join(dir, "index.ts"), join(dir, "index.tsx")].includes(to);
}

describe("src/modules/", () => {
  const names = readdirSync(modules, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const files = sources(src).filter((f) => f !== import.meta.path);

  test("is scanned: each module has an index.ts, and files outside the modules import them", () => {
    expect(names).toEqual(expect.arrayContaining(["calc", "db", "docker", "media", "monitor", "news", "sandbox", "tour", "usage", "welcome"]));
    for (const n of names) expect(existsSync(join(modules, n, "index.ts"))).toBe(true);
    const into = files.filter((f) => !moduleOf(f) && imports(readFileSync(f, "utf8")).some((s) => moduleOf(resolveFrom(f, s))));
    expect(into.length).toBeGreaterThan(5);
  });

  test("are entered only through their folder (index.ts), from other modules and from outside", () => {
    const out: string[] = [];
    for (const f of files)
      for (const spec of imports(readFileSync(f, "utf8")))
        if (crossesSeam(f, resolveFrom(f, spec))) out.push(`${relative(src, f).replaceAll("\\", "/")} -> ${spec}`);
    expect(out).toEqual([]);
  });

  test("the seam rule tells the folder from a file inside it", () => {
    const m = (...p: string[]) => join(modules, ...p);
    expect(crossesSeam(join(src, "App.tsx"), m("db", "index.ts"))).toBe(false);
    expect(crossesSeam(join(src, "App.tsx"), m("db", "db.ts"))).toBe(true);
    expect(crossesSeam(join(src, "App.tsx"), m("db", "db.css"))).toBe(true);
    expect(crossesSeam(m("docker", "DockerPanel.tsx"), m("sandbox", "index.ts"))).toBe(false);
    expect(crossesSeam(m("docker", "DockerPanel.tsx"), m("sandbox", "sandbox.ts"))).toBe(true);
    expect(crossesSeam(m("db", "DbPanel.tsx"), m("db", "dbsql.ts"))).toBe(false);
    expect(crossesSeam(m("db", "DbPanel.tsx"), join(shared, "ui", "ui.ts"))).toBe(false);
  });
});
