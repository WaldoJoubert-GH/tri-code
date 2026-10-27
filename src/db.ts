// The Database Window's store (ADR 0004). A project's Connections live in its repo's
// `.dev/databases.json`, written only by tri-code; a URL Connection's password stays on the
// host (Rust's db/target.rs). Each window holds one Session, kept here rather than in the
// component, so a window on another workspace keeps its connection, page and Pending Edits.

import { invoke } from "@tauri-apps/api/core";
import { createStore, produce, unwrap } from "solid-js/store";
import { type Project, type Tab, addTab, focusTab, repoOf } from "./state";
import {
  type Cell, type DbKind, type MongoOp, type Pending, type SqlOp, type Target, emptyPending, mongoOps, mongoText, pendingCount, rowKey, sqlOps,
} from "./dbsql";
import { flash } from "./ui";

export type DbTarget = { env: string } | { url: string } | { file: string };

/** A saved Connection. */
export type DbConn = {
  id: string;
  name: string;
  kind: DbKind;
  target: DbTarget;
  /** An ssh project: reach the database through the host (a tunnel) or from this machine. */
  via?: "direct" | "host";
  readOnly?: boolean;
  tag?: "prod";
};

export type Column = { name: string; type: string };
export type ResultSet = { columns: Column[]; rows: Cell[][]; more: boolean; affected?: number; ms: number };
export type ObjKind = "table" | "view" | "system" | "collection";
export type Obj = { name: string; kind: ObjKind; count: number | null };
export type Group = { name: string; objects: Obj[] };
export type ColInfo = { name: string; type: string; nullable: boolean; pk: boolean; default: string | null };
export type Named = { name: string; def: string };
export type Structure = { columns: ColInfo[]; key: string[]; indexes: Named[]; fks: Named[]; ddl: string };
export type Page = { columns: Column[]; rows: Cell[][]; more: boolean; total: number | null };
export type Sel = { group: string; name: string; kind: ObjKind };
export type View = "data" | "query" | "structure";

/** One window's state. */
export type Win = {
  status: "opening" | "open" | "error";
  error?: string;
  session?: number;
  version?: string;
  tunnel?: number | null;
  groups: Group[];
  shut: string[];
  obj?: Sel;
  view: View;
  structs: Record<string, Structure>;
  page?: Page;
  offset: number;
  sort?: { col: string; desc: boolean };
  filter: string;
  loading: boolean;
  pageError?: string;
  /** The selected cell: a row of the shown list (new rows first) and a column index. */
  sel: { r: number; c: number };
  /** Pending Edits by `group.name`. */
  pending: Record<string, Pending>;
  query: string;
  results?: ResultSet[];
  resTab: number;
  running: boolean;
  runError?: string;
  /** A nested value opened in the side panel. */
  doc?: { col: string; v: Cell };
  /** The statements under review, with the text shown. */
  review?: { ops: (SqlOp | MongoOp)[]; text: string[] };
  applyError?: string;
};

const objKey = (s: Sel) => `${s.group}.${s.name}`;

// ── Connections ─────────────────────────────────────────────────────

const [conns, setConns] = createStore<Record<string, DbConn[] | undefined>>({});

const fileOf = (p: Project) => `${repoOf(p).path.replace(/[\\/]+$/, "")}/.dev/databases.json`;
/** Where `.env` and relative SQLite paths are read from, and what a password is filed under. */
export const rootOf = (p: Project) => repoOf(p).path;

export const connsOf = (p: Project) => conns[repoOf(p).id];
export const connOf = (p: Project, id: string | undefined) => (id ? connsOf(p)?.find((c) => c.id === id) : undefined);

export async function loadConns(p: Project): Promise<DbConn[]> {
  const raw = await invoke<string | null>("dev_read", { host: p.host, path: fileOf(p) }).catch(() => null);
  let list: DbConn[] = [];
  try {
    list = raw ? (JSON.parse(raw).connections ?? []) : [];
  } catch {
    flash(".dev/databases.json isn't valid JSON");
  }
  setConns(repoOf(p).id, list);
  return list;
}

async function writeConns(p: Project, list: DbConn[]) {
  await invoke("dev_write", { host: p.host, path: fileOf(p), contents: JSON.stringify({ connections: list }, null, 2) + "\n" });
  setConns(repoOf(p).id, list);
}

/** Save a Connection. `secret` keeps (a string) or forgets (null) its password; undefined leaves it. */
export async function saveConn(p: Project, c: DbConn, secret?: string | null) {
  const list = [...((await loadConns(p)) ?? [])];
  const i = list.findIndex((x) => x.id === c.id);
  if (i >= 0) list[i] = c;
  else list.push(c);
  if (secret !== undefined) await invoke("db_secret_set", { host: p.host, root: rootOf(p), id: c.id, secret });
  await writeConns(p, list);
}

