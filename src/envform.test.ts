// bun test: the Environment dialog's rules (envform.ts) and moving an Environment to a new destination (state.ts).
import { beforeEach, describe, expect, test } from "bun:test";
import { type EnvFields, type EnvOriginal, emptyFields, envFormView, fieldsFrom, optionsList, optionsText, parseSsh, sshOf } from "./envform";
import { app, moveEnvironment, setApp } from "./state";

const devbox: EnvOriginal = { host: "dev@box", port: "2222", key: "~/k.pem", options: "A=1", hasPin: true };
const edit = (over: Partial<EnvFields> = {}): EnvFields => ({ ...fieldsFrom(devbox), ...over });
const add = (over: Partial<EnvFields> = {}): EnvFields => ({ ...emptyFields("ssh"), ...over });
const ctx = (original?: EnvOriginal, over = {}) => ({ original, hosts: ["local", "dev@box", "build-01"], locked: false, projects: 2, terminals: 3, ...over });

describe("parseSsh", () => {
  test("reads a pasted command", () => {
    expect(parseSsh(`ssh -i .\\key.pem -p 2200 -o A=1 -o "ProxyCommand ssh x" -l me host`)).toEqual({
      dest: "me@host", identityFile: "~\\key.pem", port: "2200", options: ["A=1", "ProxyCommand ssh x"],
    });
  });
});

describe("ssh options as text", () => {
  test("an option with spaces survives the field", () => {
    const list = ["A=1", "ProxyCommand ssh jump"];
    expect(optionsText(list)).toBe('A=1 "ProxyCommand ssh jump"');
    expect(optionsList(optionsText(list))).toEqual(list);
  });
  test("empty is none", () => {
    expect(optionsList("  ")).toBeUndefined();
    expect(optionsText(undefined)).toBe("");
  });
  test("fields become the ssh options, or nothing", () => {
    expect(sshOf(add({ key: " ~/k ", port: "22", options: "A=1 B=2" }))).toEqual({ identityFile: "~/k", port: "22", options: ["A=1", "B=2"] });
    expect(sshOf(add())).toBeUndefined();
  });
});

describe("New environment", () => {
  test("needs a destination, then tests before adding", () => {
    expect(envFormView(add(), ctx()).blocked).toBe(true);
    const v = envFormView(add({ dest: "me@new" }), ctx());
    expect(v.blocked).toBe(false);
    expect(v.primary).toBe("Test and add");
    expect(v.needsTest).toBe(true);
  });
  test("follows the test", () => {
    expect(envFormView(add({ dest: "me@new", test: "wait" }), ctx()).blocked).toBe(true);
    expect(envFormView(add({ dest: "me@new", test: "ok" }), ctx()).primary).toBe("Add");
    expect(envFormView(add({ dest: "me@new", test: "bad" }), ctx()).primary).toBe("Add anyway");
  });
  test("a host that is already an environment is refused", () => {
    const v = envFormView(add({ dest: "dev@box" }), ctx());
    expect(v.taken).toBe(true);
    expect(v.blocked).toBe(true);
  });
  test("a destination that can't be one is refused", () => {
    expect(envFormView(add({ dest: "two words" }), ctx()).blocked).toBe(true);
    expect(envFormView(add({ dest: "-oProxyCommand=x" }), ctx()).blocked).toBe(true);
  });
  test("local adds at once, with no connection or PIN", () => {
    const v = envFormView(emptyFields("local"), ctx(undefined, { hosts: ["build-01"] }));
    expect(v.host).toBe("local");
    expect(v.open).toBe(false);
    expect(v.primary).toBe("Add");
    expect(v.needsTest).toBe(false);
    expect(v.localDisabled).toBe(false);
  });
  test("local can't be added twice", () => {
    expect(envFormView(add(), ctx()).localDisabled).toBe(true);
  });
  test("a new PIN must be 4-8 matching digits", () => {
    const f = { dest: "me@new", pinOn: true };
    expect(envFormView(add({ ...f, pin: "12" }), ctx()).pinProblem).toBe("PIN must be 4–8 digits");
    expect(envFormView(add({ ...f, pin: "1234", pin2: "1235" }), ctx()).pinProblem).toBe("PINs don't match");
    expect(envFormView(add({ ...f, pin: "1234", pin2: "1234" }), ctx()).pinProblem).toBe("");
    expect(envFormView(add({ ...f, pin: "1234", pin2: "1234" }), ctx()).needCur).toBe(false);
  });
});

