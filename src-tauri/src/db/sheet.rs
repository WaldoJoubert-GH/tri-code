//! Spreadsheet files as a Database Window Session (design/csv-xlsx.html, variant C).
//!
//! A CSV or TSV file, or an Excel / OpenDocument workbook, is read from the project's host (so an
//! ssh project works too) and loaded into an in-memory SQLite database: one table per CSV, one per
//! sheet. Everything the window does then runs on that copy through `sqlite.rs`.
//!
//! Column types are guessed from the cells (INTEGER, REAL, DATE, DATETIME, else TEXT). A CSV keeps
//! how each row was written, so Apply rewrites the file with its own delimiter, line endings and
//! BOM, untouched rows byte for byte and untouched cells as they were typed (`1.50` stays `1.50`).
//! The write checks the file's stamp first, so a file an agent changed since is not overwritten.
//! Workbooks are read-only: writing one back would lose its formatting, charts and formulas.

use std::io::Cursor;
use std::sync::{Arc, Mutex};

use calamine::{Data, Reader};
use rusqlite::Connection;
use rusqlite::types::Value as Sv;
use serde::Serialize;
use serde_json::{Value, json};

use super::sqlite::{self, Lite};
use super::{Column, Group, Page, ResultSet, RowsReq, Structure, qi, text_cell};
use crate::fs::{CHANGED, read_bytes, stamp_of, write_checked};

/// Largest file opened as a table.
const LIMIT: u64 = 50_000_000;
/// Rows of each sheet the editor's table view gets; the Database Window pages through all of them.
const PREVIEW_ROWS: usize = 5_000;

/// What the file is, by its extension.
pub fn is_csv(path: &str) -> bool {
    matches!(ext(path).as_str(), "csv" | "tsv" | "tab" | "psv")
}

