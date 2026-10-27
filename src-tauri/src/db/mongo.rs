//! MongoDB through the official driver. Documents travel as relaxed Extended JSON; a
//! collection's columns are its documents' top-level fields. The Query view runs one
//! `runCommand` document, and a read-only Connection only allows the commands that read.

use std::time::Duration;

use futures_util::TryStreamExt;
use mongodb::bson::{Bson, Document, doc};
use mongodb::results::CollectionType;
use mongodb::{Client, Collection};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Notify;

use super::{ColInfo, Column, Group, Named, Obj, PAGE, Page, ResultSet, RowsReq, Structure, cap};

pub struct Mongo {
    client: Client,
    /// The database the URL names, if any: the tree then shows only it.
    db: Option<String>,
    stop: Notify,
}

const READS: &[&str] = &[
    "find", "aggregate", "count", "distinct", "listCollections", "listIndexes", "listDatabases", "dbStats", "collStats",
    "explain", "ping", "buildInfo", "serverStatus", "hello", "isMaster", "connectionStatus", "getMore",
];

fn err(e: mongodb::error::Error) -> String {
    match *e.kind {
        mongodb::error::ErrorKind::Command(ref c) => format!("{} ({}): {}", c.code_name, c.code, c.message),
        _ => e.to_string(),
    }
}

pub async fn connect(url: &str) -> Result<(Mongo, String), String> {
    let mut opts = mongodb::options::ClientOptions::parse(url).await.map_err(err)?;
    opts.app_name = Some("tri-code".into());
    opts.connect_timeout = Some(Duration::from_secs(10));
    opts.server_selection_timeout = Some(Duration::from_secs(10));
    let db = opts.default_database.clone();
    let client = Client::with_options(opts).map_err(err)?;
    let info = client.database("admin").run_command(doc! { "buildInfo": 1 }).await.map_err(err)?;
    let version = format!("MongoDB {}", info.get_str("version").unwrap_or(""));
    Ok((Mongo { client, db, stop: Notify::new() }, version))
}

/// Extended JSON text (`{ "_id": { "$oid": "…" } }`) as a document; empty means `{}`.
fn ejson_doc(text: &str) -> Result<Document, String> {
    if text.trim().is_empty() {
        return Ok(Document::new());
    }
    let v: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    to_doc(v)
}

fn to_doc(v: Value) -> Result<Document, String> {
    match Bson::try_from(v).map_err(|e| e.to_string())? {
        Bson::Document(d) => Ok(d),
        _ => Err("expected a JSON object".into()),
    }
}

/// Documents as rows: the union of their top-level fields, `_id` first; a missing field is null.
fn table(docs: Vec<Document>) -> (Vec<Column>, Vec<Vec<Value>>) {
    let mut names: Vec<String> = Vec::new();
    for d in &docs {
        for k in d.keys() {
            if !names.contains(k) {
                names.push(k.clone());
            }
        }
    }
    if let Some(i) = names.iter().position(|n| n == "_id") {
        let id = names.remove(i);
        names.insert(0, id);
    }
    let columns = names
        .iter()
        .map(|n| {
            let ty = docs.iter().find_map(|d| d.get(n).filter(|b| !matches!(b, Bson::Null))).map(type_name).unwrap_or("null");
            Column { name: n.clone(), ty: ty.into() }
        })
        .collect();
    let rows = docs.into_iter().map(|d| names.iter().map(|n| d.get(n).cloned().map_or(Value::Null, |b| cap(b.into_relaxed_extjson()))).collect()).collect();
    (columns, rows)
}

fn type_name(b: &Bson) -> &'static str {
    match b {
        Bson::ObjectId(_) => "ObjectId",
        Bson::String(_) => "string",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Double(_) => "double",
        Bson::Decimal128(_) => "decimal",
        Bson::Boolean(_) => "bool",
        Bson::DateTime(_) => "date",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        Bson::Binary(_) => "binData",
        Bson::Null => "null",
        _ => "other",
    }
}

#[derive(Deserialize)]
struct Op {
    op: String,
    db: String,
    coll: String,
    #[serde(default)]
    filter: Value,
    #[serde(default)]
    doc: Value,
}

impl Mongo {
    fn coll(&self, db: &str, name: &str) -> Collection<Document> {
        self.client.database(db).collection(name)
    }

    pub fn cancel(&self) {
        self.stop.notify_waiters();
    }

    /// `fut`, unless Cancel comes first.
    async fn stoppable<T>(&self, fut: impl Future<Output = Result<T, String>>) -> Result<T, String> {
        tokio::select! {
            r = fut => r,
            _ = self.stop.notified() => Err("cancelled".into()),
        }
    }

    pub async fn schema(&self) -> Result<Vec<Group>, String> {
        let dbs = match &self.db {
            Some(db) => vec![db.clone()],
            None => self.client.list_database_names().await.map_err(err)?.into_iter().filter(|d| !matches!(d.as_str(), "admin" | "local" | "config")).collect(),
        };
        let mut groups = Vec::new();
        for db in dbs {
            let specs: Vec<_> = self.client.database(&db).list_collections().await.map_err(err)?.try_collect().await.map_err(err)?;
            let mut objects = Vec::new();
            for s in specs {
                let view = matches!(s.collection_type, CollectionType::View);
                let system = s.name.starts_with("system.");
                let count = if view { None } else { self.coll(&db, &s.name).estimated_document_count().await.ok() };
                objects.push(Obj { kind: if system { "system" } else if view { "view" } else { "collection" }, name: s.name, count });
            }
            objects.sort_by(|a, b| a.name.cmp(&b.name));
            groups.push(Group { name: db, objects });
        }
        Ok(groups)
    }

