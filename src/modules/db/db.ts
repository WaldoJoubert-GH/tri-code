// The Database Window's store (ADR 0004). A project's Connections and Saved Queries live in its
// repo's `.dev/databases.json`, written only by tri-code; a URL Connection's password stays on the
// host (Rust's db/target.rs). Each window holds one Session, kept here rather than in the
// component, so a window on another workspace keeps its connection, page and Pending Edits.
// A query's full result is held by the Session (db/mod.rs); the window has the rows it has
// scrolled to, a page at a time.

import { invoke } from "@tauri-apps/api/core";
import { save as pickSavePath } from "@tauri-apps/plugin-dialog";
import { createStore, produce, unwrap } from "solid-js/store";
import { type Project, type Tab, addTab, focusTab, newId, repoOf } from "../../shared/state/state";
import {
  type Cell, type DbKind, type MongoOp, type Pending, type SqlOp, type Target, emptyPending, mongoOps, mongoText, pendingCount, rowKey, sqlOps,
} from "./dbsql";
import { flash } from "../../shared/ui/ui";
import { hostAt, linkAt } from "../../shared/links";

/** `sheet` is a CSV or workbook loaded into memory: never saved, made up from the window's id. */
export type DbTarget = { env: string } | { url: string } | { file: string } | { sheet: string };

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

/** A query kept by name for one Connection. */
export type SavedQuery = { id: string; conn: string; name: string; text: string };

export type Column = { name: string; type: string };
/** `rows`: those loaded so far, of `total` held by the Session. `more`: the statement had more
 *  rows than the Session holds (db/mod.rs HOLD), left behind. */
export type ResultSet = { columns: Column[]; rows: Cell[][]; more: boolean; total: number; affected?: number; ms: number };
export type ObjKind = "table" | "view" | "system" | "collection";
export type Obj = { name: string; kind: ObjKind; count: number | null };
export type Group = { name: string; objects: Obj[] };
export type ColInfo = { name: string; type: string; nullable: boolean; pk: boolean; default: string | null };
export type Named = { name: string; def: string };
/** `applyNote`: said before Apply, e.g. that a MyISAM table can't roll back. */
export type Structure = { columns: ColInfo[]; key: string[]; indexes: Named[]; fks: Named[]; ddl: string; applyNote?: string };
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
  /** What the Data view shows: the picked table's rows, or the last Query Result. Run turns it
   *  to `query`; picking a table in the tree turns it back. */
  source: "table" | "query";
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
  /** The Saved Query the editor holds, if any. */
  savedId?: string;
  /** The editor's text when it was last opened or saved: it has edits while `query` differs. */
  clean?: string;
  /** Bumped when the editor's text is replaced from outside (a Saved Query opened). */
  queryRev: number;
  /** The Session's name for `results`, which their next pages are asked by. */
  run?: number;
  results?: ResultSet[];
  resTab: number;
  running: boolean;
  /** A page of a result is on its way. */
  paging: boolean;
  runError?: string;
  /** A nested value opened in the side panel. */
  doc?: { col: string; v: Cell };
  /** The statements under review, with the text shown, and what to say before they run. */
  review?: { ops: (SqlOp | MongoOp)[]; text: string[]; note?: string };
  applyError?: string;
};

const objKey = (s: Sel) => `${s.group}.${s.name}`;

// ── Connections ─────────────────────────────────────────────────────

const [conns, setConns] = createStore<Record<string, DbConn[] | undefined>>({});
const [queries, setQueries] = createStore<Record<string, SavedQuery[] | undefined>>({});

const fileOf = (p: Project) => `${repoOf(p).path.replace(/[\\/]+$/, "")}/.dev/databases.json`;
/** Where `.env` and relative SQLite paths are read from, and what a password is filed under. */
export const rootOf = (p: Project) => repoOf(p).path;

export const connsOf = (p: Project) => conns[repoOf(p).id];
export const connOf = (p: Project, id: string | undefined) =>
  !id ? undefined : id.startsWith(SHEET) ? sheetConn(p, id.slice(SHEET.length)) : connsOf(p)?.find((c) => c.id === id);

// ── spreadsheet files ───────────────────────────────────────────────
// A CSV or workbook opened from the editor ("Open in Database") is a window whose `db` is
// `sheet:<path>`. Rust loads the file into an in-memory SQLite (db/sheet.rs), so the window
// treats it as SQLite: a CSV's Apply writes the file back, a workbook is read-only. The file is read
// and written on its own host: a Linked Folder on this machine is local in an ssh project (links.ts).

