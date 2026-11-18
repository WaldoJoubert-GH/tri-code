import { describe, expect, test } from "bun:test";
import { GRAMMARS, LANGS, VERSION, downloadSize, grammarOfScope, grammarsOf, injectionsInto, langOfName, removable, styleOf } from "./grammars";

describe("catalog", () => {
  test("is pinned to an exact tm-grammars version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("every language and dependency has a grammar with a hash", () => {
    for (const l of LANGS) for (const n of grammarsOf(l.id)) {
      expect(GRAMMARS[n]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(GRAMMARS[n].bytes).toBeGreaterThan(0);
    }
  });

  test("no file type is offered twice", () => {
    const seen = new Map<string, string>();
    for (const l of LANGS) for (const t of l.types) {
      expect(seen.get(t.toLowerCase()) ?? l.id).toBe(l.id);
      seen.set(t.toLowerCase(), l.id);
    }
  });
});

describe("langOfName", () => {
  test("by extension", () => {
    expect(langOfName("build.zig")?.id).toBe("zig");
    expect(langOfName("schema.prisma")?.id).toBe("prisma");
    expect(langOfName("main.tf")?.id).toBe("terraform");
    expect(langOfName("App.vue")?.id).toBe("vue");
  });

  test("ignores case", () => {
    expect(langOfName("MAIN.TF")?.id).toBe("terraform");
  });

  test("by whole file name", () => {
    expect(langOfName("Makefile")?.id).toBe("make");
    expect(langOfName("CODEOWNERS")?.id).toBe("codeowners");
    expect(langOfName(".env")?.id).toBe("dotenv");
  });

  test("the longest type wins", () => {
    expect(langOfName("welcome.blade.php")?.id).toBe("blade");
    expect(langOfName("index.php")?.id).toBe("php");
    expect(langOfName("nginx.conf")?.id).toBe("nginx");
    expect(langOfName("app.conf")?.id).toBe("ini");
  });

  test("nothing for an unknown file", () => {
    expect(langOfName("notes.plan")).toBeUndefined();
    expect(langOfName("README")).toBeUndefined();
  });
});

describe("installing", () => {
  test("a small language downloads only itself", () => {
    expect(grammarsOf("zig")).toEqual(["zig"]);
    expect(downloadSize("zig", new Set())).toBe(GRAMMARS.zig.bytes);
  });

  test("a web framework brings its script and style grammars", () => {
    const vue = grammarsOf("vue");
    for (const n of ["html", "css", "javascript", "typescript", "vue-directives"]) expect(vue).toContain(n);
  });

  test("what is already installed isn't downloaded again", () => {
    const all = downloadSize("vue", new Set());
    const less = downloadSize("vue", new Set(["typescript", "javascript"]));
    expect(less).toBe(all - GRAMMARS.typescript.bytes - GRAMMARS.javascript.bytes);
    expect(downloadSize("vue", new Set(grammarsOf("vue")))).toBe(0);
  });

  test("removing keeps what another language needs", () => {
    const installed = new Set([...grammarsOf("vue"), ...grammarsOf("svelte")]);
    const gone = removable("vue", installed);
    expect(gone).toContain("vue");
    expect(gone).toContain("vue-directives");
    expect(gone).not.toContain("typescript");
    expect(gone).not.toContain("css");
  });

  test("removing the last user of a dependency removes it too", () => {
    const installed = new Set(grammarsOf("svelte"));
    expect(new Set(removable("svelte", installed))).toEqual(installed);
  });

  test("injections apply only once installed", () => {
    const vue = GRAMMARS.vue.scope;
    expect(grammarOfScope(vue)).toBe("vue");
    expect(injectionsInto(vue, new Set())).toEqual([]);
    expect(injectionsInto(vue, new Set(["vue-directives"]))).toEqual([GRAMMARS["vue-directives"].scope]);
  });
});

describe("styleOf", () => {
  test("the innermost scope with a rule wins", () => {
    expect(styleOf(["source.zig", "string.quoted.double.zig", "punctuation.definition.string.begin.zig"])).toBe("string");
    expect(styleOf(["source.zig", "string.quoted.double.zig", "constant.character.escape.zig"])).toBe("string.special");
  });

  test("common scopes", () => {
    expect(styleOf(["source.x", "comment.line.double-slash.x"])).toBe("comment");
    expect(styleOf(["source.x", "keyword.control.x"])).toBe("keyword");
    expect(styleOf(["source.x", "storage.type.function.x"])).toBe("keyword");
    expect(styleOf(["source.x", "keyword.operator.arithmetic.x"])).toBe("operator");
    expect(styleOf(["source.zig", "keyword.type.integer.zig"])).toBe("typeName");
    expect(styleOf(["source.x", "constant.numeric.integer.x"])).toBe("number");
    expect(styleOf(["source.x", "constant.language.boolean.x"])).toBe("bool");
    expect(styleOf(["source.x", "meta.function.x", "entity.name.function.x"])).toBe("variableName.function");
    expect(styleOf(["source.x", "entity.name.type.x"])).toBe("typeName");
    expect(styleOf(["text.html.vue", "entity.name.tag.html"])).toBe("tagName");
    expect(styleOf(["source.css", "support.type.property-name.css"])).toBe("propertyName");
  });

  test("a prefix must end at a dot", () => {
    expect(styleOf(["source.x", "stringy.thing"])).toBeNull();
    expect(styleOf(["source.x"])).toBeNull();
  });
});
