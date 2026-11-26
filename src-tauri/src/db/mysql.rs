//! MySQL and MariaDB through mysql_async. Queries go over the text protocol, so every value is
//! the text the server prints (decimals keep their digits), and a script of several statements
//! gives one result set each, like pg.rs. A MySQL database is a group, as a Mongo one is.
//!
//! Two things differ from Postgres. MySQL counts the rows an UPDATE *changed*, so setting a cell
//! to the value it holds would look like "the row changed since it was loaded": the connection
//! asks for rows *found* instead (`CLIENT_FOUND_ROWS`). And there is no cancel token: cancel
//! opens a second connection and sends `KILL QUERY`.

use std::time::Duration;

use futures_util::StreamExt;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Row, SslOpts};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ColInfo, Column, Dialect, Group, Named, Obj, PAGE, Page, ResultSet, RowsReq, Structure, page_sql, text_cell};

const D: Dialect = Dialect::My;
/// Databases of the server itself, left out of the tree.
const SYSTEM: &str = "('mysql', 'information_schema', 'performance_schema', 'sys')";

pub struct My {
    conn: tokio::sync::Mutex<Conn>,
    /// The server's id for this connection, which `KILL QUERY` names.
    id: u32,
    opts: Opts,
}

/// How the URL asked for TLS. Each ecosystem spells it differently: the MySQL CLI's `ssl-mode`,
/// Prisma's `sslaccept`, node's `ssl`, Go's `tls`, and mysql_async's own `require_ssl`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tls {
    Off,
    /// Encrypt, but don't check the certificate (like libpq's `require`).
    Require,
    /// Check the certificate's chain, not its name.
    VerifyCa,
    Verify,
}

/// The URL mysql_async can parse (`mysql://`, no query: it refuses parameters it doesn't know),
/// and the TLS it asked for.
pub fn take_tls(url: &str) -> (String, Tls) {
    let url = match url.split_once("://") {
        Some((scheme, rest)) if matches!(scheme.to_ascii_lowercase().as_str(), "mysql2" | "mariadb" | "mysqlx") => format!("mysql://{rest}"),
        _ => url.to_string(),
    };
    let (base, query) = match url.split_once('?') {
        Some((b, q)) => (b.to_string(), q.split('#').next().unwrap_or("").to_string()),
        None => (url.split('#').next().unwrap_or("").to_string(), String::new()),
    };
    let mut tls = Tls::Off;
    for kv in query.split('&').filter(|kv| !kv.is_empty()) {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        let v = decode(v).to_ascii_lowercase();
        let v = v.as_str();
        tls = match k.to_ascii_lowercase().replace('_', "-").as_str() {
            "ssl-mode" | "sslmode" => match v {
                "required" | "require" => Tls::Require,
                "verify-ca" | "verify_ca" => Tls::VerifyCa,
                "verify-identity" | "verify_identity" | "verify-full" => Tls::Verify,
                _ => Tls::Off,
            },
            "sslaccept" => if v == "strict" { Tls::Verify } else { Tls::Require },
            "ssl" if v == "false" || v == "0" => Tls::Off,
            "ssl" => if v.replace(' ', "").contains("\"rejectunauthorized\":false") { Tls::Require } else { Tls::Verify },
            "tls" => match v {
                "true" => Tls::Verify,
                "skip-verify" | "preferred" => Tls::Require,
                _ => Tls::Off,
            },
            "require-ssl" if v == "true" => Tls::Verify,
            "verify-identity" if v == "false" && tls == Tls::Verify => Tls::VerifyCa,
            "verify-ca" if v == "false" && tls != Tls::Off => Tls::Require,
            _ => tls,
        };
    }
    (base, tls)
}

/// `%XX` decoded, for a JSON `ssl` value.
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i], b.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(x)) => {
                out.push(x);
                i += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                i += 1;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Tls {
    /// Through a tunnel the certificate still names `real_host`, not 127.0.0.1.
    fn ssl_opts(self, real_host: Option<String>) -> Option<SslOpts> {
        let base = SslOpts::default().with_danger_tls_hostname_override(real_host);
        match self {
            Tls::Off => None,
            Tls::Require => Some(base.with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true)),
            Tls::VerifyCa => Some(base.with_danger_skip_domain_validation(true)),
            Tls::Verify => Some(base),
        }
    }
}