const SHEET = "sheet:";
export const isSheet = (c: DbConn | undefined) => !!c && "sheet" in c.target;
export const sheetPathOf = (c: DbConn) => ("sheet" in c.target ? c.target.sheet : "");
export const isBookConn = (c: DbConn) => isSheet(c) && !/\.(csv|tsv|tab|psv)$/i.test(sheetPathOf(c));

function sheetConn(p: Project, path: string): DbConn {
  const conn: DbConn = { id: SHEET + path, name: path.split(/[\\/]/).pop() ?? path, kind: "sqlite", target: { sheet: path } };
  if (!/\.(csv|tsv|tab|psv)$/i.test(path) || linkAt(p, path)?.readOnly) conn.readOnly = true;
  return conn;
}

/** Focus the Database Window on a spreadsheet file, or open one after `after` (the editor). */
export function openSheetDb(p: Project, path: string, after?: string): string {
  const id = SHEET + path;
  const existing = p.tabs.find((t) => t.kind === "db" && t.db === id);
  const tabId = existing?.id ?? addTab(p.id, "db", { db: id, after });
  focusTab(p.id, tabId);
  return tabId;
}

type DbFile = { connections: DbConn[]; queries: SavedQuery[] };

/** Read `.dev/databases.json` again: what another window wrote is kept when this one writes. */
async function readFile(p: Project): Promise<DbFile> {
  const raw = await invoke<string | null>("dev_read", { host: p.host, path: fileOf(p) }).catch(() => null);
  let file: DbFile = { connections: [], queries: [] };
  try {
    const j = raw ? JSON.parse(raw) : {};
    file = { connections: j.connections ?? [], queries: j.queries ?? [] };
  } catch {
    flash(".dev/databases.json isn't valid JSON");
  }
  setConns(repoOf(p).id, file.connections);
  setQueries(repoOf(p).id, file.queries);
  return file;
}

async function writeFile(p: Project, file: DbFile) {
  const out: Partial<DbFile> = { connections: file.connections };
  if (file.queries.length) out.queries = file.queries;
  await invoke("dev_write", { host: p.host, path: fileOf(p), contents: JSON.stringify(out, null, 2) + "\n" });
  setConns(repoOf(p).id, file.connections);
  setQueries(repoOf(p).id, file.queries);
}

export async function loadConns(p: Project): Promise<DbConn[]> {
  return (await readFile(p)).connections;
}

/** Save a Connection. `secret` keeps (a string) or forgets (null) its password; undefined leaves it. */
export async function saveConn(p: Project, c: DbConn, secret?: string | null) {
  const file = await readFile(p);
  const i = file.connections.findIndex((x) => x.id === c.id);
  if (i >= 0) file.connections[i] = c;
  else file.connections.push(c);
  if (secret !== undefined) await invoke("db_secret_set", { host: p.host, root: rootOf(p), id: c.id, secret });
  await writeFile(p, file);
}

/** Remove a Connection, with its Saved Queries. */
export async function removeConn(p: Project, id: string) {
  const file = await readFile(p);
  await invoke("db_secret_set", { host: p.host, root: rootOf(p), id, secret: null }).catch(() => {});
  await writeFile(p, { connections: file.connections.filter((c) => c.id !== id), queries: file.queries.filter((q) => q.conn !== id) });
}

// ── Saved Queries ───────────────────────────────────────────────────

/** A Connection's Saved Queries, by name. */
export const savedOf = (p: Project, conn: string | undefined): SavedQuery[] =>
  (queries[repoOf(p).id] ?? []).filter((q) => q.conn === conn).sort((a, b) => a.name.localeCompare(b.name));
export const savedById = (p: Project, id: string | undefined) => (id ? queries[repoOf(p).id]?.find((q) => q.id === id) : undefined);

/** The editor has text not saved since it was opened. */
export const queryDirty = (w: Win | undefined) => !!w && w.clean !== undefined && w.query !== w.clean;

/** Save the editor's text: over the Saved Query it holds, or, given a name, as a new one. */
export async function saveQuery(p: Project, tabId: string, conn: string, name?: string) {
  const w = wins[tabId];
  if (!w) return;
  const file = await readFile(p);
  const i = name === undefined ? file.queries.findIndex((q) => q.id === w.savedId) : -1;
  let id: string;
  if (i >= 0) {
    file.queries[i] = { ...file.queries[i], text: w.query };
    id = file.queries[i].id;
  } else {
    if (!name?.trim()) return;
    id = newId();
    file.queries.push({ id, conn, name: name.trim(), text: w.query });
  }
  await writeFile(p, file);
  const text = w.query;
  up(tabId, (x) => { x.savedId = id; x.clean = text; });
  flash(`saved ${file.queries.find((q) => q.id === id)?.name}`);
}

