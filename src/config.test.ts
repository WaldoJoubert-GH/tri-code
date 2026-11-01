// bun test: configuration export and import (config.ts).

import { describe, expect, test } from "bun:test";
import { type Persisted, migrate } from "./state";
import { SECTIONS, applyImport, assetKeys, buildExport, parseConfig, planImport } from "./config";

const ALL = SECTIONS.map((s) => s.id);

/** A state as loadState would produce it, from a few raw fields. */
const state = (raw: any): Persisted => migrate(raw);

const proj = (id: string, extra: any = {}) => ({ id, name: id, host: "local", path: `/src/${id}`, tabs: [{ id: `${id}-t`, kind: "term", space: 0 }], ...extra });

let n = 0;
const ids = () => `new${++n}`;

describe("export", () => {
  const s = state({
    projects: [
      proj("a", { bg: "image", icon: { kind: "image" }, notify: { done: "custom" }, setup: "bun i" }),
      proj("wt", { parent: "a", branch: "x" }),
      proj("tour", { sample: true }),
    ],
    envLocks: { "me@box": { salt: "s", hash: "h", minutes: 5 } },
    environments: ["local", "me@box"],
    settings: { modKey: "meta", hotkeys: { close: [] } },
  });

  test("leaves out Worktrees, the Sample Project, windows and PIN locks", () => {
    const f = buildExport(s, ALL, {}, "0.1.42", new Date(0));
    expect(f.sections.projects!.map((p) => p.id)).toEqual(["a"]);
    expect((f.sections.projects![0] as any).tabs).toBeUndefined();
    expect(JSON.stringify(f)).not.toContain("hash");
    expect(f.sections.environments!.environments).toEqual(["local", "me@box"]);
  });

  test("asks for each project's uploaded files and packs the ones it got", () => {
    expect(assetKeys(s, ALL).map((a) => `${a.kind}/${a.key}`)).toEqual(["bg/a", "icon/a", "sound/a-done"]);
    expect(assetKeys(s, ["preferences"])).toEqual([]);
    const f = buildExport(s, ALL, { "bg/a": "data:bg", "icon/a": "data:icon" }, "0.1.42");
    expect(f.assets).toEqual({ "bg/a": "data:bg", "icon/a": "data:icon" });
  });

  test("only the picked sections", () => {
    const f = buildExport(s, ["preferences"], {}, "0.1.42");
    expect(Object.keys(f.sections)).toEqual(["preferences"]);
    expect(f.sections.preferences!.settings.modKey).toBe("meta");
  });

  test("round-trips through parseConfig", () => {
    const f = buildExport(s, ALL, {}, "0.1.42");
    expect(parseConfig(JSON.stringify(f))).toEqual(f);
  });
});

describe("parseConfig", () => {
  test("rejects other files and newer versions", () => {
    expect(() => parseConfig("nope")).toThrow("isn't JSON");
    expect(() => parseConfig(JSON.stringify({ projects: [] }))).toThrow("isn't a tri-code configuration");
    expect(() => parseConfig(JSON.stringify({ format: "tri-code-config", version: 99, app: "9.0.0" }))).toThrow("newer tri-code");
  });
});

