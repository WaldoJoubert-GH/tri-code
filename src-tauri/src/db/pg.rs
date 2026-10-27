//! Postgres through tokio-postgres. Rows come over the simple-query protocol, so every value
//! is the text Postgres itself prints (numerics keep their digits, timestamps their zone) and
//! a script of several statements gives one result set each.

use std::time::Duration;

use futures_util::{StreamExt, pin_mut};
use serde::Deserialize;
use serde_json::Value;
use tokio_postgres::config::SslMode;
use tokio_postgres::{CancelToken, Client, SimpleQueryMessage};

use super::tls::{self, Mode, Tls};
use super::{ColInfo, Column, Group, Named, Obj, PAGE, Page, ResultSet, RowsReq, Structure, page_sql, qi, text_cell};

pub struct Pg {
    client: Client,
    cancel: CancelToken,
    tls: Tls,
}

pub async fn connect(url: &str, read_only: bool, sni: Option<String>) -> Result<(Pg, String), String> {
    let (url, mode) = tls::take_sslmode(url);
    let mut cfg: tokio_postgres::Config = url.parse().map_err(|e| format!("not a Postgres URL: {e}"))?;
    cfg.application_name("tri-code").connect_timeout(Duration::from_secs(10)).ssl_mode(match mode {
        Mode::Disable => SslMode::Disable,
        Mode::Prefer => SslMode::Prefer,
        Mode::Require | Mode::Verify => SslMode::Require,
    });
    let tls = Tls::new(mode, sni);
    let (client, conn) = cfg.connect(tls.clone()).await.map_err(err)?;
    tauri::async_runtime::spawn(async move {
        let _ = conn.await;
    });
    let mut init = String::from("SET statement_timeout = '30s';");
    if read_only {
        init += "SET default_transaction_read_only = on;";
    }
    client.batch_execute(&init).await.map_err(err)?;
    let version: String = client.query_one("SELECT current_setting('server_version')", &[]).await.map_err(err)?.get(0);
    let version = format!("PostgreSQL {}", version.split_whitespace().next().unwrap_or(""));
    Ok((Pg { cancel: client.cancel_token(), client, tls }, version))
}

/// The server's message with its detail and hint, or the error chain for a connection failure.
fn err(e: tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let mut s = format!("{}: {}", db.severity(), db.message());
        if let Some(d) = db.detail() {
            s += &format!("\n{d}");
        }
        if let Some(h) = db.hint() {
            s += &format!("\nHint: {h}");
        }
        return s;
    }
    let mut s = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(c) = src {
        s += &format!(": {c}");
        src = c.source();
    }
    s
}

#[derive(Deserialize)]
struct Op {
    sql: String,
    expect: Option<u64>,
}

impl Pg {
    pub fn cancel(&self) {
        let (token, tls) = (self.cancel.clone(), self.tls.clone());
        tauri::async_runtime::spawn(async move {
            let _ = token.cancel_query(tls).await;
        });
    }

    pub async fn schema(&self) -> Result<Vec<Group>, String> {
        let rows = self
            .client
            .query(
                "SELECT n.nspname::text, c.relname::text, c.relkind::text, c.reltuples::float8
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
                    AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
                  ORDER BY n.nspname <> 'public', n.nspname, c.relname",
                &[],
            )
            .await
            .map_err(err)?;
        let mut groups: Vec<Group> = Vec::new();
        for r in rows {
            let (schema, name, kind, tuples): (String, String, String, f64) = (r.get(0), r.get(1), r.get(2), r.get(3));
            let obj = Obj {
                name,
                kind: if matches!(kind.as_str(), "r" | "p") { "table" } else { "view" },
                count: (tuples >= 0.0).then_some(tuples as u64),
            };
            match groups.last_mut() {
                Some(g) if g.name == schema => g.objects.push(obj),
                _ => groups.push(Group { name: schema, objects: vec![obj] }),
            }
        }
        Ok(groups)
    }