fn ext(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

fn stem(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.rsplit_once('.').map_or(name, |(s, _)| s).to_string()
}

// ── reading ─────────────────────────────────────────────────────────

/// A table as read: column names, their declared types, and the cells.
#[derive(Debug)]
pub struct Table {
    pub name: String,
    pub columns: Vec<String>,
    pub types: Vec<&'static str>,
    pub rows: Vec<Vec<Sv>>,
}

/// How a CSV was written, kept to write it back the same way.
#[derive(Debug, Clone, PartialEq)]
pub struct CsvFormat {
    pub delim: u8,
    pub header: bool,
    pub eol: &'static str,
    pub bom: bool,
    pub trailing_eol: bool,
}

/// One CSV row as read: its text in the file, each field's text, and the values loaded.
#[derive(Debug)]
struct Orig {
    raw: String,
    texts: Vec<String>,
    values: Vec<Sv>,
}

#[derive(Debug)]
struct CsvSource {
    format: CsvFormat,
    header_raw: Option<String>,
    /// Row `i` was loaded with rowid `i + 1`.
    rows: Vec<Orig>,
}

#[derive(Debug)]
pub struct Parsed {
    pub tables: Vec<Table>,
    csv: Option<CsvSource>,
    /// What the window's footer says: `CSV · comma · header row`, `Excel workbook · 3 sheets`.
    pub label: String,
}

pub fn parse(path: &str, bytes: &[u8]) -> Result<Parsed, String> {
    if is_csv(path) { parse_csv(path, bytes) } else { parse_book(path, bytes) }
}

fn parse_csv(path: &str, bytes: &[u8]) -> Result<Parsed, String> {
    let (bom, body) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let text = String::from_utf8_lossy(body);
    let delim = match ext(path).as_str() {
        "tsv" | "tab" => b'\t',
        "psv" => b'|',
        _ => sniff(&text),
    };
    let mut rdr = csv::ReaderBuilder::new().delimiter(delim).has_headers(false).flexible(true).from_reader(text.as_bytes());
    let mut recs: Vec<(usize, Vec<String>)> = Vec::new();
    for r in rdr.records() {
        let r = r.map_err(|e| format!("can't read {} as CSV: {e}", name_of(path)))?;
        let start = r.position().map_or(0, |p| p.byte() as usize);
        recs.push((start, r.iter().map(String::from).collect()));
    }
    let raw = |i: usize| {
        let end = recs.get(i + 1).map_or(text.len(), |r| r.0);
        // With CRLF the reader puts a record's start on the `\n` before it; a record never
        // starts with a newline itself (a quoted field starts with `"`).
        text[recs[i].0..end].trim_matches(['\r', '\n']).to_string()
    };
    let header = recs.first().is_some_and(|(_, f)| looks_like_header(f));
    let width = recs.iter().map(|(_, f)| f.len()).max().unwrap_or(0).max(1);
    let columns = column_names(header.then(|| recs[0].1.as_slice()), width);
    let first = usize::from(header);
    let types: Vec<&'static str> = (0..width).map(|c| text_type(recs[first..].iter().map(|(_, f)| f.get(c).map_or("", String::as_str)))).collect();
    let mut rows = Vec::with_capacity(recs.len().saturating_sub(first));
    let mut origs = Vec::with_capacity(rows.capacity());
    for i in first..recs.len() {
        let texts = &recs[i].1;
        let values: Vec<Sv> = (0..width).map(|c| text_value(texts.get(c).map_or("", String::as_str), types[c])).collect();
        origs.push(Orig { raw: raw(i), texts: texts.clone(), values: values.clone() });
        rows.push(values);
    }
    let format = CsvFormat {
        delim,
        header,
        eol: if text.contains("\r\n") { "\r\n" } else { "\n" },
        bom,
        trailing_eol: text.ends_with('\n'),
    };
    let label = format!(
        "{} · {}{}",
        if delim == b'\t' { "TSV" } else { "CSV" },
        match delim {
            b',' => "comma",
            b';' => "semicolon",
            b'\t' => "tab",
            b'|' => "pipe",
            _ => "delimited",
        },
        if header { " · header row" } else { "" },
    );
    let csv = CsvSource { format, header_raw: header.then(|| raw(0)), rows: origs };
    Ok(Parsed { tables: vec![Table { name: table_name(&stem(path)), columns, types, rows }], csv: Some(csv), label })
}

/// The delimiter of the first lines: the one that splits them into the same number of fields
/// (more than one) most often.
fn sniff(text: &str) -> u8 {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(20).collect();
    let mut best = (b',', 0usize);
    for d in [b',', b';', b'\t', b'|'] {
        let counts: Vec<usize> = lines.iter().map(|l| count_outside_quotes(l, d as char)).collect();
        let Some(&first) = counts.first() else { break };
        if first == 0 {
            continue;
        }
        let score = counts.iter().filter(|&&n| n == first).count() * 1000 + first;
        if score > best.1 {
            best = (d, score);
        }
    }
    best.0
}

fn count_outside_quotes(line: &str, d: char) -> usize {
    let mut quoted = false;
    line.chars().filter(|&c| {
        if c == '"' {
            quoted = !quoted;
        }
        c == d && !quoted
    })
    .count()
}

/// A first row that names columns: every cell filled, no two alike, none a number or a date.
fn looks_like_header(cells: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    !cells.is_empty()
        && cells.iter().all(|c| {
            let t = c.trim();
            !t.is_empty() && int_text(t).is_none() && real_text(t).is_none() && date_text(t).is_none() && seen.insert(t.to_lowercase())
        })
}

/// Header cells as column names: trimmed, blanks filled in, repeats numbered.
fn column_names(header: Option<&[String]>, width: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(width);
    for c in 0..width {
        let base = header.and_then(|h| h.get(c)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("column{}", c + 1));
        let mut name = base.clone();
        let mut n = 2;
        while out.iter().any(|o| o.eq_ignore_ascii_case(&name)) || name.eq_ignore_ascii_case("rowid") {
            name = format!("{base}_{n}");
            n += 1;
        }
        out.push(name);
    }
    out
}

fn table_name(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() { "sheet".into() } else { t.to_string() }
}

fn name_of(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// `42`, `-7`: an integer that prints back the same (so `007` and `+1` stay text).
fn int_text(s: &str) -> Option<i64> {
    s.parse::<i64>().ok().filter(|i| i.to_string() == s)
}

/// `1.50`, `-0.5`, `3e8`: a plain decimal number, with no leading zero before other digits.
fn real_text(s: &str) -> Option<f64> {
    let digits = s.strip_prefix('-').unwrap_or(s);
    let b = digits.as_bytes();
    if b.is_empty() || !b[0].is_ascii_digit() || (b[0] == b'0' && b.get(1).is_some_and(u8::is_ascii_digit)) {
        return None;
    }
    if !digits.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'-' | b'+')) || digits.ends_with('.') {
        return None;
    }
    s.parse::<f64>().ok().filter(|f| f.is_finite())
}