export async function removeConn(p: Project, id: string) {
  const list = ((await loadConns(p)) ?? []).filter((c) => c.id !== id);
  await invoke("db_secret_set", { host: p.host, root: rootOf(p), id, secret: null }).catch(() => {});
  await writeConns(p, list);
}

export type EnvVar = { key: string; kind: DbKind };
export const envVars = (p: Project) => invoke<EnvVar[]>("db_env_vars", { host: p.host, root: rootOf(p) });

/** Open and close a Connection, for the form's Test button. */
export async function testConn(p: Project, c: DbConn, secret?: string): Promise<string> {
  if (secret) await invoke("db_secret_set", { host: p.host, root: rootOf(p), id: c.id, secret });
  const o = await invoke<{ session: number; version: string; tunnel: number | null }>("db_open", { host: p.host, root: rootOf(p), conn: c });
  await invoke("db_close", { session: o.session });
  return o.tunnel ? `${o.version} · tunnel 127.0.0.1:${o.tunnel}` : o.version;
}

// ── windows ─────────────────────────────────────────────────────────

export const [wins, setWins] = createStore<Record<string, Win>>({});

const blank = (): Win => ({
  status: "opening", groups: [], shut: [], view: "data", structs: {}, offset: 0, filter: "", loading: false,
  sel: { r: 0, c: 0 }, pending: {}, query: "", resTab: 0, running: false,
});

const up = (tabId: string, fn: (w: Win) => void) => setWins(produce((all) => { if (all[tabId]) fn(all[tabId]); }));
const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

/** Open the window's Connection, unless it is open or opening. */
export async function openSession(p: Project, tab: Tab, force = false) {
  const w = wins[tab.id];
  if (w && !force && w.status !== "error") return;
  const c = connOf(p, tab.db);
  if (!c) return;
  if (w?.session) await invoke("db_close", { session: w.session }).catch(() => {});
  setWins(tab.id, { ...blank(), query: w?.query ?? "", pending: w?.pending ?? {} });
  try {
    const o = await invoke<{ session: number; version: string; tunnel: number | null }>("db_open", { host: p.host, root: rootOf(p), conn: c });
    up(tab.id, (x) => Object.assign(x, { status: "open", session: o.session, version: o.version, tunnel: o.tunnel }));
    await loadSchema(tab.id);
  } catch (e) {
    up(tab.id, (x) => Object.assign(x, { status: "error", error: errText(e) }));
  }
}

/** Close the window's Session (and its tunnel). */
export function closeSession(tabId: string) {
  const s = wins[tabId]?.session;
  if (s) invoke("db_close", { session: s }).catch(() => {});
  setWins(produce((all) => { delete all[tabId]; }));
}

export async function loadSchema(tabId: string) {
  const w = wins[tabId];
  if (!w?.session) return;
  try {
    const groups = await invoke<Group[]>("db_schema", { session: w.session });
    up(tabId, (x) => { x.groups = groups; });
    const still = w.obj && groups.some((g) => g.name === w.obj!.group && g.objects.some((o) => o.name === w.obj!.name));
    if (still) await loadPage(tabId);
    else {
      const first = groups.flatMap((g) => g.objects.filter((o) => o.kind !== "system").map((o) => ({ group: g.name, name: o.name, kind: o.kind })))[0];
      if (first) await openObj(tabId, first);
    }
  } catch (e) {
    up(tabId, (x) => { x.pageError = errText(e); });
  }
}

export async function openObj(tabId: string, sel: Sel) {
  up(tabId, (x) => Object.assign(x, { obj: sel, sort: undefined, filter: "", offset: 0, sel: { r: 0, c: 0 }, doc: undefined, page: undefined, pageError: undefined }));
  await ensureStruct(tabId, sel);
  await loadPage(tabId);
}

export async function ensureStruct(tabId: string, sel: Sel, force = false): Promise<Structure | undefined> {
  const w = wins[tabId];
  if (!w?.session) return;
  if (w.structs[objKey(sel)] && !force) return w.structs[objKey(sel)];
  try {
    const s = await invoke<Structure>("db_structure", { session: w.session, group: sel.group, name: sel.name, kind: sel.kind });
    up(tabId, (x) => { x.structs[objKey(sel)] = s; });
    return s;
  } catch (e) {
    up(tabId, (x) => { x.pageError = errText(e); });
  }
}

