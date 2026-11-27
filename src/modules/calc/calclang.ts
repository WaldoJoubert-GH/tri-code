// The Tape as CodeMirror sees it: a small language for its highlighting (numbers, names, functions,
// keywords, comments, and names nothing defines in red), and the answers in a gutter on the right,
// one per line, worked out by runTape (calcdata.ts) whenever the text changes.

import { type Extension, StateField } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, type StreamParser, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { type Answer, CONSTS, FNS, KEYWORDS, runTape } from "./calcdata";

type LineState = { vars: string[] };

const KEYWORD = new Set(KEYWORDS);

/** Tokens: `variableName.definition` where a line names something, `variableName` for a name defined
 *  above, `invalid` for one that isn't (so a typo shows before its answer goes missing). */
export const tapeParser: StreamParser<LineState> = {
  name: "tape",
  startState: () => ({ vars: [] }),
  copyState: (s) => ({ vars: [...s.vars] }),
  token(stream, state) {
    if (stream.sol()) {
      const def = stream.match(/^\s*([a-z_]\w*)(?=\s*=(?!=))/i, false) as RegExpMatchArray | null;
      if (def) {
        stream.eatSpace();
        stream.match(def[1]);
        if (!state.vars.includes(def[1])) state.vars.push(def[1]);
        return "variableName.definition";
      }
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.match(/^0(x[0-9a-f_]+|b[01_]+|o[0-7_]+)/i) || stream.match(/^(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)) return "number";
    const w = stream.match(/^[a-z_][a-z0-9_]*/i) as RegExpMatchArray | null;
    if (w) {
      const name = w[0], key = name.toLowerCase();
      // A call is a call even where a name shadows the function, as evaluate() reads it.
      if (FNS[key] && stream.match(/^\s*\(/, false)) return "variableName.function";
      if (state.vars.includes(name)) return "variableName";
      if (KEYWORD.has(key)) return "keyword";
      if (key in CONSTS || name === "ans") return "atom";
      return "invalid";
    }
    if (stream.match(/^(<<|>>|\*\*|[-+*/%^&|~!=×÷−,])/)) return "operator";
    if (stream.match(/^[()]/)) return "paren";
    stream.next();
    return "invalid";
  },
  languageData: { commentTokens: { line: "//" } },
};

export const tapeLanguage = StreamLanguage.define(tapeParser);

/** The Tape's colours, from tri-code's tokens so they follow the theme. Names are green in the text
 *  and in the answers, so `rate = 95` reads as one thing. */
export const tapeHighlight = HighlightStyle.define([
  { tag: t.number, color: "var(--warn)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--ok)" },
  { tag: t.definition(t.variableName), fontWeight: "600" },
  { tag: t.function(t.variableName), color: "var(--accent)" },
  { tag: t.keyword, color: "var(--violet)" },
  { tag: t.atom, color: "color-mix(in srgb, var(--accent) 55%, var(--text))", fontStyle: "italic" },
  { tag: [t.operator, t.paren], color: "var(--muted)" },
  { tag: t.lineComment, color: "var(--muted)", fontStyle: "italic" },
  { tag: t.invalid, color: "var(--bad)", textDecoration: "underline wavy color-mix(in srgb, var(--bad) 60%, transparent)", textUnderlineOffset: "3px" },
]);

/** Every line's answer, recomputed when the text changes. */
export const answers = StateField.define<(Answer | null)[]>({
  create: (s) => runTape(s.doc.toString().split("\n")),
  update: (v, tr) => (tr.docChanged ? runTape(tr.state.doc.toString().split("\n")) : v),
});

class AnswerMark extends GutterMarker {
  constructor(readonly a: Answer) { super(); }
  eq(o: AnswerMark) {
    const a = this.a, b = o.a;
    return a.ok && b.ok ? a.text === b.text && a.name === b.name && a.sum === b.sum : !a.ok && !b.ok && a.why === b.why;
  }
  toDOM() {
    const el = document.createElement("span");
    const a = this.a;
    if (a.ok) {
      el.className = `ca-ans${a.name ? " ca-var" : ""}${a.sum ? " ca-sum" : ""}`;
      el.textContent = a.text;
      el.title = `${a.name ? `${a.name} = ` : ""}${a.text} · click to copy`;
    } else {
      el.className = "ca-why";
      el.textContent = a.incomplete ? "…" : "?";
      el.title = a.why;
    }
    return el;
  }
}

/** The answer of the line at `pos`, if it has one. */
export function answerAt(view: EditorView, pos: number): Answer | null {
  return view.state.field(answers)[view.state.doc.lineAt(pos).number - 1] ?? null;
}

/** The answers gutter and the language, for an editor showing a Tape. `onCopy` hears a click on an answer. */
export function tape(onCopy: (a: Extract<Answer, { ok: true }>) => void): Extension {
  return [
    tapeLanguage,
    syntaxHighlighting(tapeHighlight),
    answers,
    gutter({
      class: "ca-gutter",
      side: "after",
      lineMarker: (view, line) => {
        const a = answerAt(view, line.from);
        return a ? new AnswerMark(a) : null;
      },
      lineMarkerChange: (u) => u.docChanged,
      domEventHandlers: {
        mousedown: (view, line) => {
          const a = answerAt(view, line.from);
          if (!a?.ok) return false;
          onCopy(a);
          return true;
        },
      },
    }),
  ];
}
