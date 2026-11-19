// bun test: Page Profiles (state.pageProfile and friends). A window's pages share its profile unless
// its menu is set to Each page; then a page can pick its own, keeps it while the switch is on, and
// a page opened from it starts in the same one.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  type Page, type Project, type Tab, addPage, app, pageProfile, removeProfile, setApp, setPageProfile, setProfileScope,
  setProjectProfile, setTabProfile,
} from "./state";

const space = () => ({ layout: "master", ratio: 0.55 });
const browser = (id: string, pages: Page[], extra: Partial<Tab> = {}): Tab =>
  ({ id, kind: "browser", space: 0, pages, page: pages[0].id, ...extra }) as Tab;
const project = (id: string, tabs: Tab[], profile?: string) =>
  ({ id, name: id, host: "local", path: "~", tabs, ws: 0, favs: [], profile, spaces: [space(), space(), space(), space()] }) as unknown as Project;
const p = () => app.projects[0];
const t = () => p().tabs[0];
const pg = (id: string) => t().pages!.find((x) => x.id === id)!;
const prof = (id: string) => pageProfile(p(), t(), pg(id)).id;

beforeEach(() => {
  setApp("profiles", [
    { id: "default", name: "Personal", icon: "house", color: "ocean" },
    { id: "work", name: "Work", icon: "briefcase", color: "marigold" },
    { id: "qa", name: "QA", icon: "flask-conical", color: "plum" },
  ]);
  setApp("settings", { modKey: "alt" });
  setApp("projects", [project("tri", [browser("w", [{ id: "a", url: "https://a" }, { id: "b", url: "https://b" }])], "work")]);
});

describe("pageProfile", () => {
  test("without Each page, a page's own pick is ignored", () => {
    setApp("projects", 0, "tabs", 0, "pages", 0, "profile", "qa");
    expect(prof("a")).toBe("work");
  });

  test("with Each page, a page uses its pick, else the window's", () => {
    setProfileScope("tri", "w", true);
    setPageProfile("tri", "w", "a", "qa");
    expect(prof("a")).toBe("qa");
    expect(prof("b")).toBe("work");
    setTabProfile("tri", "w", "default");
    expect(prof("b")).toBe("default");
  });

  test("turning Each page off sends every page back to the window's profile", () => {
    setProfileScope("tri", "w", true);
    setPageProfile("tri", "w", "a", "qa");
    setProfileScope("tri", "w", false);
    expect(t().profileScope).toBeUndefined();
    expect(pg("a").profile).toBeUndefined();
    expect(prof("a")).toBe("work");
  });
});

describe("pages that pick a profile", () => {
  test("a page opened from another starts in its profile", () => {
    setProfileScope("tri", "w", true);
    setPageProfile("tri", "w", "a", "qa");
    const id = addPage("tri", "w", "https://c", { opener: "a" });
    expect(prof(id)).toBe("qa");
  });

  test("without Each page, a new page carries no pick of its own", () => {
    setApp("projects", 0, "tabs", 0, "pages", 0, "profile", "qa");
    const id = addPage("tri", "w", "https://c", { opener: "a" });
    expect(pg(id).profile).toBeUndefined();
  });

  test("deleting a profile sends its pages back to the window's", () => {
    setProfileScope("tri", "w", true);
    setPageProfile("tri", "w", "a", "qa");
    removeProfile("qa");
    expect(pg("a").profile).toBeUndefined();
  });

  test("a page whose pick becomes the window's profile drops it", () => {
    setProfileScope("tri", "w", true);
    setPageProfile("tri", "w", "a", "qa");
    setTabProfile("tri", "w", "qa");
    expect(pg("a").profile).toBeUndefined();
    setPageProfile("tri", "w", "b", "default");
    setTabProfile("tri", "w", undefined);
    setProjectProfile("tri", "default");
    expect(pg("b").profile).toBeUndefined();
  });
});