pub async fn connect(url: &str, read_only: bool, real_host: Option<String>) -> Result<(My, String), String> {
    let (url, tls) = take_tls(url);
    let opts = Opts::from_url(&url).map_err(|e| format!("not a MySQL URL: {e}"))?;
    let opts: Opts = OptsBuilder::from_opts(opts).client_found_rows(true).ssl_opts(tls.ssl_opts(real_host)).into();
    let mut conn = tokio::time::timeout(Duration::from_secs(10), Conn::new(opts.clone()))
        .await
        .map_err(|_| "couldn't connect within 10 s".to_string())?
        .map_err(err)?;
    let raw: String = conn.query_first("SELECT VERSION()").await.map_err(err)?.unwrap_or_default();
    let maria = raw.to_ascii_lowercase().contains("mariadb");
    // A statement timeout, like Postgres's 30 s. Old servers lack the variable: carry on without it.
    let _ = conn.query_drop(if maria { "SET SESSION max_statement_time = 30" } else { "SET SESSION max_execution_time = 30000" }).await;
    if read_only {
        conn.query_drop("SET SESSION TRANSACTION READ ONLY").await.map_err(err)?;
    }
    let number = raw.split(['-', ' ']).next().unwrap_or(&raw);
    let version = format!("{} {number}", if maria { "MariaDB" } else { "MySQL" });
    Ok((My { id: conn.id(), conn: tokio::sync::Mutex::new(conn), opts }, version))
}

/// The server's code, state and message, or the error chain for a connection failure.
fn err(e: mysql_async::Error) -> String {
    if let mysql_async::Error::Server(s) = &e {
        return format!("ERROR {} ({}): {}", s.code, s.state, s.message);
    }
    let mut s = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(c) = src {
        let more = c.to_string();
        if !s.contains(&more) {
            s += &format!(": {more}");
        }
        src = c.source();
    }
    s
}

/// The column's type as MySQL names it in DDL, near enough for the grid's header.
fn type_name(c: &mysql_async::Column) -> String {
    let binary = c.character_set() == 63;
    let f = c.flags();
    let t = match c.column_type() {
        _ if f.contains(ColumnFlags::ENUM_FLAG) => "enum",
        _ if f.contains(ColumnFlags::SET_FLAG) => "set",
        ColumnType::MYSQL_TYPE_TINY => "tinyint",
        ColumnType::MYSQL_TYPE_SHORT => "smallint",
        ColumnType::MYSQL_TYPE_INT24 => "mediumint",
        ColumnType::MYSQL_TYPE_LONG => "int",
        ColumnType::MYSQL_TYPE_LONGLONG => "bigint",
        ColumnType::MYSQL_TYPE_FLOAT => "float",
        ColumnType::MYSQL_TYPE_DOUBLE => "double",
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL => "decimal",
        ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE => "date",
        ColumnType::MYSQL_TYPE_TIME | ColumnType::MYSQL_TYPE_TIME2 => "time",
        ColumnType::MYSQL_TYPE_DATETIME | ColumnType::MYSQL_TYPE_DATETIME2 => "datetime",
        ColumnType::MYSQL_TYPE_TIMESTAMP | ColumnType::MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        ColumnType::MYSQL_TYPE_YEAR => "year",
        ColumnType::MYSQL_TYPE_VARCHAR | ColumnType::MYSQL_TYPE_VAR_STRING => if binary { "varbinary" } else { "varchar" },
        ColumnType::MYSQL_TYPE_STRING => if binary { "binary" } else { "char" },
        ColumnType::MYSQL_TYPE_TINY_BLOB | ColumnType::MYSQL_TYPE_MEDIUM_BLOB | ColumnType::MYSQL_TYPE_LONG_BLOB | ColumnType::MYSQL_TYPE_BLOB => {
            if binary { "blob" } else { "text" }
        }
        ColumnType::MYSQL_TYPE_JSON => "json",
        ColumnType::MYSQL_TYPE_BIT => "bit",
        ColumnType::MYSQL_TYPE_GEOMETRY => "geometry",
        ColumnType::MYSQL_TYPE_VECTOR => "vector",
        ColumnType::MYSQL_TYPE_NULL => "null",
        _ => "",
    };
    if f.contains(ColumnFlags::UNSIGNED_FLAG) && !t.is_empty() { format!("{t} unsigned") } else { t.to_string() }
}

