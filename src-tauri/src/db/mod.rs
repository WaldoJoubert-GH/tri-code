//! The Database Window's backend (ADR 0004): Sessions on Postgres, MySQL, SQLite and MongoDB behind
//! one set of commands, so the window never branches on the driver for anything but syntax.
//!
//! A Session is an open Connection: its client, and for an ssh project with `via: "host"` the
//! tunnel it talks through. Results are columns plus rows of JSON cells. A Data page is `PAGE`
//! rows. A query's result is read whole (up to `HOLD`) and held by the Session: the window is
//! sent `PAGE` rows at a time, and Export CSV writes the held rows, so nothing runs twice. A cell
//! is cut at `CELL` bytes on its way to the window, never in what is held or exported. Pending
//! Edits arrive as ready statements (built and shown by the window, see `db.ts`) and are applied
//! in one transaction, each checked against the rows it expects to change.

// With every driver left out the commands still exist, but nothing past the match runs.
#![cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mongo", feature = "db-mysql")), allow(unused, unreachable_code))]

mod target;
pub(crate) mod tunnel;
#[cfg(feature = "db-mongo")]
mod mongo;
#[cfg(feature = "db-mysql")]
mod mysql;
#[cfg(feature = "db-pg")]
mod pg;
#[cfg(feature = "db-sqlite")]
mod sheet;
#[cfg(feature = "db-sqlite")]
mod sqlite;
#[cfg(feature = "db-pg")]
mod tls;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Rows in a Data page (one more is fetched to know there are more), and in each piece of a
/// query's result sent to the window.
pub const PAGE: usize = 500;
/// Bytes in one cell sent to the window; a longer value goes as `{ "__cut": prefix, "len": n }`.
const CELL: usize = 64 * 1024;
/// Bytes of cells a query's results may hold (roughly: see `Fill`). Past it the statement is
/// cancelled and its set says `more`.
pub const HOLD: usize = 256 << 20;

/// A Data page's read: `PAGE` rows and one more, to know there are more.
pub(crate) const PAGE_READ: Limit = Limit::Rows(PAGE + 1);

/// How much a call may read: rows (a Data page) or bytes across every set (a query).
#[derive(Clone, Copy, Debug)]
pub(crate) enum Limit {
    Rows(usize),
    Bytes(usize),
}

/// What a call has read so far, against its `Limit`.
pub(crate) struct Fill {
    limit: Limit,
    rows: usize,
    bytes: usize,
}

impl Fill {
    pub(crate) fn new(limit: Limit) -> Fill {
        Fill { limit, rows: 0, bytes: 0 }
    }

    /// No more rows fit.
    pub(crate) fn full(&self) -> bool {
        match self.limit {
            Limit::Rows(n) => self.rows >= n,
            Limit::Bytes(n) => self.bytes >= n,
        }
    }

    pub(crate) fn add(&mut self, row: &[Value]) {
        let n = if let Limit::Bytes(_) = self.limit { row.iter().map(size).sum() } else { 0 };
        self.add_bytes(n);
    }

    /// A row that costs about `n` bytes.
    pub(crate) fn add_bytes(&mut self, n: usize) {
        self.rows += 1;
        self.bytes += n;
    }
}

/// About what a cell costs in memory: its text plus the Value around it.
fn size(v: &Value) -> usize {
    32 + match v {
        Value::String(s) => s.len(),
        Value::Array(a) => a.iter().map(size).sum(),
        Value::Object(o) => o.iter().map(|(k, v)| k.len() + size(v)).sum(),
        _ => 0,
    }
}

/// A saved Connection, as the window keeps it in `.dev/databases.json`.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub kind: Kind,
    pub target: Target,
    #[serde(default)]
    pub via: Via,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Postgres,
    /// MySQL or MariaDB: one kind, the server's version says which.
    Mysql,
    Sqlite,
    Mongo,
}

/// `{ "env": "DATABASE_URL" }`, `{ "url": "postgres://…" }` or `{ "file": "./dev.db" }`; or
/// `{ "sheet": "/abs/data.csv" }`, a spreadsheet file loaded into memory (never saved as a Connection).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Env(String),
    Url(String),
    File(String),
    Sheet(String),
}

#[derive(Deserialize, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    #[default]
    Direct,
    Host,
}

