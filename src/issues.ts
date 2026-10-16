// The issues panel's store: one view of a project's `.dev/` folder, the same
// files pi-todos and dev-hub read and write. Plane and Sentry issues live in
// `.dev/issues.json`; this module never keeps Plane data anywhere else.
//
// Rust owns the Plane HTTP (the webview's fetch would hit CORS) and returns
// data; the TypeScript side writes the `.dev/` files back through `devfs`.

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
  link: string;
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

export type UnifiedIssue = PlaneIssue | SentryIssue;

export type PlaneState = { id: string; name: string; color: string; group: string };
export type PlaneLabel = { id: string; name: string; color: string };
export type PlaneConfig = { workspace_slug: string; project_id: string; project_identifier?: string };
export type DevConfig = { plane?: PlaneConfig } & Record<string, unknown>;
export type TimeEntry = { issue_id: string; sequence_id: number; title: string; started_at: string; stopped_at: string | null };
export type CommentImage = { name: string; src: string };
export type PlaneComment = { id: string; author: string; created_at: string; text: string; html: string; images: CommentImage[] };

export type PlaneSync = {
  last_synced: string;
  project_identifier?: string;
  issues: PlaneIssue[];
  states: PlaneState[];
  labels: PlaneLabel[];
};

export type CreatedIssue = { id: string; sequence_id?: number; title: string; priority: string; link: string };

export type DevState = {
  loaded: boolean;
  loading: boolean;
  /** Config has a usable plane section; false shows the setup form. */
  connected: boolean;
  /** The project's host has `~/.pi/agent/secrets/plane.json`. */
  hostToken: boolean;
  config: DevConfig;
  issues: UnifiedIssue[];
  states: PlaneState[];
  labels: PlaneLabel[];
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

// ── pure helpers ────────────────────────────────────────────────────

/** `TRI-12` for a Plane issue, `S-4412` for a Sentry one. */
export function slugOf(state: DevState | undefined, issue: UnifiedIssue): string {
  if (issue.source === "sentry") return `S-${issue.sentry_id ?? "?"}`;
  const ident = state?.config?.plane?.project_identifier;
  return ident ? `${ident}-${issue.sequence_id ?? "?"}` : `#${issue.sequence_id ?? "?"}`;
}

export function stateOf(state: DevState | undefined, issue: PlaneIssue): PlaneState | undefined {
  return state?.states.find((s) => s.id === issue.state_id);
}

/** Stable selection key: the Plane UUID, or `se<sentry_id>` for a Sentry item. */
export function issueKey(issue: UnifiedIssue): string {
  return issue.source === "plane" ? issue.id : `se${issue.sentry_id ?? ""}`;
}

export function labelOf(state: DevState | undefined, id: string): PlaneLabel | undefined {
  return state?.labels.find((l) => l.id === id);
}

export function isActive(state: DevState | undefined, issue: UnifiedIssue): boolean {
  if (issue.source === "sentry") return issue.sentry_status !== "resolved";
  return ACTIVE_GROUPS.has(stateOf(state, issue)?.group ?? issue.state_group ?? "");
}

/** Black or white text for a Plane State Hex, by relative luminance. */
export function fgFor(hex: string): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return "#fff";
  const n = parseInt(raw, 16);
  if (Number.isNaN(n)) return "#fff";
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.5 ? "#000" : "#fff";
}

/** Priority → state group → title, Sentry after Plane. */
export function sortIssues(state: DevState | undefined, issues: UnifiedIssue[]): UnifiedIssue[] {
  const key = (i: UnifiedIssue): [number, number, number, string] =>
    i.source === "plane"
      ? [0, PRIORITY_ORDER[i.priority ?? "none"] ?? 4, GROUP_ORDER[stateOf(state, i)?.group ?? i.state_group ?? ""] ?? 9, i.title]
      : [1, Math.max(0, LEVEL_ORDER.indexOf(i.level ?? "error")), 0, i.title];
  return [...issues].sort((a, b) => {
    const x = key(a), y = key(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3].localeCompare(y[3]);
  });
}

export type View = { src: "all" | "plane" | "sentry"; done: boolean; q: string };

/** The rows the list shows: source filter, done toggle, and a search that
 *  matches the Slug-ID, the title and label names. */
