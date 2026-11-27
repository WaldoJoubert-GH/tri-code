// bun test: the Database Window's Connections (src/modules/db/db.ts): a spreadsheet's, read-only in a
// read-only Linked Folder.

import { beforeEach, describe, expect, test } from "bun:test";
import { type Project, app, setApp } from "../../shared/state/state";
import { connOf } from "./db";

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
  ]);
});

describe("spreadsheets in a Linked Folder", () => {
  test("a CSV in a read-only link opens read-only in the Database Window; elsewhere it can be written", () => {
    expect(connOf(p("app"), "sheet:C:/Users/me/Design/brand/prices.csv")?.readOnly).toBe(true);
    expect(connOf(p("app"), "sheet:/home/me/shared-ui/data.csv")?.readOnly).toBeUndefined();
    expect(connOf(p("app"), "sheet:/home/me/app/report.xlsx")?.readOnly).toBe(true);
  });
});