    pub async fn structure(&self, group: &str, name: &str, kind: &str) -> Result<Structure, String> {
        let rel = format!("{}.{}", qi(group), qi(name));
        let cols = self
            .client
            .query(
                "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
                        COALESCE(a.attnum = ANY(i.indkey::int2[]), false)
                   FROM pg_attribute a
                   LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                   LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
                  WHERE a.attrelid = $1::text::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  ORDER BY a.attnum",
                &[&rel],
            )
            .await
            .map_err(err)?;
        let columns: Vec<ColInfo> =
            cols.iter().map(|r| ColInfo { name: r.get(0), ty: r.get(1), nullable: r.get(2), default: r.get(3), pk: r.get(4) }).collect();
        let key = self
            .client
            .query(
                "SELECT a.attname::text FROM pg_index i
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey::int2[])
                  WHERE i.indrelid = $1::text::regclass AND i.indisprimary
                  ORDER BY array_position(i.indkey::int2[], a.attnum)",
                &[&rel],
            )
            .await
            .map_err(err)?
            .iter()
            .map(|r| r.get(0))
            .collect::<Vec<String>>();
        let indexes = self
            .client
            .query("SELECT indexname::text, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname", &[&group, &name])
            .await
            .map_err(err)?
            .iter()
            .map(|r| Named { name: r.get(0), def: r.get(1) })
            .collect::<Vec<_>>();
        let fks = self
            .client
            .query("SELECT conname::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = $1::text::regclass AND contype = 'f' ORDER BY conname", &[&rel])
            .await
            .map_err(err)?
            .iter()
            .map(|r| Named { name: r.get(0), def: r.get(1) })
            .collect::<Vec<_>>();
        let ddl = if kind == "view" {
            let def: String = self.client.query_one("SELECT pg_get_viewdef($1::text::regclass, true)", &[&rel]).await.map_err(err)?.get(0);
            format!("CREATE VIEW {rel} AS\n{}", def.trim_end())
        } else {
            let mut lines: Vec<String> = columns
                .iter()
                .map(|c| {
                    let mut l = format!("  {} {}", qi(&c.name), c.ty);
                    if !c.nullable {
                        l += " NOT NULL";
                    }
                    if let Some(d) = &c.default {
                        l += &format!(" DEFAULT {d}");
                    }
                    l
                })
                .collect();
            if !key.is_empty() {
                lines.push(format!("  PRIMARY KEY ({})", key.iter().map(|k| qi(k)).collect::<Vec<_>>().join(", ")));
            }
            lines.extend(fks.iter().map(|f| format!("  CONSTRAINT {} {}", qi(&f.name), f.def)));
            let mut ddl = format!("CREATE TABLE {rel} (\n{}\n);", lines.join(",\n"));
            for i in indexes.iter().filter(|i| !i.def.contains(" PRIMARY KEY") && !i.name.ends_with("_pkey")) {
                ddl += &format!("\n{};", i.def);
            }
            ddl
        };
        // A view has no key to find a row by, so it isn't editable.
        let key = if kind == "view" { Vec::new() } else { key };
        Ok(Structure { columns, key, indexes, fks, ddl })
    }

    pub async fn rows(&self, req: &RowsReq) -> Result<Page, String> {
        let from = format!("{}.{}", qi(&req.group), qi(&req.name));
        let sql = page_sql(&from, req, false)?;
        let mut set = self.simple(&sql, PAGE + 1).await?.into_iter().next().unwrap_or_default();
        let more = set.rows.len() > PAGE;
        set.rows.truncate(PAGE);
        let total = if req.filter.trim().is_empty() {
            let est: f64 = self.client.query_one("SELECT reltuples::float8 FROM pg_class WHERE oid = $1::text::regclass", &[&from]).await.map_err(err)?.get(0);
            if (0.0..100_000.0).contains(&est) || est < 0.0 {
                self.count(&format!("SELECT count(*) FROM {from}")).await
            } else {
                Some(est as u64)
            }
        } else if !more && req.offset == 0 {
            Some(set.rows.len() as u64)
        } else {
            None
        };
        Ok(Page { columns: set.columns, rows: set.rows, more, total })
    }

    async fn count(&self, sql: &str) -> Option<u64> {
        let r = self.client.query_one(sql, &[]).await.ok()?;
        Some(r.get::<_, i64>(0) as u64)
    }

    pub async fn run(&self, text: &str, _scope: Option<&str>, _read_only: bool) -> Result<Vec<ResultSet>, String> {
        // One statement can be described first, which gives its columns' types.
        let types = self.client.prepare(text).await.ok().map(|st| st.columns().iter().map(|c| c.type_().name().to_string()).collect::<Vec<_>>());
        let mut sets = self.simple(text, PAGE).await?;
        if let (Some(types), Some(set)) = (types, sets.first_mut())
            && types.len() == set.columns.len()
        {
            for (c, t) in set.columns.iter_mut().zip(types) {
                c.ty = t;
            }
        }
        Ok(sets)
    }

    /// Run `sql` and keep at most `max` rows a set. Past that the statement is cancelled, so a
    /// `SELECT *` on a huge table doesn't stream all of it; the set says `more`.
    async fn simple(&self, sql: &str, max: usize) -> Result<Vec<ResultSet>, String> {
        let stream = self.client.simple_query_raw(sql).await.map_err(err)?;
        pin_mut!(stream);
        let mut sets = Vec::new();
        let mut cur: Option<ResultSet> = None;
        let mut capped = false;
        while let Some(msg) = stream.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(_) if capped => break,
                Err(e) => return Err(err(e)),
            };
            match msg {
                SimpleQueryMessage::RowDescription(cols) => {
                    cur = Some(ResultSet { columns: cols.iter().map(|c| Column { name: c.name().to_string(), ty: String::new() }).collect(), ..Default::default() });
                }
                SimpleQueryMessage::Row(row) => {
                    let set = cur.get_or_insert_with(|| ResultSet {
                        columns: row.columns().iter().map(|c| Column { name: c.name().to_string(), ty: String::new() }).collect(),
                        ..Default::default()
                    });
                    if set.rows.len() >= max {
                        if !set.more {
                            set.more = true;
                            capped = true;
                            let _ = self.cancel.cancel_query(self.tls.clone()).await;
                        }
                        continue;
                    }
                    set.rows.push((0..row.len()).map(|i| row.get(i).map_or(Value::Null, text_cell)).collect());
                }
                SimpleQueryMessage::CommandComplete(n) => match cur.take() {
                    Some(set) => sets.push(set),
                    None => sets.push(ResultSet { affected: Some(n), ..Default::default() }),
                },
                _ => {}
            }
        }
        sets.extend(cur.take());
        Ok(sets)
    }

    pub async fn apply(&self, ops: Vec<Value>) -> Result<u64, String> {
        let ops: Vec<Op> = ops.into_iter().map(serde_json::from_value).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        self.client.batch_execute("BEGIN").await.map_err(err)?;
        let mut total = 0;
        for (i, op) in ops.iter().enumerate() {
            let res = self.client.execute(op.sql.as_str(), &[]).await;
            let fail = match res {
                Ok(n) if op.expect.is_none_or(|e| e == n) => {
                    total += n;
                    None
                }
                Ok(n) => Some(format!("statement {} matched {n} rows, not {}: the row changed since it was loaded", i + 1, op.expect.unwrap_or(0))),
                Err(e) => Some(format!("statement {}: {}", i + 1, err(e))),
            };
            if let Some(f) = fail {
                let _ = self.client.batch_execute("ROLLBACK").await;
                return Err(format!("{f}. Nothing was written."));
            }
        }
        self.client.batch_execute("COMMIT").await.map_err(err)?;
        Ok(total)
    }
}