#[derive(Serialize, Default, Clone, Debug)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

/// One statement's result: rows, or the count it changed.
#[derive(Serialize, Default, Debug, Clone)]
pub struct ResultSet {
    pub columns: Vec<Column>,
    /// Every row read; sent to the window, the first `PAGE`.
    pub rows: Vec<Vec<Value>>,
    /// The statement had more rows than fit in `HOLD`: they were left behind.
    pub more: bool,
    /// Rows read, of which `rows` are sent.
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected: Option<u64>,
    pub ms: u64,
}

/// A query's results as the window gets them: `run` names them for the pages that follow.
#[derive(Serialize)]
pub struct Ran {
    run: u64,
    sets: Vec<ResultSet>,
}

/// The latest query's full results, by Session.
#[derive(Default)]
struct Held {
    run: u64,
    sets: Vec<ResultSet>,
}

/// A page of a table or collection for the Data view.
#[derive(Serialize)]
pub struct Page {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub more: bool,
    /// Rows in the table (or matching the filter) when that is cheap to know.
    pub total: Option<u64>,
}

#[derive(Deserialize)]
pub struct RowsReq {
    #[cfg_attr(not(any(feature = "db-pg", feature = "db-mongo")), allow(dead_code))]
    pub group: String,
    pub name: String,
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub filter: String,
    pub sort: Option<String>,
    #[serde(default)]
    pub desc: bool,
    /// The columns that find a row (`Structure::key`), for a stable order and SQLite's rowid.
    #[serde(default)]
    pub key: Vec<String>,
}

/// A schema (Postgres), the main file (SQLite) or a database (Mongo), and what it holds.
#[derive(Serialize)]
pub struct Group {
    pub name: String,
    pub objects: Vec<Obj>,
}

#[derive(Serialize)]
pub struct Obj {
    pub name: String,
    /// `table`, `view`, `system` or `collection`.
    pub kind: &'static str,
    pub count: Option<u64>,
}

#[derive(Serialize, Default)]
pub struct Structure {
    pub columns: Vec<ColInfo>,
    /// The columns that find one row: the primary key, `rowid`, or `_id`. Empty: not editable.
    pub key: Vec<String>,
    pub indexes: Vec<Named>,
    pub fks: Vec<Named>,
    pub ddl: String,
    /// Said before Apply, e.g. that a MyISAM table can't roll back a failed batch.
    #[serde(rename = "applyNote", skip_serializing_if = "Option::is_none")]
    pub apply_note: Option<String>,
}

#[derive(Serialize)]
pub struct ColInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub nullable: bool,
    pub pk: bool,
    pub default: Option<String>,
}

#[derive(Serialize)]
pub struct Named {
    pub name: String,
    pub def: String,
}

#[derive(Serialize)]
pub struct Opened {
    session: u64,
    version: String,
    /// The local end of the ssh tunnel, when there is one.
    tunnel: Option<u16>,
}

enum Driver {
    #[cfg(feature = "db-pg")]
    Pg(pg::Pg),
    #[cfg(feature = "db-sqlite")]
    Sqlite(sqlite::Lite),
    #[cfg(feature = "db-sqlite")]
    Sheet(sheet::Sheet),
    #[cfg(feature = "db-mongo")]
    Mongo(mongo::Mongo),
    #[cfg(feature = "db-mysql")]
    My(mysql::My),
    /// A build with every driver left out still compiles; it can't open anything.
    #[cfg(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mongo", feature = "db-mysql")))]
    #[allow(dead_code)]
    None(std::convert::Infallible),
}

/// The same call on whichever driver the Session has.
macro_rules! each {
    ($drv:expr, $d:ident => $body:expr) => {
        match $drv {
            #[cfg(feature = "db-pg")]
            Driver::Pg($d) => $body,
            #[cfg(feature = "db-sqlite")]
            Driver::Sqlite($d) => $body,
            #[cfg(feature = "db-sqlite")]
            Driver::Sheet($d) => $body,
            #[cfg(feature = "db-mongo")]
            Driver::Mongo($d) => $body,
            #[cfg(feature = "db-mysql")]
            Driver::My($d) => $body,
            #[cfg(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mongo", feature = "db-mysql")))]
            Driver::None(n) => match *n {},
        }
    };
}