export function shownIssues(state: DevState | undefined, view: View): UnifiedIssue[] {
  const q = view.q.trim().toLowerCase();
  const issues = (state?.issues ?? []).filter(
    (i) =>
      (view.src === "all" || i.source === view.src) &&
      (view.done || isActive(state, i)) &&
      (!q || `${slugOf(state, i)} ${i.title} ${(i.source === "plane" ? (i.labels ?? []) : []).map((id) => labelOf(state, id)?.name ?? "").join(" ")}`.toLowerCase().includes(q)),
  );
  return sortIssues(state, issues);
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
  config: {}, issues: [], states: [], labels: [], timeEntries: [], syncing: false,
});

export const [dev, setDev] = createStore<Record<string, DevState>>({});
export const devOf = (projectId: string): DevState | undefined => dev[projectId];

/** Comment drafts keyed by `projectId/issueId`, so they survive repaints. */
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

/** Comments keyed by `projectId/issueId`. */
export const [comments, setComments] = createStore<Record<string, PlaneComment[]>>({});
export const commentsOf = (projectId: string, issueId: string) => comments[`${projectId}/${issueId}`];

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

/** The window title for an issues panel: identifier, active count and sync age. */
export function panelTitle(project: Project): string {
  const d = dev[project.id];
  if (!d) return "not connected";
  if (!d.connected) return `${project.name} · connect Plane`;
  const n = d.issues.filter((i) => i.source === "plane" && isActive(d, i)).length;
  const via = project.host !== "local" ? ` via ${project.host}` : "";
  return `${d.config.plane?.project_identifier ?? project.name} · ${n} active · ${d.syncing ? "syncing…" : `synced ${ago(d.lastSynced)}`}${via}`;
}

