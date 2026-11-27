# 0004. A native Database Window for Postgres, SQLite and MongoDB

Date: 2026-10-27

## Status

Accepted.

## Context

Projects want to look at and change their databases without leaving tri-code. We weighed three shapes: running db-studio (`npx db-studio`) in a Browser Window, native Rust drivers, and driving `psql` / `sqlite3` / `mongosh` on the project's host. db-studio keeps its Connections per user, not per project, needs Node on the host and a port forward for ssh projects, and is young (no tagged releases). The CLI route needs three tools installed on every host and lives off their output formats. Native drivers cost binary size and compile time but give us our own UI, keys and per-project Connections.

## Decision

1. **Native drivers in `src-tauri/src/db/`**: `tokio-postgres` + `tokio-postgres-rustls`, `rusqlite` (bundled), `mongodb` (rustls). They reuse the `rustls 0.23` / `ring` / `tokio` already in the tree through `ureq` and `axum`. Each sits behind a cargo feature (`db-pg`, `db-sqlite`, `db-mongo`, all default) so a dev build can leave Mongo out.

2. **One interface for all three.** The frontend sees `db_open`, `db_schema`, `db_rows`, `db_run` (+ `db_cancel`), `db_edit` and `db_close`. Every result is `{ columns, rows, truncated, affected, ms }` with JSON cells: big integers and numerics as strings, bytes as truncated hex, times as ISO. A page is at most 500 rows and a cell at most 64 KB. Mongo flattens top-level keys into columns; nested values are JSON cells.
   *Since:* a `db_run` result is no longer cut at 500 rows. The Session reads every row (up to 256 MB of cells, then cancels) and holds it; `db_run` returns the first 500 of each set with a `run` id, `db_result_rows` the next 500, and `db_csv` writes the held rows as CSV. Cells are held whole and cut to 64 KB only on their way to the window. Holding the result (rather than a server-side cursor) keeps the connection free for the Data view, and lets Export write exactly what ran without running it again.

3. **Connections live in `.dev/databases.json`** on the project's host, written only by tri-code (like `local-issues.json`). A Connection is `{ id, name, kind, target, via, readOnly, tag }`. `target` is either `{ env: "DATABASE_URL" }`, read from the project's `.env` at connect time, so most Connections store no secret; or a URL whose password is kept out of `.dev/`, in `~/.tri-code/secrets/databases.json` on the host, keyed by project path and Connection id (the same pattern as Plane's token).

4. **ssh projects tunnel.** `via: "host"` opens `ssh -N -L 127.0.0.1:<free>:<dbhost>:<port>` with `envssh::args`, after `envssh::check`, so a PIN-locked Environment is never reached. The tunnel belongs to the Session and dies with it. Mongo through a tunnel connects with `directConnection=true`; `mongodb+srv://` is always `via: "direct"`. **SQLite is local only**: a project on an ssh host shows its SQLite Connections as unsupported for now.

5. **One Database Window per Connection** (`TabKind "db"`), so two databases can tile side by side. `Alt+Shift+D` focuses the most recent one, or opens a new one on its start page (the project's Connections and the form); `Alt+D` is Diff. The Command Palette lists each Connection. The window has a schema tree and Data, Query and Structure views. Query uses `cm.ts` with `lang-sql` (PostgreSQL or SQLite dialect, completion from `db_schema`) or JSON for Mongo, where the Query view takes `runCommand` documents and Data takes EJSON filter and sort.

6. **Inline editing ships in v1, as Pending Edits.** Edited cells, new rows and deleted rows are staged and highlighted, not written. Apply shows the generated statements and runs them in one transaction (Postgres, SQLite) or as one ordered batch (Mongo). Rows are found by primary key (SQLite falls back to `rowid`; a table or view with neither is read-only) or by `_id`, and an edit also checks the cell's original value, so a row changed underneath fails instead of being overwritten.

7. **Safety.** `readOnly` opens Postgres with `default_transaction_read_only=on`, SQLite with `SQLITE_OPEN_READ_ONLY`, and allows Mongo only read commands; the grid can't be edited. `tag: "prod"` colours the header red and asks before every Apply or write statement. Every statement has a default timeout and can be cancelled.

## Consequences

- The binary grows, mostly through the Mongo driver. Phase 1 measures it with SQLite alone before the other two land.
- `.dev/databases.json` is a new Dev Directory file; pi-todos and dev-hub can ignore it.
- Agents get no database access yet. `db_run` is kept free of UI so a read-only, project-scoped MCP tool can wrap it later, like agent windows.
- Remote SQLite and `db.x.find(...)` syntax for Mongo are left for later.

Phases: (1) SQLite local, Data + Query + Pending Edits; (2) Postgres, tunnels, `.env` Connections; (3) Mongo; (4) agent MCP tool.

Addendum (2026-11-11): Spreadsheet Files (CSV, TSV, Excel, OpenDocument) open in the same window through a fourth target, `{ sheet: path }`, which is never saved as a Connection. `db/sheet.rs` reads the file on the project's host (`csv` and `calamine`, behind `db-sqlite`) into an in-memory SQLite, so the window, its SQL and its Pending Edits are unchanged; Apply on a CSV runs the statements and rewrites the file in one step, rolling both back if the file changed on disk. Unlike a SQLite Connection this works for ssh projects: only the bytes travel. Workbooks are read-only.

Addendum (2026-11-26): **MySQL and MariaDB** are a fourth driver, `db/mysql.rs` on `mysql_async` (rustls on ring, behind `db-mysql`, on by default), as one kind `mysql`: the server's version says which, for the chip and the Query view's dialect. A group is a MySQL database; the URL's own database is listed first and system databases are left out. Queries use the text protocol, so cells are the server's text as with Postgres. The connection sets `CLIENT_FOUND_ROWS`, because MySQL otherwise counts an UPDATE's *changed* rows and a cell set to the value it holds would fail the `expect: 1` check. Cancel and the 500-row cap send `KILL QUERY` from a second connection, as MySQL has no cancel token. `readOnly` is `SET SESSION TRANSACTION READ ONLY`, and the timeout `max_execution_time` (MySQL) or `max_statement_time` (MariaDB). `dbsql.ts` writes MySQL with backticks, `<=>`, `CAST(… AS CHAR)` for json and floats, `() VALUES ()` and backslashes escaped in literals, since MySQL reads `\` as an escape. Forcing `ANSI_QUOTES` instead was rejected: it would change what the user's own Query text means. A table on a non-transactional engine (MyISAM) gets a note in the review, since a failed batch can't roll back. TLS comes from the URL in any of its common spellings (`ssl-mode`, `sslaccept`, `ssl`, `tls`), and other parameters are dropped. Chosen from design/mysql-connection.html (variant A).