struct Session {
    driver: Driver,
    read_only: bool,
    /// One call at a time, so a page load can't land inside an apply's transaction.
    /// Cancel doesn't take it.
    busy: tokio::sync::Mutex<()>,
    held: Mutex<Held>,
    _tunnel: Option<tunnel::Tunnel>,
}

static SESSIONS: LazyLock<Mutex<HashMap<u64, Arc<Session>>>> = LazyLock::new(Default::default);
static NEXT: AtomicU64 = AtomicU64::new(1);

fn session(id: u64) -> Result<Arc<Session>, String> {
    SESSIONS.lock().unwrap().get(&id).cloned().ok_or_else(|| "the connection was closed: reopen the window".into())
}

/// Close every Session (and its tunnel) as the app exits.
pub fn close_all() {
    SESSIONS.lock().unwrap().clear();
}

#[tauri::command]
pub async fn db_open(host: String, root: String, conn: Connection) -> Result<Opened, String> {
    // A spreadsheet file is read on the project's host and queried here, so ssh projects work too.
    if let Target::Sheet(path) = &conn.target {
        #[cfg(feature = "db-sqlite")]
        {
            let (d, version, book) = sheet::open(&host, path).await?;
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let s = Session { driver: Driver::Sheet(d), read_only: conn.read_only || book, busy: Default::default(), held: Default::default(), _tunnel: None };
            SESSIONS.lock().unwrap().insert(id, Arc::new(s));
            return Ok(Opened { session: id, version, tunnel: None });
        }
        #[allow(unreachable_code)]
        return Err(format!("this build of tri-code can't open {path} as a table"));
    }
    let remote = !matches!(host.as_str(), "" | "local");
    let url = target::resolve(&host, &root, &conn).await?;
    if conn.kind == Kind::Sqlite && remote {
        return Err("SQLite on an ssh host isn't supported yet: the file lives over there".into());
    }
    #[cfg_attr(not(any(feature = "db-pg", feature = "db-mysql")), allow(unused_variables))]
    let original = url.clone();
    let mut url = url;
    let tunnel = if remote && conn.via == Via::Host && conn.kind != Kind::Sqlite {
        if url.starts_with("mongodb+srv://") {
            return Err("mongodb+srv:// is a cloud address: set Connect to Direct".into());
        }
        let default_port = default_port(conn.kind);
        let (h, p) = target::first_host(&url, default_port).ok_or("can't find the database's host in the URL")?;
        let t = tunnel::open(&host, &h, p).await?;
        url = target::point_at(&url, "127.0.0.1", t.port);
        if conn.kind == Kind::Mongo {
            url = target::with_param(&url, "directConnection", "true");
        }
        Some(t)
    } else {
        None
    };
    let port = tunnel.as_ref().map(|t| t.port);
    let (driver, version) = match conn.kind {
        #[cfg(feature = "db-pg")]
        Kind::Postgres => {
            // Through a tunnel TLS still names the real server, so verify-full can check it.
            let sni = tunnel.as_ref().and_then(|_| target::first_host(&original, 5432)).map(|(h, _)| h);
            let (d, v) = pg::connect(&url, conn.read_only, sni).await?;
            (Driver::Pg(d), v)
        }
        #[cfg(feature = "db-sqlite")]
        Kind::Sqlite => {
            let (d, v) = sqlite::open(&url, &root, conn.read_only)?;
            (Driver::Sqlite(d), v)
        }
        #[cfg(feature = "db-mongo")]
        Kind::Mongo => {
            let (d, v) = mongo::connect(&url).await?;
            (Driver::Mongo(d), v)
        }
        #[cfg(feature = "db-mysql")]
        Kind::Mysql => {
            // Through a tunnel TLS still names the real server, as for Postgres.
            let real = tunnel.as_ref().and_then(|_| target::first_host(&original, 3306)).map(|(h, _)| h);
            let (d, v) = mysql::connect(&url, conn.read_only, real).await?;
            (Driver::My(d), v)
        }
        #[allow(unreachable_patterns)]
        _ => return Err("this build of tri-code leaves that database out".into()),
    };
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let s = Session { driver, read_only: conn.read_only, busy: Default::default(), held: Default::default(), _tunnel: tunnel };
    SESSIONS.lock().unwrap().insert(id, Arc::new(s));
    Ok(Opened { session: id, version, tunnel: port })
}

