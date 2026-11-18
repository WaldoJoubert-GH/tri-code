// A TextMate grammar as a CodeMirror StreamParser: each line is tokenized by vscode-textmate and
// handed to CodeMirror one TextMate token at a time, styled by grammars.ts `styleOf`. Pure (no
// Tauri, no WASM loading), so tmparser.test.ts runs it on real grammars.

import type { StreamParser } from "@codemirror/language";
import { INITIAL, type IGrammar, type StateStack } from "vscode-textmate";
import { type Lang, styleOf } from "./grammars";

/** Longer lines are tokenized only this far, as CodeMirror stops styling them there too. */
const MAX_LINE = 10_000;
/** A line that takes longer than this is left partly unstyled rather than freezing the editor. */
const LINE_MS = 200;

type State = { stack: StateStack; ends: number[]; styles: (string | null)[]; i: number };

export function parser(grammar: IGrammar, lang: Lang): StreamParser<State> {
  return {
    name: lang.id,
    startState: () => ({ stack: INITIAL, ends: [], styles: [], i: 0 }),
    copyState: (s) => ({ ...s }),
    blankLine: (s) => {
      s.stack = grammar.tokenizeLine("", s.stack, LINE_MS).ruleStack;
    },
    token(stream, s) {
      if (stream.sol()) {
        const line = stream.string.length > MAX_LINE ? stream.string.slice(0, MAX_LINE) : stream.string;
        const r = grammar.tokenizeLine(line, s.stack, LINE_MS);
        s.stack = r.ruleStack;
        s.ends = r.tokens.map((_, k) => r.tokens[k + 1]?.startIndex ?? line.length);
        s.styles = r.tokens.map((t) => styleOf(t.scopes));
        s.i = 0;
      }
      while (s.i < s.ends.length && s.ends[s.i] <= stream.pos) s.i++;
      if (s.i >= s.ends.length) {
        stream.skipToEnd();
        return null;
      }
      stream.pos = s.ends[s.i];
      return s.styles[s.i++];
    },
    languageData: lang.comment ? { commentTokens: lang.comment } : {},
  };
}