export async function renameQuery(p: Project, id: string, name: string) {
  if (!name.trim()) return;
  const file = await readFile(p);
  const q = file.queries.find((x) => x.id === id);
  if (!q) return;
  q.name = name.trim();
  await writeFile(p, file);
}

export async function removeQuery(p: Project, id: string) {
  const file = await readFile(p);
  await writeFile(p, { ...file, queries: file.queries.filter((q) => q.id !== id) });
  setWins(produce((all) => { for (const w of Object.values(all)) if (w.savedId === id) w.savedId = undefined; }));
}

/** Put text in the Query view's editor: a Saved Query (`savedId`) or a new, unsaved one. */
export function openQueryText(tabId: string, text: string, savedId?: string) {
  up(tabId, (x) => Object.assign(x, { query: text, clean: text, savedId, queryRev: x.queryRev + 1, view: "query" }));
}

/** The Query view's first text, which counts as nothing to save. */
export const setStarter = (tabId: string, text: string) => up(tabId, (x) => { x.query = text; x.clean = text; });

export type EnvVar = { key: string; kind: DbKind };
export const envVars = (p: Project) => invoke<EnvVar[]>("db_env_vars", { host: p.host, root: rootOf(p) });

// ── MySQL or MariaDB ────────────────────────────────────────────────
// Both are the `mysql` kind; the server's version says which. It's remembered by Connection id
// once a window or Test has connected, so the start page's chip can say MARIADB too.

const [servers, setServers] = createStore<Record<string, string>>({});
const noteServer = (c: DbConn, version: string) => { if (c.kind === "mysql") setServers(c.id, version); };
export const isMaria = (c: DbConn) => c.kind === "mysql" && /^MariaDB\b/.test(servers[c.id] ?? "");

/** Open and close a Connection, for the form's Test button. */
export async function testConn(p: Project, c: DbConn, secret?: string): Promise<string> {
  if (secret) await invoke("db_secret_set", { host: p.host, root: rootOf(p), id: c.id, secret });
  const o = await invoke<{ session: number; version: string; tunnel: number | null }>("db_open", { host: p.host, root: rootOf(p), conn: c });
  noteServer(c, o.version);
  await invoke("db_close", { session: o.session });
  return o.tunnel ? `${o.version} · tunnel 127.0.0.1:${o.tunnel}` : o.version;
}

// ── windows ─────────────────────────────────────────────────────────

export const [wins, setWins] = createStore<Record<string, Win>>({});

