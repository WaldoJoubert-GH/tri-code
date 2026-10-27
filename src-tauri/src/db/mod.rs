//! The Database Window's backend (ADR 0004): Sessions on Postgres, SQLite and MongoDB behind
//! one set of commands, so the window never branches on the driver for anything but syntax.
//!
//! A Session is an open Connection: its client, and for an ssh project with `via: "host"` the
//! tunnel it talks through. Results are columns plus rows of JSON cells, at most `PAGE` rows a
//! set and `CELL` bytes a cell. Pending Edits arrive as ready statements (built and shown by the
//! window, see `db.ts`) and are applied in one transaction, each checked against the rows it
//! expects to change.

// With every driver left out the commands still exist, but nothing past the match runs.
#![cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mongo")), allow(unused, unreachable_code))]

mod target;
mod tunnel;
#[cfg(feature = "db-mongo")]
mod mongo;
#[cfg(feature = "db-pg")]
mod pg;
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

/// Rows in one result set or page. One more is fetched to know there are more.
pub const PAGE: usize = 500;
/// Bytes in one cell; a longer value comes back as `{ "__cut": prefix, "len": n }`.
const CELL: usize = 64 * 1024;

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
    Sqlite,
    Mongo,
}

/// `{ "env": "DATABASE_URL" }`, `{ "url": "postgres://…" }` or `{ "file": "./dev.db" }`.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Env(String),
    Url(String),
    File(String),
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
#[derive(Serialize, Default, Debug)]
pub struct ResultSet {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    /// More rows than `PAGE` were left behind.
    pub more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected: Option<u64>,
    pub ms: u64,
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
    #[cfg(feature = "db-mongo")]
    Mongo(mongo::Mongo),
    /// A build with every driver left out still compiles; it can't open anything.
    #[cfg(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mongo")))]
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
            #[cfg(feature = "db-mongo")]
            Driver::Mongo($d) => $body,
            #[cfg(not(any(feature = "db-pg", feature = "db-sqlite", feature = "db-mongo")))]
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
    let remote = !matches!(host.as_str(), "" | "local");
    let url = target::resolve(&host, &root, &conn).await?;
    if conn.kind == Kind::Sqlite && remote {
        return Err("SQLite on an ssh host isn't supported yet: the file lives over there".into());
    }
    #[cfg_attr(not(feature = "db-pg"), allow(unused_variables))]
    let original = url.clone();
    let mut url = url;
    let tunnel = if remote && conn.via == Via::Host && conn.kind != Kind::Sqlite {
        if url.starts_with("mongodb+srv://") {
            return Err("mongodb+srv:// is a cloud address: set Connect to Direct".into());
        }
        let default_port = if conn.kind == Kind::Mongo { 27017 } else { 5432 };
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
        #[allow(unreachable_patterns)]
        _ => return Err("this build of tri-code leaves that database out".into()),
    };
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let s = Session { driver, read_only: conn.read_only, busy: Default::default(), _tunnel: tunnel };
    SESSIONS.lock().unwrap().insert(id, Arc::new(s));
    Ok(Opened { session: id, version, tunnel: port })
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
    each!(&s.driver, d => d.rows(&req).await)
}

/// Run what the Query view holds. `scope` is the database a Mongo command runs in.
#[tauri::command]
pub async fn db_run(session: u64, text: String, scope: Option<String>) -> Result<Vec<ResultSet>, String> {
    let s = self::session(session)?;
    let _busy = s.busy.lock().await;
    let t0 = Instant::now();
    let res: Result<Vec<ResultSet>, String> = each!(&s.driver, d => d.run(&text, scope.as_deref(), s.read_only).await);
    let mut sets = res?;
    let ms = t0.elapsed().as_millis() as u64;
    for set in &mut sets {
        set.ms = ms;
    }
    Ok(sets)
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

/// A text cell, cut at `CELL` bytes.
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
#[cfg_attr(not(feature = "db-mongo"), allow(dead_code))]
pub(crate) fn cap(v: Value) -> Value {
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
#[cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite")), allow(dead_code))]
pub(crate) fn qi(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// A WHERE text from the filter box must stay one expression: no `;` outside quotes.
#[cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite")), allow(dead_code))]
pub(crate) fn one_expression(filter: &str) -> Result<(), String> {
    let mut quote: Option<char> = None;
    for c in filter.chars() {
        match (quote, c) {
            (None, '\'' | '"') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, ';') => return Err("the filter is one WHERE expression: use the Query view for statements".into()),
            _ => {}
        }
    }
    Ok(())
}

/// `SELECT … FROM t WHERE … ORDER BY … LIMIT … OFFSET …` for a Data page, Postgres and SQLite alike.
#[cfg_attr(not(any(feature = "db-pg", feature = "db-sqlite")), allow(dead_code))]
pub(crate) fn page_sql(from: &str, req: &RowsReq, rowid: bool) -> Result<String, String> {
    one_expression(&req.filter)?;
    let mut sql = format!("SELECT {}* FROM {from}", if rowid { "rowid AS \"rowid\", " } else { "" });
    if !req.filter.trim().is_empty() {
        sql += &format!(" WHERE {}", req.filter.trim());
    }
    let dir = if req.desc { "DESC" } else { "ASC" };
    let mut order: Vec<String> = req.sort.iter().map(|c| format!("{} {dir}", qi(c))).collect();
    order.extend(req.key.iter().filter(|k| req.sort.as_deref() != Some(k)).map(|k| qi(k)));
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
        assert!(one_expression("plan = 'pro'").is_ok());
        assert!(one_expression("body LIKE '%;%'").is_ok());
        assert!(one_expression("1=1; DROP TABLE users").is_err());
    }

    #[test]
    fn page_sql_orders_by_sort_then_key() {
        let req = RowsReq { group: "public".into(), name: "users".into(), offset: 500, filter: "plan = 'pro'".into(), sort: Some("email".into()), desc: true, key: vec!["id".into()] };
        assert_eq!(
            page_sql("\"public\".\"users\"", &req, false).unwrap(),
            "SELECT * FROM \"public\".\"users\" WHERE plan = 'pro' ORDER BY \"email\" DESC, \"id\" LIMIT 501 OFFSET 500"
        );
    }

    #[test]
    fn long_cells_are_cut() {
        let v = text_cell(&"é".repeat(CELL));
        assert_eq!(v["len"], CELL * 2);
        assert!(v["__cut"].as_str().unwrap().len() <= CELL);
    }
}
