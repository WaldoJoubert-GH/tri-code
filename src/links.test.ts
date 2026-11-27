// bun test: Linked Folders (links.ts): which root, and so which host, a path belongs to, and the
// link mutations in state.ts.

import { beforeEach, describe, expect, test } from "bun:test";
import { type Project, addLink, app, migrate, moveLink, removeLink, setApp, setLinkedFolders, updateLink } from "./shared/state/state";
import { hostAt, linkAt, linkName, linkProblem, linksOf, linksOn, relIn, rootAt, rootsOf, within } from "./links";

const space = () => ({ layout: "master", ratio: 0.55 });
const project = (id: string, host: string, path: string, extra: Partial<Project> = {}) =>
  ({ id, name: id, host, path, tabs: [], ws: 0, spaces: [space(), space(), space(), space()], ...extra }) as unknown as Project;
const p = (id: string) => app.projects.find((x) => x.id === id)!;

beforeEach(() => {
  setApp("projects", [
    project("app", "devbox", "/home/me/app", {
      links: [
        { id: "l1", name: "shared-ui", path: "/home/me/shared-ui" },
        { id: "l2", name: "brand", path: "C:/Users/me/Design/brand", local: true, readOnly: true },
      ],
    }),
    project("wt", "devbox", "/home/me/app.worktrees/fix", { parent: "app", branch: "fix" }),
  ]);
});

describe("within and relIn", () => {
  test("a folder holds itself and what is under it, not a sibling with the same start", () => {
    expect(within("/a/b", "/a/b")).toBe(true);
    expect(within("/a/b/", "/a/b/c.ts")).toBe(true);
    expect(within("/a/b", "/a/bc/d.ts")).toBe(false);
    expect(within("/", "/etc/hosts")).toBe(true);
  });

  test("Windows paths match without case and with either slash", () => {
    expect(within("C:/Users/Me", "c:\\users\\me\\x.txt")).toBe(true);
    expect(relIn("C:/Users/Me", "C:\\Users\\Me\\a\\b.txt")).toBe("a/b.txt");
  });
});

describe("rootAt", () => {
  test("the project's own files are on its host", () => {
    expect(rootAt(p("app"), "/home/me/app/src/main.ts").id).toBe("");
    expect(hostAt(p("app"), "/home/me/app/src/main.ts")).toBe("devbox");
  });

  test("a link beside the project is on the project's host; one on this machine is local", () => {
    expect(linkAt(p("app"), "/home/me/shared-ui/Button.tsx")?.name).toBe("shared-ui");
    expect(hostAt(p("app"), "/home/me/shared-ui/Button.tsx")).toBe("devbox");
    expect(hostAt(p("app"), "C:/Users/me/Design/brand/logo.svg")).toBe("local");
  });

  test("a path under no root falls back to the project", () => {
    expect(rootAt(p("app"), "/tmp/x").id).toBe("");
    expect(hostAt(p("app"), "")).toBe("devbox");
  });

  test("the deepest root wins", () => {
    setApp("projects", [project("home", "local", "/home/me", { links: [{ id: "l", name: "deep", path: "/home/me/a/b" }] })]);
    expect(linkAt(p("home"), "/home/me/a/b/c.ts")?.id).toBe("l");
    expect(linkAt(p("home"), "/home/me/a/c.ts")).toBeUndefined();
  });

  test("a Worktree shows its repo's links, on its own host", () => {
    expect(rootsOf(p("wt")).map((r) => r.name)).toEqual(["wt", "shared-ui", "brand"]);
    expect(hostAt(p("wt"), "/home/me/shared-ui/a.ts")).toBe("devbox");
  });
});

describe("linkName and linkProblem", () => {
  test("a new link is named after its folder, made unique", () => {
    expect(linkName(p("app"), "/srv/logs/")).toBe("logs");
    expect(linkName(p("app"), "/other/shared-ui")).toBe("shared-ui-2");
    expect(linkName(p("app"), "/home/me/shared-ui", "l1")).toBe("shared-ui");
  });

  test("the same folder twice, the project's own folder, or one inside it can't be linked", () => {
    expect(linkProblem(p("app"), "/home/me/shared-ui/", false)).toBe("Already linked as shared-ui");
    expect(linkProblem(p("app"), "/home/me/app", false)).toBe("That is the project's own folder");
    expect(linkProblem(p("app"), "/home/me/app/src", false)).toBe("That folder is inside the project already");
    expect(linkProblem(p("app"), "/home/me/shared-ui", false, "l1")).toBe("");
  });

  test("on this machine, the same path as a remote folder is a different folder", () => {
    expect(linkProblem(p("app"), "/home/me/app", true)).toBe("");
    expect(linkProblem(p("app"), "c:/users/me/design/brand", true)).toBe("Already linked as brand");
  });
});

describe("link mutations", () => {
  test("add, rename, reorder and unlink", () => {
    const id = addLink("app", { name: "logs", path: "/var/log/app" });
    expect(p("app").links!.map((l) => l.name)).toEqual(["shared-ui", "brand", "logs"]);
    updateLink("app", id, { name: "app-logs", noIndex: true });
    moveLink("app", id, -1);
    expect(p("app").links!.map((l) => l.name)).toEqual(["shared-ui", "app-logs", "brand"]);
    updateLink("app", "l2", { readOnly: undefined });
    expect("readOnly" in p("app").links!.find((l) => l.id === "l2")!).toBe(false);
    for (const l of [...p("app").links!]) removeLink("app", l.id);
    expect(p("app").links).toBeUndefined();
  });

  test("links survive a reload of state.json", () => {
    const back = migrate(JSON.parse(JSON.stringify({ projects: app.projects })));
    expect(back.projects[0].links?.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(back.projects[1].links).toBeUndefined();
  });
});

describe("the Linked folders setting", () => {
  test("on unless turned off; off hides the links but keeps them, and their files keep their host", () => {
    expect(linksOn()).toBe(true);
    setLinkedFolders(false);
    expect(app.settings.linkedFolders).toBe(false);
    expect(linksOf(p("app"))).toEqual([]);
    expect(rootsOf(p("app")).map((r) => r.name)).toEqual(["app"]);
    expect(p("app").links).toHaveLength(2);
    expect(hostAt(p("app"), "C:/Users/me/Design/brand/logo.svg")).toBe("local");
    setLinkedFolders(true);
    expect(app.settings.linkedFolders).toBeUndefined();
    expect(rootsOf(p("app"))).toHaveLength(3);
  });
});

describe("spreadsheets in a Linked Folder", () => {
  test("a CSV in a read-only link opens read-only in the Database Window; elsewhere it can be written", async () => {
    const { connOf } = await import("./db");
    expect(connOf(p("app"), "sheet:C:/Users/me/Design/brand/prices.csv")?.readOnly).toBe(true);
    expect(connOf(p("app"), "sheet:/home/me/shared-ui/data.csv")?.readOnly).toBeUndefined();
    expect(connOf(p("app"), "sheet:/home/me/app/report.xlsx")?.readOnly).toBe(true);
  });
});
