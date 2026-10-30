// The issues panel's store: one view of a project's `.dev/` folder, the same
// files pi-todos and dev-hub read and write. A project tracks issues in any of
// three Sources: Plane, GitHub and Local, with pulled Sentry issues beside them.
// Plane, GitHub and Sentry issues live in `.dev/issues.json`; Local issues live
// in `.dev/local-issues.json`, which only tri-code writes, because they exist
// nowhere else and the other clients rewrite `issues.json` on every Plane sync.
//
// Rust owns the Plane HTTP (the webview's fetch would hit CORS) and the `gh`
// calls, and returns data; the TypeScript side writes the `.dev/` files back
// through `devfs`.

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { type Project, addTab, focusTab } from "./state";
import { flash } from "./ui";

// ── types (the shapes in .dev/) ─────────────────────────────────────

export type PlaneIssue = {
  source: "plane";
  id: string;
  sequence_id?: number;
  title: string;
  description?: string;
  state_id?: string;
  state_name?: string;
  state_group?: string;
  state_hex?: string;
  priority?: string;
  start_date?: string | null;
  target_date?: string | null;
  labels?: string[];
  /** Member ids (Plane user UUIDs); names come from `members`. */
  assignees?: string[];
  link: string;
  created_at?: string;
  updated_at: string;
};

export type GithubIssue = {
  source: "github";
  number: number;
  title: string;
  description?: string;
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned" | null;
  /** Label names; GitHub labels have no other id. */
  labels?: string[];
  author?: string;
  /** Assignees' logins, which are also their names. */
  assignees?: string[];
  link: string;
  created_at?: string;
  updated_at: string;
};

export type LocalIssue = {
  source: "local";
  number: number;
  title: string;
  description?: string;
  state_id: string;
  link: "";
  created_at: string;
  updated_at: string;
};

export type SentryIssue = {
  source: "sentry";
  sentry_id?: string;
  title: string;
  link: string;
  level?: string;
  sentry_status?: string;
  count?: number;
  culprit?: string;
  detail_file?: string;
  updated_at: string;
};

/** An issue from a Source: one the panel can change State on, time and create. */
export type TrackedIssue = PlaneIssue | GithubIssue | LocalIssue;
export type UnifiedIssue = TrackedIssue | SentryIssue;
export type Source = TrackedIssue["source"];
export const SOURCES: Source[] = ["plane", "github", "local"];
export const SOURCE_NAMES: Record<UnifiedIssue["source"], string> = { plane: "Plane", github: "GitHub", local: "Local", sentry: "Sentry" };

export type PlaneState = { id: string; name: string; color: string; group: string };
export type PlaneLabel = { id: string; name: string; color: string };
/** Someone an issue can be assigned to. `id` is what the issue carries: a Plane user id, or a GitHub login. */
export type Member = { id: string; name: string };
export type PlaneConfig = { workspace_slug: string; project_id: string; project_identifier?: string };
export type GithubConfig = { repo: string; progress_label?: string };
export type LocalConfig = { prefix?: string };
export type DevConfig = {
  /** The Sources this project uses. Missing means Plane alone if it has a plane section (before Sources). */
  sources?: Source[];
  plane?: PlaneConfig;
  github?: GithubConfig;
  local?: LocalConfig;
} & Record<string, unknown>;
export type TimeEntry = { issue_id: string; sequence_id: number; title: string; started_at: string; stopped_at: string | null };
export type CommentImage = { name: string; src: string };
export type PlaneComment = { id: string; author: string; created_at: string; text: string; html: string; images: CommentImage[] };

export type PlaneSync = {
  last_synced: string;
  project_identifier?: string;
  issues: PlaneIssue[];
  states: PlaneState[];
  labels: PlaneLabel[];
  members: Member[];
};
export type GithubSync = { issues: GithubIssue[]; labels: PlaneLabel[] };

export type CreatedIssue = { id: string; sequence_id?: number; title: string; priority: string; link: string; created_at: string };

/** What the New Issue modal collects. `labels` are Label ids (Plane) or names (GitHub); `assignees` are member ids (Plane) or logins (GitHub). */
export type NewIssue = { title: string; description: string; labels: string[]; assignees: string[] };

export type DevState = {
  loaded: boolean;
  loading: boolean;
  /** At least one Source is set up; false shows the setup form. */
  connected: boolean;
  /** The project's host has `~/.pi/agent/secrets/plane.json`. */
  hostToken: boolean;
  config: DevConfig;
  issues: UnifiedIssue[];
  states: PlaneState[];
  labels: PlaneLabel[];
  githubLabels: PlaneLabel[];
  /** Plane project members, for assignee names and the New Issue picker. */
  members: Member[];
  /** The repo's assignable logins. */
  githubMembers: Member[];
  /** The next Local issue number. */
  localNext: number;
  timeEntries: TimeEntry[];
  lastSynced?: string;
  syncing: boolean;
  error?: string;
};

// ── .dev/ constants ─────────────────────────────────────────────────

/** Any State Group except these two counts as active (pi-todos' ACTIVE_GROUPS). */
export const ACTIVE_GROUPS = new Set(["backlog", "unstarted", "started", "triage"]);
export const GROUP_ORDER: Record<string, number> = { backlog: 0, unstarted: 1, started: 2, triage: 3, completed: 4, cancelled: 5 };
export const PRIORITY_COLORS: Record<string, string> = {
  urgent: "#EF4444", high: "#F59E0B", medium: "#EAB308", low: "#3B82F6", none: "#9CA3AF",
};
export const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
export const LEVEL_COLORS: Record<string, string> = { fatal: "#b91c1c", error: "#EF4444", warning: "#F59E0B", info: "#3B82F6" };
const LEVEL_ORDER = ["fatal", "error", "warning", "info"];
const AVATAR_COLORS = ["#7aa2f7", "#f7768e", "#9ece6a", "#bb9af7", "#ff9e64", "#73daca"];