/// `2025-03-14` (true) or `2025-03-14 09:30:00`, `2025-03-14T09:30Z` (false).
fn date_text(s: &str) -> Option<bool> {
    let b = s.as_bytes();
    let ymd = b.len() >= 10 && b[4] == b'-' && b[7] == b'-' && [0, 1, 2, 3, 5, 6, 8, 9].iter().all(|&i| b[i].is_ascii_digit());
    if !ymd {
        return None;
    }
    if b.len() == 10 {
        return Some(true);
    }
    let rest = &s[11..];
    (matches!(b[10], b' ' | b'T') && rest.len() >= 5 && rest.as_bytes()[2] == b':' && rest.bytes().all(|c| c.is_ascii_digit() || matches!(c, b':' | b'.' | b'+' | b'-' | b'Z')))
        .then_some(false)
}

/// The type every filled cell of a column fits, TEXT when they don't agree or none is filled.
fn text_type<'a>(cells: impl Iterator<Item = &'a str>) -> &'static str {
    let (mut int, mut real, mut date, mut datetime, mut any) = (true, true, true, true, false);
    for c in cells {
        if c.is_empty() {
            continue;
        }
        any = true;
        int &= int_text(c).is_some();
        real &= real_text(c).is_some();
        match date_text(c) {
            Some(true) => {}
            Some(false) => date = false,
            None => (date, datetime) = (false, false),
        }
        if !int && !real && !datetime {
            return "TEXT";
        }
    }
    match () {
        _ if !any => "TEXT",
        _ if int => "INTEGER",
        _ if real => "REAL",
        _ if date => "DATE",
        _ if datetime => "DATETIME",
        _ => "TEXT",
    }
}

/// A CSV field as the value of its column. Empty is NULL.
fn text_value(s: &str, ty: &str) -> Sv {
    if s.is_empty() {
        return Sv::Null;
    }
    match ty {
        "INTEGER" => int_text(s).map_or_else(|| Sv::Text(s.into()), Sv::Integer),
        "REAL" => real_text(s).map_or_else(|| Sv::Text(s.into()), Sv::Real),
        _ => Sv::Text(s.into()),
    }
}

fn parse_book(path: &str, bytes: &[u8]) -> Result<Parsed, String> {
    let fail = |e: String| format!("can't read {} as a spreadsheet: {e}", name_of(path));
    let mut wb = calamine::open_workbook_auto_from_rs(Cursor::new(bytes.to_vec())).map_err(|e| fail(e.to_string()))?;
    let mut tables: Vec<Table> = Vec::new();
    for sheet in wb.sheet_names() {
        let range = wb.worksheet_range(&sheet).map_err(|e| fail(e.to_string()))?;
        let cells: Vec<&[Data]> = range.rows().collect();
        if cells.is_empty() || range.width() == 0 {
            continue;
        }
        let width = range.width();
        let first_texts: Vec<String> = cells[0].iter().map(|d| match d {
            Data::String(s) => s.clone(),
            Data::Empty => String::new(),
            // Anything else makes the first row data.
            _ => "1".into(),
        })
        .collect();
        let header = cells.len() > 1 && looks_like_header(&first_texts);
        let columns = column_names(header.then_some(first_texts.as_slice()), width);
        let body = &cells[usize::from(header)..];
        let types: Vec<&'static str> = (0..width).map(|c| book_type(body.iter().map(|r| r.get(c).unwrap_or(&Data::Empty)))).collect();
        let rows = body.iter().map(|r| (0..width).map(|c| book_value(r.get(c).unwrap_or(&Data::Empty), types[c])).collect()).collect();
        let mut name = table_name(&sheet);
        let mut n = 2;
        while tables.iter().any(|t| t.name.eq_ignore_ascii_case(&name)) {
            name = format!("{} {n}", table_name(&sheet));
            n += 1;
        }
        tables.push(Table { name, columns, types, rows });
    }
    let kind = match ext(path).as_str() {
        "ods" => "OpenDocument spreadsheet",
        "xls" => "Excel 97 workbook",
        _ => "Excel workbook",
    };
    let label = format!("{kind} · {} {}", tables.len(), if tables.len() == 1 { "sheet" } else { "sheets" });
    Ok(Parsed { tables, csv: None, label })
}

