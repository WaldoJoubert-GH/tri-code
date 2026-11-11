import { describe, expect, test } from "bun:test";
import { addRowChange, columnNames, deleteRowChange, encodeField, parseCsv, setCellChange, sniff } from "./csv";

const apply = (text: string, ch: { from: number; to?: number; insert: string } | null) =>
  ch ? text.slice(0, ch.from) + ch.insert + text.slice(ch.to ?? ch.from) : text;

const CUSTOMERS = 'id,name,mrr\n1,Ada,240.00\n2,"Ruiz, Mateo",19.00\n\n3,"Says ""hi""\ntwice",\n';

describe("parse", () => {
  test("fields, quotes, embedded newlines and empty lines", () => {
    const csv = parseCsv(CUSTOMERS, "customers.csv");
    expect(csv.delim).toBe(",");
    expect(csv.header).toBe(true);
    expect(csv.width).toBe(3);
    expect(columnNames(csv)).toEqual(["id", "name", "mrr"]);
    expect(csv.rows.map((r) => r.fields.map((f) => f.text))).toEqual([
      ["id", "name", "mrr"],
      ["1", "Ada", "240.00"],
      ["2", "Ruiz, Mateo", "19.00"],
      ["3", 'Says "hi"\ntwice', ""],
    ]);
  });

  test("CRLF stays out of the fields", () => {
    const csv = parseCsv("a,b\r\n1,\"x\"\r\n");
    expect(csv.rows[1].fields.map((f) => f.text)).toEqual(["1", "x"]);
    expect(csv.rows[1].fields[1].to).toBe("a,b\r\n1,\"x\"".length);
  });

  test("delimiters and headerless files", () => {
    expect(sniff("a;b;c\n1;2,5;3\n")).toBe(";");
    expect(sniff("a\tb\n1\t2\n")).toBe("\t");
    expect(sniff("x|y", "t.psv")).toBe("|");
    const csv = parseCsv("1,2\n3,4\n");
    expect(csv.header).toBe(false);
    expect(columnNames(csv)).toEqual(["column1", "column2"]);
  });
});

describe("edits", () => {
  test("a cell edit replaces just that field, quoting when it must", () => {
    const csv = parseCsv(CUSTOMERS);
    expect(apply(CUSTOMERS, setCellChange(csv, 1, 1, "Ada Okafor"))).toBe(CUSTOMERS.replace("1,Ada,", "1,Ada Okafor,"));
    expect(apply(CUSTOMERS, setCellChange(csv, 1, 1, "Okafor, Ada"))).toBe(CUSTOMERS.replace("1,Ada,", '1,"Okafor, Ada",'));
    // A quoted field stays quoted.
    expect(apply(CUSTOMERS, setCellChange(csv, 2, 1, "Ruiz"))).toBe(CUSTOMERS.replace('"Ruiz, Mateo"', '"Ruiz"'));
    expect(setCellChange(csv, 1, 1, "Ada")).toBeNull();
  });

  test("a cell past a short row's end", () => {
    const text = "a,b,c\n1\n";
    const csv = parseCsv(text);
    expect(apply(text, setCellChange(csv, 1, 2, "z"))).toBe("a,b,c\n1,,z\n");
  });

  test("add and delete rows", () => {
    const csv = parseCsv(CUSTOMERS);
    expect(apply(CUSTOMERS, addRowChange(CUSTOMERS, csv))).toBe(CUSTOMERS + ",,\n");
    expect(apply(CUSTOMERS, deleteRowChange(CUSTOMERS, csv, 1))).toBe(CUSTOMERS.replace("1,Ada,240.00\n", ""));
    const noEol = "a,b\n1,2\n3,4";
    expect(apply(noEol, deleteRowChange(noEol, parseCsv(noEol), 2))).toBe("a,b\n1,2");
    expect(apply("a\n1", addRowChange("a\n1", parseCsv("a\n1")))).toBe('a\n1\n""');
  });

  test("encodeField", () => {
    expect(encodeField("plain", ",")).toBe("plain");
    expect(encodeField('say "x"', ",")).toBe('"say ""x"""');
    expect(encodeField("a\tb", "\t")).toBe('"a\tb"');
  });
});
