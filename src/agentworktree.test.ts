// bun test: which branch an agent's create_worktree name means (branchname.ts).

import { describe, expect, test } from "bun:test";
import { agentBranch } from "./branchname";

describe("agentBranch", () => {
  test("a new branch gets the repo's prefix and a clean name", () => {
    expect(agentBranch("Fix Sync!", [], "waldo")).toBe("waldo/fix-sync");
    expect(agentBranch("fix-sync", [])).toBe("fix-sync");
  });

  test("the prefix isn't added twice", () => {
    expect(agentBranch("waldo/fix-sync", [], "waldo/")).toBe("waldo/fix-sync");
  });

  test("a branch git already has is used as it is", () => {
    expect(agentBranch("Release/2.0", ["Release/2.0"], "waldo")).toBe("Release/2.0");
  });

  test("a name can't become an option, and nothing usable gives no branch", () => {
    expect(agentBranch("--force", [], "")).toBe("force");
    expect(agentBranch("  !!  ", [], "waldo")).toBe("");
  });
});