fn whole(f: f64) -> Option<i64> {
    (f.fract() == 0.0 && f.abs() < 9e15).then_some(f as i64)
}

fn book_type<'a>(cells: impl Iterator<Item = &'a Data>) -> &'static str {
    let (mut int, mut real, mut date, mut datetime, mut boolean, mut any) = (true, true, true, true, true, false);
    for d in cells {
        match d {
            Data::Empty => continue,
            Data::Int(_) => (date, datetime, boolean) = (false, false, false),
            Data::Float(f) => {
                int &= whole(*f).is_some();
                (date, datetime, boolean) = (false, false, false);
            }
            Data::Bool(_) => (int, real, date, datetime) = (false, false, false, false),
            Data::DateTime(dt) => {
                (int, real, boolean) = (false, false, false);
                if !dt.is_datetime() {
                    (date, datetime) = (false, false);
                } else if dt.as_f64().fract() != 0.0 {
                    date = false;
                }
            }
            Data::DateTimeIso(s) => {
                (int, real, boolean) = (false, false, false);
                if s.len() != 10 {
                    date = false;
                }
            }
            _ => return "TEXT",
        }
        any = true;
    }
    match () {
        _ if !any => "TEXT",
        _ if int => "INTEGER",
        _ if real => "REAL",
        _ if date => "DATE",
        _ if datetime => "DATETIME",
        _ if boolean => "BOOLEAN",
        _ => "TEXT",
    }
}

fn book_value(d: &Data, ty: &str) -> Sv {
    let v = match d {
        Data::Empty => return Sv::Null,
        Data::Int(i) => Sv::Integer(*i),
        Data::Float(f) => whole(*f).map_or(Sv::Real(*f), Sv::Integer),
        Data::Bool(b) => Sv::Integer(i64::from(*b)),
        Data::String(s) => Sv::Text(s.clone()),
        Data::DateTime(dt) if dt.is_datetime() => {
            let (y, mo, da, h, mi, s, ms) = dt.to_ymd_hms_milli();
            Sv::Text(match () {
                _ if ty == "DATE" || (h, mi, s, ms) == (0, 0, 0, 0) => format!("{y:04}-{mo:02}-{da:02}"),
                _ if ms == 0 => format!("{y:04}-{mo:02}-{da:02} {h:02}:{mi:02}:{s:02}"),
                _ => format!("{y:04}-{mo:02}-{da:02} {h:02}:{mi:02}:{s:02}.{ms:03}"),
            })
        }
        other => Sv::Text(other.to_string()),
    };
    // A column of mixed kinds holds text, so it sorts and compares one way.
    match (ty, v) {
        ("TEXT", Sv::Integer(i)) if !matches!(d, Data::Bool(_)) => Sv::Text(i.to_string()),
        ("TEXT", Sv::Integer(i)) => Sv::Text(if i == 1 { "TRUE" } else { "FALSE" }.into()),
        ("TEXT", Sv::Real(f)) => Sv::Text(f.to_string()),
        (_, v) => v,
    }
}

// ── loading into SQLite ─────────────────────────────────────────────

