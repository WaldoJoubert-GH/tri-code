//! SQLite through rusqlite (bundled), local files only. Calls run on a blocking thread; a
//! running one is stopped with `sqlite3_interrupt`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::types::ValueRef;
use rusqlite::{Batch, Connection, InterruptHandle, OpenFlags};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ColInfo, Column, Group, Named, Obj, PAGE, Page, ResultSet, RowsReq, Structure, page_sql, qi, text_cell};

pub struct Lite {
    conn: Arc<Mutex<Connection>>,
    interrupt: InterruptHandle,
}

/// `file:./dev.db`, `sqlite:./dev.db` or a plain path, relative to the project.
fn path_of(target: &str, root: &str) -> PathBuf {
    let p = ["sqlite://", "sqlite:", "file://", "file:"].iter().find_map(|pre| target.strip_prefix(pre)).unwrap_or(target);
    let p = p.split('?').next().unwrap_or(p);
    let p = crate::spawn::expand_home(p);
    let p = Path::new(&p);
    if p.is_absolute() { p.to_path_buf() } else { Path::new(root).join(p) }
}

pub fn open(target: &str, root: &str, read_only: bool) -> Result<(Lite, String), String> {
    let path = path_of(target, root);
    // Opening a missing file would quietly create an empty database.
    if !path.is_file() {
        return Err(format!("no SQLite file at {}", path.display()));
    }
    let flags = OpenFlags::SQLITE_OPEN_NO_MUTEX | if read_only { OpenFlags::SQLITE_OPEN_READ_ONLY } else { OpenFlags::SQLITE_OPEN_READ_WRITE };
    let conn = Connection::open_with_flags(&path, flags).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let interrupt = conn.get_interrupt_handle();
    Ok((Lite { conn: Arc::new(Mutex::new(conn)), interrupt }, format!("SQLite {}", rusqlite::version())))
}

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        // Past 2^53 a JavaScript number loses digits, so big integers travel as text.
        ValueRef::Integer(i) if i.unsigned_abs() > (1 << 53) => Value::String(i.to_string()),
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => text_cell(&String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!({ "__blob": b.len() }),
    }
}

fn read_set(stmt: &mut rusqlite::Statement, max: usize) -> rusqlite::Result<ResultSet> {
    let columns: Vec<Column> = stmt.columns().map(|c| Column { name: c.name().to_string(), ty: c.decl_type().unwrap_or("").to_string() }).collect();
    let n = columns.len();
    let mut set = ResultSet { columns, ..Default::default() };
    let mut rows = stmt.raw_query();
    while let Some(row) = rows.next()? {
        if set.rows.len() >= max {
            set.more = true;
            break;
        }
        set.rows.push((0..n).map(|i| row.get_ref(i).map_or(Value::Null, cell)).collect());
    }
    Ok(set)
}

#[derive(Deserialize)]
struct Op {
    sql: String,
    expect: Option<u64>,
}