/** GitHub's open/closed and close reason, plus "In Progress" as a label, as States. */
export const GITHUB_STATES: PlaneState[] = [
  { id: "open", name: "Open", color: "#1a7f37", group: "unstarted" },
  { id: "progress", name: "In Progress", color: "#bf8700", group: "started" },
  { id: "closed", name: "Closed", color: "#8250df", group: "completed" },
  { id: "not_planned", name: "Not planned", color: "#6e7781", group: "cancelled" },
];
export const LOCAL_STATES: PlaneState[] = [
  { id: "todo", name: "Todo", color: "#6b7080", group: "unstarted" },
  { id: "progress", name: "In Progress", color: "#f59e0b", group: "started" },
  { id: "done", name: "Done", color: "#16a34a", group: "completed" },
  { id: "cancelled", name: "Cancelled", color: "#9ca3af", group: "cancelled" },
];
export const DEFAULT_PROGRESS_LABEL = "in progress";

// ── pure helpers ────────────────────────────────────────────────────

/** The Sources a project uses, in a fixed order. */
export function sourcesOf(config: DevConfig | undefined): Source[] {
  if (!config) return [];
  const listed = config.sources ?? (config.plane ? ["plane"] : []);
  return SOURCES.filter((s) =>
    listed.includes(s) &&
    (s === "plane" ? !!(config.plane?.workspace_slug && config.plane?.project_id) : s === "github" ? !!config.github?.repo : true));
}

export const progressLabel = (state: DevState | undefined) => state?.config.github?.progress_label || DEFAULT_PROGRESS_LABEL;

/** `TRI-12` (Plane), `#231` (GitHub), `L-3` or `3` (Local, by its prefix), `S-4412` (Sentry). */
export function slugOf(state: DevState | undefined, issue: UnifiedIssue): string {
  if (issue.source === "sentry") return `S-${issue.sentry_id ?? "?"}`;
  if (issue.source === "github") return `#${issue.number}`;
  if (issue.source === "local") {
    const prefix = state?.config.local?.prefix?.trim();
    return prefix ? `${prefix}-${issue.number}` : String(issue.number);
  }
  const ident = state?.config?.plane?.project_identifier;
  return ident ? `${ident}-${issue.sequence_id ?? "?"}` : `#${issue.sequence_id ?? "?"}`;
}

/** The States an issue from `source` can be in. */
export function statesFor(state: DevState | undefined, source: Source): PlaneState[] {
  return source === "plane" ? state?.states ?? [] : source === "github" ? GITHUB_STATES : LOCAL_STATES;
}

function stateIdOf(state: DevState | undefined, issue: TrackedIssue): string | undefined {
  if (issue.source !== "github") return issue.state_id;
  if (issue.state === "closed") return issue.state_reason === "not_planned" ? "not_planned" : "closed";
  return (issue.labels ?? []).includes(progressLabel(state)) ? "progress" : "open";
}

export function stateOf(state: DevState | undefined, issue: TrackedIssue): PlaneState | undefined {
  const id = stateIdOf(state, issue);
  return statesFor(state, issue.source).find((s) => s.id === id);
}

/** Stable selection and Time Entry key: the Plane UUID, `gh<n>`, `lo<n>` or `se<sentry_id>`. */
export function issueKey(issue: UnifiedIssue): string {
  switch (issue.source) {
    case "plane": return issue.id;
    case "github": return `gh${issue.number}`;
    case "local": return `lo${issue.number}`;
    case "sentry": return `se${issue.sentry_id ?? ""}`;
  }
}

/** The Labels an issue from `source` can carry. Local issues have none. */
export function labelsFor(state: DevState | undefined, source: Source): PlaneLabel[] {
  if (source === "plane") return state?.labels ?? [];
  if (source === "github") return (state?.githubLabels ?? []).filter((l) => l.id !== progressLabel(state));
  return [];
}

export function labelOf(state: DevState | undefined, source: Source, id: string): PlaneLabel | undefined {
  return labelsFor(state, source).find((l) => l.id === id);
}

/** The Label ids shown on an issue: GitHub's progress label is its State, so it's left out. */
export function issueLabels(state: DevState | undefined, issue: TrackedIssue): string[] {
  if (issue.source === "local") return [];
  const ids = issue.labels ?? [];
  return issue.source === "github" ? ids.filter((l) => l !== progressLabel(state)) : ids;
}

export function isActive(state: DevState | undefined, issue: UnifiedIssue): boolean {
  if (issue.source === "sentry") return issue.sentry_status !== "resolved";
  const fallback = issue.source === "plane" ? issue.state_group : undefined;
  return ACTIVE_GROUPS.has(stateOf(state, issue)?.group ?? fallback ?? "");
}

/** Black or white text for a State Hex, by relative luminance. */
export function fgFor(hex: string): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return "#fff";
  const n = parseInt(raw, 16);
  if (Number.isNaN(n)) return "#fff";
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.5 ? "#000" : "#fff";
}

/** Priority → state group → title, Sentry after the Sources. */
export function sortIssues(state: DevState | undefined, issues: UnifiedIssue[]): UnifiedIssue[] {
  const key = (i: UnifiedIssue): [number, number, number, string] =>
    i.source === "sentry"
      ? [1, Math.max(0, LEVEL_ORDER.indexOf(i.level ?? "error")), 0, i.title]
      : [0, priorityRank(i.source === "plane" ? i.priority : undefined), GROUP_ORDER[stateOf(state, i)?.group ?? ""] ?? 9, i.title];
  return [...issues].sort((a, b) => {
    const x = key(a), y = key(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3].localeCompare(y[3]);
  });
}

export type SourceFilter = "all" | UnifiedIssue["source"];
/** The Status filter: Open (not Done or Cancelled), All, or one State name (`state:<name>`). */
export type StatusFilter = "open" | "all" | `state:${string}`;
export type SortOrder = "newest" | "oldest";
export type View = { src: SourceFilter; status: StatusFilter; sort: SortOrder; q: string };

/** The source filter's stops: All, each of the project's Sources, Sentry. */
export function filtersOf(state: DevState | undefined): SourceFilter[] {
  return ["all", ...sourcesOf(state?.config), "sentry"];
}

