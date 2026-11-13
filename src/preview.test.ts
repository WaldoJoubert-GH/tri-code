import { describe, expect, test } from "bun:test";
import { PREVIEWS, previewOn, sandboxPreview } from "./preview";
import { type Project, app, migrate, setPreview } from "./state";
import { runsInSandbox, sandboxOf } from "./sandbox";

describe("preview features", () => {
  test("are off until turned on, also in a state.json from before they existed", () => {
    expect(migrate({ settings: { monoGutter: 40 } } as never).settings.preview).toBeUndefined();
    for (const f of PREVIEWS) expect(previewOn(f.id)).toBe(false);
  });

  test("turn on and off one at a time; all off leaves nothing saved", () => {
    setPreview("sandbox", true);
    expect(sandboxPreview()).toBe(true);
    expect(app.settings.preview).toEqual({ sandbox: true });
    setPreview("sandbox", false);
    expect(sandboxPreview()).toBe(false);
    expect(app.settings.preview).toBeUndefined();
  });

  test("with Sandboxed Worktrees off, a worktree's sandbox is hidden and its claude runs on the host; on, it is back", () => {
    const wt = { id: "w", host: "local", path: "C:\\app.worktrees\\fix", parent: "r", sandbox: "tri-app-fix" } as Project;
    expect(sandboxOf(wt)).toBeUndefined();
    expect(runsInSandbox(wt, "claude")).toBe(false);
    setPreview("sandbox", true);
    expect(sandboxOf(wt)).toBe("tri-app-fix");
    expect(runsInSandbox(wt, "claude")).toBe(true);
    setPreview("sandbox", false);
  });
});
