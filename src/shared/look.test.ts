// bun test: the theme and font values behind Settings › Appearance (look.ts).

import { describe, expect, test } from "bun:test";
import { fontMissing, fontStack, terminalFont, themeOf } from "./look";

describe("fonts", () => {
  test("unset is the default stack", () => {
    expect(fontStack("ui")).toBe('system-ui, "Segoe UI", sans-serif');
    expect(terminalFont()).toStartWith('"Cascadia Mono"');
  });

  test("a chosen font goes first and falls back to the default", () => {
    expect(fontStack("mono", "Fira Code")).toStartWith('"Fira Code", "JetBrains Mono"');
    expect(terminalFont("Fira Code")).toStartWith('"Fira Code", "Cascadia Mono"');
  });

  test("a name from an imported file can't close the CSS string", () => {
    expect(fontStack("ui", 'x"; color: red; \\')).toStartWith('"x\\"; color: red; \\\\", ');
  });
});

describe("themeOf", () => {
  test("light and dark are kept, anything else follows the system", () => {
    expect(themeOf({ theme: "light" })).toBe("light");
    expect(themeOf({ theme: "dark" })).toBe("dark");
    expect(themeOf({})).toBe("system");
    expect(themeOf({ theme: "blue" as any })).toBe("system");
  });
});

describe("fontMissing", () => {
  const installed = ["Consolas", "Inter"];

  test("warns only for a saved font that isn't installed", () => {
    expect(fontMissing("Berkeley Mono", installed)).toBe(true);
    expect(fontMissing("consolas", installed)).toBe(false);
    expect(fontMissing(undefined, installed)).toBe(false);
  });

  test("says nothing until the list has loaded", () => {
    expect(fontMissing("Berkeley Mono", null)).toBe(false);
  });
});
