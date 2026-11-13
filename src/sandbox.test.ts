import { describe, expect, test } from "bun:test";
import { canSandbox, hostKey, isAgentCommand, lastJson, mountsFor, parseBlocked, parseBoxes, parseRules, parseSecrets, parseTemplates, readSignIn, sandboxName, sandboxesFor, templateOf } from "./sandbox";
import { type Project, migrate } from "./state";

describe("a Worktree keeps its sandbox", () => {
  test("across a save and a load of state.json", () => {
    const raw = { projects: [{ id: "r", name: "app", host: "local", path: "C:\\app" }, { id: "w", name: "fix", host: "local", path: "C:\\app.worktrees\\fix", parent: "r", branch: "fix", sandbox: "tri-app-fix" }] };
    expect(migrate(JSON.parse(JSON.stringify(raw))).projects.find((p) => p.id === "w")?.sandbox).toBe("tri-app-fix");
  });

  test("one that lost it gets it back from the sandbox whose workspace is its folder", () => {
    const boxes = parseBoxes(JSON.stringify([
      { name: "tri-tri-code-sidebar-changes", status: "stopped", workspaces: ["C:\\Users\\me\\tri-code.worktrees\\sidebar-changes", "C:\\Users\\me\\tri-code\\.git"] },
      { name: "claude-other", status: "stopped", workspaces: ["C:\\Users\\me\\tri-code.worktrees\\other"] },
    ]));
    expect(sandboxesFor([{ id: "w", path: "C:/Users/me/tri-code.worktrees/sidebar-changes/" }, { id: "x", path: "C:\\Users\\me\\tri-code.worktrees\\other" }], boxes)).toEqual([
      { id: "w", sandbox: "tri-tri-code-sidebar-changes" },
    ]);
  });
});

describe("readSignIn", () => {
  test("a /login sbx keeps is the anthropic secret's OAuth", () => {
    expect(readSignIn(JSON.stringify({ secrets: [{ scope: "global", type: "oauth", name: "anthropic", secret: "(stored)" }] }))).toBe("subscription");
  });

  test("an Anthropic API key, or nothing", () => {
    expect(readSignIn(JSON.stringify({ secrets: [{ scope: "global", type: "service", name: "anthropic", secret: "sk-ant-api…" }] }))).toBe("apikey");
    expect(readSignIn(JSON.stringify({ secrets: [{ scope: "global", type: "service", name: "github", secret: "(stored)" }], custom_secrets: [] }))).toBe(null);
    expect(readSignIn("")).toBe(null);
  });
});

describe("templates", () => {
  test("one per repo, as a tag sbx accepts", () => {
    expect(templateOf("tri-code")).toBe("tri-template/tri-code:latest");
    expect(templateOf("My App!")).toBe("tri-template/my-app:latest");
  });

  test("only tri-code's, from sbx template ls --json", () => {
    const json = JSON.stringify([
      { repository: "docker.io/library/sandbox-kit-assembled", tag: "1591fd067d6b7450", size: 367439718 },
      { repository: "docker.io/tri-template/imapp", tag: "latest", size: 812000000 },
    ]);
    expect(parseTemplates(json)).toEqual([{ tag: "tri-template/imapp:latest", size: 812000000 }]);
  });
});

describe("isAgentCommand", () => {
  test("claude runs in the sandbox, whatever its path, suffix or flags", () => {
    for (const c of ["claude", "claude --model opus", "C:\\Users\\me\\.local\\bin\\claude.exe", "/usr/local/bin/claude -c"]) {
      expect(isAgentCommand(c)).toBe(true);
    }
  });

  test("pi, shells, scripts and the user's other tools stay on this machine", () => {
    for (const c of ["", "pi", "codex", "lazygit", "bun run dev", "claudette", "pip install x", "claude\nbun run dev"]) {
      expect(isAgentCommand(c)).toBe(false);
    }
  });
});