export const structOf = (w: Win | undefined) => (w?.obj ? w.structs[objKey(w.obj)] : undefined);
export const pendingOf = (w: Win | undefined) => (w?.obj ? w.pending[objKey(w.obj)] : undefined);

export async function loadPage(tabId: string) {
  const w = wins[tabId];
  if (!w?.session || !w.obj) return;
  const obj = w.obj;
  up(tabId, (x) => { x.loading = true; });
  try {
    const page = await invoke<Page>("db_rows", {
      session: w.session,
      req: { group: obj.group, name: obj.name, offset: w.offset, filter: w.filter, sort: w.sort?.col ?? null, desc: !!w.sort?.desc, key: structOf(w)?.key ?? [] },
    });
    up(tabId, (x) => {
      if (x.obj && objKey(x.obj) !== objKey(obj)) return;
      Object.assign(x, { page, loading: false, pageError: undefined });
      x.sel.r = Math.min(x.sel.r, Math.max(0, page.rows.length - 1));
    });
  } catch (e) {
    up(tabId, (x) => Object.assign(x, { loading: false, pageError: errText(e) }));
  }
}

export function setFilter(tabId: string, filter: string) {
  up(tabId, (x) => Object.assign(x, { filter, offset: 0 }));
  return loadPage(tabId);
}

/** Click a header: ascending, descending, then back to the key order. */
export function toggleSort(tabId: string, col: string) {
  up(tabId, (x) => {
    x.sort = x.sort?.col !== col ? { col, desc: false } : !x.sort.desc ? { col, desc: true } : undefined;
    x.offset = 0;
  });
  return loadPage(tabId);
}

export function turnPage(tabId: string, dir: 1 | -1) {
  const w = wins[tabId];
  if (!w) return;
  const offset = Math.max(0, w.offset + dir * 500);
  if (offset === w.offset || (dir > 0 && !w.page?.more)) return;
  up(tabId, (x) => { x.offset = offset; x.sel.r = 0; });
  return loadPage(tabId);
}

export const setView = (tabId: string, view: View) => up(tabId, (x) => { x.view = view; });
export const setSelCell = (tabId: string, r: number, c: number) => up(tabId, (x) => { x.sel = { r, c }; });
export const setDoc = (tabId: string, doc: Win["doc"]) => up(tabId, (x) => { x.doc = doc; });
export const setQuery = (tabId: string, q: string) => up(tabId, (x) => { x.query = q; });
export const setResTab = (tabId: string, i: number) => up(tabId, (x) => { x.resTab = i; });
export const toggleGroup = (tabId: string, g: string) => up(tabId, (x) => { x.shut = x.shut.includes(g) ? x.shut.filter((s) => s !== g) : [...x.shut, g]; });

// ── Pending Edits ───────────────────────────────────────────────────

/** Undo steps, by window: a snapshot of the table's Pending Edits before each change. */
const undoLog = new Map<string, { key: string; before: Pending }[]>();

function change(tabId: string, fn: (p: Pending) => void) {
  const w = wins[tabId];
  if (!w?.obj) return;
  const key = objKey(w.obj);
  // A store proxy can't be cloned: copy the plain object under it.
  const before: Pending = structuredClone(unwrap(w.pending[key]) ?? emptyPending());
  const log = undoLog.get(tabId) ?? [];
  log.push({ key, before });
  undoLog.set(tabId, log.slice(-200));
  up(tabId, (x) => {
    x.pending[key] ??= emptyPending();
    fn(x.pending[key]);
    x.applyError = undefined;
  });
}

/** A row of the page as column → value. */
export const rowObj = (cols: Column[], row: Cell[]) => Object.fromEntries(cols.map((c, i) => [c.name, row[i] ?? null]));

/** Set a cell of a loaded row (`rowIndex` into the page) or of a new row (`added` index). */
export function setCell(tabId: string, at: { page: number } | { added: number }, col: string, value: Cell) {
  const w = wins[tabId];
  const key = structOf(w)?.key ?? [];
  if (!w?.page) return;
  change(tabId, (p) => {
    if ("added" in at) {
      p.added[at.added][col] = value;
      return;
    }
    const row = rowObj(w.page!.columns, w.page!.rows[at.page]);
    const k = rowKey(key, row);
    const e = (p.edits[k] ??= { row, set: {} });
    if (JSON.stringify(value) === JSON.stringify(row[col] ?? null)) delete e.set[col];
    else e.set[col] = value;
    if (!Object.keys(e.set).length) delete p.edits[k];
  });
}

export function addRow(tabId: string) {
  change(tabId, (p) => { p.added.unshift({}); });
  up(tabId, (x) => { x.sel.r = 0; });
}