/// Against a real server: `TRI_DB_PG_URL=postgres://… cargo test --lib db::pg -- --ignored`, on a
/// database with the tables of `design/` (users, orders, billing.invoices, active_users, nokey).
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn db(read_only: bool) -> Pg {
        let url = std::env::var("TRI_DB_PG_URL").expect("TRI_DB_PG_URL");
        connect(&url, read_only, None).await.unwrap().0
    }

    fn req(name: &str, filter: &str, sort: Option<&str>, key: &[&str]) -> RowsReq {
        RowsReq { group: "public".into(), name: name.into(), offset: 0, filter: filter.into(), sort: sort.map(Into::into), desc: true, key: key.iter().map(|k| k.to_string()).collect() }
    }

    #[tokio::test]
    #[ignore]
    async fn browse_query_edit() {
        let pg = db(false).await;
        let groups = pg.schema().await.unwrap();
        assert_eq!(groups[0].name, "public");
        assert!(groups.iter().any(|g| g.name == "billing"));
        let s = pg.structure("public", "users", "table").await.unwrap();
        assert_eq!(s.key, ["id"]);
        assert_eq!(s.columns.iter().find(|c| c.name == "credits").unwrap().ty, "numeric(10,2)");
        assert!(s.ddl.starts_with("CREATE TABLE \"public\".\"users\""));
        assert!(pg.structure("public", "active_users", "view").await.unwrap().key.is_empty());
        assert!(pg.structure("public", "nokey", "table").await.unwrap().key.is_empty());

        let page = pg.rows(&req("users", "", None, &["id"])).await.unwrap();
        assert_eq!((page.rows.len(), page.more, page.total), (500, true, Some(1200)));
        assert_eq!(page.rows[0][0], "1");
        let page = pg.rows(&req("users", "plan = 'pro'", Some("credits"), &["id"])).await.unwrap();
        assert_eq!(page.rows.len(), 400);
        assert_eq!(page.rows[0][3], "1797.00");
        assert!(pg.rows(&req("users", "true; drop table users", None, &[])).await.is_err());

        // What dbsql.ts builds: the key, then each old value, null-safe; json as text.
        let row = pg.rows(&req("users", "id = 7", None, &["id"])).await.unwrap().rows.remove(0);
        let (active, meta) = (row[4].as_str().unwrap().to_string(), row[5].as_str().unwrap().to_string());
        let upd = format!(
            "UPDATE \"public\".\"users\" SET \"plan\" = 'team', \"active\" = 'f', \"meta\" = '{{\"n\": 70}}' WHERE \"id\" = '7' AND \"plan\" IS NOT DISTINCT FROM 'pro' AND \"active\" IS NOT DISTINCT FROM '{active}' AND \"meta\"::text IS NOT DISTINCT FROM '{meta}'"
        );
        let ins = "INSERT INTO \"public\".\"users\" (\"email\") VALUES ('new@acme.dev')";
        assert_eq!(pg.apply(vec![json!({ "sql": upd, "expect": 1 }), json!({ "sql": ins, "expect": 1 })]).await.unwrap(), 2);
        // The same update again: the old values no longer match, and the insert after it is rolled back.
        let again = pg.apply(vec![json!({ "sql": ins.replace("new@", "new2@"), "expect": 1 }), json!({ "sql": upd, "expect": 1 })]).await.unwrap_err();
        assert!(again.contains("changed since"), "{again}");
        let n = pg.run("SELECT count(*) FROM users WHERE email LIKE 'new%'", None, false).await.unwrap();
        assert_eq!(n[0].rows[0][0], "1");
        assert_eq!(n[0].columns[0].ty, "int8");

        let sets = pg.run("SELECT 1 AS a; UPDATE users SET plan = plan WHERE id < 4; SELECT 'x' AS b", None, false).await.unwrap();
        assert_eq!((sets.len(), sets[1].affected), (3, Some(3)));
        let big = pg.run("SELECT * FROM generate_series(1, 100000)", None, false).await.unwrap();
        assert_eq!((big[0].rows.len(), big[0].more), (PAGE, true));
        // The connection is still usable after the cancel.
        assert_eq!(pg.run("SELECT 2", None, false).await.unwrap()[0].rows[0][0], "2");
        let bad = pg.run("SELECT nope FROM users", None, false).await.unwrap_err();
        assert!(bad.starts_with("ERROR: column \"nope\" does not exist"), "{bad}");
        pg.run("DELETE FROM users WHERE email LIKE 'new%'; UPDATE users SET plan = 'pro', active = true, meta = '{\"n\": 7}' WHERE id = 7", None, false).await.unwrap();

        let ro = db(true).await;
        let e = ro.run("UPDATE users SET plan = 'x' WHERE id = 1", None, true).await.unwrap_err();
        assert!(e.contains("read-only transaction"), "{e}");
    }

    /// With `ssl = on` on the server: `require` encrypts, `verify-full` refuses a self-signed cert.
    #[tokio::test]
    #[ignore]
    async fn tls_modes() {
        let url = std::env::var("TRI_DB_PG_URL").expect("TRI_DB_PG_URL");
        let pg = connect(&format!("{url}?sslmode=require"), false, None).await.unwrap().0;
        let ssl = pg.run("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()", None, false).await.unwrap();
        assert_eq!(ssl[0].rows[0][0], "t");
        let e = connect(&format!("{url}?sslmode=verify-full"), false, None).await.err().unwrap();
        assert!(e.to_lowercase().contains("certificate"), "{e}");
    }
}