/** The Status filter's stops: Open, All, then each State name of the project's Sources, in State Group order. */
export function statusStopsOf(state: DevState | undefined): { value: StatusFilter; label: string }[] {
  const names = new Map<string, PlaneState>();
  for (const source of sourcesOf(state?.config)) {
    for (const s of statesFor(state, source)) if (!names.has(s.name)) names.set(s.name, s);
  }
  const byGroup = [...names.values()].sort((a, b) => (GROUP_ORDER[a.group] ?? 9) - (GROUP_ORDER[b.group] ?? 9));
  return [
    { value: "open", label: "Open" },
    { value: "all", label: "All" },
    ...byGroup.map((s) => ({ value: `state:${s.name}` as StatusFilter, label: s.name })),
  ];
}

function matchesStatus(state: DevState | undefined, issue: UnifiedIssue, status: StatusFilter): boolean {
  if (status === "all") return true;
  if (status === "open") return isActive(state, issue);
  return issue.source !== "sentry" && stateOf(state, issue)?.name === status.slice("state:".length);
}

/** Slug-ID, title, label names and assignee names: what the search box matches. */
function matchesQuery(state: DevState | undefined, issue: UnifiedIssue, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (issue.source === "sentry") return `${slugOf(state, issue)} ${issue.title}`.toLowerCase().includes(q);
  const labels = issueLabels(state, issue).map((id) => labelOf(state, issue.source, id)?.name ?? "");
  const people = assigneesOf(state, issue).map((m) => m.name);
  return `${slugOf(state, issue)} ${issue.title} ${labels.join(" ")} ${people.join(" ")}`.toLowerCase().includes(q);
}

/** Tracked issues by created date (newest or oldest first), then Sentry by level. */
export function sortForList(state: DevState | undefined, issues: UnifiedIssue[], order: SortOrder): UnifiedIssue[] {
  const dir = order === "newest" ? -1 : 1;
  const tracked = issues
    .filter((i): i is TrackedIssue => i.source !== "sentry")
    .sort((a, b) => dir * (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.title.localeCompare(b.title));
  return [...tracked, ...sortIssues(state, issues.filter((i) => i.source === "sentry"))];
}

/** The rows the list shows: the Source filter, the Status filter, and the search, sorted by created date. */
export function shownIssues(state: DevState | undefined, view: View): UnifiedIssue[] {
  const on = sourcesOf(state?.config);
  const issues = (state?.issues ?? []).filter(
    (i) =>
      (i.source === "sentry" || on.includes(i.source)) &&
      (view.src === "all" || i.source === view.src) &&
      matchesStatus(state, i, view.status) &&
      matchesQuery(state, i, view.q),
  );
  return sortForList(state, issues, view.sort);
}

/** The search dropdown's matches: any issue from the project's Sources, newest first. */
export function searchIssues(state: DevState | undefined, query: string, limit = 8): UnifiedIssue[] {
  const on = sourcesOf(state?.config);
  const issues = (state?.issues ?? []).filter((i) => (i.source === "sentry" || on.includes(i.source)) && matchesQuery(state, i, query));
  return sortForList(state, issues, "newest").slice(0, limit);
}

/** The people an issue from `source` can be assigned to. Local issues have no account to assign. */
export function membersFor(state: DevState | undefined, source: Source): Member[] {
  return source === "plane" ? state?.members ?? [] : source === "github" ? state?.githubMembers ?? [] : [];
}

/** The assignees on an issue, by name: a Plane member id resolves through the members; a GitHub login is its own name. */
export function assigneesOf(state: DevState | undefined, issue: UnifiedIssue): Member[] {
  if (issue.source === "sentry" || issue.source === "local") return [];
  const pool = membersFor(state, issue.source);
  return (issue.assignees ?? []).map((id) => pool.find((m) => m.id === id) ?? { id, name: issue.source === "plane" ? "Unknown member" : id });
}

export function priorityRank(p?: string): number {
  return PRIORITY_ORDER[p ?? "none"] ?? 4;
}

export function formatHms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? `${h}h ` : "") + (h || m ? `${m}m ` : "") + `${s % 60}s`;
}

export function formatHm(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return (m >= 60 ? `${Math.floor(m / 60)}h ` : "") + `${m % 60}m`;
}

export function formatDay(iso?: string | null): string {
  return iso ? new Date(`${iso}T00:00`).toLocaleDateString("en", { month: "short", day: "numeric" }) : "—";
}

