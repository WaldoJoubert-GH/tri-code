// bun test: which ignored files New worktree starts with ticked, and its search (ignored.ts).

import { describe, expect, test } from "bun:test";
import { fileSize, filterIgnored, isEnvFile, splitPath, startingTicks, tickedByDefault } from "./ignored";

const files = [".env", "apps/web/.env.local", ".dev/plane.conf.json", "prisma/dev.db", "data/rows.csv"].map((path) => ({ path, size: 1 }));

describe("startingTicks", () => {
  test("first time: env files and .dev config, not databases or data", () => {
    expect(startingTicks(files)).toEqual([".env", "apps/web/.env.local", ".dev/plane.conf.json"]);
  });

  test("then exactly what was saved", () => {
    const known = files.map((f) => f.path);
    expect(startingTicks(files, { ticked: ["prisma/dev.db"], known })).toEqual(["prisma/dev.db"]);
  });

  test("a file new since the save: ticked only if it is a .env", () => {
    const saved = { ticked: [".env"], known: [".env", "prisma/dev.db", "data/rows.csv"] };
    expect(startingTicks(files, saved)).toEqual([".env", "apps/web/.env.local"]);
  });

  test("a saved file that is gone isn't ticked", () => {
    expect(startingTicks([{ path: ".env", size: 1 }], { ticked: [".env", "old.db"], known: [".env", "old.db"] })).toEqual([".env"]);
  });
});

describe("rules", () => {
  test("env files are .env in any folder, not folders called .env", () => {
    expect(isEnvFile(".envrc")).toBe(true);
    expect(isEnvFile("a/.env.test")).toBe(true);
    expect(isEnvFile(".env/x.db")).toBe(false);
    expect(isEnvFile("my.env")).toBe(false);
  });

  test(".dev config only at the top", () => {
    expect(tickedByDefault(".dev/sentry.conf.json")).toBe(true);
    expect(tickedByDefault("a/.dev/x.conf.json")).toBe(false);
  });
});

describe("filterIgnored", () => {
  const ticked = new Set([".env"]);
  test("matches anywhere in the path, any case", () => {
    expect(filterIgnored(files, " WEB ", ticked, false).map((f) => f.path)).toEqual(["apps/web/.env.local"]);
    expect(filterIgnored(files, "env", ticked, true).map((f) => f.path)).toEqual([".env"]);
    expect(filterIgnored(files, "", ticked, false)).toHaveLength(5);
  });
});

test("fileSize and splitPath", () => {
  expect([412, 3_480_000, 142_000_000, 2 * 1024 ** 3].map(fileSize)).toEqual(["412 B", "3.3 MB", "135 MB", "2.0 GB"]);
  expect(splitPath("apps/web/.env")).toEqual({ dir: "apps/web/", name: ".env" });
  expect(splitPath(".env")).toEqual({ dir: "", name: ".env" });
});
