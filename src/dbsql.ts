// The Database Window's pure half: how a cell reads, how typed text becomes a value, and how
// Pending Edits become the statements the review shows and `db_apply` runs (ADR 0004).
// No imports, so `bun test` covers it.

export type DbKind = "postgres" | "sqlite" | "mongo";
/** A cell as the backend sends it. Postgres cells are the text Postgres prints; Mongo cells are
 *  relaxed Extended JSON; `{ __cut, len }` is a value cut at 64 KB, `{ __blob }` a SQLite blob. */
export type Cell = null | string | number | boolean | { [k: string]: unknown } | unknown[];

/** The table or collection the edits are on. `group` is a schema, `main`, or a Mongo database. */
export type Target = { kind: DbKind; group: string; name: string };

/** Pending Edits of one table, keyed by the row's key values (`rowKey`). */
export type Pending = {
  /** Changed cells: the row as loaded, and the new value of each changed column. */
  edits: Record<string, { row: Record<string, Cell>; set: Record<string, Cell> }>;
  /** New rows, column → value; a column left out takes its default. */
  added: Record<string, Cell>[];
  /** Deleted rows, as loaded. */
  deleted: Record<string, Record<string, Cell>>;
};

export const emptyPending = (): Pending => ({ edits: {}, added: [], deleted: {} });
export const pendingCount = (p: Pending | undefined) =>
  p ? Object.values(p.edits).reduce((n, e) => n + Object.keys(e.set).length, 0) + p.added.length + Object.keys(p.deleted).length : 0;

export type SqlOp = { sql: string; expect: number };
export type MongoOp = { op: "insert" | "update" | "delete"; db: string; coll: string; filter?: Cell; doc?: Cell };

/** Cut or binary: shown, not edited. */
export const isOpaque = (v: Cell) => !!v && typeof v === "object" && !Array.isArray(v) && ("__cut" in v || "__blob" in v);

/** The key that finds a row on the page and in the Pending Edits. */
export const rowKey = (key: string[], row: Record<string, Cell>) => JSON.stringify(key.map((k) => row[k] ?? null));