    pub async fn structure(&self, group: &str, name: &str, kind: &str) -> Result<Structure, String> {
        let coll = self.coll(group, name);
        let sample: Vec<Document> = coll.aggregate([doc! { "$sample": { "size": 200 } }]).await.map_err(err)?.try_collect().await.map_err(err)?;
        let n = sample.len();
        let (cols, _) = table(sample);
        let columns = cols.iter().map(|c| ColInfo { name: c.name.clone(), ty: c.ty.clone(), nullable: c.name != "_id", pk: c.name == "_id", default: None }).collect();
        let indexes = coll
            .list_indexes()
            .await
            .map_err(err)?
            .try_collect::<Vec<_>>()
            .await
            .map_err(err)?
            .into_iter()
            .map(|ix| {
                let unique = ix.options.as_ref().and_then(|o| o.unique).unwrap_or(false);
                let name = ix.options.and_then(|o| o.name).unwrap_or_default();
                let keys = Bson::Document(ix.keys).into_relaxed_extjson().to_string();
                Named { name, def: if unique { format!("{keys} unique") } else { keys } }
            })
            .collect();
        let shape: serde_json::Map<String, Value> = cols.into_iter().map(|c| (c.name, Value::String(c.ty))).collect();
        let ddl = format!("// {name}: the fields of {n} sampled documents\n{}", serde_json::to_string_pretty(&shape).unwrap_or_default());
        let key = if kind == "collection" { vec!["_id".into()] } else { Vec::new() };
        Ok(Structure { columns, key, indexes, fks: Vec::new(), ddl })
    }

    pub async fn rows(&self, req: &RowsReq) -> Result<Page, String> {
        let coll = self.coll(&req.group, &req.name);
        let filter = ejson_doc(&req.filter)?;
        let sort = match &req.sort {
            Some(c) => doc! { c: if req.desc { -1 } else { 1 }, "_id": 1 },
            None => doc! { "_id": 1 },
        };
        let docs: Vec<Document> = coll
            .find(filter.clone())
            .sort(sort)
            .skip(req.offset)
            .limit(PAGE as i64 + 1)
            .max_time(Duration::from_secs(30))
            .await
            .map_err(err)?
            .try_collect()
            .await
            .map_err(err)?;
        let more = docs.len() > PAGE;
        let (columns, mut rows) = table(docs);
        rows.truncate(PAGE);
        let total = if filter.is_empty() {
            coll.estimated_document_count().await.ok()
        } else {
            coll.count_documents(filter).max_time(Duration::from_secs(10)).await.ok()
        };
        Ok(Page { columns, rows, more, total })
    }

    pub async fn run(&self, text: &str, scope: Option<&str>, read_only: bool) -> Result<Vec<ResultSet>, String> {
        let cmd = ejson_doc(text)?;
        let name = cmd.keys().next().cloned().ok_or("an empty command")?;
        let writes_out = name == "aggregate" && text.contains("\"$out\"") || text.contains("\"$merge\"");
        if read_only && (!READS.contains(&name.as_str()) || writes_out) {
            return Err(format!("{name} can write, and this Connection is read-only"));
        }
        let db = scope.map(str::to_string).or_else(|| self.db.clone()).ok_or("pick a database in the tree first")?;
        let reply = self.stoppable(async { self.client.database(&db).run_command(cmd).await.map_err(err) }).await?;
        let (docs, more) = match reply.get_document("cursor") {
            Ok(c) => {
                let batch = c.get_array("firstBatch").map(|a| a.iter().filter_map(|b| b.as_document().cloned()).collect()).unwrap_or_default();
                (batch, c.get_i64("id").unwrap_or(0) != 0)
            }
            Err(_) => (vec![reply], false),
        };
        let mut docs: Vec<Document> = docs;
        let more = more || docs.len() > PAGE;
        docs.truncate(PAGE);
        let (columns, rows) = table(docs);
        Ok(vec![ResultSet { columns, rows, more, ..Default::default() }])
    }

    /// Ordered, stopping at the first failure: a transaction would need a replica set.
    pub async fn apply(&self, ops: Vec<Value>) -> Result<u64, String> {
        let ops: Vec<Op> = ops.into_iter().map(serde_json::from_value).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        let mut total = 0;
        for (i, op) in ops.into_iter().enumerate() {
            let coll = self.coll(&op.db, &op.coll);
            let done = match op.op.as_str() {
                "insert" => coll.insert_one(to_doc(op.doc)?).await.map(|_| 1).map_err(err),
                "update" => coll.update_one(to_doc(op.filter)?, doc! { "$set": to_doc(op.doc)? }).await.map(|r| r.matched_count).map_err(err),
                "delete" => coll.delete_one(to_doc(op.filter)?).await.map(|r| r.deleted_count).map_err(err),
                other => Err(format!("unknown op {other}")),
            };
            match done {
                Ok(1) => total += 1,
                Ok(_) => return Err(format!("change {} found no document: it changed since it was loaded. The {total} before it were written.", i + 1)),
                Err(e) => return Err(format!("change {}: {e}. The {total} before it were written.", i + 1)),
            }
        }
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ejson_round_trip() {
        let d = ejson_doc(r#"{ "_id": { "$oid": "64b4a2cc0e3d826827b02582" }, "n": 1 }"#).unwrap();
        assert!(matches!(d.get("_id"), Some(Bson::ObjectId(_))));
        let (cols, rows) = table(vec![d, doc! { "x": "y" }]);
        assert_eq!(cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["_id", "n", "x"]);
        assert_eq!(rows[0][0]["$oid"], "64b4a2cc0e3d826827b02582");
        assert_eq!(rows[1][1], Value::Null);
    }
}
