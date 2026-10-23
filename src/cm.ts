// CodeMirror 6 for the editor window: the extensions every file gets, a theme drawn from
// tri-code's CSS variables (so it follows light / dark and the project accent with no JS),
// languages loaded per file type, and the line ending, BOM and indent a file is saved back with.

import { EditorState, type Extension, RangeSet, type StateCommand, StateEffect, StateField, Text } from "@codemirror/state";
import {
  EditorView, GutterMarker, crosshairCursor, drawSelection, dropCursor, gutter, highlightActiveLine, highlightActiveLineGutter,
  type Command, highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, moveLineDown, moveLineUp, copyLineDown, copyLineUp } from "@codemirror/commands";
import {
  HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser, bracketMatching, foldEffect, foldGutter, foldAll, foldKeymap, foldable, foldedRanges, indentOnInput, indentUnit, syntaxHighlighting, unfoldAll, unfoldEffect,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import type { ChangeMarks } from "./diff";
import { keysOf, sameChord, setEditorKeys, textPress } from "./keymap";
import type { Chord } from "./state";

/** The look: plain CSS with tri-code's variables, so every editor follows the theme and accent. */
const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--bg)", fontSize: "12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "17px" },
  ".cm-content": { caretColor: "var(--accent)", padding: "6px 0 14px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "color-mix(in srgb, var(--accent) 26%, transparent) !important" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "color-mix(in srgb, var(--muted) 75%, transparent)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px", minWidth: "40px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--muted)", padding: "0 4px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--raised)", border: "1px solid var(--line)", color: "var(--muted)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 20%, transparent)", outline: "1px solid color-mix(in srgb, var(--accent) 50%, transparent)" },
  ".cm-nonmatchingBracket": { color: "var(--bad)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 18%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 28%, transparent)", outline: "1px solid color-mix(in srgb, var(--warn) 55%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-panel.cm-search": { fontFamily: "var(--ui)", fontSize: "12px", padding: "4px 8px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontFamily: "inherit", fontSize: "12px" },
  ".cm-textfield": { backgroundColor: "var(--bg)", border: "1px solid var(--line)", borderRadius: "4px", color: "var(--text)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--raised)", border: "1px solid var(--line)", borderRadius: "4px", color: "var(--text)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line)", borderRadius: "6px", color: "var(--text)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--text)" },
  ".cm-specialChar": { color: "var(--bad)" },
  ".cm-changes .cm-gutterElement": { width: "4px", padding: "0", position: "relative" },
  ".cm-chg": { position: "absolute", inset: "1px 0 1px 0", borderRadius: "1px" },
  ".cm-chg.add": { backgroundColor: "var(--ok)" },
  ".cm-chg.mod": { backgroundColor: "var(--warn)" },
  ".cm-chg.del": {
    inset: "-4px auto auto 0", width: "0", height: "0", borderRadius: "0",
    borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "4px solid var(--bad)",
  },
});

// ---- change bars: where the buffer differs from HEAD, in a thin gutter beside the line numbers