/** What a cell shows in the grid. */
export function cellText(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  if ("__cut" in v) return `${v.__cut}… (${kb(Number(v.len))})`;
  if ("__blob" in v) return `<blob ${kb(Number(v.__blob))}>`;
  if ("$oid" in v) return `ObjectId(${v.$oid})`;
  if ("$date" in v && typeof v.$date === "string") return v.$date;
  if ("$numberLong" in v) return String(v.$numberLong);
  if ("$numberDecimal" in v) return String(v.$numberDecimal);
  return JSON.stringify(v);
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** A nested document or array, which the grid shows as a chip and the side panel opens. */
export const isNested = (v: Cell) => !!v && typeof v === "object" && !isOpaque(v) && (Array.isArray(v) || !Object.keys(v).some((k) => k.startsWith("$")));

/** The text an edit box starts with. */
export const editText = (v: Cell) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

const NUMERIC = /int|real|num|float|double|dec|serial/i;

/** Typed text as a value of the column. Empty is NULL when the column allows it. Postgres takes
 *  text (it casts), SQLite a number for a numeric column, Mongo the original's JSON type. */
export function parseInput(kind: DbKind, text: string, was: Cell, type: string, nullable: boolean): Cell {
  if (text === "" && nullable) return null;
  if (kind === "postgres") return text;
  if (kind === "sqlite") return NUMERIC.test(type) && text.trim() !== "" && !isNaN(Number(text)) ? Number(text) : text;
  if (typeof was === "string") return text;
  if (typeof was === "number") return isNaN(Number(text)) ? text : Number(text);
  try {
    return JSON.parse(text) as Cell;
  } catch {
    return text;
  }
}

export const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A value as an SQL literal. Postgres gets quoted text and casts it to the column's type. */
export function lit(kind: DbKind, v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  if (kind === "sqlite" && typeof v === "number") return String(v);
  if (kind === "sqlite" && typeof v === "boolean") return v ? "1" : "0";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

/** Types Postgres can't compare with `=`: their text is compared instead. */
const NO_EQUALS = /^(jsonb?|xml|point|line|lseg|box|path|polygon|circle)\b/;

/** "The cell still holds what was loaded", null-safe. */
function still(kind: DbKind, col: string, v: Cell, type: string): string {
  if (v === null) return `${qi(col)} IS NULL`;
  if (kind === "sqlite") return `${qi(col)} IS ${lit(kind, v)}`;
  const c = NO_EQUALS.test(type) ? `${qi(col)}::text` : qi(col);
  return `${c} IS NOT DISTINCT FROM ${lit(kind, v)}`;
}

const where = (t: Target, key: string[], row: Record<string, Cell>) =>
  key.map((k) => (k === "rowid" ? `rowid = ${Number(row[k])}` : `${qi(k)} = ${lit(t.kind, row[k] ?? null)}`));

const table = (t: Target) => (t.kind === "sqlite" ? qi(t.name) : `${qi(t.group)}.${qi(t.name)}`);

/** Pending Edits as statements: inserts, then updates, then deletes. Each update also checks
 *  the cells it changes still hold what was loaded, and expects to change exactly one row. */
export function sqlOps(t: Target, key: string[], types: Record<string, string>, p: Pending): SqlOp[] {
  const out: SqlOp[] = [];
  for (const row of p.added) {
    const cols = Object.keys(row).filter((c) => row[c] !== null && row[c] !== "");
    out.push({
      sql: cols.length
        ? `INSERT INTO ${table(t)} (${cols.map(qi).join(", ")}) VALUES (${cols.map((c) => lit(t.kind, row[c])).join(", ")})`
        : `INSERT INTO ${table(t)} DEFAULT VALUES`,
      expect: 1,
    });
  }
  for (const k of Object.keys(p.edits)) {
    if (p.deleted[k]) continue;
    const { row, set } = p.edits[k];
    const cols = Object.keys(set);
    if (!cols.length) continue;
    const conds = [...where(t, key, row), ...cols.map((c) => still(t.kind, c, row[c] ?? null, types[c] ?? ""))];
    out.push({ sql: `UPDATE ${table(t)} SET ${cols.map((c) => `${qi(c)} = ${lit(t.kind, set[c])}`).join(", ")} WHERE ${conds.join(" AND ")}`, expect: 1 });
  }
  for (const row of Object.values(p.deleted)) {
    out.push({ sql: `DELETE FROM ${table(t)} WHERE ${where(t, key, row).join(" AND ")}`, expect: 1 });
  }
  return out;
}

/** The same for a collection: by `_id`, an update also matching the old values of what it sets. */
export function mongoOps(t: Target, p: Pending): MongoOp[] {
  const base = { db: t.group, coll: t.name };
  const out: MongoOp[] = [];
  for (const row of p.added) {
    const doc = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== ""));
    out.push({ ...base, op: "insert", doc });
  }
  for (const k of Object.keys(p.edits)) {
    if (p.deleted[k]) continue;
    const { row, set } = p.edits[k];
    if (!Object.keys(set).length) continue;
    const filter: Record<string, Cell> = { _id: row._id ?? null };
    for (const c of Object.keys(set)) filter[c] = row[c] ?? null;
    out.push({ ...base, op: "update", filter, doc: set });
  }
  for (const row of Object.values(p.deleted)) out.push({ ...base, op: "delete", filter: { _id: row._id ?? null } });
  return out;
}

/** The review's text for Mongo changes, in mongosh's words. */
export function mongoText(ops: MongoOp[]): string[] {
  const j = (v: unknown) => JSON.stringify(v);
  return ops.map((o) =>
    o.op === "insert" ? `db.${o.coll}.insertOne(${j(o.doc)})`
    : o.op === "update" ? `db.${o.coll}.updateOne(${j(o.filter)}, { "$set": ${j(o.doc)} })`
    : `db.${o.coll}.deleteOne(${j(o.filter)})`,
  );
}

/** A statement that changes data or schema, which a `prod` Connection asks about first. */
export function writes(kind: DbKind, text: string): boolean {
  if (kind === "mongo") return /"(insert|update|delete|findAndModify|drop|dropDatabase|create|createIndexes|dropIndexes|renameCollection)"\s*:|"\$(out|merge)"/.test(text);
  const bare = text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/'(?:[^']|'')*'/g, "''");
  return /\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|vacuum|reindex|replace|upsert)\b/i.test(bare);
}
