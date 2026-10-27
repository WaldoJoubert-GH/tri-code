// bun test: Pending Edits to statements, cells and typed input (src/dbsql.ts).

import { describe, expect, test } from "bun:test";
import { type Pending, cellText, emptyPending, mongoOps, mongoText, parseInput, pendingCount, rowKey, sqlOps, writes } from "./dbsql";

const users = { kind: "postgres" as const, group: "public", name: "users" };
const types = { id: "bigint", plan: "text", meta: "jsonb", ok: "boolean" };

describe("sqlOps", () => {
  test("an update finds the row by key and checks the old value", () => {
    const p: Pending = { ...emptyPending(), edits: { "[1002]": { row: { id: "1002", plan: "free", ok: "t" }, set: { plan: "pro", ok: "f" } } } };
    expect(sqlOps(users, ["id"], types, p)).toEqual([
      {
        sql: `UPDATE "public"."users" SET "plan" = 'pro', "ok" = 'f' WHERE "id" = '1002' AND "plan" IS NOT DISTINCT FROM 'free' AND "ok" IS NOT DISTINCT FROM 't'`,
        expect: 1,
      },
    ]);
  });

  test("json is compared as text, null with IS NULL, quotes are doubled", () => {
    const p: Pending = { ...emptyPending(), edits: { k: { row: { id: "1", meta: '{"a": 1}', plan: null }, set: { meta: '{"a": 2}', plan: "it's" } } } };
    expect(sqlOps(users, ["id"], types, p)[0].sql).toBe(
      `UPDATE "public"."users" SET "meta" = '{"a": 2}', "plan" = 'it''s' WHERE "id" = '1' AND "meta"::text IS NOT DISTINCT FROM '{"a": 1}' AND "plan" IS NULL`,
    );
  });

  test("inserts first, deletes last, a deleted row's edits are dropped", () => {
    const p: Pending = {
      added: [{ email: "new@x", plan: "" }, {}],
      edits: { "[7]": { row: { id: "7", plan: "free" }, set: { plan: "pro" } } },
      deleted: { "[7]": { id: "7", plan: "free" } },
    };
    expect(sqlOps(users, ["id"], types, p).map((o) => o.sql)).toEqual([
      `INSERT INTO "public"."users" ("email") VALUES ('new@x')`,
      `INSERT INTO "public"."users" DEFAULT VALUES`,
      `DELETE FROM "public"."users" WHERE "id" = '7'`,
    ]);
  });

  test("SQLite: numbers bare, IS for the old value, rowid for a keyless table", () => {
    const tags = { kind: "sqlite" as const, group: "main", name: "tags" };
    const p: Pending = { ...emptyPending(), edits: { "[3]": { row: { rowid: 3, n: 4, name: "x" }, set: { n: 5 } } }, deleted: { "[4]": { rowid: 4 } } };
    expect(sqlOps(tags, ["rowid"], {}, p).map((o) => o.sql)).toEqual([
      `UPDATE "tags" SET "n" = 5 WHERE rowid = 3 AND "n" IS 4`,
      `DELETE FROM "tags" WHERE rowid = 4`,
    ]);
  });
});

describe("mongoOps", () => {
  test("by _id, matching the old values of what is set", () => {
    const t = { kind: "mongo" as const, group: "analytics", name: "events" };
    const id = { $oid: "64b4a2cc0e3d826827b02582" };
    const p: Pending = { added: [{ type: "signup", n: "" }], edits: { k: { row: { _id: id, type: "login" }, set: { type: "logout" } } }, deleted: { d: { _id: id } } };
    const ops = mongoOps(t, p);
    expect(ops).toEqual([
      { db: "analytics", coll: "events", op: "insert", doc: { type: "signup" } },
      { db: "analytics", coll: "events", op: "update", filter: { _id: id, type: "login" }, doc: { type: "logout" } },
      { db: "analytics", coll: "events", op: "delete", filter: { _id: id } },
    ]);
    expect(mongoText(ops)[1]).toBe(`db.events.updateOne({"_id":{"$oid":"64b4a2cc0e3d826827b02582"},"type":"login"}, { "$set": {"type":"logout"} })`);
  });
});

test("parseInput follows each database", () => {
  expect(parseInput("postgres", "", "x", "text", true)).toBeNull();
  expect(parseInput("postgres", "", "x", "text", false)).toBe("");
  expect(parseInput("postgres", "42", "1", "bigint", false)).toBe("42");
  expect(parseInput("sqlite", "42", 1, "INTEGER", false)).toBe(42);
  expect(parseInput("sqlite", "42", "1", "TEXT", false)).toBe("42");
  expect(parseInput("mongo", "7", 1, "int", true)).toBe(7);
  expect(parseInput("mongo", "7", "1", "string", true)).toBe("7");
  expect(parseInput("mongo", '{"a":1}', { a: 0 }, "object", true)).toEqual({ a: 1 });
  expect(parseInput("mongo", "plain", null, "", true)).toBe("plain");
});

test("cells, keys and counts", () => {
  expect(cellText(null)).toBe("NULL");
  expect(cellText({ $oid: "abc" })).toBe("ObjectId(abc)");
  expect(cellText({ __cut: "abc", len: 70000 })).toBe("abc… (68.4 KB)");
  expect(cellText({ __blob: 12 })).toBe("<blob 12 B>");
  expect(rowKey(["id"], { id: 5, x: 1 })).toBe("[5]");
  const p: Pending = { added: [{}], edits: { a: { row: {}, set: { x: 1, y: 2 } } }, deleted: { b: {} } };
  expect(pendingCount(p)).toBe(4);
});

test("writes spots changes, not words in strings or comments", () => {
  expect(writes("postgres", "UPDATE users SET plan = 'pro'")).toBe(true);
  expect(writes("postgres", "SELECT * FROM users WHERE note = 'delete me' -- drop")).toBe(false);
  expect(writes("mongo", '{ "find": "events" }')).toBe(false);
  expect(writes("mongo", '{ "delete": "events", "deletes": [] }')).toBe(true);
  expect(writes("mongo", '{ "aggregate": "e", "pipeline": [{ "$out": "x" }] }')).toBe(true);
});