/** The project's "In Progress" issues: the running one first, then by priority. */
export function inProgress(projectId: string): PlaneIssue[] {
  const d = dev[projectId];
  if (!d) return [];
  const running = runningEntry(projectId)?.issue_id;
  return d.issues
    .filter((i): i is PlaneIssue => i.source === "plane" && stateOf(d, i)?.name === "In Progress")
    .sort((a, b) => Number(b.id === running) - Number(a.id === running) || priorityRank(a.priority) - priorityRank(b.priority));
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

/** Read and parse the whole `.dev/` folder. This is a read only; a Plane sync is a separate call. */
export async function loadDev(project: Project): Promise<void> {
  const current = dev[project.id];
  if (current?.loading) return;
  setDev(project.id, { ...(current ?? empty()), loading: true, error: undefined });
  try {
    const [configRaw, issuesRaw, statesRaw, labelsRaw, timeRaw] = await Promise.all([
      devRead(project, "config.json"),
      devRead(project, "issues.json"),
      devRead(project, "plane-states.json"),
      devRead(project, "plane-labels.json"),
      devRead(project, "time-entries.json"),
    ]);
    const config = parse<DevConfig>(configRaw, {});
    const plane = config.plane;
    const issuesFile = parse<{ last_synced?: string; issues?: UnifiedIssue[] }>(issuesRaw, {});
    const statesFile = parse<{ states?: PlaneState[] }>(statesRaw, {});
    const labelsFile = parse<{ labels?: PlaneLabel[] }>(labelsRaw, {});
    const timeFile = parse<{ entries?: TimeEntry[] }>(timeRaw, {});
    setDev(project.id, {
      loaded: true, loading: false,
      config,
      connected: !!(plane?.workspace_slug && plane?.project_id),
      issues: issuesFile.issues ?? [],
      lastSynced: issuesFile.last_synced,
      states: statesFile.states ?? [],
      labels: labelsFile.labels ?? [],
      timeEntries: timeFile.entries ?? [],
    });
    if (plane?.workspace_slug && plane?.project_id) {
      invoke<boolean>("plane_check_token", { host: project.host })
        .then((ok) => setDev(project.id, "hostToken", ok))
        .catch(() => {});
    }
  } catch (e) {
    setDev(project.id, { ...(dev[project.id] ?? empty()), loaded: true, loading: false, error: String(e) });
  }
}

async function persistIssues(project: Project, issues: UnifiedIssue[]): Promise<void> {
  const last = dev[project.id]?.lastSynced;
  await devWrite(project, "issues.json", JSON.stringify({ last_synced: last, issues }, null, 2));
  setDev(project.id, "issues", issues);
}

/** Pull Plane, then write the three files pi-todos and dev-hub also read. */
export async function syncDev(project: Project, quiet = false): Promise<void> {
  const plane = planeOf(project.id);
  const current = dev[project.id];
  if (!plane?.workspace_slug || !plane.project_id || current?.syncing) return;
  setDev(project.id, "syncing", true);
  try {
    const res = await invoke<PlaneSync>("plane_sync", {
      host: project.host,
      workspaceSlug: plane.workspace_slug,
      projectId: plane.project_id,
    });
    const sentry = (current?.issues ?? []).filter((i) => i.source === "sentry");
    const issues: UnifiedIssue[] = [...res.issues, ...sentry];
    await Promise.all([
      devWrite(project, "issues.json", JSON.stringify({ last_synced: res.last_synced, issues }, null, 2)),
      devWrite(project, "plane-states.json", JSON.stringify({ last_fetched: res.last_synced, states: res.states }, null, 2)),
      devWrite(project, "plane-labels.json", JSON.stringify({ last_fetched: res.last_synced, labels: res.labels }, null, 2)),
    ]);
    setDev(project.id, {
      issues, states: res.states, labels: res.labels, lastSynced: res.last_synced, syncing: false, error: undefined,
    });
    // Fill in the project identifier the first time we see it.
    if (res.project_identifier && !plane.project_identifier) {
      const config: DevConfig = { ...(current?.config ?? {}), plane: { ...plane, project_identifier: res.project_identifier } };
      await devWrite(project, "config.json", JSON.stringify(config, null, 2));
      setDev(project.id, "config", config);
    }
    if (!quiet) flash(`synced ${res.issues.length} Plane issues · wrote .dev/issues.json`);
  } catch (e) {
    setDev(project.id, { syncing: false, error: String(e) });
    if (!quiet) flash(`sync failed: ${e}`);
  }
}

/** A manual sync, matching the `r` binding. */
export const syncNow = (project: Project) => syncDev(project, false);

// ── mutations ───────────────────────────────────────────────────────

const args = (project: Project) => {
  const plane = planeOf(project.id);
  if (!plane) throw new Error("this project is not connected to Plane");
  return { host: project.host, workspaceSlug: plane.workspace_slug, projectId: plane.project_id };
};

export async function setIssueState(project: Project, issue: PlaneIssue, stateId: string): Promise<void> {
  const state = dev[project.id]?.states.find((s) => s.id === stateId);
  try {
    await invoke("plane_set_state", { ...args(project), issueId: issue.id, stateId });
  } catch (e) {
    flash(`state change failed: ${e}`);
    return;
  }
  const issues = (dev[project.id]?.issues ?? []).map((i) =>
    i.source === "plane" && i.id === issue.id
      ? { ...i, state_id: stateId, state_name: state?.name, state_group: state?.group, state_hex: state?.color }
      : i,
  );
  await persistIssues(project, issues);
  flash(`${slugOf(dev[project.id], issue)} → ${state?.name ?? "state"} · PATCH sent to Plane`);
}

export async function setIssueLabels(project: Project, issue: PlaneIssue, labels: string[]): Promise<void> {
  try {
    await invoke("plane_set_labels", { ...args(project), issueId: issue.id, labels });
  } catch (e) {
    flash(`label change failed: ${e}`);
    return;
  }
  const issues = (dev[project.id]?.issues ?? []).map((i) =>
    i.source === "plane" && i.id === issue.id ? { ...i, labels } : i,
  );
  await persistIssues(project, issues);
}

export function toggleLabel(project: Project, issue: PlaneIssue, labelId: string): Promise<void> {
  const labels = issue.labels ?? [];
  const next = labels.includes(labelId) ? labels.filter((l) => l !== labelId) : [...labels, labelId];
  const name = labelOf(dev[project.id], labelId)?.name ?? "label";
  flash(`${slugOf(dev[project.id], issue)} ${labels.includes(labelId) ? "−" : "+"}${name} · PATCH sent to Plane`);
  return setIssueLabels(project, issue, next);
}

/** Default State for a new issue: "Todo", else first unstarted, else first backlog. */
export function defaultStateId(projectId: string): string | undefined {
  const states = dev[projectId]?.states ?? [];
  return (
    states.find((s) => s.name.toLowerCase() === "todo")?.id ??
    states.find((s) => s.group === "unstarted")?.id ??
    states.find((s) => s.group === "backlog")?.id
  );
}

export async function createIssue(project: Project, title: string): Promise<PlaneIssue | undefined> {
  try {
    const created = await invoke<CreatedIssue>("plane_create_issue", {
      ...args(project),
      title,
      stateId: defaultStateId(project.id) ?? null,
    });
    const state = dev[project.id]?.states.find((s) => s.id === defaultStateId(project.id));
    const issue: PlaneIssue = {
      source: "plane",
      id: created.id,
      sequence_id: created.sequence_id,
      title: created.title,
      description: "",
      state_id: state?.id,
      state_name: state?.name,
      state_group: state?.group,
      state_hex: state?.color,
      priority: created.priority,
      link: created.link,
      labels: [],
      updated_at: new Date().toISOString(),
    };
    await persistIssues(project, [...(dev[project.id]?.issues ?? []), issue]);
    flash(`created ${slugOf(dev[project.id], issue)} in Plane`);
    return issue;
  } catch (e) {
    flash(`create failed: ${e}`);
    return undefined;
  }
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
export async function toggleTimer(project: Project, issue: PlaneIssue): Promise<void> {
  const current = dev[project.id];
  if (!current) return;
  const now = new Date().toISOString();
  const running = runningEntry(project.id);
  let entries: TimeEntry[];
  if (running?.issue_id === issue.id) {
    entries = current.timeEntries.map((e) => (e.stopped_at ? e : { ...e, stopped_at: now }));
    flash(`stopped ${slugOf(current, issue)} · ${formatHm(accumulatedMs(project.id, issue.id))} total`);
  } else {
    entries = current.timeEntries
      .map((e) => (e.stopped_at ? e : { ...e, stopped_at: now }))
      .concat({ issue_id: issue.id, sequence_id: issue.sequence_id ?? 0, title: issue.title, started_at: now, stopped_at: null });
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

/** Show cached comments immediately, then refresh them from Plane. */
export async function ensureComments(project: Project, issueId: string): Promise<void> {
  if (!comments[commentKey(project.id, issueId)]) {
    const raw = await devRead(project, `plane/comments/${issueId}.json`).catch(() => null);
    setComments(commentKey(project.id, issueId), parse<{ comments?: PlaneComment[] }>(raw, {}).comments ?? []);
  }
  refreshComments(project, issueId).catch(() => {});
}

export async function refreshComments(project: Project, issueId: string): Promise<void> {
  const list = await invoke<PlaneComment[]>("plane_comments", { ...args(project), issueId });
  setComments(commentKey(project.id, issueId), list);
  await devWrite(
    project,
    `plane/comments/${issueId}.json`,
    JSON.stringify({ fetched_at: new Date().toISOString(), comments: list }, null, 2),
  );
}

/** Upload each image, then post one comment that references them. */
export async function postComment(project: Project, issue: PlaneIssue, text: string, images: CommentImage[]): Promise<void> {
  const parts: string[] = [];
  if (text.trim()) parts.push(`<p>${escapeHtml(text.trim()).replace(/\n/g, "<br>")}</p>`);
  for (const image of images) {
    try {
      const url = await invoke<string>("plane_upload_asset", { ...args(project), name: image.name, dataUrl: image.src });
      parts.push(`<p><img src="${url}"></p>`);
    } catch (e) {
      flash(`image upload failed: ${e}`);
    }
  }
  try {
    const comment = await invoke<PlaneComment>("plane_add_comment", { ...args(project), issueId: issue.id, commentHtml: parts.join("") });
    const key = commentKey(project.id, issue.id);
    const next = [...(comments[key] ?? []), { ...comment, images }];
    setComments(key, next);
    await devWrite(project, `plane/comments/${issue.id}.json`, JSON.stringify({ fetched_at: new Date().toISOString(), comments: next }, null, 2));
    flash(`commented on ${slugOf(dev[project.id], issue)}${images.length ? ` · uploaded ${images.length} image${images.length === 1 ? "" : "s"}` : ""}`);
  } catch (e) {
    flash(`comment failed: ${e}`);
  }
}

// ── setup ───────────────────────────────────────────────────────────

/** Save the token (if given), write `.dev/config.json`, then sync. */
export async function connectPlane(
  project: Project,
  form: { workspace_slug: string; project_id: string; token?: string },
): Promise<void> {
  try {
    if (form.token) {
      await writeFile(project, secretsFile, JSON.stringify({ token: form.token }, null, 2));
      setDev(project.id, "hostToken", true);
    }
    const config: DevConfig = { ...(dev[project.id]?.config ?? {}), plane: { workspace_slug: form.workspace_slug, project_id: form.project_id } };
    await devWrite(project, "config.json", JSON.stringify(config, null, 2));
    setDev(project.id, { config, connected: true, syncing: false });
    flash(`wrote ${project.host !== "local" ? `${project.host}:` : ""}${project.path}/.dev/config.json · first sync…`);
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