/** Delete (or undelete) a loaded row; a new row is just dropped. */
export function toggleDelete(tabId: string, at: { page: number } | { added: number }) {
  const w = wins[tabId];
  const key = structOf(w)?.key ?? [];
  if (!w?.page) return;
  change(tabId, (p) => {
    if ("added" in at) return void p.added.splice(at.added, 1);
    const row = rowObj(w.page!.columns, w.page!.rows[at.page]);
    const k = rowKey(key, row);
    if (p.deleted[k]) delete p.deleted[k];
    else p.deleted[k] = row;
  });
}

export function undo(tabId: string) {
  const step = undoLog.get(tabId)?.pop();
  if (!step) return void flash("nothing to undo");
  up(tabId, (x) => { x.pending[step.key] = step.before; x.applyError = undefined; });
}

export function discard(tabId: string) {
  const w = wins[tabId];
  if (!w?.obj) return;
  change(tabId, (p) => Object.assign(p, emptyPending()));
  flash("Pending Edits discarded");
}

/** Build the statements for review. */
export function review(p: Project, tabId: string) {
  const w = wins[tabId];
  const c = connOf(p, p.tabs.find((t) => t.id === tabId)?.db);
  const pend = pendingOf(w);
  const s = structOf(w);
  if (!w?.obj || !c || !s || !pendingCount(pend)) return;
  const t: Target = { kind: c.kind, group: w.obj.group, name: w.obj.name };
  if (c.kind === "mongo") {
    const ops = mongoOps(t, pend!);
    up(tabId, (x) => { x.review = { ops, text: mongoText(ops) }; });
  } else {
    const types = Object.fromEntries(s.columns.map((col) => [col.name, col.type]));
    const ops = sqlOps(t, s.key, types, pend!);
    up(tabId, (x) => { x.review = { ops, text: ["BEGIN;", ...ops.map((o) => o.sql + ";"), "COMMIT;"] }; });
  }
}

export const closeReview = (tabId: string) => up(tabId, (x) => { x.review = undefined; });

export async function apply(tabId: string) {
  const w = wins[tabId];
  if (!w?.session || !w.review || !w.obj) return;
  const key = objKey(w.obj);
  try {
    const n = await invoke<number>("db_apply", { session: w.session, ops: unwrap(w.review.ops) });
    undoLog.set(tabId, (undoLog.get(tabId) ?? []).filter((s) => s.key !== key));
    up(tabId, (x) => { x.review = undefined; x.pending[key] = emptyPending(); x.applyError = undefined; });
    flash(`applied · ${n} ${n === 1 ? "row" : "rows"} changed`);
    await loadPage(tabId);
  } catch (e) {
    up(tabId, (x) => { x.review = undefined; x.applyError = errText(e); });
  }
}

// ── Query ───────────────────────────────────────────────────────────

export async function runQuery(tabId: string, text: string) {
  const w = wins[tabId];
  if (!w?.session || w.running || !text.trim()) return;
  up(tabId, (x) => Object.assign(x, { running: true, runError: undefined }));
  try {
    const results = await invoke<ResultSet[]>("db_run", { session: w.session, text, scope: w.obj?.group ?? null });
    up(tabId, (x) => Object.assign(x, { results, resTab: 0, running: false }));
  } catch (e) {
    up(tabId, (x) => Object.assign(x, { running: false, runError: errText(e), results: undefined }));
  }
}

export function cancelQuery(tabId: string) {
  const s = wins[tabId]?.session;
  if (s) invoke("db_cancel", { session: s }).catch(() => {});
}

// ── opening windows ─────────────────────────────────────────────────

/** Focus the window of a Connection, or open one. Without an id: the most recent database
 *  window, else a new one on its start page. */
export function openDbWindow(p: Project, connId?: string): string {
  const dbTabs = p.tabs.filter((t) => t.kind === "db");
  const existing = connId ? dbTabs.find((t) => t.db === connId) : dbTabs[dbTabs.length - 1];
  const id = existing?.id ?? addTab(p.id, "db", { db: connId });
  focusTab(p.id, id);
  return id;
}

/** The window title: the Connection's name and server. */
export function dbTitle(p: Project, tab: Tab): string {
  const c = connOf(p, tab.db);
  if (!c) return "connections";
  const w = wins[tab.id];
  return [c.name, w?.version, w?.tunnel ? `via ${p.host}` : ""].filter(Boolean).join(" · ");
}

export const isProd = (p: Project, tab: Tab) => connOf(p, tab.db)?.tag === "prod";