const blank = (): Win => ({
  status: "opening", groups: [], shut: [], view: "data", source: "table", structs: {}, offset: 0, filter: "", loading: false,
  sel: { r: 0, c: 0 }, pending: {}, query: "", queryRev: 0, resTab: 0, running: false, paging: false,
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
  setWins(tab.id, { ...blank(), query: w?.query ?? "", savedId: w?.savedId, clean: w?.clean, queryRev: w?.queryRev ?? 0, pending: w?.pending ?? {} });
  try {
    // A spreadsheet is read (and a CSV written back) where the file is, not always on the project's host.
    const host = isSheet(c) ? hostAt(p, sheetPathOf(c)) : p.host;
    const o = await invoke<{ session: number; version: string; tunnel: number | null }>("db_open", { host, root: rootOf(p), conn: c });
    noteServer(c, o.version);
    up(tab.id,(x) => Object.assign(x, { status: "open", session: o.session, version: o.version, tunnel: o.tunnel }));
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
  up(tabId, (x) => Object.assign(x, { obj: sel, source: "table", sort: undefined, filter: "", offset: 0, sel: { r: 0, c: 0 }, doc: undefined, page: undefined, pageError: undefined }));
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

/** The latest page request by window: an older reply arriving later is dropped. */
const pageReq = new Map<string, number>();

export async function loadPage(tabId: string) {
  const w = wins[tabId];
  if (!w?.session || !w.obj) return;
  const obj = w.obj;
  const n = (pageReq.get(tabId) ?? 0) + 1;
  pageReq.set(tabId, n);
  up(tabId, (x) => { x.loading = true; });
  try {
    const page = await invoke<Page>("db_rows", {
      session: w.session,
      req: { group: obj.group, name: obj.name, offset: w.offset, filter: w.filter, sort: w.sort?.col ?? null, desc: !!w.sort?.desc, key: structOf(w)?.key ?? [] },
    });
    if (pageReq.get(tabId) !== n) return;
    up(tabId, (x) => {
      if (x.obj && objKey(x.obj) !== objKey(obj)) return;
      Object.assign(x, { page, loading: false, pageError: undefined });
      x.sel.r = Math.min(x.sel.r, Math.max(0, page.rows.length - 1));
    });
  } catch (e) {
    if (pageReq.get(tabId) !== n) return;
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
/** Show the picked table's rows in the Data view again, in place of the Query Result. */
export const showTable = (tabId: string) => up(tabId, (x) => { x.source = "table"; x.view = "data"; });
/** Show the Query Result in the Data view. */
export const showResult = (tabId: string) => up(tabId, (x) => { x.source = "query"; x.view = "data"; });
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
    const begin = c.kind === "mysql" ? "START TRANSACTION;" : "BEGIN;";
    up(tabId, (x) => { x.review = { ops, text: [begin, ...ops.map((o) => o.sql + ";"), "COMMIT;"], note: s.applyNote }; });
  }
}

export const closeReview = (tabId: string) => up(tabId, (x) => { x.review = undefined; });

/** Run the reviewed statements. `file` names the CSV a spreadsheet window writes back. */
export async function apply(tabId: string, file?: string) {
  const w = wins[tabId];
  if (!w?.session || !w.review || !w.obj) return;
  const key = objKey(w.obj);
  try {
    const n = await invoke<number>("db_apply", { session: w.session, ops: unwrap(w.review.ops) });
    undoLog.set(tabId, (undoLog.get(tabId) ?? []).filter((s) => s.key !== key));
    up(tabId, (x) => { x.review = undefined; x.pending[key] = emptyPending(); x.applyError = undefined; });
    flash(`applied · ${n} ${n === 1 ? "row" : "rows"} changed${file ? ` · saved ${file}` : ""}`);
    // A CSV was loaded again from what was written: its rowids start over.
    if (file) await loadSchema(tabId);
    else await loadPage(tabId);
  } catch (e) {
    up(tabId, (x) => { x.review = undefined; x.applyError = errText(e); });
  }
}

// ── Query ───────────────────────────────────────────────────────────

/** Run `text` and show its result in the Data view (the Query view shows it too). */
export async function runQuery(tabId: string, text: string) {
  const w = wins[tabId];
  if (!w?.session || w.running || !text.trim()) return;
  up(tabId, (x) => Object.assign(x, { running: true, runError: undefined, view: "data", source: "query" }));
  try {
    const r = await invoke<{ run: number; sets: ResultSet[] }>("db_run", { session: w.session, text, scope: w.obj?.group ?? null });
    up(tabId, (x) => Object.assign(x, { run: r.run, results: r.sets, resTab: 0, running: false, paging: false }));
  } catch (e) {
    up(tabId, (x) => Object.assign(x, { running: false, runError: errText(e), run: undefined, results: undefined }));
  }
}

/** The shown result's next page, from the rows the Session holds. */
export async function moreRows(tabId: string) {
  const w = wins[tabId];
  const i = w?.resTab ?? 0;
  const set = w?.results?.[i];
  if (!w?.session || w.paging || !set || set.rows.length >= set.total) return;
  const run = w.run;
  up(tabId, (x) => { x.paging = true; });
  try {
    const rows = await invoke<Cell[][]>("db_result_rows", { session: w.session, run, set: i, offset: set.rows.length });
    up(tabId, (x) => {
      x.paging = false;
      if (x.run === run) x.results?.[i]?.rows.push(...rows);
    });
  } catch (e) {
    up(tabId, (x) => { x.paging = false; });
    flash(errText(e));
  }
}

/** Export the shown result as CSV: every row the Session holds, or the ones loaded. */
export async function exportCsv(tabId: string, which: "all" | "loaded", name: string) {
  const w = wins[tabId];
  const i = w?.resTab ?? 0;
  const set = w?.results?.[i];
  if (!w?.session || !set) return;
  const path = await pickSavePath({ title: "Export CSV", defaultPath: `${name.replace(/[\\/:*?"<>|]+/g, "-") || "query"}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (!path) return;
  try {
    const out = await invoke<{ rows: number }>("db_csv", { session: w.session, run: w.run, set: i, rows: which === "all" ? null : set.rows.length, path });
    flash(`exported ${out.rows.toLocaleString()} ${out.rows === 1 ? "row" : "rows"} · ${path.split(/[\\/]/).pop()}`);
  } catch (e) {
    flash(errText(e));
  }
}

/** The loaded rows of the shown result, as CSV, to the clipboard. */
export async function copyCsv(tabId: string) {
  const w = wins[tabId];
  const i = w?.resTab ?? 0;
  const set = w?.results?.[i];
  if (!w?.session || !set) return;
  try {
    const out = await invoke<{ rows: number; text: string }>("db_csv", { session: w.session, run: w.run, set: i, rows: set.rows.length, path: null });
    await navigator.clipboard.writeText(out.text);
    flash(`copied ${out.rows.toLocaleString()} ${out.rows === 1 ? "row" : "rows"} as CSV`);
  } catch (e) {
    flash(errText(e));
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