/// A cell: the text the server sent. Bytes that aren't text (a binary uuid, a bit, a geometry)
/// come back as `{ "__blob": len }`, shown and never edited, like a SQLite blob.
fn cell(c: &mysql_async::Column, v: Option<&mysql_async::Value>) -> Value {
    match v {
        None | Some(mysql_async::Value::NULL) => Value::Null,
        Some(mysql_async::Value::Bytes(b)) => {
            let opaque = matches!(c.column_type(), ColumnType::MYSQL_TYPE_BIT | ColumnType::MYSQL_TYPE_GEOMETRY);
            match std::str::from_utf8(b) {
                Ok(s) if !opaque => text_cell(s),
                _ if c.character_set() == 63 || opaque => json!({ "__blob": b.len() }),
                _ => text_cell(&String::from_utf8_lossy(b)),
            }
        }
        // Only the binary protocol sends these; the text protocol sends bytes.
        Some(v) => text_cell(v.as_sql(true).trim_matches('\'')),
    }
}

#[derive(Deserialize)]
struct Op {
    sql: String,
    expect: Option<u64>,
}

/// Engines whose writes roll back.
const TRANSACTIONAL: &[&str] = &["innodb", "ndbcluster", "ndb", "rocksdb", "tokudb"];

impl My {
    pub fn cancel(&self) {
        let (opts, id) = (self.opts.clone(), self.id);
        tauri::async_runtime::spawn(async move {
            if let Ok(Ok(mut c)) = tokio::time::timeout(Duration::from_secs(5), Conn::new(opts)).await {
                let _ = c.query_drop(format!("KILL QUERY {id}")).await;
                let _ = c.disconnect().await;
            }
        });
    }