describe("Edit environment", () => {
  test("starts with nothing to test", () => {
    const v = envFormView(edit(), ctx(devbox));
    expect(v.primary).toBe("Save");
    expect(v.needsTest).toBe(false);
    expect(v.blocked).toBe(false);
  });
  test("its own host isn't taken", () => {
    expect(envFormView(edit(), ctx(devbox)).taken).toBe(false);
    expect(envFormView(edit({ dest: "build-01" }), ctx(devbox)).taken).toBe(true);
  });
  test("a changed key file needs a test", () => {
    const v = envFormView(edit({ key: "~/other.pem" }), ctx(devbox));
    expect(v.primary).toBe("Test and save");
    expect(v.needsTest).toBe(true);
    expect(v.moving).toBe(false);
    expect(envFormView(edit({ key: "~/other.pem", test: "bad" }), ctx(devbox)).primary).toBe("Save anyway");
  });
  test("a new destination warns what moves", () => {
    const v = envFormView(edit({ dest: "dev@new", test: "ok" }), ctx(devbox));
    expect(v.moving).toBe(true);
    expect(v.primary).toBe("Save and move");
    expect(v.moveText).toBe("Moves 2 projects to dev@new. 3 open terminals restart there. Folders keep their paths, so they need to exist on the new host.");
  });
  test("an empty environment has nothing to move", () => {
    const v = envFormView(edit({ dest: "dev@new", test: "ok" }), ctx(devbox, { projects: 0, terminals: 0 }));
    expect(v.moveText).toBe("");
    expect(v.primary).toBe("Save");
  });
  test("changing or removing a PIN asks for the current one", () => {
    expect(envFormView(edit({ changing: true, pin: "5678", pin2: "5678" }), ctx(devbox)).pinProblem).toBe("Enter the current PIN");
    expect(envFormView(edit({ changing: true, cur: "1234", pin: "5678", pin2: "5678" }), ctx(devbox)).pinProblem).toBe("");
    const off = envFormView(edit({ pinOn: false }), ctx(devbox));
    expect(off.removing).toBe(true);
    expect(off.pinProblem).toBe("Enter the current PIN");
    expect(envFormView(edit({ pinOn: false, cur: "1234" }), ctx(devbox)).blocked).toBe(false);
  });
  test("locked: only the name and icon, however the fields read", () => {
    const v = envFormView(edit({ pinOn: false, dest: "dev@new" }), ctx(devbox, { locked: true }));
    expect(v.open).toBe(false);
    expect(v.primary).toBe("Save");
    expect(v.needsTest).toBe(false);
    expect(v.blocked).toBe(false);
    expect(v.host).toBe("dev@box");
  });
  test("local edits its name only", () => {
    const local: EnvOriginal = { host: "local", port: "", key: "", options: "", hasPin: false, local: true };
    const v = envFormView(fieldsFrom(local), ctx(local));
    expect(v.open).toBe(false);
    expect(v.host).toBe("local");
    expect(v.primary).toBe("Save");
  });
});

describe("moveEnvironment", () => {
  const project = (id: string, host: string, parent?: string) => ({ id, name: id, host, path: `/srv/${id}`, tabs: [], ws: 0, ...(parent ? { parent } : {}) });

  beforeEach(() => {
    setApp({
      environments: ["local", "old", "other"],
      envStyles: { old: { name: "Box", icon: "cloud" } },
      envSsh: { old: { port: "2222" } },
      envLocks: { old: { salt: "s", hash: "h", minutes: 15 } },
      projects: [project("a", "old"), project("w", "old", "a"), project("b", "other")] as never,
      recent: [{ host: "new", path: "/srv/a" }, { host: "old", path: "/srv/a" }, { host: "old", path: "/srv/z" }, { host: "other", path: "/srv/b" }],
      agents: [
        { id: "1", name: "x", command: "", icon: "bot", scope: { env: "old" } },
        { id: "2", name: "y", command: "", icon: "bot", scope: { env: "other" } },
        { id: "3", name: "z", command: "", icon: "bot", scope: { project: "a" } },
        { id: "4", name: "g", command: "", icon: "bot" },
      ],
    });
    moveEnvironment("old", "new");
  });

  test("keeps its place in the sidebar", () => expect([...app.environments]).toEqual(["local", "new", "other"]));
  test("takes its projects and Worktrees", () => expect(app.projects.map((p) => p.host)).toEqual(["new", "new", "other"]));
  test("takes its name, ssh options and PIN", () => {
    expect(app.envStyles.new).toEqual({ name: "Box", icon: "cloud" });
    expect(app.envSsh.new).toEqual({ port: "2222" });
    expect(app.envLocks.new).toEqual({ salt: "s", hash: "h", minutes: 15 });
    expect(app.envStyles.old).toBeUndefined();
    expect(app.envSsh.old).toBeUndefined();
    expect(app.envLocks.old).toBeUndefined();
  });
  test("takes Commands scoped to it, and no others", () => {
    expect(app.agents.map((a) => a.scope)).toEqual([{ env: "new" }, { env: "other" }, { project: "a" }, undefined] as never);
  });
  test("takes recents, without doubles", () => {
    expect(app.recent).toEqual([{ host: "new", path: "/srv/a" }, { host: "new", path: "/srv/z" }, { host: "other", path: "/srv/b" }]);
  });
});