fn default_port(kind: Kind) -> u16 {
    match kind {
        Kind::Mongo => 27017,
        Kind::Mysql => 3306,
        Kind::Postgres | Kind::Sqlite => 5432,
    }
}

#[tauri::command]
pub fn db_close(session: u64) {
    if let Some(s) = SESSIONS.lock().unwrap().remove(&session) {
        each!(&s.driver, d => d.cancel());
    }
}

#[tauri::command]
pub async fn db_schema(session: u64) -> Result<Vec<Group>, String> {
    let s = self::session(session)?;
    let _busy = s.busy.lock().await;
    each!(&s.driver, d => d.schema().await)
}

#[tauri::command]
pub async fn db_structure(session: u64, group: String, name: String, kind: String) -> Result<Structure, String> {
    let s = self::session(session)?;
    let _busy = s.busy.lock().await;
    each!(&s.driver, d => d.structure(&group, &name, &kind).await)
}

#[tauri::command]
pub async fn db_rows(session: u64, req: RowsReq) -> Result<Page, String> {
    let s = self::session(session)?;
    let _busy = s.busy.lock().await;
    let mut page: Page = each!(&s.driver, d => d.rows(&req).await)?;
    page.rows = cut(&page.rows);
    Ok(page)
}

static NEXT_RUN: AtomicU64 = AtomicU64::new(1);

/// Run what the Query view holds. `scope` is the database a Mongo command runs in. Every row
/// is read and held; the window gets the first `PAGE` of each set and asks `db_result_rows` for more.
#[tauri::command]
pub async fn db_run(session: u64, text: String, scope: Option<String>) -> Result<Ran, String> {
    let s = self::session(session)?;
    let _busy = s.busy.lock().await;
    // The last results go first, so two never sit in memory together.
    *s.held.lock().unwrap() = Held::default();
    let t0 = Instant::now();
    let res: Result<Vec<ResultSet>, String> = each!(&s.driver, d => d.run(&text, scope.as_deref(), s.read_only, Limit::Bytes(HOLD)).await);
    let mut sets = res?;
    let ms = t0.elapsed().as_millis() as u64;
    for set in &mut sets {
        set.ms = ms;
        set.total = set.rows.len();
    }
    let sent = sets.iter().map(|set| ResultSet { rows: cut(&set.rows[..set.total.min(PAGE)]), columns: set.columns.clone(), ..*set }).collect();
    let run = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
    *s.held.lock().unwrap() = Held { run, sets };
    Ok(Ran { run, sets: sent })
}

fn held_set<'a>(held: &'a Held, run: u64, set: usize) -> Result<&'a ResultSet, String> {
    if held.run != run {
        return Err("a newer run replaced these results: run the query again".into());
    }
    held.sets.get(set).ok_or_else(|| "no such result set".into())
}

/// The next `PAGE` rows of a held set, from `offset`.
#[tauri::command]
pub fn db_result_rows(session: u64, run: u64, set: usize, offset: usize) -> Result<Vec<Vec<Value>>, String> {
    let s = self::session(session)?;
    let held = s.held.lock().unwrap();
    let set = held_set(&held, run, set)?;
    let from = offset.min(set.rows.len());
    Ok(cut(&set.rows[from..(from + PAGE).min(set.rows.len())]))
}

