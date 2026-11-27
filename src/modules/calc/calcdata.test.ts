import { describe, expect, test } from "bun:test";
import { StringStream } from "@codemirror/language";
import { type Answer, evaluate, inBase, plain, pretty, runTape } from "./calcdata";
import { tapeParser } from "./calclang";

const shown = (a: Answer | null) => (a === null ? null : a.ok ? a.text : a.incomplete ? "…" : "?");

describe("evaluate", () => {
  test("precedence, powers and unary minus", () => {
    expect(evaluate("1+2*3")).toBe(7);
    expect(evaluate("-2^2")).toBe(-4);
    expect(evaluate("2^-1")).toBe(0.5);
    expect(evaluate("2**3**2")).toBe(512);
    expect(evaluate("5!")).toBe(120);
  });
  test("% is percent, or modulo when an operand follows", () => {
    expect(evaluate("200*15%")).toBe(30);
    expect(evaluate("50%")).toBe(0.5);
    expect(evaluate("10 % 3")).toBe(1);
    expect(evaluate("10 mod 4")).toBe(2);
  });
  test("bases, separators and bit operators", () => {
    expect(evaluate("0xff & 0b1010")).toBe(10);
    expect(evaluate("0o17 | 1_000")).toBe(1007);
    expect(evaluate("1 << 4 xor 1")).toBe(17);
    expect(evaluate("~0")).toBe(-1);
  });
  test("functions, constants and names", () => {
    expect(evaluate("sqrt(16) + max(1, 3)")).toBe(7);
    expect(evaluate("round(pi * 100)")).toBe(314);
    expect(evaluate("rate * 2", { rate: 21 })).toBe(42);
  });
  test("an open bracket at the end is closed", () => {
    expect(evaluate("sqrt(9")).toBe(3);
    expect(evaluate("(1+2")).toBe(3);
  });
  test("what it can't work out says why", () => {
    expect(() => evaluate("1+")).toThrow("incomplete");
    expect(() => evaluate("abc")).toThrow('unknown "abc"');
    expect(() => evaluate("1 2")).toThrow('unexpected "2"');
    expect(() => evaluate("sqrt(-1)")).toThrow("not a number");
  });
});

describe("formatting", () => {
  test("pretty groups and hides float noise", () => {
    expect(pretty(0.1 + 0.2)).toBe("0.3");
    expect(pretty(1234567.5)).toBe("1,234,567.5");
    expect(pretty(-4)).toBe("−4");
    expect(pretty(1e20)).toBe("1e20");
    expect(pretty(1 / 0)).toBe("∞");
  });
  test("plain can be typed back", () => {
    expect(plain(1234567.5)).toBe("1234567.5");
    expect(plain(1 / 3)).toBe("0.333333333333333");
  });
  test("inBase", () => {
    expect(inBase(255, 16)).toBe("0xFF");
    expect(inBase(10, 2)).toBe("0b1010");
    expect(inBase(-8.9, 8)).toBe("-0o10");
  });
});

describe("the tape", () => {
  test("names, ans and comments", () => {
    const r = runTape(["// a note", "rate = 95", "hours = 2 * 4", "rate * hours", "ans + 40 // tip"]);
    expect(r.map(shown)).toEqual([null, "95", "8", "760", "800"]);
    expect(r[1]).toMatchObject({ ok: true, name: "rate" });
  });
  test("sum adds the block since the last blank line", () => {
    const r = runTape(["100", "", "12", "8", "sum", "total"]);
    expect(r.map(shown)).toEqual(["100", null, "12", "8", "20", "40"]);
    expect(r[4]).toMatchObject({ sum: true });
  });
  test("a comment-only line doesn't break a block", () => {
    expect(runTape(["1", "// still here", "2", "sum"]).map(shown)).toEqual(["1", null, "2", "3"]);
  });
  test("in hex / bin / oct changes how a line shows, and what is copied", () => {
    const r = runTape(["1920 / 16 in hex", "5 to bin", "x = 8 as oct", "x"]);
    expect(r.map(shown)).toEqual(["0x78", "0b101", "0o10", "8"]);
    expect(r[0]).toMatchObject({ copy: "0x78" });
  });
  test("an unfinished line is …, a wrong one ?, and later lines still work", () => {
    const r = runTape(["2 *", "oops + 1", "3"]);
    expect(r.map(shown)).toEqual(["…", "?", "3"]);
  });
});

/** The highlighter's tokens for a tape, as `text:style` per line. */
function tokens(lines: string[]): string[][] {
  let state = tapeParser.startState!(2);
  return lines.map((line) => {
    state = tapeParser.copyState!(state);
    const s = new StringStream(line, 2, 2);
    const out: string[] = [];
    while (!s.eol()) {
      const style = tapeParser.token(s, state);
      if (style) out.push(`${s.current()}:${style}`);
      s.start = s.pos;
    }
    return out;
  });
}

describe("highlighting", () => {
  test("definitions, names, functions, numbers and comments", () => {
    expect(tokens(["rate = 95", "sqrt(rate) * pi // hi"])).toEqual([
      ["rate:variableName.definition", "=:operator", "95:number"],
      ["sqrt:variableName.function", "(:paren", "rate:variableName", "):paren", "*:operator", "pi:atom", "// hi:lineComment"],
    ]);
  });
  test("keywords, and a name nothing defines is invalid", () => {
    expect(tokens(["0xff in hex", "sum", "nope + ans"])).toEqual([
      ["0xff:number", "in:keyword", "hex:keyword"],
      ["sum:keyword"],
      ["nope:invalid", "+:operator", "ans:atom"],
    ]);
  });
  test("a name is only known below its definition", () => {
    expect(tokens(["x + 1", "x = 2", "x"]).map((l) => l[0])).toEqual(["x:invalid", "x:variableName.definition", "x:variableName"]);
  });
});