fn load(c: &Connection, tables: &[Table], previous: &[String]) -> Result<(), String> {
    let e = |e: rusqlite::Error| e.to_string();
    c.execute_batch("BEGIN").map_err(e)?;
    let res = (|| {
        for t in previous {
            c.execute_batch(&format!("DROP TABLE IF EXISTS {}", qi(t))).map_err(e)?;
        }
        for t in tables {
            let cols: Vec<String> = t.columns.iter().zip(&t.types).map(|(n, ty)| format!("{} {ty}", qi(n))).collect();
            c.execute_batch(&format!("CREATE TABLE {} ({})", qi(&t.name), cols.join(", "))).map_err(e)?;
            let marks = vec!["?"; t.columns.len() + 1].join(", ");
            let names: Vec<String> = t.columns.iter().map(|n| qi(n)).collect();
            let mut stmt = c.prepare(&format!("INSERT INTO {} (rowid, {}) VALUES ({marks})", qi(&t.name), names.join(", "))).map_err(e)?;
            for (i, row) in t.rows.iter().enumerate() {
                let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(row.len() + 1);
                let id = i as i64 + 1;
                params.push(&id);
                params.extend(row.iter().map(|v| v as &dyn rusqlite::ToSql));
                stmt.execute(params.as_slice()).map_err(e)?;
            }
        }
        Ok(())
    })();
    match res {
        Ok(()) => c.execute_batch("COMMIT").map_err(e),
        Err(err) => {
            let _ = c.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

// ── writing a CSV back ──────────────────────────────────────────────

/// The CSV text for the table's rows now (`(rowid, values)` in rowid order).
fn write_csv(src: &CsvSource, rows: &[(i64, Vec<Sv>)]) -> Vec<u8> {
    let f = &src.format;
    let mut lines: Vec<String> = Vec::with_capacity(rows.len() + 1);
    if let Some(h) = &src.header_raw {
        lines.push(h.clone());
    }
    for (rowid, values) in rows {
        let orig = usize::try_from(*rowid - 1).ok().and_then(|i| src.rows.get(i));
        if let Some(o) = orig.filter(|o| &o.values == values) {
            lines.push(o.raw.clone());
            continue;
        }
        // A short row stays short unless a cell past its end was filled in.
        let keep = orig.map_or(0, |o| o.texts.len());
        let filled = values.iter().rposition(|v| *v != Sv::Null).map_or(0, |i| i + 1);
        let n = keep.max(filled).max(1).min(values.len());
        let fields: Vec<String> = (0..n)
            .map(|c| {
                let text = match orig {
                    Some(o) if o.values.get(c) == Some(&values[c]) && c < o.texts.len() => o.texts[c].clone(),
                    _ => value_text(&values[c]),
                };
                quote(&text, f.delim)
            })
            .collect();
        lines.push(fields.join(&(f.delim as char).to_string()));
    }
    let mut out = String::new();
    if f.bom {
        out.push('\u{FEFF}');
    }
    out += &lines.join(f.eol);
    if f.trailing_eol && !lines.is_empty() {
        out += f.eol;
    }
    out.into_bytes()
}

fn value_text(v: &Sv) -> String {
    match v {
        Sv::Null => String::new(),
        Sv::Integer(i) => i.to_string(),
        Sv::Real(f) => f.to_string(),
        Sv::Text(s) => s.clone(),
        Sv::Blob(b) => String::from_utf8_lossy(b).into_owned(),
    }
}

fn quote(s: &str, delim: u8) -> String {
    if s.contains([delim as char, '"', '\r', '\n']) || s.starts_with(' ') || s.ends_with(' ') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// ── the Session ─────────────────────────────────────────────────────

struct State {
    stamp: String,
    tables: Vec<String>,
    csv: Option<CsvSource>,
}

pub struct Sheet {
    lite: Lite,
    host: String,
    path: String,
    state: Arc<Mutex<State>>,
}

/// Open the file: the Session, what the footer shows, and whether it is read-only (a workbook).
pub async fn open(host: &str, path: &str) -> Result<(Sheet, String, bool), String> {
    let (host, path) = (host.to_string(), path.to_string());
    let lite = sqlite::memory()?;
    let (h, p) = (host.clone(), path.clone());
    let (state, label) = lite
        .on(move |c| {
            let (bytes, stamp) = read_bytes(&h, &p, LIMIT)?;
            let parsed = parse(&p, &bytes)?;
            load(c, &parsed.tables, &[])?;
            let tables = parsed.tables.iter().map(|t| t.name.clone()).collect();
            Ok((State { stamp, tables, csv: parsed.csv }, parsed.label))
        })
        .await?;
    let read_only = state.csv.is_none();
    Ok((Sheet { lite, host, path, state: Arc::new(Mutex::new(state)) }, label, read_only))
}

impl Sheet {
    pub fn cancel(&self) {
        self.lite.cancel();
    }

    /// The tables, after reading the file again if it changed on disk since it was loaded.
    pub async fn schema(&self) -> Result<Vec<Group>, String> {
        let (host, path, state) = (self.host.clone(), self.path.clone(), self.state.clone());
        self.lite
            .on(move |c| {
                let now = stamp_of(&host, &path)?.ok_or_else(|| format!("{} is gone", name_of(&path)))?;
                let mut st = state.lock().unwrap();
                if now != st.stamp {
                    let (bytes, stamp) = read_bytes(&host, &path, LIMIT)?;
                    let parsed = parse(&path, &bytes)?;
                    load(c, &parsed.tables, &st.tables)?;
                    *st = State { stamp, tables: parsed.tables.iter().map(|t| t.name.clone()).collect(), csv: parsed.csv };
                }
                Ok(())
            })
            .await?;
        self.lite.schema().await
    }

    pub async fn structure(&self, group: &str, name: &str, kind: &str) -> Result<Structure, String> {
        self.lite.structure(group, name, kind).await
    }

    pub async fn rows(&self, req: &RowsReq) -> Result<Page, String> {
        self.lite.rows(req).await
    }

    /// The Query view runs on the in-memory copy; nothing it changes reaches the file.
    pub async fn run(&self, text: &str, scope: Option<&str>, read_only: bool) -> Result<Vec<ResultSet>, String> {
        self.lite.run(text, scope, read_only).await
    }

    /// Apply Pending Edits to the copy and write the CSV, in one go: if the file can't be
    /// written (it changed on disk), the copy is rolled back too.
    pub async fn apply(&self, ops: Vec<Value>) -> Result<u64, String> {
        let ops = sqlite::parse_ops(ops)?;
        let (host, path, state) = (self.host.clone(), self.path.clone(), self.state.clone());
        self.lite
            .on(move |c| {
                let mut st = state.lock().unwrap();
                let table = st.tables.first().cloned().ok_or("nothing to write")?;
                let Some(src) = &st.csv else { return Err("Excel files open read-only".into()) };
                c.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                let written = (|| {
                    let n = sqlite::run_ops(c, &ops)?;
                    let rows = current_rows(c, &table)?;
                    let bytes = write_csv(src, &rows);
                    let stamp = write_checked(&host, &path, &bytes, Some(&st.stamp)).map_err(|e| {
                        if e == CHANGED {
                            format!("{} changed on disk since it was loaded: reload the schema (⟳) and make the edits again", name_of(&path))
                        } else {
                            e
                        }
                    })?;
                    Ok::<_, String>((n, bytes, stamp))
                })();
                let (n, bytes, stamp) = match written {
                    Ok(w) => w,
                    Err(e) => {
                        let _ = c.execute_batch("ROLLBACK");
                        return Err(format!("{e}. Nothing was written."));
                    }
                };
                c.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                // Load what was written, so the next save compares against it and rowids run 1..n again.
                let parsed = parse(&path, &bytes)?;
                load(c, &parsed.tables, &st.tables)?;
                *st = State { stamp, tables: parsed.tables.iter().map(|t| t.name.clone()).collect(), csv: parsed.csv };
                Ok(n)
            })
            .await
    }
}

fn current_rows(c: &Connection, table: &str) -> Result<Vec<(i64, Vec<Sv>)>, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let mut stmt = c.prepare(&format!("SELECT rowid, * FROM {} ORDER BY rowid", qi(table))).map_err(e)?;
    let n = stmt.column_count();
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, (1..n).map(|i| r.get::<_, Sv>(i)).collect::<Result<Vec<_>, _>>()?)))
        .map_err(e)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e)?;
    Ok(rows)
}

