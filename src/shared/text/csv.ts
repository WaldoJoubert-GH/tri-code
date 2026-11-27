// The Editor Window's Table mode for CSV and TSV files (design/csv-xlsx.html, variant C). The
// table is a view of the text buffer: each field keeps where it sits in the text, so an edit in
// a cell replaces exactly that field and the rest of the file stays byte for byte. Saving, Diff,
// undo and the modified dot then work as for any edit. No imports, so `bun test` covers it.

/** One field: where it sits in the text (`from`–`to`, quotes included) and what it reads. */
export type Field = { from: number; to: number; text: string; quoted: boolean };
/** One record: its fields, where its line starts, and where the next one starts (after the newline). */
export type Row = { fields: Field[]; start: number; next: number };

export type Csv = { delim: string; rows: Row[]; header: boolean; width: number };

/** CSV, TSV or another delimited file, by extension. */
export const isCsvPath = (path: string) => /\.(csv|tsv|tab|psv)$/i.test(path);
/** A workbook the editor shows as read-only tables. */
export const isBookPath = (path: string) => /\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(path);

/** The delimiter of the first lines: the one that splits them into the same number of fields most often. */
export function sniff(text: string, path = ""): string {
  if (/\.(tsv|tab)$/i.test(path)) return "\t";
  if (/\.psv$/i.test(path)) return "|";
  const lines = text.split("\n").filter((l) => l.trim()).slice(0, 20);
  let best = { d: ",", score: 0 };
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => countOutside(l, d));
    const first = counts[0] ?? 0;
    if (!first) continue;
    const score = counts.filter((n) => n === first).length * 1000 + first;
    if (score > best.score) best = { d, score };
  }
  return best.d;
}

function countOutside(line: string, d: string) {
  let quoted = false, n = 0;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === d && !quoted) n++;
  }
  return n;
}

/** Split `text` into records. Empty lines are skipped; a quoted field may hold the delimiter,
 *  `""` and newlines. Lenient: text after a closing quote joins the field. */
export function parseRows(text: string, delim: string): Row[] {
  const rows: Row[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const start = i;
    // An empty line (or a lone \r\n) is no record.
    if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] === "\n")) {
      i += text[i] === "\r" ? 2 : 1;
      continue;
    }
    const fields: Field[] = [];
    for (;;) {
      const from = i;
      let value = "";
      let quoted = false;
      if (text[i] === '"') {
        quoted = true;
        i++;
        for (;;) {
          if (i >= n) break;
          if (text[i] === '"') {
            if (text[i + 1] === '"') { value += '"'; i += 2; continue; }
            i++;
            break;
          }
          value += text[i++];
        }
        // Anything up to the delimiter after the closing quote.
        while (i < n && text[i] !== delim && text[i] !== "\n") value += text[i++];
        if (value.endsWith("\r") && text[i] === "\n") value = value.slice(0, -1);
      } else {
        while (i < n && text[i] !== delim && text[i] !== "\n") value += text[i++];
        if (value.endsWith("\r") && (i >= n || text[i] === "\n")) value = value.slice(0, -1);
      }
      let to = i;
      if (to > from && text[to - 1] === "\r" && (i >= n || text[i] === "\n")) to--;
      fields.push({ from, to, text: value, quoted });
      if (i < n && text[i] === delim) { i++; continue; }
      break;
    }
    if (i < n && text[i] === "\n") i++;
    rows.push({ fields, start, next: i });
  }
  return rows;
}

const INT = /^-?(0|[1-9]\d*)$/;
const REAL = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A number or a date, which right-aligns and which a header row never holds. */
export const isNumber = (s: string) => INT.test(s) || REAL.test(s);
const isDate = (s: string) => DATE.test(s);

/** A first row that names columns: every cell filled, no two alike, none a number or a date. */
export function looksLikeHeader(cells: string[]): boolean {
  const seen = new Set<string>();
  return cells.length > 0 && cells.every((c) => {
    const t = c.trim();
    if (!t || isNumber(t) || isDate(t) || seen.has(t.toLowerCase())) return false;
    seen.add(t.toLowerCase());
    return true;
  });
}

export function parseCsv(text: string, path = ""): Csv {
  const delim = sniff(text, path);
  const rows = parseRows(text, delim);
  const width = rows.reduce((w, r) => Math.max(w, r.fields.length), 0);
  return { delim, rows, header: !!rows[0] && looksLikeHeader(rows[0].fields.map((f) => f.text)), width };
}

/** The column names: the header row's, else `column1`… */
export const columnNames = (csv: Csv) =>
  Array.from({ length: csv.width }, (_, c) => (csv.header ? csv.rows[0].fields[c]?.text.trim() : "") || `column${c + 1}`);

/** A value as a field: quoted when it must be, or when it was. */
export function encodeField(value: string, delim: string, quoted = false): string {
  if (quoted || value.includes(delim) || value.includes('"') || value.includes("\n") || value.includes("\r") || value.startsWith(" ") || value.endsWith(" ")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export type Change = { from: number; to?: number; insert: string };

/** The change that sets cell (`r`, `c`) of the file's rows (header included) to `value`. A cell
 *  past a short row's end adds the delimiters before it. */
export function setCellChange(csv: Csv, r: number, c: number, value: string): Change | null {
  const row = csv.rows[r];
  if (!row) return null;
  const f = row.fields[c];
  if (f) return f.text === value ? null : { from: f.from, to: f.to, insert: encodeField(value, csv.delim, f.quoted) };
  if (value === "") return null;
  const end = row.fields[row.fields.length - 1].to;
  return { from: end, insert: csv.delim.repeat(c - row.fields.length + 1) + encodeField(value, csv.delim) };
}

/** The change that adds an empty row at the end, with the file's own line ending. */
export function addRowChange(text: string, csv: Csv): Change {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const blank = csv.delim.repeat(Math.max(0, csv.width - 1));
  // A row of nothing but an empty field would read back as an empty line, which is no row.
  const line = blank || '""';
  if (!text.length) return { from: 0, insert: line + eol };
  return text.endsWith("\n") ? { from: text.length, insert: line + eol } : { from: text.length, insert: eol + line };
}

/** The change that removes row `r` and its line ending. */
export function deleteRowChange(text: string, csv: Csv, r: number): Change | null {
  const row = csv.rows[r];
  if (!row) return null;
  // The last row of a file without a final newline takes the newline before it instead.
  if (row.next >= text.length && !text.endsWith("\n") && r > 0) {
    const prev = csv.rows[r - 1];
    const prevEnd = prev.fields[prev.fields.length - 1].to;
    return { from: prevEnd, to: text.length, insert: "" };
  }
  return { from: row.start, to: row.next, insert: "" };
}
