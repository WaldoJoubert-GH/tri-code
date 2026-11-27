// The Calculator Window's pure parts: an expression evaluator (no `eval`) and the Tape, where
// every line is worked out against the lines above it. The window is CalcPanel.tsx.

/** Functions a Tape line can call, by lower-case name. */
export const FNS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp, min: Math.min, max: Math.max, hypot: Math.hypot,
};
export const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
/** Words with a meaning of their own on a Tape line. */
export const KEYWORDS = ["in", "to", "as", "hex", "bin", "oct", "dec", "mod", "xor", "sum", "total"];

const BASES = { hex: 16, bin: 2, oct: 8, dec: 10 } as const;
const PREFIX: Record<number, string> = { 2: "0b", 8: "0o", 10: "", 16: "0x" };

/** Work out `src`. Names resolve from `scope` first, then the constants. `%` is percent, or modulo
 *  when an operand follows it (`10 % 3`). A bracket left open at the end is closed. Throws with a
 *  short reason; "incomplete" means the line just isn't finished yet. */
export function evaluate(src: string, scope: Record<string, number> = {}): number {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const peek = (t: string) => (ws(), src.startsWith(t, i));
  const word = (w: string) => { ws(); const m = /^[a-z]+/i.exec(src.slice(i)); return !!m && m[0].toLowerCase() === w; };
  const operandAt = (j: number) => { while (j < src.length && /\s/.test(src[j])) j++; return j < src.length && /[0-9a-z_.(~]/i.test(src[j]); };
  const int = (x: number) => BigInt(Math.trunc(x));
  const bits = (f: (a: bigint, b: bigint) => bigint) => (a: number, b: number) => Number(BigInt.asIntN(64, f(int(a), int(b))));
  const fail = (m: string): never => { throw new Error(m); };

  const bor = (): number => { let v = bxor(); while (peek("|")) { i++; v = bits((a, b) => a | b)(v, bxor()); } return v; };
  const bxor = (): number => { let v = band(); while (word("xor")) { i += 3; v = bits((a, b) => a ^ b)(v, band()); } return v; };
  const band = (): number => { let v = shift(); while (peek("&")) { i++; v = bits((a, b) => a & b)(v, shift()); } return v; };
  const shift = (): number => {
    let v = add();
    for (;;) {
      if (peek("<<")) { i += 2; v = bits((a, b) => a << b)(v, add()); }
      else if (peek(">>")) { i += 2; v = bits((a, b) => a >> b)(v, add()); }
      else return v;
    }
  };
  const add = (): number => {
    let v = mul();
    for (;;) {
      if (peek("+")) { i++; v += mul(); }
      else if (peek("-") || peek("−")) { i++; v -= mul(); }
      else return v;
    }
  };
  const mul = (): number => {
    let v = unary();
    for (;;) {
      if (peek("**")) return v;
      if (peek("*") || peek("×")) { i++; v *= unary(); }
      else if (peek("/") || peek("÷")) { i++; v /= unary(); }
      else if (peek("%")) { i++; v %= unary(); }
      else if (word("mod")) { i += 3; v %= unary(); }
      else return v;
    }
  };
  const unary = (): number => {
    if (peek("-") || peek("−")) { i++; return -unary(); }
    if (peek("+")) { i++; return unary(); }
    if (peek("~")) { i++; return Number(BigInt.asIntN(64, ~int(unary()))); }
    return pow();
  };
  const pow = (): number => {
    const b = postfix();
    if (peek("^") || peek("**")) { i += src[i] === "^" ? 1 : 2; return b ** unary(); }
    return b;
  };
  const postfix = (): number => {
    let v = primary();
    for (;;) {
      if (peek("!")) { i++; v = fact(v); }
      else if (peek("%") && !operandAt(i + 1)) { i++; v /= 100; }
      else return v;
    }
  };
  const fact = (v: number) => {
    if (v < 0 || !Number.isInteger(v) || v > 170) fail("bad factorial");
    let r = 1;
    for (let k = 2; k <= v; k++) r *= k;
    return r;
  };
  const close = () => { ws(); if (src[i] === ")") i++; else if (i < src.length) fail("missing )"); };
  const primary = (): number => {
    ws();
    if (i >= src.length) fail("incomplete");
    if (src[i] === "(") { i++; const v = bor(); close(); return v; }
    const rest = src.slice(i);
    let m = /^0(x[0-9a-f_]+|b[01_]+|o[0-7_]+)/i.exec(rest);
    if (m) { i += m[0].length; return Number(m[0].replace(/_/g, "").toLowerCase()); }
    m = /^(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    if (m) { i += m[0].length; return Number(m[0].replace(/_/g, "")); }
    m = /^[a-z_][a-z0-9_]*/i.exec(rest);
    if (!m) return fail(`unexpected "${src[i]}"`);
    i += m[0].length;
    const name = m[0], key = name.toLowerCase();
    if (FNS[key] && peek("(")) {
      i++;
      const args: number[] = [];
      ws();
      if (i < src.length && src[i] !== ")") { args.push(bor()); while (peek(",")) { i++; args.push(bor()); } }
      close();
      return FNS[key](...args);
    }
    if (name in scope) return scope[name];
    if (key in CONSTS) return CONSTS[key];
    return fail(`unknown "${name}"`);
  };

  if (!src.trim()) fail("empty");
  const v = bor();
  ws();
  if (i < src.length) fail(`unexpected "${src[i]}"`);
  if (Number.isNaN(v)) fail("not a number");
  return v;
}

/** A number as it can be typed back or pasted: no grouping, at most 15 significant digits. */
export function plain(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return String(parseFloat(n.toPrecision(15)));
}

/** A number for reading: grouped, rounded past float noise (0.1+0.2 is 0.3), exponent when huge or tiny. */
export function pretty(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "∞" : "−∞";
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e15 || a < 1e-9)) return n.toExponential(8).replace(/\.?0+e/, "e").replace("e+", "e").replace("-", "−");
  return parseFloat(n.toPrecision(14)).toLocaleString("en-US", { maximumFractionDigits: 12 }).replace("-", "−");
}

