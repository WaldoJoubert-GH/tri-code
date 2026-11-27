// Real grammars from the pinned tm-grammars package, tokenized by the real Oniguruma WASM, through
// CodeMirror's StreamLanguage: what the editor shows once a grammar is installed.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { EditorState } from "@codemirror/state";
import { StreamLanguage, ensureSyntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { Registry, parseRawGrammar } from "vscode-textmate";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import { GRAMMARS, grammarOfScope, grammarsOf, injectionsInto, langById } from "./grammars";
import { parser } from "./tmparser";

const require = createRequire(import.meta.url);
const pkg = dirname(require.resolve("tm-grammars/package.json"));
const onigWasm = join(dirname(require.resolve("vscode-oniguruma")), "onig.wasm");

beforeAll(async () => {
  await loadWASM(readFileSync(onigWasm).buffer as ArrayBuffer);
});

/** Each styled stretch of `doc` as [text, classes], with `installed` grammars available. */
async function styled(id: string, doc: string, installed = new Set(grammarsOf(id))) {
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async (scope) => {
      const n = grammarOfScope(scope);
      return n && installed.has(n) ? parseRawGrammar(readFileSync(join(pkg, "grammars", `${n}.json`), "utf8"), `${n}.json`) : null;
    },
    getInjections: (scope) => injectionsInto(scope, installed),
  });
  const grammar = (await reg.loadGrammar(GRAMMARS[id].scope))!;
  const lang = StreamLanguage.define(parser(grammar, langById(id)!));
  const state = EditorState.create({ doc, extensions: lang });
  const tree = ensureSyntaxTree(state, doc.length, 5000)!;
  const out: [string, string][] = [];
  highlightTree(tree, classHighlighter, (from, to, cls) => out.push([doc.slice(from, to), cls]));
  return { out, state, cls: (text: string) => out.find(([t]) => t === text)?.[1] };
}

describe("Zig", () => {
  const src = [
    'const std = @import("std");',
    "",
    "// Build a small CLI.",
    "pub fn build(b: *std.Build) void {",
    "    const n: u32 = 42;",
    "    _ = n;",
    "}",
  ].join("\n");

  test("keywords, strings, comments, numbers, functions and types", async () => {
    const { cls } = await styled("zig", src);
    expect(cls("const")).toBe("tok-keyword");
    expect(cls("pub")).toBe("tok-keyword");
    expect(cls('"std"')).toBe("tok-string");
    expect(cls("// Build a small CLI.")).toBe("tok-comment");
    expect(cls("42")).toBe("tok-number");
    expect(cls("build")).toContain("tok-variableName");
    expect(cls("u32")).toBe("tok-typeName");
  });

  test("toggle comment knows the language's comment", async () => {
    const { state } = await styled("zig", src);
    expect(state.languageDataAt<{ line?: string }>("commentTokens", 0)[0]?.line).toBe("//");
  });
});

describe("Vue", () => {
  const src = [
    "<template>",
    '  <div class="greeting">{{ msg }}</div>',
    "</template>",
    "",
    '<script setup lang="ts">',
    "const msg: string = 'hi'",
    "</script>",
    "",
    "<style>",
    "/* spans",
    "   two lines */",
    ".greeting { color: red; }",
    "</style>",
  ].join("\n");

  test("its HTML, script and style grammars come along and are used", async () => {
    const { cls } = await styled("vue", src);
    expect(cls("div")).toBe("tok-typeName");
    // attributeName is a kind of propertyName; classHighlighter names only the latter.
    expect(cls("class")).toBe("tok-propertyName");
    expect(cls("const")).toBe("tok-keyword");
    expect(cls("'hi'")).toBe("tok-string");
    expect(cls("color")).toBe("tok-propertyName");
  });

  test("state carries across lines (a comment spanning two)", async () => {
    const { out } = await styled("vue", src);
    expect(out.some(([t, c]) => t.includes("two lines") && c === "tok-comment")).toBe(true);
  });

  test("without its dependencies the template still colours, the script doesn't", async () => {
    const { cls } = await styled("vue", src, new Set(["vue"]));
    expect(cls("template")).toBe("tok-typeName");
    expect(cls("const")).toBeUndefined();
  });
});

test("every line gets tokens, however long", async () => {
  const long = `const s = "${"x".repeat(12_000)}";\nconst after = 1;`;
  const { cls } = await styled("zig", long);
  expect(cls("after")).toBeDefined();
});
