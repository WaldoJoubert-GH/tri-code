import { describe, expect, test } from "bun:test";
import { addLines, caselessPath, isRepoUrl, nameProblem, progress, repoFolder, shortUrl } from "./newfolder";

describe("repository URLs", () => {
  test("recognises the usual forms", () => {
    for (const u of ["https://github.com/a/b.git", "http://host/x", "ssh://git@host/a/b", "git@github.com:a/b.git", "file:///srv/repo"]) {
      expect(isRepoUrl(u)).toBe(true);
    }
    for (const u of ["", "github.com/a/b", "a/b", "~/src", "C:/x", "https://"]) expect(isRepoUrl(u)).toBe(false);
  });

  test("the folder is the last part without .git", () => {
    expect(repoFolder("https://github.com/a/tri-code.git")).toBe("tri-code");
    expect(repoFolder("https://github.com/a/tri-code/")).toBe("tri-code");
    expect(repoFolder("git@github.com:a/b.git")).toBe("b");
    expect(repoFolder("git@host:repo")).toBe("repo");
    expect(shortUrl("https://github.com/a/b.git")).toBe("github.com/a/b");
  });
});

describe("folder names", () => {
  test("refuses bad names and ones that exist", () => {
    expect(nameProblem("", [], false)).toBe("");
    expect(nameProblem("app", ["other"], false)).toBe("");
    expect(nameProblem("a/b", [], false)).toBe("not a valid folder name");
    expect(nameProblem("x.", [], false)).toBe("not a valid folder name");
    expect(nameProblem("..", [], false)).toBe("not a valid folder name");
    expect(nameProblem("App", ["app"], true)).toBe("already exists");
    expect(nameProblem("App", ["app"], false)).toBe("");
  });

  test("Windows paths are caseless", () => {
    expect(caselessPath("C:\\Users\\me")).toBe(true);
    expect(caselessPath("/home/me")).toBe(false);
  });
});

describe("clone output", () => {
  const l = (text: string, partial = false) => ({ text, partial });

  test("a partial line is replaced by the next", () => {
    let log = addLines([], [l("Cloning into 'x'..."), l("Receiving objects:  10% (1/10)", true)]);
    log = addLines(log, [l("Receiving objects:  50% (5/10)", true)]);
    expect(log.map((x) => x.text)).toEqual(["Cloning into 'x'...", "Receiving objects:  50% (5/10)"]);
    log = addLines(log, [l("Receiving objects: 100% (10/10), done.")]);
    expect(log.map((x) => x.text)).toEqual(["Cloning into 'x'...", "Receiving objects: 100% (10/10), done."]);
  });

  test("progress is the latest meter", () => {
    expect(progress([l("Cloning into 'x'...")])).toBeNull();
    expect(progress([l("remote: Counting objects:  40% (4/10)"), l("Receiving objects:  7% (1/10)", true)])).toEqual({ phase: "Receiving objects", pct: 7 });
  });
});