    pub async fn schema(&self) -> Result<Vec<Group>, String> {
        let mut conn = self.conn.lock().await;
        let rows: Vec<(String, String, String, Option<u64>)> = conn
            .query(format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES
                  WHERE TABLE_SCHEMA NOT IN {SYSTEM}
                  ORDER BY TABLE_SCHEMA <> COALESCE(DATABASE(), ''), TABLE_SCHEMA, TABLE_NAME"
            ))
            .await
            .map_err(err)?;
        let mut groups: Vec<Group> = Vec::new();
        for (db, name, ty, n) in rows {
            let view = ty.contains("VIEW");
            let obj = Obj { name, kind: if view { "view" } else { "table" }, count: if view { None } else { n } };
            match groups.last_mut() {
                Some(g) if g.name == db => g.objects.push(obj),
                _ => groups.push(Group { name: db, objects: vec![obj] }),
            }
        }
        Ok(groups)
    }

    pub async fn structure(&self, group: &str, name: &str, kind: &str) -> Result<Structure, String> {
        let mut conn = self.conn.lock().await;
        let at = (group, name);
        let cols: Vec<(String, String, i64, Option<String>, i64, String)> = conn
            .exec(
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE = 'YES', COLUMN_DEFAULT, COLUMN_KEY = 'PRI', EXTRA
                   FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                at,
            )
            .await
            .map_err(err)?;
        let columns: Vec<ColInfo> = cols
            .into_iter()
            .map(|(name, ty, nullable, default, pk, extra)| ColInfo {
                default: default.or_else(|| extra.to_ascii_lowercase().contains("auto_increment").then(|| "auto_increment".into())),
                name,
                ty,
                nullable: nullable != 0,
                pk: pk != 0,
            })
            .collect();
        let key: Vec<String> = conn
            .exec(
                "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
                  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
                at,
            )
            .await
            .map_err(err)?;

        // Indexes as SHOW CREATE TABLE writes them: PRIMARY KEY (…), UNIQUE KEY `x` (…), KEY `x` (…).
        let parts: Vec<(String, i64, Option<String>, String)> = conn
            .exec(
                "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME <> 'PRIMARY', INDEX_NAME, SEQ_IN_INDEX",
                at,
            )
            .await
            .map_err(err)?;
        let mut indexes: Vec<(String, i64, String, Vec<String>)> = Vec::new();
        for (ix, non_unique, col, ty) in parts {
            let col = col.map_or("(expression)".into(), |c| D.q(&c));
            match indexes.last_mut() {
                Some(last) if last.0 == ix => last.3.push(col),
                _ => indexes.push((ix, non_unique, ty, vec![col])),
            }
        }
        let indexes: Vec<Named> = indexes
            .into_iter()
            .map(|(ix, non_unique, ty, cols)| {
                let what = match (ix.as_str(), non_unique, ty.as_str()) {
                    ("PRIMARY", _, _) => "PRIMARY KEY".to_string(),
                    (_, _, "FULLTEXT") => format!("FULLTEXT KEY {}", D.q(&ix)),
                    (_, _, "SPATIAL") => format!("SPATIAL KEY {}", D.q(&ix)),
                    (_, 0, _) => format!("UNIQUE KEY {}", D.q(&ix)),
                    _ => format!("KEY {}", D.q(&ix)),
                };
                Named { def: format!("{what} ({})", cols.join(", ")), name: ix }
            })
            .collect();

        let refs: Vec<(String, String, String, String, String)> = conn
            .exec(
                "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
                   FROM information_schema.KEY_COLUMN_USAGE
                  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
                  ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
                at,
            )
            .await
            .map_err(err)?;
        let mut fks: Vec<(String, Vec<String>, String, Vec<String>)> = Vec::new();
        for (fk, col, db, table, to) in refs {
            match fks.last_mut() {
                Some(last) if last.0 == fk => {
                    last.1.push(D.q(&col));
                    last.3.push(D.q(&to));
                }
                _ => {
                    let target = if db == group { D.q(&table) } else { format!("{}.{}", D.q(&db), D.q(&table)) };
                    fks.push((fk, vec![D.q(&col)], target, vec![D.q(&to)]));
                }
            }
        }
        let fks = fks
            .into_iter()
            .map(|(fk, cols, target, to)| Named { def: format!("FOREIGN KEY ({}) REFERENCES {target} ({})", cols.join(", "), to.join(", ")), name: fk })
            .collect();

        let rel = format!("{}.{}", D.q(group), D.q(name));
        let view = kind == "view";
        let show: Option<Row> = conn.query_first(format!("SHOW CREATE {} {rel}", if view { "VIEW" } else { "TABLE" })).await.map_err(err)?;
        let ddl = show.and_then(|r| r.get::<String, usize>(1)).map(|s| s + ";").unwrap_or_default();

        let engine: Option<Option<String>> =
            conn.exec_first("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", at).await.map_err(err)?;
        let apply_note = engine.flatten().filter(|e| !TRANSACTIONAL.contains(&e.to_ascii_lowercase().as_str())).map(|e| {
            format!("{name} uses {e}, which has no transactions: if a statement fails, the ones before it stay written.")
        });

        // A view has no key to find a row by, so it isn't editable.
        let key = if view { Vec::new() } else { key };
        Ok(Structure { columns, key, indexes, fks, ddl, apply_note })
    }

    pub async fn rows(&self, req: &RowsReq) -> Result<Page, String> {
        let from = format!("{}.{}", D.q(&req.group), D.q(&req.name));
        let sql = page_sql(D, &from, req, false)?;
        let mut conn = self.conn.lock().await;
        let mut set = self.text(&mut conn, &sql, PAGE + 1).await?.into_iter().next().unwrap_or_default();
        let more = set.rows.len() > PAGE;
        set.rows.truncate(PAGE);
        let total = if req.filter.trim().is_empty() {
            // TABLE_ROWS is an estimate for InnoDB (and NULL for a view): count when it's small or unknown.
            let est: Option<Option<u64>> = conn
                .exec_first("SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", (&req.group, &req.name))
                .await
                .map_err(err)?;
            match est.flatten() {
                Some(n) if n >= 100_000 => Some(n),
                _ => conn.query_first::<u64, _>(format!("SELECT COUNT(*) FROM {from}")).await.ok().flatten(),
            }
        } else if !more && req.offset == 0 {
            Some(set.rows.len() as u64)
        } else {
            None
        };
        Ok(Page { columns: set.columns, rows: set.rows, more, total })
    }

    pub async fn run(&self, text: &str, _scope: Option<&str>, _read_only: bool) -> Result<Vec<ResultSet>, String> {
        let mut conn = self.conn.lock().await;
        self.text(&mut conn, text, PAGE).await
    }

    /// Run `sql` and keep at most `max` rows a set. Past that the query is killed, so a
    /// `SELECT *` on a huge table doesn't stream all of it; the set says `more`.
    async fn text(&self, conn: &mut Conn, sql: &str, max: usize) -> Result<Vec<ResultSet>, String> {
        let mut res = conn.query_iter(sql).await.map_err(err)?;
        let mut sets = Vec::new();
        let mut capped = false;
        loop {
            let mut stream = match res.stream::<Row>().await {
                Ok(Some(s)) => s,
                Ok(None) => break,
                Err(_) if capped => break,
                Err(e) => return Err(err(e)),
            };
            let cols = stream.columns();
            if cols.is_empty() {
                sets.push(ResultSet { affected: Some(stream.affected_rows()), ..Default::default() });
                continue;
            }
            let mut set = ResultSet { columns: cols.iter().map(|c| Column { name: c.name_str().into_owned(), ty: type_name(c) }).collect(), ..Default::default() };
            while let Some(row) = stream.next().await {
                let row = match row {
                    Ok(r) => r,
                    // The kill below ends the stream with "Query execution was interrupted".
                    Err(_) if capped => break,
                    Err(e) => return Err(err(e)),
                };
                if set.rows.len() >= max {
                    if !set.more {
                        set.more = true;
                        capped = true;
                        self.cancel();
                    }
                    continue;
                }
                set.rows.push(cols.iter().enumerate().map(|(i, c)| cell(c, row.as_ref(i))).collect());
            }
            sets.push(set);
            if capped {
                break;
            }
        }
        Ok(sets)
    }

    pub async fn apply(&self, ops: Vec<Value>) -> Result<u64, String> {
        let ops: Vec<Op> = ops.into_iter().map(serde_json::from_value).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        let mut conn = self.conn.lock().await;
        conn.query_drop("START TRANSACTION").await.map_err(err)?;
        let mut total = 0;
        for (i, op) in ops.iter().enumerate() {
            let res = conn.query_drop(op.sql.as_str()).await.map(|_| conn.affected_rows());
            let fail = match res {
                Ok(n) if op.expect.is_none_or(|e| e == n) => {
                    total += n;
                    None
                }
                Ok(n) => Some(format!("statement {} matched {n} rows, not {}: the row changed since it was loaded", i + 1, op.expect.unwrap_or(0))),
                Err(e) => Some(format!("statement {}: {}", i + 1, err(e))),
            };
            if let Some(f) = fail {
                let _ = conn.query_drop("ROLLBACK").await;
                return Err(format!("{f}. Nothing was written."));
            }
        }
        conn.query_drop("COMMIT").await.map_err(err)?;
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_tls() {
        assert_eq!(take_tls("mysql://app@db:3306/app"), ("mysql://app@db:3306/app".into(), Tls::Off));
        assert_eq!(take_tls("mysql2://app@db/app?encoding=utf8mb4&pool=5").0, "mysql://app@db/app");
        assert_eq!(take_tls("mariadb://app@db/app").0, "mysql://app@db/app");
        assert_eq!(take_tls("mysql://a@h/d?ssl-mode=REQUIRED").1, Tls::Require);
        assert_eq!(take_tls("mysql://a@h/d?ssl_mode=VERIFY_IDENTITY").1, Tls::Verify);
        assert_eq!(take_tls("mysql://a@h/d?sslmode=verify-ca").1, Tls::VerifyCa);
        assert_eq!(take_tls("mysql://a@h/d?sslaccept=strict").1, Tls::Verify);
        assert_eq!(take_tls("mysql://a@h/d?sslaccept=accept_invalid_certs").1, Tls::Require);
        assert_eq!(take_tls("mysql://a@h/d?ssl=%7B%22rejectUnauthorized%22%3Atrue%7D").1, Tls::Verify);
        assert_eq!(take_tls("mysql://a@h/d?ssl=%7B%22rejectUnauthorized%22%3A%20false%7D").1, Tls::Require);
        assert_eq!(take_tls("mysql://a@h/d?tls=skip-verify").1, Tls::Require);
        assert_eq!(take_tls("mysql://a@h/d?require_ssl=true&verify_identity=false").1, Tls::VerifyCa);
        assert_eq!(take_tls("mysql://a@h/d?ssl-mode=PREFERRED").1, Tls::Off);
    }

    /// Against a real server: `TRI_DB_MYSQL_URL=mysql://root:pw@127.0.0.1:3306/app cargo test --lib db::mysql -- --ignored`,
    /// on a database with the tables of pg.rs's test (users, orders, active_users, nokey).
    #[tokio::test]
    #[ignore]
    async fn browse_query_edit() {
        let url = std::env::var("TRI_DB_MYSQL_URL").expect("TRI_DB_MYSQL_URL");
        let (my, version) = connect(&url, false, None).await.unwrap();
        assert!(version.starts_with("MySQL ") || version.starts_with("MariaDB "), "{version}");
        let groups = my.schema().await.unwrap();
        assert_eq!(groups[0].name, "app");
        let s = my.structure("app", "users", "table").await.unwrap();
        assert_eq!(s.key, ["id"]);
        assert!(s.ddl.starts_with("CREATE TABLE `users`"), "{}", s.ddl);
        assert!(s.apply_note.is_none());
        assert!(my.structure("app", "active_users", "view").await.unwrap().key.is_empty());

        let req = |filter: &str| RowsReq { group: "app".into(), name: "users".into(), offset: 0, filter: filter.into(), sort: None, desc: false, key: vec!["id".into()] };
        let page = my.rows(&req("")).await.unwrap();
        assert_eq!((page.rows.len(), page.more, page.total), (500, true, Some(1200)));
        assert!(my.rows(&req("1; DROP TABLE users")).await.is_err());

        // Setting a cell to the value it holds still finds the row (CLIENT_FOUND_ROWS).
        let same = "UPDATE `app`.`users` SET `plan` = `plan` WHERE `id` = '7'";
        assert_eq!(my.apply(vec![json!({ "sql": same, "expect": 1 })]).await.unwrap(), 1);
        let gone = "UPDATE `app`.`users` SET `plan` = 'x' WHERE `id` = '7' AND `plan` <=> 'not what it holds'";
        let e = my.apply(vec![json!({ "sql": same, "expect": 1 }), json!({ "sql": gone, "expect": 1 })]).await.unwrap_err();
        assert!(e.contains("changed since"), "{e}");

        let sets = my.run("SELECT 1 AS a; UPDATE users SET plan = plan WHERE id < 4; SELECT 'x' AS b", None, false).await.unwrap();
        assert_eq!((sets.len(), sets[1].affected), (3, Some(3)));
        assert_eq!(sets[0].columns[0].ty, "bigint");
        // 1.44M rows, cut at 500 and killed.
        let big = my.run("SELECT a.id, b.id FROM users a CROSS JOIN users b", None, false).await.unwrap();
        assert_eq!((big[0].rows.len(), big[0].more), (PAGE, true));
        // The connection is still usable after the kill.
        assert_eq!(my.run("SELECT 2", None, false).await.unwrap()[0].rows[0][0], "2");
        let bad = my.run("SELECT nope FROM users", None, false).await.unwrap_err();
        assert!(bad.starts_with("ERROR 1054"), "{bad}");

        let (ro, _) = connect(&url, true, None).await.unwrap();
        let e = ro.run("UPDATE users SET plan = 'x' WHERE id = 1", None, true).await.unwrap_err();
        assert!(e.to_lowercase().contains("read only"), "{e}");
    }
}