/// A held set as CSV: its first `rows` rows, or all of them. Written to `path` (on this
/// machine, from a save dialog) with the count returned, or without one returned as text.
#[tauri::command]
pub async fn db_csv(session: u64, run: u64, set: usize, rows: Option<usize>, path: Option<String>) -> Result<CsvOut, String> {
    let s = self::session(session)?;
    tauri::async_runtime::spawn_blocking(move || {
        let held = s.held.lock().unwrap();
        let set = held_set(&held, run, set)?;
        let n = rows.unwrap_or(usize::MAX).min(set.rows.len());
        match path {
            Some(p) => {
                let f = std::fs::File::create(&p).map_err(|e| format!("can't write {p}: {e}"))?;
                let mut w = std::io::BufWriter::new(f);
                write_csv(&mut w, &set.columns, &set.rows[..n]).map_err(|e| format!("can't write {p}: {e}"))?;
                Ok(CsvOut { rows: n, text: None })
            }
            None => {
                let mut buf = Vec::new();
                write_csv(&mut buf, &set.columns, &set.rows[..n]).map_err(|e| e.to_string())?;
                Ok(CsvOut { rows: n, text: Some(String::from_utf8_lossy(&buf).into_owned()) })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct CsvOut {
    rows: usize,
    text: Option<String>,
}

/// RFC 4180: a header row of the column names, CRLF line ends, a field quoted when it holds a
/// comma, quote or line break, or starts or ends with a space.
fn write_csv(w: &mut impl std::io::Write, columns: &[Column], rows: &[Vec<Value>]) -> std::io::Result<()> {
    let line = |w: &mut dyn std::io::Write, fields: &mut dyn Iterator<Item = String>| -> std::io::Result<()> {
        for (i, f) in fields.enumerate() {
            if i > 0 {
                w.write_all(b",")?;
            }
            let quote = f.contains([',', '"', '\n', '\r']) || f.starts_with(' ') || f.ends_with(' ');
            if quote {
                write!(w, "\"{}\"", f.replace('"', "\"\""))?;
            } else {
                w.write_all(f.as_bytes())?;
            }
        }
        w.write_all(b"\r\n")
    };
    line(w, &mut columns.iter().map(|c| c.name.clone()))?;
    for r in rows {
        line(w, &mut r.iter().map(csv_field))?;
    }
    w.flush()
}

/// A cell as CSV text: NULL is empty; a Mongo ObjectId, date or long is its value; other nested
/// values are JSON.
fn csv_field(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(o) if o.len() == 1 => match o.iter().next() {
            Some((k, Value::String(s))) if matches!(k.as_str(), "$oid" | "$date" | "$numberLong" | "$numberDecimal") => s.clone(),
            Some((k, Value::Number(n))) if k == "__blob" => format!("<blob {n} bytes>"),
            _ => v.to_string(),
        },
        Value::Object(_) | Value::Array(_) => v.to_string(),
        v => v.to_string(),
    }
}

/// Rows as the window gets them: each cell cut at `CELL`.
fn cut(rows: &[Vec<Value>]) -> Vec<Vec<Value>> {
    rows.iter().map(|r| r.iter().cloned().map(cap).collect()).collect()
}

#[tauri::command]
pub fn db_cancel(session: u64) {
    if let Ok(s) = self::session(session) {
        each!(&s.driver, d => d.cancel());
    }
}

/// Apply Pending Edits: SQL drivers take `{ sql, expect }`, Mongo `{ op, db, coll, filter, doc }`.
/// All or nothing where the database allows it; returns the rows changed.
#[tauri::command]
pub async fn db_apply(session: u64, ops: Vec<Value>) -> Result<u64, String> {
    let s = self::session(session)?;
    if s.read_only {
        return Err("read-only Connection".into());
    }
    let _busy = s.busy.lock().await;
    each!(&s.driver, d => d.apply(ops).await)
}

/// A workbook (`.xlsx`, `.xls`, `.ods`…) as tables for the editor's read-only table view.
#[tauri::command]
pub async fn sheet_read(host: String, path: String) -> Result<serde_json::Value, String> {
    #[cfg(feature = "db-sqlite")]
    return serde_json::to_value(sheet::read_book(host, path).await?).map_err(|e| e.to_string());
    #[allow(unreachable_code)]
    Err(format!("this build of tri-code can't read {path}: {host}"))
}

/// `.env` keys whose value looks like a database URL, for the connection form.
#[tauri::command]
pub async fn db_env_vars(host: String, root: String) -> Result<Vec<target::EnvVar>, String> {
    target::env_vars(&host, &root).await
}

/// Keep (or with `None`, forget) a URL Connection's password on the project's host.
#[tauri::command]
pub async fn db_secret_set(host: String, root: String, id: String, secret: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || target::set_secret(&host, &root, &id, secret.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// A text cell, whole: `cut` shortens it for the window.
#[cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mysql")), allow(dead_code))]
pub(crate) fn text(s: &str) -> Value {
    Value::String(s.to_string())
}

/// A text cell, cut at `CELL` bytes: for what goes to the window without `cut`.
pub(crate) fn text_cell(s: &str) -> Value {
    if s.len() <= CELL {
        return Value::String(s.to_string());
    }
    let mut end = CELL;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    json!({ "__cut": &s[..end], "len": s.len() })
}

/// Any cell, cut when its JSON is longer than `CELL` bytes.
fn cap(v: Value) -> Value {
    match v {
        Value::String(s) => text_cell(&s),
        Value::Object(_) | Value::Array(_) => {
            let s = v.to_string();
            if s.len() > CELL { text_cell(&s) } else { v }
        }
        v => v,
    }
}

/// `"name"` with inner quotes doubled.
#[cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mysql")), allow(dead_code))]
pub(crate) fn qi(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// How names are quoted and strings escaped: Postgres and SQLite (`"name"`), or MySQL
/// (`` `name` ``, and `\` an escape inside a string).
#[derive(Clone, Copy, PartialEq, Debug)]
#[cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mysql")), allow(dead_code))]
pub(crate) enum Dialect {
    Std,
    My,
}

#[cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mysql")), allow(dead_code))]
impl Dialect {
    pub(crate) fn q(self, name: &str) -> String {
        match self {
            Dialect::Std => qi(name),
            Dialect::My => format!("`{}`", name.replace('`', "``")),
        }
    }
}

/// A WHERE text from the filter box must stay one expression: no `;` outside quotes and comments.
#[cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mysql")), allow(dead_code))]
pub(crate) fn one_expression(d: Dialect, filter: &str) -> Result<(), String> {
    let my = d == Dialect::My;
    let c: Vec<char> = filter.chars().collect();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < c.len() {
        match quote {
            Some(q) if my && q != '`' && c[i] == '\\' => i += 1,
            Some(q) if c[i] == q => quote = None,
            Some(_) => {}
            None => match c[i] {
                '\'' | '"' => quote = Some(c[i]),
                '`' if my => quote = Some('`'),
                '-' if c.get(i + 1) == Some(&'-') => i = c[i..].iter().position(|&x| x == '\n').map_or(c.len(), |n| i + n),
                '#' if my => i = c[i..].iter().position(|&x| x == '\n').map_or(c.len(), |n| i + n),
                '/' if c.get(i + 1) == Some(&'*') => i = c[i + 2..].windows(2).position(|w| w == ['*', '/']).map_or(c.len(), |n| i + 2 + n + 1),
                ';' => return Err("the filter is one WHERE expression: use the Query view for statements".into()),
                _ => {}
            },
        }
        i += 1;
    }
    Ok(())
}

/// `SELECT … FROM t WHERE … ORDER BY … LIMIT … OFFSET …` for a Data page, Postgres, SQLite and MySQL alike.
#[cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mysql")), allow(dead_code))]
pub(crate) fn page_sql(d: Dialect, from: &str, req: &RowsReq, rowid: bool) -> Result<String, String> {
    one_expression(d, &req.filter)?;
    let mut sql = format!("SELECT {}* FROM {from}", if rowid { "rowid AS \"rowid\", " } else { "" });
    if !req.filter.trim().is_empty() {
        sql += &format!(" WHERE {}", req.filter.trim());
    }
    let dir = if req.desc { "DESC" } else { "ASC" };
    let mut order: Vec<String> = req.sort.iter().map(|c| format!("{} {dir}", d.q(c))).collect();
    order.extend(req.key.iter().filter(|k| req.sort.as_deref() != Some(k)).map(|k| d.q(k)));
    if !order.is_empty() {
        sql += &format!(" ORDER BY {}", order.join(", "));
    }
    sql += &format!(" LIMIT {} OFFSET {}", PAGE + 1, req.offset);
    Ok(sql)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_stay_one_expression() {
        for d in [Dialect::Std, Dialect::My] {
            assert!(one_expression(d, "plan = 'pro'").is_ok());
            assert!(one_expression(d, "body LIKE '%;%'").is_ok());
            assert!(one_expression(d, "1=1; DROP TABLE users").is_err());
            // A comment can't hide a quote that the `;` after it would seem to be inside.
            assert!(one_expression(d, "x = 1 -- '\n; DROP TABLE users; '").is_err());
            assert!(one_expression(d, "x = 1 /* ' */; DROP TABLE users; '").is_err());
        }
        // MySQL: `\'` stays inside the string, `#` is a comment, backticks quote names.
        assert!(one_expression(Dialect::My, r"note = '\'' ; DROP TABLE users; '").is_err());
        assert!(one_expression(Dialect::My, "x = 1 # '\n; DROP TABLE users; '").is_err());
        assert!(one_expression(Dialect::My, r"note = 'a\';b'").is_ok());
        assert!(one_expression(Dialect::My, "`we;ird` = 1").is_ok());
        // Postgres: a backtick is no quote.
        assert!(one_expression(Dialect::Std, "x = `; DROP TABLE users; `").is_err());
    }

    #[test]
    fn page_sql_orders_by_sort_then_key() {
        let req = RowsReq { group: "public".into(), name: "users".into(), offset: 500, filter: "plan = 'pro'".into(), sort: Some("email".into()), desc: true, key: vec!["id".into()] };
        assert_eq!(
            page_sql(Dialect::Std, "\"public\".\"users\"", &req, false).unwrap(),
            "SELECT * FROM \"public\".\"users\" WHERE plan = 'pro' ORDER BY \"email\" DESC, \"id\" LIMIT 501 OFFSET 500"
        );
        assert_eq!(
            page_sql(Dialect::My, "`app`.`users`", &req, false).unwrap(),
            "SELECT * FROM `app`.`users` WHERE plan = 'pro' ORDER BY `email` DESC, `id` LIMIT 501 OFFSET 500"
        );
    }

    #[test]
    fn quoted_names() {
        assert_eq!(qi("a\"b"), "\"a\"\"b\"");
        assert_eq!(Dialect::My.q("a`b"), "`a``b`");
    }

    #[test]
    fn long_cells_are_cut() {
        let v = text_cell(&"é".repeat(CELL));
        assert_eq!(v["len"], CELL * 2);
        assert!(v["__cut"].as_str().unwrap().len() <= CELL);
        // Held whole, cut on the way to the window.
        let rows = vec![vec![text(&"x".repeat(CELL + 10)), json!(1)]];
        let sent = cut(&rows);
        assert_eq!(sent[0][0]["len"], CELL + 10);
        assert_eq!(sent[0][1], json!(1));
    }

    #[test]
    fn csv_quotes_and_flattens_cells() {
        let columns = [Column { name: "id".into(), ty: String::new() }, Column { name: "note, with comma".into(), ty: String::new() }];
        let rows = vec![
            vec![json!(1), json!("plain")],
            vec![json!(2), json!("say \"hi\"\nbye")],
            vec![Value::Null, json!(" padded")],
            vec![json!({ "$oid": "64b4a2cc0e3d826827b02582" }), json!({ "a": [1, 2] })],
            vec![json!({ "__blob": 12 }), json!(true)],
            vec![json!("x".repeat(CELL + 1)), json!(1.5)],
        ];
        let mut out = Vec::new();
        write_csv(&mut out, &columns, &rows).unwrap();
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = text.split("\r\n").collect();
        assert_eq!(lines[0], "id,\"note, with comma\"");
        assert_eq!(lines[1], "1,plain");
        assert_eq!(lines[2], "2,\"say \"\"hi\"\"\nbye\"");
        assert_eq!(lines[3], ",\" padded\"");
        assert_eq!(lines[4], "64b4a2cc0e3d826827b02582,\"{\"\"a\"\":[1,2]}\"");
        assert_eq!(lines[5], "<blob 12 bytes>,true");
        // A long cell is written whole, not cut.
        assert_eq!(lines[6].len(), CELL + 1 + 4);
        assert_eq!(lines[7], "");
    }

    #[test]
    fn fill_counts_rows_or_bytes() {
        let mut f = Fill::new(Limit::Rows(2));
        f.add(&[json!(1)]);
        assert!(!f.full());
        f.add(&[json!(1)]);
        assert!(f.full());
        let mut f = Fill::new(Limit::Bytes(100));
        f.add(&[json!("x".repeat(60))]);
        assert!(!f.full());
        f.add(&[json!("x".repeat(10))]);
        assert!(f.full());
    }
}