describe("sandboxName", () => {
  test("is the repo and the worktree folder, in what sbx accepts", () => {
    expect(sandboxName("tri-code", "fix_sync")).toBe("tri-tri-code-fix-sync");
    expect(sandboxName("My App!", "WALDO.Feature")).toBe("tri-my-app-waldo-feature");
  });

  test("takes the next free number when the name is taken", () => {
    expect(sandboxName("app", "x", ["tri-app-x", "tri-app-x-2"])).toBe("tri-app-x-3");
  });

  test("stays within 63 characters and ends on a letter or digit", () => {
    const n = sandboxName("a".repeat(40), "b".repeat(40));
    expect(n.length).toBeLessThanOrEqual(63);
    expect(n).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
});

describe("mountsFor", () => {
  test("the repo's .git first, so git works in the worktree, then the folders with {repo} filled in", () => {
    expect(mountsFor("C:\\Users\\me\\app\\", ["{repo}\\docs:ro", "D:\\shared"])).toEqual([
      "C:\\Users\\me\\app\\.git",
      "C:\\Users\\me\\app\\docs:ro",
      "D:\\shared",
    ]);
    expect(mountsFor("/home/me/app")).toEqual(["/home/me/app/.git"]);
  });

  test("a copy of a multi-repo folder: each nested repo's .git instead of the folder's", () => {
    expect(mountsFor("C:\\work\\suite", ["{repo}\\shared:ro"], ["api", "web/app"])).toEqual([
      "C:\\work\\suite\\api\\.git",
      "C:\\work\\suite\\web\\app\\.git",
      "C:\\work\\suite\\shared:ro",
    ]);
    expect(mountsFor("/home/me/suite/", [], ["api/"])).toEqual(["/home/me/suite/api/.git"]);
  });
});

describe("canSandbox", () => {
  const local = { host: "local" } as Project;
  test("a repo, or a folder with repos in it, on this machine or an ssh host", () => {
    expect(canSandbox(local, { git: true })).toBe(true);
    expect(canSandbox(local, { git: false, repos: ["api"] })).toBe(true);
    expect(canSandbox({ host: "me@box" } as Project, { git: true })).toBe(true);
  });

  test("not a folder without repos, or one still being scanned", () => {
    expect(canSandbox(local, { git: false, repos: [] })).toBe(false);
    expect(canSandbox(local, undefined)).toBe(false);
  });
});

describe("each host has its own sbx", () => {
  test("this machine goes by one key however it is spelled; an ssh host by its destination", () => {
    expect(hostKey("")).toBe("local");
    expect(hostKey("local")).toBe("local");
    expect(hostKey(undefined)).toBe("local");
    expect(hostKey("me@box")).toBe("me@box");
  });

  test("its JSON is read past a banner the host's login shell printed", () => {
    expect(lastJson("Welcome to box!\nLast login: today\n[{\"name\":\"tri-a-b\"}]\n")).toBe("[{\"name\":\"tri-a-b\"}]");
    expect(parseBoxes("motd\n[{\"name\":\"tri-a-b\",\"status\":\"running\"}]")[0]?.name).toBe("tri-a-b");
    expect(lastJson("{\"a\":1}")).toBe("{\"a\":1}");
    expect(lastJson("")).toBe("");
  });

  test("a sandbox on an ssh host belongs to the worktree whose folder is its workspace there", () => {
    const boxes = parseBoxes(JSON.stringify([{ name: "tri-app-fix", status: "running", workspaces: ["/home/me/app.worktrees/fix"] }]));
    expect(sandboxesFor([{ id: "w", path: "/home/me/app.worktrees/fix" }], boxes)).toEqual([{ id: "w", sandbox: "tri-app-fix" }]);
  });
});

describe("parsing sbx's JSON", () => {
  test("network rules: the presets and the ones added here", () => {
    const json = JSON.stringify({
      rules: [
        { id: "default-ai-services", name: "default-ai-services", resource_type: "network", decision: "allow", resources: ["api.anthropic.com:443"], origin: "local", provenance: { created_via: "default" } },
        { id: "9f1", name: "user", resource_type: "network", decision: "deny", resources: ["evil.example"], origin: "local", provenance: { created_via: "added" } },
        { id: "fs", resource_type: "filesystem", decision: "allow", resources: ["/x"] },
      ],
    });
    expect(parseRules(json)).toEqual([
      { id: "default-ai-services", name: "default-ai-services", decision: "allow", resources: ["api.anthropic.com:443"], own: false, scope: "global" },
      { id: "9f1", name: "user", decision: "deny", resources: ["evil.example"], own: true, scope: "global" },
    ]);
  });

  test("empty lists from a fresh install", () => {
    expect(parseBoxes("[]")).toEqual([]);
    expect(parseSecrets(JSON.stringify({ secrets: [], custom_secrets: [] }))).toEqual([]);
    expect(parseBlocked(JSON.stringify({ allowed: [], blocked: [] }))).toEqual([]);
  });

  test("sandboxes and secrets, whatever their fields are called", () => {
    expect(parseBoxes(JSON.stringify([{ name: "tri-app-x", agent: "claude", status: "running", workspaces: ["C:\\app.worktrees\\x"], ports: [] }]))).toEqual([
      { name: "tri-app-x", status: "running", agent: "claude", workspace: "C:\\app.worktrees\\x", ports: "" },
    ]);
    expect(parseSecrets(JSON.stringify({ secrets: [{ scope: "(global)", service: "github", secret: "gho_****43qy" }] }))).toEqual([
      { service: "github", scope: "(global)", type: "", shown: "gho_****43qy" },
    ]);
  });

  test("a blocked host without its https port", () => {
    expect(parseBlocked(JSON.stringify({ blocked: [{ host: "bun.sh:443", count: 2, sandbox: "tri-app-x" }] }))).toEqual([
      { host: "bun.sh", count: 2, sandbox: "tri-app-x" },
    ]);
  });
});
