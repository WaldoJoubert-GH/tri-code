// bun test: what kind a file name is, and how the File Icon Themes draw it (src/shared/ui/fileicons.ts).

import { describe, expect, test } from "bun:test";
import { folderOf, iconSvg, kindOf, shade } from "./fileicons";

describe("kindOf", () => {
  test("a whole file name wins over its extension", () => {
    expect(kindOf("package.json")).toBe("npm");
    expect(kindOf("tsconfig.json")).toBe("tsconfig");
    expect(kindOf("Cargo.toml")).toBe("cargo");
    expect(kindOf("README.md")).toBe("readme");
    expect(kindOf("LICENSE")).toBe("license");
  });

  test("a path is read by its last part", () => {
    expect(kindOf("src/FileList.tsx")).toBe("react");
    expect(kindOf("site/package.json")).toBe("npm");
  });

  test("vite configs and .env files by pattern", () => {
    expect(kindOf("vite.config.ts")).toBe("vite");
    expect(kindOf("vite.config.mjs")).toBe("vite");
    expect(kindOf(".env.local")).toBe("env");
  });

  test("by extension, any case; unknown or none is a plain file", () => {
    expect(kindOf("files.css")).toBe("css");
    expect(kindOf("SHOT.PNG")).toBe("image");
    expect(kindOf("notes.xyz")).toBe("file");
    expect(kindOf("Procfile")).toBe("file");
  });

  test("a dotfile's name is not its extension", () => {
    expect(kindOf(".bashrc")).toBe("file");
  });
});

describe("folders", () => {
  test("known names have a colour and badge, any case", () => {
    expect(folderOf("src")?.[1]).toBe("code");
    expect(folderOf("Docs")?.[1]).toBe("lines");
    expect(folderOf("misc")).toBeUndefined();
  });
});

describe("iconSvg", () => {
  test("classic and none draw nothing here: FileIcon draws them", () => {
    expect(iconSvg("classic", "a.ts", false)).toBe("");
    expect(iconSvg("none", "src", true)).toBe("");
  });

  test("every set draws something for a file it doesn't know", () => {
    for (const t of ["atom", "material"] as const) expect(iconSvg(t, "notes.xyz", false)).toStartWith("<svg");
  });

  test("material folders take their name's colour unless plain", () => {
    const named = iconSvg("material", "src", true);
    expect(named).toContain(folderOf("src")![0]);
    expect(iconSvg("material", "src", true, false, { plainFolders: true })).not.toContain(folderOf("src")![0]);
  });

  test("atom open folders are hollow unless filled, and closed ones never are", () => {
    const hollow = 'transform="translate(.4 .4) scale(.95)"';
    expect(iconSvg("atom", "src", true, true)).toContain(hollow);
    expect(iconSvg("atom", "src", true, true, { filledOpen: true })).not.toContain(hollow);
    expect(iconSvg("atom", "src", true, false)).not.toContain(hollow);
  });

  test("atom mono draws in the text colour, its folder badges cut out in the panel's", () => {
    const file = iconSvg("atom", "a.ts", false, false, { mono: true });
    expect(file).toContain("currentColor");
    expect(file).not.toContain("#2f74c0");
    const dir = iconSvg("atom", "src", true, false, { mono: true });
    expect(dir).toContain("var(--panel)");
    expect(dir).not.toContain('="var(--panel)"');
  });
});

test("shade mixes toward black and white", () => {
  expect(shade("#808080", -1)).toBe("#000000");
  expect(shade("#808080", 1)).toBe("#ffffff");
  expect(shade("#336699", 0)).toBe("#336699");
});
