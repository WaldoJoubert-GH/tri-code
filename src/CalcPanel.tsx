// The Calculator Window (design/calculator.html, variant B): a Tape you type sums into, one per line,
// with each line's answer in a column on the right. It's a CodeMirror editor, so it has undo,
// brackets and the Tape's own highlighting (calclang.ts). The text is kept on the project.

import { For, createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import {
  type CompletionContext, type CompletionResult, acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap,
  closeCompletion, moveCompletionSelection, startCompletion,
} from "@codemirror/autocomplete";
import { type Project, type Tab, setCalcTape } from "./state";
import { type Answer, CONSTS, FNS, KEYWORDS, SAMPLE, stripComment } from "./calcdata";
import { answerAt, answers, tape } from "./calclang";
import { theme } from "./cm";
import { copyText } from "./clipboard";
import { Icon } from "./lucide";
import { flash } from "./ui";
import "./calc.css";

const SAVE_AFTER = 400;
type Ok = Extract<Answer, { ok: true }>;

/** The syntax the footer reminds of. */
const HINTS = ["x = 5", "ans", "sum", "… in hex", "// note", "sqrt( )", "2^10", "15%"];

/** Names to offer while typing: functions, constants, keywords, and the names the Tape defines. */
function complete(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[a-z_]\w*/i);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  if (stripComment(line.text).length < ctx.pos - line.from) return null;
  const defined = new Set<string>();
  for (const l of ctx.state.doc.iterLines()) {
    const m = /^\s*([a-z_]\w*)\s*=(?!=)/i.exec(l);
    if (m) defined.add(m[1]);
  }
  return {
    from: word.from,
    validFor: /^\w*$/,
    options: [
      ...[...defined].map((n) => ({ label: n, type: "variable" })),
      ...Object.keys(FNS).map((n) => ({ label: n, type: "function", apply: `${n}(` })),
      ...[...Object.keys(CONSTS), "ans"].map((n) => ({ label: n, type: "constant" })),
      ...KEYWORDS.map((n) => ({ label: n, type: "keyword" })),
    ],
  };
}

export default function CalcPanel(props: { project: Project; tab: Tab; focused: boolean }): JSX.Element {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const [last, setLast] = createSignal<Ok | null>(null);
  const [count, setCount] = createSignal(0);

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (view) setCalcTape(props.project.id, view.state.doc.toString());
  };

  const copy = (a: Ok) => {
    copyText(a.copy);
    flash(`copied ${a.copy.length > 28 ? a.copy.slice(0, 28) + "…" : a.copy}`);
  };

  /** The answer on the cursor's line, else the last one on the Tape. */
  const current = (): Ok | null => {
    if (!view) return null;
    const here = answerAt(view, view.state.selection.main.head);
    return here?.ok ? here : last();
  };

  const summarise = (s: EditorState) => {
    const all = s.field(answers).filter((a): a is Ok => !!a?.ok);
    setCount(all.length);
    setLast(all.at(-1) ?? null);
  };

  function clear() {
    if (!view || !view.state.doc.length) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" }, userEvent: "delete" });
    view.focus();
    flash("tape cleared · Ctrl+Z brings it back");
  }

  onMount(() => {
    const state = EditorState.create({
      doc: props.project.calc ?? SAMPLE,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ override: [complete], defaultKeymap: false, icons: false }),
        keymap.of([
          // Enter is always a new line; Tab takes the offered name.
          { key: "Tab", run: acceptCompletion },
          { key: "ArrowDown", run: moveCompletionSelection(true) },
          { key: "ArrowUp", run: moveCompletionSelection(false) },
          { key: "Escape", run: closeCompletion },
          { key: "Ctrl-Space", run: startCompletion },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        theme,
        tape(copy),
        EditorView.contentAttributes.of({ "aria-label": "Calculator tape", spellcheck: "false" }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          summarise(u.state);
          clearTimeout(saveTimer);
          saveTimer = setTimeout(save, SAVE_AFTER);
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
    summarise(state);
    // The first open keeps the sample, so the next one doesn't bring it back after a clear.
    if (props.project.calc === undefined) save();
    if (props.focused) view.focus();
  });

  createEffect(on(() => props.focused, (f) => {
    if (f && view && !view.hasFocus) view.focus();
  }, { defer: true }));

  onCleanup(() => {
    if (saveTimer) save();
    view?.destroy();
  });

  return (
    <div class="ca-root">
      <div class="ca-ph">
        <span class="ca-title">Tape</span>
        <span class="ca-dim">{count() === 1 ? "1 answer" : `${count()} answers`}</span>
        <span class="ca-grow" />
        <button class="ca-ib" onClick={() => { const a = current(); if (a) copy(a); else flash("no answer to copy"); }} title="Copy the answer on this line, else the last one">
          <Icon name="copy" size={13} />
        </button>
        <button class="ca-ib" onClick={clear} title="Clear the tape (Ctrl+Z brings it back)">
          <Icon name="eraser" size={13} />
        </button>
      </div>
      <div class="ca-ed" ref={host} />
      <div class="ca-foot">
        <For each={HINTS}>{(h) => <code>{h}</code>}</For>
      </div>
    </div>
  );
}