/** A whole number in base 2, 8 or 16 with its prefix (`0xFF`); fractions are dropped. */
export function inBase(n: number, base: 2 | 8 | 16): string {
  const v = BigInt(Math.trunc(n));
  const neg = v < 0n;
  return (neg ? "-" : "") + PREFIX[base] + (neg ? -v : v).toString(base).toUpperCase();
}

/** One Tape line's answer. `text` is shown, `copy` goes to the clipboard. `name` is set by an
 *  assignment (`rate = 95`); `sum` marks a `sum` / `total` line. */
export type Answer =
  | { ok: true; v: number; text: string; copy: string; name?: string; sum?: true }
  | { ok: false; why: string; incomplete: boolean };

/** Work out every line of a Tape, top to bottom. Blank and comment-only lines (`// …`) get null.
 *  `name = expr` sets a name for the lines below; `ans` is the answer above; `sum` / `total` adds
 *  the answers since the last blank line; `… in hex|bin|oct|dec` changes how a line is shown. */
export function runTape(lines: readonly string[]): (Answer | null)[] {
  const vars: Record<string, number> = {};
  let ans = 0;
  let block: number[] = [];
  return lines.map((raw) => {
    let s = stripComment(raw).trim();
    if (!s) {
      if (!raw.trim()) block = [];
      return null;
    }
    let base: 2 | 8 | 10 | 16 = 10;
    const conv = /^(.*?)\s+(?:in|to|as)\s+(hex|bin|oct|dec)$/i.exec(s);
    if (conv) {
      s = conv[1];
      base = BASES[conv[2].toLowerCase() as keyof typeof BASES];
    }
    const asg = /^([a-z_]\w*)\s*=(?!=)\s*(.*)$/i.exec(s);
    const name = asg?.[1];
    if (asg) s = asg[2];
    try {
      const sum = /^(sum|total)$/i.test(s);
      const v = sum ? block.reduce((a, b) => a + b, 0) : evaluate(s, { ...vars, ans });
      if (name) vars[name] = v;
      ans = v;
      block.push(v);
      const text = base === 10 ? pretty(v) : inBase(v, base);
      return { ok: true, v, text, copy: base === 10 ? plain(v) : text, ...(name ? { name } : {}), ...(sum ? { sum: true as const } : {}) };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { ok: false, why, incomplete: why === "incomplete" || why === "empty" };
    }
  });
}

/** A line without its `//` comment. */
export const stripComment = (line: string) => {
  const at = line.indexOf("//");
  return at < 0 ? line : line.slice(0, at);
};

/** What a new project's Tape starts with: a short tour of what a line can do. */
export const SAMPLE = `// Lines are worked out as you type. Click an answer to copy it.
rate = 95
hours = 6.5 * 4
rate * hours
ans * 1.15        // ans is the line above

// sum adds the lines since the last blank one
12
9.99
24.50
sum

1920 / 16 in hex
2^32 - 1
round(1024 / 3)
`;