export function ago(ts?: number | string): string {
  const t = typeof ts === "string" ? Date.parse(ts) : ts;
  if (!t || Number.isNaN(t)) return "—";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

export function initials(name: string): string {
  return name.split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase();
}

export function avatarColor(name: string): string {
  if (name === "You") return "var(--accent)";
  const n = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── store ───────────────────────────────────────────────────────────

const empty = (): DevState => ({
  loaded: false, loading: false, connected: false, hostToken: false,
  config: {}, issues: [], states: [], labels: [], githubLabels: [], members: [], githubMembers: [], localNext: 1, timeEntries: [], syncing: false,
});

export const [dev, setDev] = createStore<Record<string, DevState>>({});
export const devOf = (projectId: string): DevState | undefined => dev[projectId];

/** Comment drafts keyed by `projectId/issueKey`, so they survive repaints. */
export const [drafts, setDrafts] = createStore<Record<string, { text: string; images: CommentImage[] }>>({});
const draftKey = (projectId: string, issueId: string) => `${projectId}/${issueId}`;
export const getDraft = (projectId: string, issueId: string) =>
  drafts[draftKey(projectId, issueId)] ?? { text: "", images: [] as CommentImage[] };
export function setDraftText(projectId: string, issueId: string, text: string): void {
  setDrafts(produce((s) => { (s[draftKey(projectId, issueId)] ??= { text: "", images: [] }).text = text; }));
}
export function addDraftImage(projectId: string, issueId: string, image: CommentImage): void {
  setDrafts(produce((s) => { (s[draftKey(projectId, issueId)] ??= { text: "", images: [] }).images.push(image); }));
}
export function removeDraftImage(projectId: string, issueId: string, index: number): void {
  setDrafts(produce((s) => {
    const d = (s[draftKey(projectId, issueId)] ??= { text: "", images: [] });
    d.images.splice(index, 1);
  }));
}
export function clearDraft(projectId: string, issueId: string): void {
  setDrafts(produce((s) => { delete s[draftKey(projectId, issueId)]; }));
}

/** Comments keyed by `projectId/issueKey`. */
export const [comments, setComments] = createStore<Record<string, PlaneComment[]>>({});
export const commentsOf = (projectId: string, issueId: string) => comments[`${projectId}/${issueId}`];

/** State changes still in flight, keyed `projectId/issueKey`, to the State id asked for. */
export const [stateChanges, setStateChanges] = createStore<Record<string, string>>({});
const changeKey = (projectId: string, issue: TrackedIssue) => `${projectId}/${issueKey(issue)}`;
/** The State `issue` is being moved to, while the change is in flight. */
export function changingTo(projectId: string, issue: TrackedIssue): PlaneState | undefined {
  const id = stateChanges[changeKey(projectId, issue)];
  return id ? statesFor(dev[projectId], issue.source).find((s) => s.id === id) : undefined;
}

/** One shared 1s clock for the running timer and "synced Xm ago". */
export const [clock, setClock] = createSignal(Date.now());
let clockStarted = false;
export function startClock() {
  if (clockStarted) return;
  clockStarted = true;
  setInterval(() => setClock(Date.now()), 1000);
}

/** The issue the toolbar or sidebar asked the panel to open; cleared by the panel. */
export const [pendingIssue, setPendingIssue] = createSignal<{ projectId: string; issueId: string } | null>(null);

/** Focus the project's issues panel (opening one if needed) and drill into `issueId`. */
export function openIssuePanel(project: Project, issueId?: string): void {
  const existing = project.tabs.find((t) => t.kind === "issues");
  const id = existing?.id ?? addTab(project.id, "issues");
  focusTab(project.id, id);
  setPendingIssue(issueId ? { projectId: project.id, issueId } : null);
}

/** What the panel's title calls the project: the Plane identifier, the GitHub repo name, or the project name. */
function trackerName(project: Project, d: DevState): string {
  const s = sourcesOf(d.config);
  if (s.length === 1 && s[0] === "plane") return d.config.plane?.project_identifier ?? project.name;
  if (s.length === 1 && s[0] === "github") return d.config.github?.repo.split("/").pop() ?? project.name;
  return project.name;
}

/** The window title for an issues panel: name, active count and sync age. */
export function panelTitle(project: Project): string {
  const d = dev[project.id];
  if (!d) return "not connected";
  if (!d.connected) return `${project.name} · choose issue sources`;
  const on = sourcesOf(d.config);
  const n = d.issues.filter((i) => i.source !== "sentry" && on.includes(i.source) && isActive(d, i)).length;
  const via = project.host !== "local" ? ` via ${project.host}` : "";
  const remote = on.some((s) => s !== "local");
  const synced = !remote ? "" : d.syncing ? " · syncing…" : ` · synced ${ago(d.lastSynced)}`;
  return `${trackerName(project, d)} · ${n} active${synced}${via}`;
}

/** The project's "In Progress" issues: the running one first, then by priority. */
export function inProgress(projectId: string): TrackedIssue[] {
  const d = dev[projectId];
  if (!d) return [];
  const running = runningEntry(projectId)?.issue_id;
  const on = sourcesOf(d.config);
  const prio = (i: TrackedIssue) => priorityRank(i.source === "plane" ? i.priority : undefined);
  return d.issues
    .filter((i): i is TrackedIssue => i.source !== "sentry" && on.includes(i.source) && stateOf(d, i)?.name === "In Progress")
    .sort((a, b) => Number(issueKey(b) === running) - Number(issueKey(a) === running) || prio(a) - prio(b));
}

// ── .dev/ file plumbing ─────────────────────────────────────────────

const join = (root: string, rel: string) => `${root.replace(/[\\/]+$/, "")}/.dev/${rel}`;
const secretsFile = "~/.pi/agent/secrets/plane.json";

const readFile = (project: Project, path: string) =>
  invoke<string | null>("dev_read", { host: project.host, path });
const writeFile = (project: Project, path: string, contents: string) =>
  invoke("dev_write", { host: project.host, path, contents });
const devRead = (project: Project, rel: string) => readFile(project, join(project.path, rel));
const devWrite = (project: Project, rel: string, contents: string) =>
  writeFile(project, join(project.path, rel), contents);
const parse = <T,>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const planeOf = (projectId: string) => dev[projectId]?.config?.plane;
const githubOf = (projectId: string) => dev[projectId]?.config?.github;

/** Read and parse the whole `.dev/` folder. This is a read only; a sync is a separate call. */
export async function loadDev(project: Project): Promise<void> {
  const current = dev[project.id];
  if (current?.loading) return;
  setDev(project.id, { ...(current ?? empty()), loading: true, error: undefined });
  try {
    const [configRaw, issuesRaw, statesRaw, labelsRaw, timeRaw, localRaw, ghLabelsRaw, membersRaw, ghMembersRaw] = await Promise.all([
      devRead(project, "config.json"),
      devRead(project, "issues.json"),
      devRead(project, "plane-states.json"),
      devRead(project, "plane-labels.json"),
      devRead(project, "time-entries.json"),
      devRead(project, "local-issues.json"),
      devRead(project, "github-labels.json"),
      devRead(project, "plane-members.json"),
      devRead(project, "github-members.json"),
    ]);
    const config = parse<DevConfig>(configRaw, {});
    const plane = config.plane;
    const issuesFile = parse<{ last_synced?: string; issues?: UnifiedIssue[] }>(issuesRaw, {});
    const statesFile = parse<{ states?: PlaneState[] }>(statesRaw, {});
    const labelsFile = parse<{ labels?: PlaneLabel[] }>(labelsRaw, {});
    const timeFile = parse<{ entries?: TimeEntry[] }>(timeRaw, {});
    const localFile = parse<{ next?: number; issues?: LocalIssue[] }>(localRaw, {});
    const ghLabelsFile = parse<{ labels?: PlaneLabel[] }>(ghLabelsRaw, {});
    const membersFile = parse<{ members?: Member[] }>(membersRaw, {});
    const ghMembersFile = parse<{ members?: Member[] }>(ghMembersRaw, {});
    const local = localFile.issues ?? [];
    setDev(project.id, {
      loaded: true, loading: false,
      config,
      connected: sourcesOf(config).length > 0,
      issues: [...(issuesFile.issues ?? []).filter((i) => i.source !== "local"), ...local],
      lastSynced: issuesFile.last_synced,
      states: statesFile.states ?? [],
      labels: labelsFile.labels ?? [],
      githubLabels: ghLabelsFile.labels ?? [],
      members: membersFile.members ?? [],
      githubMembers: ghMembersFile.members ?? [],
      localNext: localFile.next ?? Math.max(0, ...local.map((i) => i.number)) + 1,
      timeEntries: timeFile.entries ?? [],
    });
    if (sourcesOf(config).includes("plane") && plane) {
      invoke<boolean>("plane_check_token", { host: project.host })
        .then((ok) => setDev(project.id, "hostToken", ok))
        .catch(() => {});
    }
  } catch (e) {
    setDev(project.id, { ...(dev[project.id] ?? empty()), loaded: true, loading: false, error: String(e) });
  }
}

/** Write the list back: Local issues to their own file, everything else to `issues.json`. */
async function persistIssues(project: Project, issues: UnifiedIssue[], touched: "shared" | "local" | "both" = "shared"): Promise<void> {
  const d = dev[project.id];
  const writes: Promise<unknown>[] = [];
  if (touched !== "local") {
    writes.push(devWrite(project, "issues.json", JSON.stringify({ last_synced: d?.lastSynced, issues: issues.filter((i) => i.source !== "local") }, null, 2)));
  }
  if (touched !== "shared") {
    const local = issues.filter((i): i is LocalIssue => i.source === "local");
    writes.push(devWrite(project, "local-issues.json", JSON.stringify({ next: d?.localNext ?? 1, issues: local }, null, 2)));
  }
  await Promise.all(writes);
  setDev(project.id, "issues", issues);
}

/** Replace one Source's issues in the list, keeping every other Source's. */
const replaceSource = (issues: UnifiedIssue[], source: Source, next: UnifiedIssue[]) =>
  [...next, ...issues.filter((i) => i.source !== source)];

async function syncPlane(project: Project, plane: PlaneConfig): Promise<number> {
  const res = await invoke<PlaneSync>("plane_sync", {
    host: project.host,
    workspaceSlug: plane.workspace_slug,
    projectId: plane.project_id,
  });
  const current = dev[project.id];
  const issues = replaceSource(current?.issues ?? [], "plane", res.issues);
  await Promise.all([
    devWrite(project, "issues.json", JSON.stringify({ last_synced: res.last_synced, issues: issues.filter((i) => i.source !== "local") }, null, 2)),
    devWrite(project, "plane-states.json", JSON.stringify({ last_fetched: res.last_synced, states: res.states }, null, 2)),
    devWrite(project, "plane-labels.json", JSON.stringify({ last_fetched: res.last_synced, labels: res.labels }, null, 2)),
    devWrite(project, "plane-members.json", JSON.stringify({ last_fetched: res.last_synced, members: res.members }, null, 2)),
  ]);
  setDev(project.id, { issues, states: res.states, labels: res.labels, members: res.members, lastSynced: res.last_synced });
  // Fill in the project identifier the first time we see it.
  if (res.project_identifier && !plane.project_identifier) {
    const config: DevConfig = { ...(current?.config ?? {}), plane: { ...plane, project_identifier: res.project_identifier } };
    await devWrite(project, "config.json", JSON.stringify(config, null, 2));
    setDev(project.id, "config", config);
  }
  return res.issues.length;
}

async function syncGithub(project: Project, github: GithubConfig): Promise<number> {
  const res = await invoke<GithubSync>("gh_issues_sync", { host: project.host, path: project.path, repo: github.repo });
  // Who can be assigned: a failed read keeps the last list rather than failing the sync.
  const logins = await invoke<string[]>("gh_assignees", { host: project.host, path: project.path, repo: github.repo }).catch(() => null);
  const now = new Date().toISOString();
  const members: Member[] = logins ? logins.map((login) => ({ id: login, name: login })) : dev[project.id]?.githubMembers ?? [];
  const issues = replaceSource(dev[project.id]?.issues ?? [], "github", res.issues);
  await Promise.all([
    devWrite(project, "issues.json", JSON.stringify({ last_synced: now, issues: issues.filter((i) => i.source !== "local") }, null, 2)),
    devWrite(project, "github-labels.json", JSON.stringify({ last_fetched: now, labels: res.labels }, null, 2)),
    devWrite(project, "github-members.json", JSON.stringify({ last_fetched: now, members }, null, 2)),
  ]);
  setDev(project.id, { issues, githubLabels: res.labels, githubMembers: members, lastSynced: now });
  return res.issues.length;
}

/** Pull each remote Source in turn (they share `issues.json`, so never at once). */
export async function syncDev(project: Project, quiet = false): Promise<void> {
  const current = dev[project.id];
  const sources = sourcesOf(current?.config).filter((s) => s !== "local");
  if (!sources.length || current?.syncing) return;
  setDev(project.id, "syncing", true);
  const done: string[] = [];
  const failed: string[] = [];
  for (const source of sources) {
    try {
      const plane = planeOf(project.id), github = githubOf(project.id);
      const n = source === "plane" && plane ? await syncPlane(project, plane) : source === "github" && github ? await syncGithub(project, github) : 0;
      done.push(`${n} ${SOURCE_NAMES[source]}`);
    } catch (e) {
      failed.push(`${SOURCE_NAMES[source]}: ${e}`);
    }
  }
  setDev(project.id, { syncing: false, error: failed.length ? failed.join(" · ") : undefined });
  if (failed.length) flash(`sync failed · ${failed.join(" · ")}`);
  else if (!quiet) flash(`synced ${done.join(" + ")} issues · wrote .dev/issues.json`);
}

/** A manual sync, matching the `r` binding. */
export const syncNow = (project: Project) => syncDev(project, false);

// ── mutations ───────────────────────────────────────────────────────

const planeArgs = (project: Project) => {
  const plane = planeOf(project.id);
  if (!plane) throw new Error("this project is not connected to Plane");
  return { host: project.host, workspaceSlug: plane.workspace_slug, projectId: plane.project_id };
};

const ghArgs = (project: Project) => {
  const github = githubOf(project.id);
  if (!github) throw new Error("this project is not connected to GitHub");
  return { host: project.host, path: project.path, repo: github.repo };
};

/** Swap one issue in the list for `next`, matched by key. */
const swap = (projectId: string, next: TrackedIssue) =>
  (dev[projectId]?.issues ?? []).map((i) => (issueKey(i) === issueKey(next) ? next : i));

const touchedBy = (issue: TrackedIssue) => (issue.source === "local" ? "local" : "shared");

export async function setIssueState(project: Project, issue: TrackedIssue, stateId: string): Promise<void> {
  const key = changeKey(project.id, issue);
  if (stateChanges[key]) return void flash(`${slugOf(dev[project.id], issue)} is still changing state`);
  setStateChanges(key, stateId);
  try {
    await changeState(project, issue, stateId);
  } finally {
    setStateChanges(produce((s) => { delete s[key]; }));
  }
}

async function changeState(project: Project, issue: TrackedIssue, stateId: string): Promise<void> {
  const d = dev[project.id];
  const state = statesFor(d, issue.source).find((s) => s.id === stateId);
  let next: TrackedIssue;
  try {
    if (issue.source === "plane") {
      await invoke("plane_set_state", { ...planeArgs(project), issueId: issue.id, stateId });
      next = { ...issue, state_id: stateId, state_name: state?.name, state_group: state?.group, state_hex: state?.color };
    } else if (issue.source === "github") {
      const label = progressLabel(d);
      const had = (issue.labels ?? []).includes(label);
      await invoke("gh_issue_set_state", {
        ...ghArgs(project), number: issue.number, state: stateId, progressLabel: label, wasClosed: issue.state === "closed", hadLabel: had,
      });
      const others = (issue.labels ?? []).filter((l) => l !== label);
      next = {
        ...issue,
        state: stateId === "open" || stateId === "progress" ? "open" : "closed",
        state_reason: stateId === "closed" ? "completed" : stateId === "not_planned" ? "not_planned" : null,
        labels: stateId === "progress" ? [...others, label] : others,
      };
    } else {
      next = { ...issue, state_id: stateId, updated_at: new Date().toISOString() };
    }
  } catch (e) {
    flash(`state change failed: ${e}`);
    return;
  }
  await persistIssues(project, swap(project.id, next), touchedBy(issue));
  const sent = issue.source === "plane" ? " · PATCH sent to Plane" : issue.source === "github" ? " · gh issue updated" : "";
  flash(`${slugOf(d, issue)} → ${state?.name ?? "state"}${sent}`);
}

export async function toggleLabel(project: Project, issue: TrackedIssue, labelId: string): Promise<void> {
  if (issue.source === "local") return;
  const d = dev[project.id];
  const labels = issue.labels ?? [];
  const on = labels.includes(labelId);
  const next = on ? labels.filter((l) => l !== labelId) : [...labels, labelId];
  const name = labelOf(d, issue.source, labelId)?.name ?? "label";
  try {
    if (issue.source === "plane") await invoke("plane_set_labels", { ...planeArgs(project), issueId: issue.id, labels: next });
    else await invoke("gh_issue_labels", { ...ghArgs(project), number: issue.number, add: on ? [] : [labelId], remove: on ? [labelId] : [] });
  } catch (e) {
    flash(`label change failed: ${e}`);
    return;
  }
  await persistIssues(project, swap(project.id, { ...issue, labels: next } as TrackedIssue));
  flash(`${slugOf(d, issue)} ${on ? "−" : "+"}${name} · ${issue.source === "plane" ? "PATCH sent to Plane" : "gh issue edit"}`);
}

/** Default Plane State for a new issue: "Todo", else first unstarted, else first backlog. */
export function defaultStateId(projectId: string): string | undefined {
  const states = dev[projectId]?.states ?? [];
  return (
    states.find((s) => s.name.toLowerCase() === "todo")?.id ??
    states.find((s) => s.group === "unstarted")?.id ??
    states.find((s) => s.group === "backlog")?.id
  );
}

/** Create an issue in `source` from the New Issue modal. Local issues take no tags or assignees. */
export async function createIssue(project: Project, draft: NewIssue, source: Source): Promise<TrackedIssue | undefined> {
  const d = dev[project.id];
  const title = draft.title.trim();
  const description = draft.description.trim();
  const labels = source === "local" ? [] : draft.labels;
  const assignees = source === "local" ? [] : draft.assignees;
  let issue: TrackedIssue;
  try {
    if (source === "plane") {
      const stateId = defaultStateId(project.id);
      const created = await invoke<CreatedIssue>("plane_create_issue", {
        ...planeArgs(project),
        title,
        stateId: stateId ?? null,
        descriptionHtml: description ? `<p>${escapeHtml(description).replace(/\n/g, "<br>")}</p>` : null,
        labels,
        assignees,
      });
      const state = d?.states.find((s) => s.id === stateId);
      issue = {
        source: "plane",
        id: created.id,
        sequence_id: created.sequence_id,
        title: created.title,
        description,
        state_id: state?.id,
        state_name: state?.name,
        state_group: state?.group,
        state_hex: state?.color,
        priority: created.priority,
        link: created.link,
        labels,
        assignees,
        created_at: created.created_at,
        updated_at: new Date().toISOString(),
      };
    } else if (source === "github") {
      issue = await invoke<GithubIssue>("gh_issue_create", { ...ghArgs(project), title, body: description, labels, assignees });
    } else {
      const now = new Date().toISOString();
      const number = d?.localNext ?? 1;
      issue = { source: "local", number, title, description, state_id: "todo", link: "", created_at: now, updated_at: now };
      setDev(project.id, "localNext", number + 1);
    }
  } catch (e) {
    flash(`create failed: ${e}`);
    return undefined;
  }
  await persistIssues(project, [...(dev[project.id]?.issues ?? []), issue], touchedBy(issue));
  flash(`created ${slugOf(dev[project.id], issue)}${source === "local" ? " in .dev/local-issues.json" : ` in ${SOURCE_NAMES[source]}`}`);
  return issue;
}

/** What the Edit form starts from: the issue's title, description, shown Labels and assignees. */
export function draftOf(state: DevState | undefined, issue: TrackedIssue): NewIssue {
  return {
    title: issue.title,
    description: issue.description ?? "",
    labels: issueLabels(state, issue),
    assignees: issue.source === "local" ? [] : issue.assignees ?? [],
  };
}

export type IssueEdit = {
  title?: string;
  description?: string;
  addLabels: string[];
  removeLabels: string[];
  addAssignees: string[];
  removeAssignees: string[];
};

/** What the Edit form changed. Only changed fields are sent, so an untouched Plane description keeps its formatting. */
export function editOf(state: DevState | undefined, issue: TrackedIssue, draft: NewIssue): IssueEdit {
  const was = draftOf(state, issue);
  const title = draft.title.trim();
  const description = draft.description.trim();
  const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  return {
    title: title && title !== was.title ? title : undefined,
    description: description !== was.description.trim() ? description : undefined,
    addLabels: minus(draft.labels, was.labels),
    removeLabels: minus(was.labels, draft.labels),
    addAssignees: minus(draft.assignees, was.assignees),
    removeAssignees: minus(was.assignees, draft.assignees),
  };
}

const isEmptyEdit = (e: IssueEdit) =>
  e.title === undefined && e.description === undefined &&
  !e.addLabels.length && !e.removeLabels.length && !e.addAssignees.length && !e.removeAssignees.length;

/** Save the Edit form to the issue's Source, then to `.dev/`. Returns false if it failed. */
export async function updateIssue(project: Project, issue: TrackedIssue, draft: NewIssue): Promise<boolean> {
  const d = dev[project.id];
  const edit = editOf(d, issue, draft);
  if (isEmptyEdit(edit)) return true;
  const now = new Date().toISOString();
  let next: TrackedIssue = {
    ...issue,
    title: edit.title ?? issue.title,
    description: edit.description ?? issue.description,
    updated_at: now,
  };
  try {
    if (issue.source === "plane") {
      const labels = edit.addLabels.length || edit.removeLabels.length ? draft.labels : undefined;
      const assignees = edit.addAssignees.length || edit.removeAssignees.length ? draft.assignees : undefined;
      await invoke("plane_update_issue", {
        ...planeArgs(project),
        issueId: issue.id,
        title: edit.title ?? null,
        descriptionHtml: edit.description === undefined ? null : edit.description ? `<p>${escapeHtml(edit.description).replace(/\n/g, "<br>")}</p>` : "",
        labels: labels ?? null,
        assignees: assignees ?? null,
      });
      next = { ...(next as PlaneIssue), labels: labels ?? issue.labels, assignees: assignees ?? issue.assignees };
    } else if (issue.source === "github") {
      await invoke("gh_issue_edit", {
        ...ghArgs(project),
        number: issue.number,
        title: edit.title ?? null,
        body: edit.description ?? null,
        addLabels: edit.addLabels,
        removeLabels: edit.removeLabels,
        addAssignees: edit.addAssignees,
        removeAssignees: edit.removeAssignees,
      });
      // The progress label is the State, not a shown Label, so it stays whatever it was.
      const progress = (issue.labels ?? []).filter((l) => l === progressLabel(d));
      next = { ...(next as GithubIssue), labels: [...draft.labels, ...progress], assignees: draft.assignees };
    }
  } catch (e) {
    flash(`edit failed: ${e}`);
    return false;
  }
  await persistIssues(project, swap(project.id, next), touchedBy(issue));
  const sent = issue.source === "plane" ? " · PATCH sent to Plane" : issue.source === "github" ? " · gh issue edit" : " in .dev/local-issues.json";
  flash(`updated ${slugOf(d, issue)}${sent}`);
  return true;
}

/** Set a Plane Issue's Start Date and Target Date (`YYYY-MM-DD`), as the Timeline drags them. Returns false if it failed. */
export async function setIssueDates(project: Project, issue: PlaneIssue, start: string, target: string): Promise<boolean> {
  if (issue.start_date === start && issue.target_date === target) return true;
  try {
    await invoke("plane_set_dates", { ...planeArgs(project), issueId: issue.id, startDate: start, targetDate: target });
  } catch (e) {
    flash(`date change failed: ${e}`);
    return false;
  }
  await persistIssues(project, swap(project.id, { ...issue, start_date: start, target_date: target, updated_at: new Date().toISOString() }));
  flash(`${slugOf(dev[project.id], issue)} · ${formatDay(start)} → ${formatDay(target)} · PATCH sent to Plane`);
  return true;
}

// ── time entries ────────────────────────────────────────────────────

export function runningEntry(projectId: string): TimeEntry | null {
  return (dev[projectId]?.timeEntries ?? []).find((e) => e.stopped_at === null) ?? null;
}

export function accumulatedMs(projectId: string, issueId: string): number {
  let total = 0;
  for (const e of dev[projectId]?.timeEntries ?? []) {
    if (e.issue_id !== issueId) continue;
    const end = e.stopped_at ? Date.parse(e.stopped_at) : clock();
    total += end - Date.parse(e.started_at);
  }
  return total;
}

export function todayTotal(projectId: string): number {
  const day = new Date().toISOString().slice(0, 10);
  return (dev[projectId]?.timeEntries ?? []).reduce((sum, e) => {
    if (!e.started_at.startsWith(day)) return sum;
    const end = e.stopped_at ? Date.parse(e.stopped_at) : clock();
    return sum + (end - Date.parse(e.started_at));
  }, 0);
}

/** Start a timer on `issue`, or stop the running one. Only one runs at a time. */
export async function toggleTimer(project: Project, issue: TrackedIssue): Promise<void> {
  const current = dev[project.id];
  if (!current) return;
  const key = issueKey(issue);
  const now = new Date().toISOString();
  const running = runningEntry(project.id);
  let entries: TimeEntry[];
  if (running?.issue_id === key) {
    entries = current.timeEntries.map((e) => (e.stopped_at ? e : { ...e, stopped_at: now }));
    flash(`stopped ${slugOf(current, issue)} · ${formatHm(accumulatedMs(project.id, key))} total`);
  } else {
    const seq = issue.source === "plane" ? issue.sequence_id ?? 0 : issue.number;
    entries = current.timeEntries
      .map((e) => (e.stopped_at ? e : { ...e, stopped_at: now }))
      .concat({ issue_id: key, sequence_id: seq, title: issue.title, started_at: now, stopped_at: null });
    flash(`timer on ${slugOf(current, issue)} · wrote .dev/time-entries.json`);
  }
  try {
    await devWrite(project, "time-entries.json", JSON.stringify({ entries }, null, 2));
    setDev(project.id, "timeEntries", entries);
  } catch (e) {
    flash(`timer failed: ${e}`);
  }
}

// ── comments ────────────────────────────────────────────────────────

const commentKey = (projectId: string, issueId: string) => `${projectId}/${issueId}`;
const commentFile = (issue: PlaneIssue | GithubIssue) =>
  issue.source === "plane" ? `plane/comments/${issue.id}.json` : `github/comments/${issue.number}.json`;

/** Show cached comments immediately, then refresh them from Plane or GitHub. Local issues have none. */
export async function ensureComments(project: Project, issue: UnifiedIssue): Promise<void> {
  if (issue.source !== "plane" && issue.source !== "github") return;
  const key = commentKey(project.id, issueKey(issue));
  if (!comments[key]) {
    const raw = await devRead(project, commentFile(issue)).catch(() => null);
    setComments(key, parse<{ comments?: PlaneComment[] }>(raw, {}).comments ?? []);
  }
  refreshComments(project, issue).catch(() => {});
}

export async function refreshComments(project: Project, issue: PlaneIssue | GithubIssue): Promise<void> {
  const list = issue.source === "plane"
    ? await invoke<PlaneComment[]>("plane_comments", { ...planeArgs(project), issueId: issue.id })
    : await invoke<PlaneComment[]>("gh_issue_comments", { ...ghArgs(project), number: issue.number });
  setComments(commentKey(project.id, issueKey(issue)), list);
  await devWrite(project, commentFile(issue), JSON.stringify({ fetched_at: new Date().toISOString(), comments: list }, null, 2));
}

/** Post a comment. On Plane each image is uploaded first and referenced; GitHub takes text only. */
export async function postComment(project: Project, issue: PlaneIssue | GithubIssue, text: string, images: CommentImage[]): Promise<void> {
  try {
    let comment: PlaneComment;
    if (issue.source === "plane") {
      const parts: string[] = [];
      if (text.trim()) parts.push(`<p>${escapeHtml(text.trim()).replace(/\n/g, "<br>")}</p>`);
      for (const image of images) {
        try {
          const url = await invoke<string>("plane_upload_asset", { ...planeArgs(project), name: image.name, dataUrl: image.src });
          parts.push(`<p><img src="${url}"></p>`);
        } catch (e) {
          flash(`image upload failed: ${e}`);
        }
      }
      comment = { ...(await invoke<PlaneComment>("plane_add_comment", { ...planeArgs(project), issueId: issue.id, commentHtml: parts.join("") })), images };
    } else {
      await invoke("gh_issue_comment", { ...ghArgs(project), number: issue.number, body: text.trim() });
      comment = { id: `local-${Date.now()}`, author: "You", created_at: new Date().toISOString(), text: text.trim(), html: "", images: [] };
    }
    const key = commentKey(project.id, issueKey(issue));
    const next = [...(comments[key] ?? []), comment];
    setComments(key, next);
    await devWrite(project, commentFile(issue), JSON.stringify({ fetched_at: new Date().toISOString(), comments: next }, null, 2));
    flash(`commented on ${slugOf(dev[project.id], issue)}${images.length && issue.source === "plane" ? ` · uploaded ${images.length} image${images.length === 1 ? "" : "s"}` : ""}`);
  } catch (e) {
    flash(`comment failed: ${e}`);
  }
}

// ── setup ───────────────────────────────────────────────────────────

export type SourcesForm = {
  sources: Source[];
  plane?: { workspace_slug: string; project_id: string; token?: string };
  github?: { repo: string; progress_label: string };
  local?: { prefix: string };
};

/** The GitHub repo gh sees in the project folder, for the setup form. */
export const guessRepo = (project: Project) => invoke<string>("gh_repo", { host: project.host, path: project.path });

/** Save the Plane token (if given), write `.dev/config.json` with the chosen Sources, then sync. */
export async function saveSources(project: Project, form: SourcesForm): Promise<void> {
  try {
    if (form.plane?.token) {
      await writeFile(project, secretsFile, JSON.stringify({ token: form.plane.token }, null, 2));
      setDev(project.id, "hostToken", true);
    }
    const prev = dev[project.id]?.config ?? {};
    const config: DevConfig = { ...prev, sources: form.sources };
    if (form.plane) config.plane = { ...prev.plane, workspace_slug: form.plane.workspace_slug, project_id: form.plane.project_id };
    if (form.github) config.github = { repo: form.github.repo, progress_label: form.github.progress_label || DEFAULT_PROGRESS_LABEL };
    if (form.local) config.local = { prefix: form.local.prefix.trim() };
    await devWrite(project, "config.json", JSON.stringify(config, null, 2));
    setDev(project.id, { config, connected: sourcesOf(config).length > 0, syncing: false });
    flash(`wrote ${project.host !== "local" ? `${project.host}:` : ""}${project.path}/.dev/config.json · ${form.sources.map((s) => SOURCE_NAMES[s]).join(" + ")}`);
    await syncDev(project, true);
  } catch (e) {
    flash(`setup failed: ${e}`);
  }
}

/** Drop everything for a removed project. */
export function forgetProject(projectId: string): void {
  setDev(produce((s) => { delete s[projectId]; }));
  setComments(produce((s) => {
    for (const key of Object.keys(s)) if (key.startsWith(`${projectId}/`)) delete s[key];
  }));
  setDrafts(produce((s) => {
    for (const key of Object.keys(s)) if (key.startsWith(`${projectId}/`)) delete s[key];
  }));
}