// ── the editor's table view of a workbook ───────────────────────────

#[derive(Serialize)]
pub struct Book {
    pub label: String,
    pub sheets: Vec<BookSheet>,
}

#[derive(Serialize)]
pub struct BookSheet {
    pub name: String,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    /// Rows in the sheet; `rows` holds the first `PREVIEW_ROWS`.
    pub total: usize,
}

/// A workbook's sheets for the editor (read-only), each cut at `PREVIEW_ROWS`.
pub async fn read_book(host: String, path: String) -> Result<Book, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes, _) = read_bytes(&host, &path, LIMIT)?;
        let parsed = parse(&path, &bytes)?;
        let sheets = parsed
            .tables
            .into_iter()
            .map(|t| BookSheet {
                name: t.name,
                columns: t.columns.into_iter().zip(t.types).map(|(name, ty)| Column { name, ty: ty.to_string() }).collect(),
                total: t.rows.len(),
                rows: t.rows.into_iter().take(PREVIEW_ROWS).map(|r| r.iter().map(json_cell).collect()).collect(),
            })
            .collect();
        Ok(Book { label: parsed.label, sheets })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn json_cell(v: &Sv) -> Value {
    match v {
        Sv::Null => Value::Null,
        Sv::Integer(i) if i.unsigned_abs() > (1 << 53) => Value::String(i.to_string()),
        Sv::Integer(i) => json!(i),
        Sv::Real(f) => serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number),
        Sv::Text(s) => text_cell(s),
        Sv::Blob(b) => json!({ "__blob": b.len() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CUSTOMERS: &str = "id,name,mrr,signed_up,zip\r\n1,Ada,240.00,2025-03-14,02134\r\n2,\"Ruiz, Mateo\",19.00,2025-04-02,10001\r\n3,Hana,,2025-09-09,\r\n";

    #[test]
    fn guesses_format_header_and_types() {
        let p = parse("data/customers.csv", CUSTOMERS.as_bytes()).unwrap();
        let t = &p.tables[0];
        assert_eq!(t.name, "customers");
        assert_eq!(t.columns, ["id", "name", "mrr", "signed_up", "zip"]);
        assert_eq!(t.types, ["INTEGER", "TEXT", "REAL", "DATE", "TEXT"]);
        assert_eq!(t.rows[1][1], Sv::Text("Ruiz, Mateo".into()));
        assert_eq!(t.rows[2][2], Sv::Null);
        assert_eq!(p.label, "CSV · comma · header row");
        let f = &p.csv.as_ref().unwrap().format;
        assert_eq!((f.eol, f.trailing_eol, f.bom), ("\r\n", true, false));
    }

    #[test]
    fn sniffs_semicolons_and_headerless_files() {
        let p = parse("x.csv", b"1;2,5;3\n4;5,5;6\n").unwrap();
        assert_eq!(p.tables[0].columns, ["column1", "column2", "column3"]);
        assert_eq!(p.tables[0].rows.len(), 2);
        assert_eq!(p.csv.unwrap().format.delim, b';');
    }

    #[test]
    fn writes_back_only_what_changed() {
        let p = parse("customers.csv", CUSTOMERS.as_bytes()).unwrap();
        let src = p.csv.unwrap();
        let mut rows: Vec<(i64, Vec<Sv>)> = p.tables[0].rows.iter().cloned().enumerate().map(|(i, r)| (i as i64 + 1, r)).collect();
        // Untouched: byte for byte.
        assert_eq!(String::from_utf8(write_csv(&src, &rows)).unwrap(), CUSTOMERS);
        // Change Ada's name, delete Hana, add a row.
        rows[0].1[1] = Sv::Text("Ada Okafor".into());
        rows.remove(2);
        rows.push((9, vec![Sv::Integer(4), Sv::Text("Lee \"LJ\"".into()), Sv::Real(1.5), Sv::Null, Sv::Null]));
        let out = String::from_utf8(write_csv(&src, &rows)).unwrap();
        assert_eq!(out, "id,name,mrr,signed_up,zip\r\n1,Ada Okafor,240.00,2025-03-14,02134\r\n2,\"Ruiz, Mateo\",19.00,2025-04-02,10001\r\n4,\"Lee \"\"LJ\"\"\",1.5\r\n");
    }

    #[test]
    fn number_shapes() {
        assert_eq!(int_text("42"), Some(42));
        assert_eq!(int_text("007"), None);
        assert_eq!(real_text("1.50"), Some(1.5));
        assert_eq!(real_text("01.5"), None);
        assert_eq!(real_text("1,5"), None);
        assert_eq!(real_text("inf"), None);
        assert_eq!(date_text("2025-03-14"), Some(true));
        assert_eq!(date_text("2025-03-14T09:30:00Z"), Some(false));
        assert_eq!(date_text("2025-3-14"), None);
    }

    #[tokio::test]
    async fn loads_into_sqlite_and_queries() {
        let p = parse("customers.csv", CUSTOMERS.as_bytes()).unwrap();
        let lite = sqlite::memory().unwrap();
        let tables = p.tables;
        lite.on(move |c| load(c, &tables, &[])).await.unwrap();
        let sets = lite.run("SELECT count(*), sum(mrr) FROM customers WHERE mrr > 100", None, false).await.unwrap();
        assert_eq!(sets[0].rows[0], [json!(1), json!(240.0)]);
        let s = lite.structure("main", "customers", "table").await.unwrap();
        assert_eq!(s.key, ["rowid"]);
    }
}
