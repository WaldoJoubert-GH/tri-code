// bun test: the issues panel's list rules: the Status and Source filters, the search dropdown,
// the created-date sort, and how assignees resolve to names (src/issues.ts).

import { describe, expect, test } from "bun:test";
import { type DevState, type GithubIssue, type UnifiedIssue, assigneesOf, editOf, searchIssues, shownIssues, statusStopsOf } from "./issues";

const states = [
  { id: "t", name: "Todo", color: "#fde047", group: "unstarted" },
  { id: "p", name: "In Progress", color: "#f59e0b", group: "started" },
  { id: "d", name: "Done", color: "#16a34a", group: "completed" },
];

const state = (issues: UnifiedIssue[], over: Partial<DevState> = {}): DevState => ({
  loaded: true, loading: false, connected: true, hostToken: true,
  config: { sources: ["plane", "local"], plane: { workspace_slug: "w", project_id: "p", project_identifier: "TRI" } },
  issues, states, labels: [], githubLabels: [],
  members: [{ id: "u-anna", name: "Anna K." }, { id: "u-wj", name: "Waldo Joubert" }],
  githubMembers: [], localNext: 4, timeEntries: [], syncing: false,
  ...over,
});

const plane = (id: number, title: string, st: string, created: string, who: string[] = []): UnifiedIssue => ({
  source: "plane", id: `uuid-${id}`, sequence_id: id, title, description: "", state_id: states.find((s) => s.name === st)?.id,
  state_name: st, state_group: states.find((s) => s.name === st)?.group, state_hex: "#000000", priority: "none",
  labels: [], link: "", updated_at: created, created_at: created, assignees: who,
});

const local = (n: number, title: string, st: string, created: string): UnifiedIssue => ({
  source: "local", number: n, title, state_id: st.toLowerCase(), link: "", created_at: created, updated_at: created,
});

const issues = [
  plane(1, "Old open", "Todo", "2026-04-01"),
  plane(2, "New in progress", "In Progress", "2026-04-20", ["u-anna"]),
  plane(3, "Finished", "Done", "2026-04-10", ["u-wj"]),
  local(1, "Local todo", "Todo", "2026-04-15"),
];

const view = { src: "all" as const, status: "open" as const, sort: "newest" as const, q: "" };
const titles = (list: UnifiedIssue[]) => list.map((i) => i.title);

describe("status stops", () => {
  test("Open, All, then each State name of the project's Sources, by State Group", () => {
    const stops = statusStopsOf(state(issues));
    expect(stops.map((s) => s.value)).toEqual(["open", "all", "state:Todo", "state:In Progress", "state:Done", "state:Cancelled"]);
  });
});

describe("shownIssues", () => {
  test("Open hides Done; All shows everything", () => {
    expect(titles(shownIssues(state(issues), view))).not.toContain("Finished");
    expect(titles(shownIssues(state(issues), { ...view, status: "all" }))).toContain("Finished");
  });

  test("a State name filter keeps only that State", () => {
    expect(titles(shownIssues(state(issues), { ...view, status: "state:Todo" })).sort()).toEqual(["Local todo", "Old open"]);
  });

  test("the Source filter narrows to one Source", () => {
    expect(titles(shownIssues(state(issues), { ...view, src: "local" }))).toEqual(["Local todo"]);
  });

  test("sorts by created date, newest first or oldest first", () => {
    const s = state(issues);
    expect(titles(shownIssues(s, { ...view, status: "all" }))).toEqual(["New in progress", "Local todo", "Finished", "Old open"]);
    expect(titles(shownIssues(s, { ...view, status: "all", sort: "oldest" }))).toEqual(["Old open", "Finished", "Local todo", "New in progress"]);
  });

  test("the search matches the Slug-ID, the title and assignee names", () => {
    const s = state(issues);
    expect(titles(shownIssues(s, { ...view, q: "TRI-2" }))).toEqual(["New in progress"]);
    expect(titles(shownIssues(s, { ...view, q: "anna" }))).toEqual(["New in progress"]);
    expect(titles(shownIssues(s, { ...view, q: "local todo" }))).toEqual(["Local todo"]);
  });

  test("a Source the project no longer uses is hidden", () => {
    const s = state([...issues, { ...plane(9, "Github-free", "Todo", "2026-04-02"), source: "github", number: 9, state: "open", link: "", labels: [], author: "", updated_at: "" } as UnifiedIssue]);
    expect(titles(shownIssues(s, { ...view, status: "all" }))).not.toContain("Github-free");
  });
});

describe("searchIssues", () => {
  test("the dropdown lists matches newest first, capped", () => {
    const many = Array.from({ length: 12 }, (_, k) => plane(100 + k, `Bulk ${k}`, "Todo", `2026-03-${String(k + 1).padStart(2, "0")}`));
    const hits = searchIssues(state(many), "bulk");
    expect(hits).toHaveLength(8);
    expect(hits[0].title).toBe("Bulk 11");
  });

  test("an empty query lists the newest issues", () => {
    expect(searchIssues(state(issues), "")[0].title).toBe("New in progress");
  });
});

describe("assigneesOf", () => {
  test("a Plane member id resolves to the member's name; an unknown id says so", () => {
    const people = assigneesOf(state(issues), plane(5, "x", "Todo", "2026-04-01", ["u-wj", "gone"]));
    expect(people.map((m) => m.name)).toEqual(["Waldo Joubert", "Unknown member"]);
  });

  test("a GitHub login is its own name; a local issue has no assignees", () => {
    const gh = { ...plane(6, "gh", "Todo", "2026-04-01"), source: "github", number: 6, state: "open", link: "", labels: [], author: "", assignees: ["octo"], updated_at: "" } as UnifiedIssue;
    const s = state([gh], { githubMembers: [{ id: "octo", name: "octo" }] });
    expect(assigneesOf(s, gh).map((m) => m.name)).toEqual(["octo"]);
    expect(assigneesOf(state(issues), local(1, "l", "Todo", "2026-04-01"))).toEqual([]);
  });
});

describe("the Edit form", () => {
  const issue = { ...(plane(5, "Title", "Todo", "2026-04-01", ["u-anna"]) as Extract<UnifiedIssue, { source: "plane" }>), description: "Body", labels: ["bug"] };

  test("an untouched form changes nothing", () => {
    const e = editOf(state([issue]), issue, { title: "Title", description: "Body", labels: ["bug"], assignees: ["u-anna"] });
    expect(e).toEqual({ title: undefined, description: undefined, addLabels: [], removeLabels: [], addAssignees: [], removeAssignees: [] });
  });

  test("only changed fields are sent", () => {
    const e = editOf(state([issue]), issue, { title: " New ", description: "Body", labels: ["ui"], assignees: ["u-anna", "u-wj"] });
    expect(e).toEqual({ title: "New", description: undefined, addLabels: ["ui"], removeLabels: ["bug"], addAssignees: ["u-wj"], removeAssignees: [] });
  });

  test("a GitHub issue's progress label is its State, not a Label to remove", () => {
    const gh: GithubIssue = { source: "github", number: 3, title: "T", state: "open", labels: ["bug", "in progress"], link: "", updated_at: "" };
    const e = editOf(state([gh]), gh, { title: "T", description: "", labels: [], assignees: [] });
    expect(e.removeLabels).toEqual(["bug"]);
  });
});