describe("import", () => {
  const source = state({
    projects: [
      proj("a", { bg: "image", accent: "#111111", notify: { done: "custom", error: "custom" } }),
      proj("b", { icon: { kind: "image" } }),
    ],
    agents: [
      { id: "claude", name: "claude-yolo", command: "claude --yolo", icon: "asterisk" },
      { id: "srv", name: "server", command: "bun dev", icon: "server", scope: { project: "b" } },
      { id: "only-c", name: "c", command: "c", icon: "x", scope: { project: "c" } },
    ],
    profiles: [{ id: "default", name: "Home", icon: "house", color: "moss" }, { id: "work", name: "Work", icon: "briefcase", color: "plum" }],
    environments: ["local", "me@box"],
    envSsh: { "me@box": { identityFile: "C:/keys/box", port: "2222" } },
    settings: { modKey: "meta", hotkeys: { close: [{ code: "KeyQ" }] }, profile: "work" },
    notify: { volume: 30 },
    gap: 4,
  });
  const file = () => parseConfig(JSON.stringify(buildExport(source, ALL, { "bg/a": "data:bg", "sound/a-done": "data:snd", "icon/b": "data:ico" }, "0.1.42")));

  const target = () => state({
    projects: [proj("mine", { path: "/src/a", accent: "#999999" })],
    agents: [{ id: "claude", name: "claude", command: "claude", icon: "asterisk" }, { id: "lazygit", name: "lazygit", command: "lazygit", icon: "git" }],
    settings: { hotkeys: { help: [{ code: "F1" }] }, monoGutter: 40 },
  });

  test("the preview counts what's new and what it replaces", () => {
    const plan = planImport(target(), file());
    const by = Object.fromEntries(plan.sections.map((s) => [s.id, s.summary]));
    expect(by.commands).toBe("3 commands: 2 new, 1 replacing the same id");
    expect(by.projects).toBe("2 projects: 1 new, 1 already open (appearance updated)");
    expect(plan.notes.join(" ")).toContain("me@box");
  });

  test("a project at the same host and path keeps its id and windows and takes the appearance", () => {
    const s = target();
    applyImport(s, file(), ALL, ids);
    const mine = s.projects.find((p) => p.id === "mine")!;
    expect(mine.accent).toBe("#111111");
    expect(mine.tabs.length).toBe(1);
    expect(mine.name).toBe("a");
  });

  test("a new project gets a new id, an empty canvas and its files under that id", () => {
    const s = target();
    const writes = applyImport(s, file(), ALL, ids);
    const b = s.projects.find((p) => p.path === "/src/b")!;
    expect(b.id).toStartWith("new");
    expect(b.tabs).toEqual([]);
    expect(b.spaces.length).toBe(4);
    expect(writes).toContainEqual({ kind: "icon", key: b.id, dataUrl: "data:ico" });
    expect(writes).toContainEqual({ kind: "bg", key: "mine", dataUrl: "data:bg" });
    expect(writes).toContainEqual({ kind: "sound", key: "mine-done", dataUrl: "data:snd" });
  });

  test("a custom sound the file lacks goes back to the default", () => {
    const s = target();
    applyImport(s, file(), ALL, ids);
    const mine = s.projects.find((p) => p.id === "mine")!;
    expect(mine.notify?.done).toBe("custom");
    expect(mine.notify?.error).toBeUndefined();
  });

  test("commands merge by id, follow their project's new id, and drop a scope to a project that didn't come", () => {
    const s = target();
    applyImport(s, file(), ALL, ids);
    expect(s.agents.map((a) => a.id)).toEqual(["claude", "lazygit", "srv", "only-c"]);
    expect(s.agents[0].command).toBe("claude --yolo");
    const b = s.projects.find((p) => p.path === "/src/b")!;
    expect(s.agents[2].scope).toEqual({ project: b.id });
    expect(s.agents[3].scope).toBeUndefined();
  });

  test("preferences: the file wins key by key, yours stay where it is silent", () => {
    const s = target();
    applyImport(s, file(), ["preferences"], ids);
    expect(s.settings.modKey).toBe("meta");
    expect(s.settings.hotkeys).toEqual({ help: [{ code: "F1" }], close: [{ code: "KeyQ" }] });
    expect(s.settings.monoGutter).toBe(40);
    expect(s.notify.volume).toBe(30);
    expect(s.notify.blocked).toBe("chime");
    expect(s.gap).toBe(4);
    // Its profile didn't come along.
    expect(s.settings.profile).toBeUndefined();
  });

  test("profiles replace by id, so a renamed default profile comes across", () => {
    const s = target();
    applyImport(s, file(), ["profiles", "preferences"], ids);
    expect(s.profiles.map((p) => [p.id, p.name])).toEqual([["default", "Home"], ["work", "Work"]]);
    expect(s.settings.profile).toBe("work");
  });

  test("environments union, ssh options come along, unpicked sections are untouched", () => {
    const s = target();
    applyImport(s, file(), ["environments"], ids);
    expect(s.environments).toEqual(["local", "me@box"]);
    expect(s.envSsh["me@box"]).toEqual({ identityFile: "C:/keys/box", port: "2222" });
    expect(s.projects.length).toBe(1);
    expect(s.agents.length).toBe(2);
  });

  test("importing twice adds nothing the second time", () => {
    const s = target();
    applyImport(s, file(), ALL, ids);
    const once = JSON.stringify({ p: s.projects.map((p) => p.id), a: s.agents.map((a) => a.id), e: s.environments });
    applyImport(s, file(), ALL, ids);
    expect(JSON.stringify({ p: s.projects.map((p) => p.id), a: s.agents.map((a) => a.id), e: s.environments })).toBe(once);
  });
});