impl Lite {
    async fn on<T: Send + 'static>(&self, f: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let conn = self.conn.clone();
        tauri::async_runtime::spawn_blocking(move || f(&conn.lock().unwrap())).await.map_err(|e| e.to_string())?
    }

    pub fn cancel(&self) {
        self.interrupt.interrupt();
    }

    pub async fn schema(&self) -> Result<Vec<Group>, String> {
        self.on(|c| {
            let mut stmt = c.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").map_err(|e| e.to_string())?;
            let list: Vec<(String, String)> =
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
            let objects = list
                .into_iter()
                .map(|(ty, name)| {
                    let kind = if name.starts_with("sqlite_") { "system" } else if ty == "view" { "view" } else { "table" };
                    // A local dev file: counting is cheap enough to show in the tree.
                    let count = (kind != "view").then(|| c.query_row(&format!("SELECT count(*) FROM {}", qi(&name)), [], |r| r.get::<_, i64>(0)).ok()).flatten();
                    Obj { name, kind, count: count.map(|n| n as u64) }
                })
                .collect();
            Ok(vec![Group { name: "main".into(), objects }])
        })
        .await
    }

    pub async fn structure(&self, _group: &str, name: &str, kind: &str) -> Result<Structure, String> {
        let (name, kind) = (name.to_string(), kind.to_string());
        self.on(move |c| {
            let e = |e: rusqlite::Error| e.to_string();
            let mut stmt = c.prepare(&format!("PRAGMA table_info({})", qi(&name))).map_err(e)?;
            let mut cols: Vec<(i64, ColInfo)> = stmt
                .query_map([], |r| {
                    let pk: i64 = r.get(5)?;
                    Ok((pk, ColInfo { name: r.get(1)?, ty: r.get(2)?, nullable: r.get::<_, i64>(3)? == 0, default: r.get(4)?, pk: pk > 0 }))
                })
                .map_err(e)?
                .collect::<Result<_, _>>()
                .map_err(e)?;
            let mut pks: Vec<(i64, String)> = cols.iter().filter(|(p, _)| *p > 0).map(|(p, c)| (*p, c.name.clone())).collect();
            pks.sort();
            let sql: String = c
                .query_row("SELECT coalesce(sql, '') FROM sqlite_master WHERE name = ?1", [&name], |r| r.get(0))
                .unwrap_or_default();
            let without_rowid = sql.to_ascii_uppercase().contains("WITHOUT ROWID");
            let key = match kind.as_str() {
                "table" | "system" if !pks.is_empty() => pks.into_iter().map(|(_, n)| n).collect(),
                "table" | "system" if !without_rowid => vec!["rowid".to_string()],
                _ => Vec::new(),
            };
            let mut stmt = c.prepare("SELECT name, coalesce(sql, '') FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 ORDER BY name").map_err(e)?;
            let indexes: Vec<Named> =
                stmt.query_map([&name], |r| Ok(Named { name: r.get(0)?, def: r.get(1)? })).map_err(e)?.collect::<Result<_, _>>().map_err(e)?;
            let mut stmt = c.prepare(&format!("PRAGMA foreign_key_list({})", qi(&name))).map_err(e)?;
            let fks: Vec<Named> = stmt
                .query_map([], |r| {
                    let (table, from, to): (String, String, Option<String>) = (r.get(2)?, r.get(3)?, r.get(4)?);
                    Ok(Named { name: from.clone(), def: format!("FOREIGN KEY ({from}) REFERENCES {table}({})", to.unwrap_or_default()) })
                })
                .map_err(e)?
                .collect::<Result<_, _>>()
                .map_err(e)?;
            let mut ddl = format!("{sql};");
            for i in indexes.iter().filter(|i| !i.def.is_empty()) {
                ddl += &format!("\n{};", i.def);
            }
            Ok(Structure { columns: cols.drain(..).map(|(_, c)| c).collect(), key, indexes, fks, ddl })
        })
        .await
    }

    pub async fn rows(&self, req: &RowsReq) -> Result<Page, String> {
        let rowid = req.key == ["rowid"];
        let from = qi(&req.name);
        let sql = page_sql(&from, req, rowid)?;
        let count = if req.filter.trim().is_empty() { format!("SELECT count(*) FROM {from}") } else { format!("SELECT count(*) FROM {from} WHERE {}", req.filter.trim()) };
        self.on(move |c| {
            let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
            let mut set = read_set(&mut stmt, PAGE + 1).map_err(|e| e.to_string())?;
            let more = set.rows.len() > PAGE;
            set.rows.truncate(PAGE);
            let total = c.query_row(&count, [], |r| r.get::<_, i64>(0)).ok().map(|n| n as u64);
            Ok(Page { columns: set.columns, rows: set.rows, more, total })
        })
        .await
    }

    pub async fn run(&self, text: &str, _scope: Option<&str>, _read_only: bool) -> Result<Vec<ResultSet>, String> {
        let text = text.to_string();
        self.on(move |c| {
            let mut sets = Vec::new();
            let mut batch = Batch::new(c, &text);
            while let Some(mut stmt) = batch.next().map_err(|e| e.to_string())? {
                if stmt.column_count() == 0 {
                    let n = stmt.raw_execute().map_err(|e| e.to_string())?;
                    sets.push(ResultSet { affected: Some(n as u64), ..Default::default() });
                } else {
                    sets.push(read_set(&mut stmt, PAGE).map_err(|e| e.to_string())?);
                }
            }
            Ok(sets)
        })
        .await
    }

    pub async fn apply(&self, ops: Vec<Value>) -> Result<u64, String> {
        let ops: Vec<Op> = ops.into_iter().map(serde_json::from_value).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        self.on(move |c| {
            c.execute_batch("BEGIN").map_err(|e| e.to_string())?;
            let mut total = 0;
            for (i, op) in ops.iter().enumerate() {
                let fail = match c.execute(&op.sql, []) {
                    Ok(n) if op.expect.is_none_or(|e| e == n as u64) => {
                        total += n as u64;
                        None
                    }
                    Ok(n) => Some(format!("statement {} matched {n} rows, not {}: the row changed since it was loaded", i + 1, op.expect.unwrap_or(0))),
                    Err(e) => Some(format!("statement {}: {e}", i + 1)),
                };
                if let Some(f) = fail {
                    let _ = c.execute_batch("ROLLBACK");
                    return Err(format!("{f}. Nothing was written."));
                }
            }
            c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(total)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (PathBuf, Lite) {
        let path = std::env::temp_dir().join(format!("tri-db-test-{}-{}.db", std::process::id(), rand_suffix()));
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, plan TEXT);
             CREATE TABLE tags (name TEXT, colour TEXT);
             INSERT INTO users (email, plan) VALUES ('a@x', 'free'), ('b@x', 'pro');
             INSERT INTO tags VALUES ('work', '#f00');",
        )
        .unwrap();
        drop(c);
        let (lite, _) = open(path.to_str().unwrap(), "/", false).unwrap();
        (path, lite)
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[tokio::test]
    async fn browse_edit_and_guard() {
        let (path, db) = temp_db();
        let tree = db.schema().await.unwrap();
        assert_eq!(tree[0].objects.iter().map(|o| (o.name.as_str(), o.count)).collect::<Vec<_>>(), [("tags", Some(1)), ("users", Some(2))]);

        let s = db.structure("main", "users", "table").await.unwrap();
        assert_eq!(s.key, ["id"]);
        assert_eq!(db.structure("main", "tags", "table").await.unwrap().key, ["rowid"]);

        let req = RowsReq { group: "main".into(), name: "users".into(), offset: 0, filter: "plan = 'pro'".into(), sort: None, desc: false, key: s.key.clone() };
        let page = db.rows(&req).await.unwrap();
        assert_eq!((page.rows.len(), page.total), (1, Some(1)));
        assert_eq!(page.rows[0][1], "b@x");

        // The original value no longer matches: nothing is written.
        let stale = vec![json!({ "sql": "UPDATE \"users\" SET \"plan\" = 'team' WHERE \"id\" = 1 AND \"plan\" IS 'pro'", "expect": 1 })];
        assert!(db.apply(stale).await.unwrap_err().contains("changed since"));
        let ok = vec![
            json!({ "sql": "UPDATE \"users\" SET \"plan\" = 'team' WHERE \"id\" = 1 AND \"plan\" IS 'free'", "expect": 1 }),
            json!({ "sql": "DELETE FROM \"tags\" WHERE rowid = 1", "expect": 1 }),
        ];
        assert_eq!(db.apply(ok).await.unwrap(), 2);

        let sets = db.run("SELECT plan FROM users ORDER BY id; UPDATE users SET plan = plan", None, false).await.unwrap();
        assert_eq!(sets[0].rows, [[json!("team")], [json!("pro")]]);
        assert_eq!(sets[1].affected, Some(2));
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