class ChangeBar extends GutterMarker {
  constructor(readonly kind: "add" | "mod" | "del") { super(); }
  eq(o: ChangeBar) { return o.kind === this.kind; }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-chg ${this.kind}`;
    el.title = this.kind === "add" ? "Added since HEAD" : this.kind === "mod" ? "Changed since HEAD" : "Lines deleted above";
    return el;
  }
}
const BARS = { add: new ChangeBar("add"), mod: new ChangeBar("mod"), del: new ChangeBar("del") };

const setMarks = StateEffect.define<ChangeMarks | null>();

/** The bars, kept in place through edits until the editor sends fresh ones (debounced). */
const marksField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return barsOf(tr.state.doc, e.value);
    return tr.docChanged ? set.map(tr.changes) : set;
  },
});

function barsOf(doc: Text, m: ChangeMarks | null): RangeSet<GutterMarker> {
  if (!m) return RangeSet.empty;
  const at = new Map<number, ChangeBar>();
  // A deletion's caret yields to a bar on the same line.
  for (const n of m.del) at.set(Math.min(Math.max(1, n), doc.lines), BARS.del);
  for (const n of m.add) if (n <= doc.lines) at.set(n, BARS.add);
  for (const n of m.mod) if (n <= doc.lines) at.set(n, BARS.mod);
  const lines = [...at.keys()].sort((a, b) => a - b);
  return RangeSet.of(lines.map((n) => at.get(n)!.range(doc.line(n).from)));
}

const changeGutter = [marksField, gutter({ class: "cm-changes", markers: (v) => v.state.field(marksField) })];

/** Show (or with null, clear) the change bars of the view's file. */
export const showChanges = (view: EditorView, m: ChangeMarks | null) => view.dispatch({ effects: setMarks.of(m) });

/** Token colours: the same few as the old highlighter (code.ts) and the Markdown preview. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--violet)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--ok)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--warn)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--accent)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.heading], color: "var(--bad)" },
  { tag: [t.attributeName, t.propertyName, t.labelName], color: "color-mix(in srgb, var(--accent) 60%, var(--text))" },
  { tag: [t.heading], fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: [t.meta, t.processingInstruction], color: "var(--muted)" },
  { tag: t.invalid, color: "var(--bad)" },
]);

/** A legacy (CodeMirror 5) mode as a language: highlighting only. */
const legacy = (mode: () => Promise<StreamParser<unknown>>) => () => mode().then((m) => new LanguageSupport(StreamLanguage.define(m)));

/** Languages by file name. Each package is its own chunk, loaded the first time a file needs it. */
const LANGS: LanguageDescription[] = [
  LanguageDescription.of({ name: "TypeScript", extensions: ["ts", "mts", "cts"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })) }),
  LanguageDescription.of({ name: "TSX", extensions: ["tsx"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })) }),
  LanguageDescription.of({ name: "JavaScript", extensions: ["js", "mjs", "cjs"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript()) }),
  LanguageDescription.of({ name: "JSX", extensions: ["jsx"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })) }),
  LanguageDescription.of({ name: "JSON", extensions: ["json", "jsonc", "json5"], filename: /^\.(babelrc|prettierrc|eslintrc)$/, load: () => import("@codemirror/lang-json").then((m) => m.json()) }),
  LanguageDescription.of({ name: "CSS", extensions: ["css", "scss", "less"], load: () => import("@codemirror/lang-css").then((m) => m.css()) }),
  LanguageDescription.of({ name: "HTML", extensions: ["html", "htm", "vue", "svelte"], load: () => import("@codemirror/lang-html").then((m) => m.html()) }),
  LanguageDescription.of({ name: "XML", extensions: ["xml", "svg", "plist", "xaml", "csproj"], load: () => import("@codemirror/lang-xml").then((m) => m.xml()) }),
  LanguageDescription.of({ name: "Markdown", extensions: ["md", "markdown", "mdx"], load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()) }),
  LanguageDescription.of({ name: "Rust", extensions: ["rs"], load: () => import("@codemirror/lang-rust").then((m) => m.rust()) }),
  LanguageDescription.of({ name: "Python", extensions: ["py", "pyi"], load: () => import("@codemirror/lang-python").then((m) => m.python()) }),
  LanguageDescription.of({ name: "Go", extensions: ["go"], load: () => import("@codemirror/lang-go").then((m) => m.go()) }),
  LanguageDescription.of({ name: "YAML", extensions: ["yaml", "yml"], load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()) }),
  LanguageDescription.of({ name: "SQL", extensions: ["sql"], load: () => import("@codemirror/lang-sql").then((m) => m.sql()) }),
  LanguageDescription.of({ name: "TOML", extensions: ["toml"], filename: /^Cargo\.lock$/, load: legacy(() => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml)) }),
  LanguageDescription.of({ name: "Shell", extensions: ["sh", "bash", "zsh"], filename: /^\.(bashrc|zshrc|profile|envrc)$/, load: legacy(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)) }),
  LanguageDescription.of({ name: "PowerShell", extensions: ["ps1", "psm1"], load: legacy(() => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell)) }),
  LanguageDescription.of({ name: "Dockerfile", filename: /^(Dockerfile|Containerfile)(\..*)?$/, load: legacy(() => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile)) }),
  LanguageDescription.of({ name: "Lua", extensions: ["lua"], load: legacy(() => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua)) }),
  LanguageDescription.of({ name: "Ruby", extensions: ["rb"], filename: /^(Gemfile|Rakefile)$/, load: legacy(() => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby)) }),
  LanguageDescription.of({ name: "Swift", extensions: ["swift"], load: legacy(() => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift)) }),
  LanguageDescription.of({ name: "C", extensions: ["c", "h"], load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c)) }),
  LanguageDescription.of({ name: "C++", extensions: ["cpp", "cc", "cxx", "hpp", "hh"], load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp)) }),
  LanguageDescription.of({ name: "C#", extensions: ["cs"], load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp)) }),
  LanguageDescription.of({ name: "Java", extensions: ["java"], load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.java)) }),
  LanguageDescription.of({ name: "Kotlin", extensions: ["kt", "kts"], load: legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin)) }),
];

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The language a file is shown with, if tri-code knows one. */
export const languageOf = (path: string) => LanguageDescription.matchFilename(LANGS, baseName(path));

/** A file's text as the editor holds it, and what to put back on save. */
export type Body = { doc: Text; eol: "\n" | "\r\n"; bom: boolean; indent: string };

/** The editor splits on any line break and joins with `\n`; a file with CRLF is saved with CRLF
 *  again, and a BOM is put back, so a save never rewrites every line. */
export function toBody(text: string): Body {
  const bom = text.startsWith("﻿");
  const raw = bom ? text.slice(1) : text;
  const eol = /\r\n/.test(raw.slice(0, 100_000)) ? "\r\n" : "\n";
  return { doc: Text.of(raw.split(/\r\n|\r|\n/)), eol, bom, indent: guessIndent(raw) };
}

export const fromBody = (b: Pick<Body, "eol" | "bom">, doc: Text) => (b.bom ? "﻿" : "") + doc.sliceString(0, doc.length, b.eol);

/** Tabs if most indented lines start with one, else the smallest step of spaces (2 when unsure). */
function guessIndent(text: string): string {
  let tabs = 0, spaces = 0, step = 0;
  const lines = text.split("\n", 2000);
  for (const l of lines) {
    if (l.startsWith("\t")) tabs++;
    else if (l.startsWith(" ")) {
      const n = l.length - l.trimStart().length;
      if (n > 1 && l.trimStart() && !l.trimStart().startsWith("*")) {
        spaces++;
        step = step ? Math.min(step, n) : n;
      }
    }
  }
  if (tabs > spaces) return "\t";
  return " ".repeat(step === 4 || step === 8 ? 4 : 2);
}

/** Describe an indent unit for the status bar. */
export const indentText = (unit: string) => (unit === "\t" ? "Tabs" : `Spaces: ${unit.length}`);

/** The foldable range around the cursor: the one starting on its line, else the nearest one
 *  above that reaches past it. */
function foldAround(state: EditorState): { from: number; to: number } | null {
  const at = state.doc.lineAt(state.selection.main.head);
  for (let n = at.number; n >= 1; n--) {
    const line = state.doc.line(n);
    const r = foldable(state, line.from, line.to);
    if (r && r.to > at.from) return r;
  }
  return null;
}

/** Fold the block around the cursor and every block inside it, so unfolding it shows them folded. */
const foldRecursive: StateCommand = ({ state, dispatch }) => {
  const outer = foldAround(state);
  if (!outer) return false;
  const folded = foldedRanges(state);
  const effects: StateEffect<unknown>[] = [];
  const last = state.doc.lineAt(outer.to).number;
  for (let n = state.doc.lineAt(outer.from).number; n <= last; n++) {
    const line = state.doc.line(n);
    const r = foldable(state, line.from, line.to);
    if (!r || r.from < outer.from || r.to > outer.to) continue;
    let has = false;
    folded.between(r.from, r.from, (from, to) => { has ||= from === r.from && to === r.to; });
    if (!has) effects.push(foldEffect.of(r));
  }
  if (!effects.length) return false;
  dispatch(state.update({ effects }));
  return true;
};

/** Unfold the block around the cursor and every fold inside it. */
const unfoldRecursive: StateCommand = ({ state, dispatch }) => {
  const outer = foldAround(state);
  if (!outer) return false;
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(state).between(outer.from, outer.to, (from, to) => {
    if (from >= outer.from && to <= outer.to) effects.push(unfoldEffect.of({ from, to }));
  });
  if (!effects.length) return false;
  dispatch(state.update({ effects }));
  return true;
};

/** The Keymap's Editor actions (keymap.ts), so Settings › Hotkeys can change their keys. */
const EDITOR_ACTIONS: Record<string, Command> = {
  "fold-recursive": (v) => foldRecursive(v),
  "unfold-recursive": (v) => unfoldRecursive(v),
  "fold-all": foldAll,
  "unfold-all": unfoldAll,
};
const MODIFIERS = new Set(["Alt", "Shift", "Control", "Meta", "AltGraph", "OS"]);
/** The first key of a two-key chord, waiting for the second. */
let pending: Chord | undefined;

/** Run the Editor action this key press finishes for the focused editor, or hold the first key of
 *  a two-key chord. True when the key was the editor's; hotkeys.ts asks before any window hotkey. */
function editorKey(e: KeyboardEvent): boolean {
  const dom = document.activeElement?.closest<HTMLElement>(".cm-editor");
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) return !!(pending = undefined);
  if (MODIFIERS.has(e.key)) return !!pending;
  const p = textPress(e), first = pending;
  pending = undefined;
  if (!p) return false;
  const ids = Object.keys(EDITOR_ACTIONS);
  // Like VS Code, a second key that finishes no chord is swallowed.
  if (first) {
    const id = ids.find((id) => keysOf(id).some((c) => c.then && sameChord({ ...c, then: undefined }, first) && sameChord(c.then, p)));
    if (id) EDITOR_ACTIONS[id](view);
    return true;
  }
  const id = ids.find((id) => keysOf(id).some((c) => sameChord(c, p)));
  if (id) return EDITOR_ACTIONS[id](view), true;
  if (ids.some((id) => keysOf(id).some((c) => c.then && sameChord({ ...c, then: undefined }, p)))) return !!(pending = p);
  return false;
}

setEditorKeys(editorKey);

export type Setup = {
  path: string;
  body: Body;
  readOnly: boolean;
  /** Ctrl+S (Cmd+S on a Mac). */
  save: () => void;
  /** Any change of document or selection, for the window's status bar and dirty marks. */
  onUpdate: (state: EditorState, docChanged: boolean) => void;
};

/** A new editor state for a file: its text, its language once loaded, and every built-in feature. */
export async function createState(s: Setup): Promise<EditorState> {
  const lang = await languageOf(s.path)?.load().catch(() => undefined);
  return EditorState.create({ doc: s.body.doc, extensions: [extensions(s), lang ?? []] });
}

function extensions(s: Setup): Extension {
  return [
    lineNumbers(),
    changeGutter,
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ markerDOM: (open) => Object.assign(document.createElement("span"), { textContent: open ? "▾" : "▸" }) }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of(s.body.indent),
    EditorState.tabSize.of(s.body.indent === "\t" ? 4 : s.body.indent.length),
    syntaxHighlighting(highlight, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorState.readOnly.of(s.readOnly),
    theme,
    keymap.of([
      { key: "Mod-s", run: () => (s.save(), true), preventDefault: true },
      // Alt+↑/↓ and Shift+Alt+↑/↓ are window hotkeys in tri-code (focus, swap), so moving and
      // copying lines also has Ctrl+Shift chords that reach the editor (Ctrl on a Mac too, where
      // Cmd+Shift+↑ selects to the top).
      { key: "Ctrl-Shift-ArrowUp", run: moveLineUp },
      { key: "Ctrl-Shift-ArrowDown", run: moveLineDown },
      { key: "Ctrl-Shift-Alt-ArrowUp", run: copyLineUp },
      { key: "Ctrl-Shift-Alt-ArrowDown", run: copyLineDown },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) s.onUpdate(u.state, u.docChanged);
    }),
  ];
}
