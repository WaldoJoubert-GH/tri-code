// Installed TextMate grammars as CodeMirror languages: vscode-textmate tokenizes each line with the
// Oniguruma regex engine (WASM), and a StreamLanguage hands CodeMirror one token per TextMate token,
// styled by grammars.ts `styleOf`, so colours come from cm.ts's `highlight` like a built-in
// language's. Its own chunk: loaded the first time a file needs an installed grammar.

import { invoke } from "@tauri-apps/api/core";
import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import { type IRawGrammar, Registry, parseRawGrammar } from "vscode-textmate";
import { OnigScanner, OnigString, loadWASM } from "vscode-oniguruma";
import onigUrl from "vscode-oniguruma/release/onig.wasm?url";
import { GRAMMARS, type Lang, grammarOfScope, injectionsInto } from "./grammars";
import { parser } from "./tmparser";
import { installedGrammars } from "./langs";

let onig: Promise<{ createOnigScanner: (p: string[]) => OnigScanner; createOnigString: (s: string) => OnigString }> | undefined;
const onigLib = () =>
  (onig ??= fetch(onigUrl)
    .then((r) => r.arrayBuffer())
    .then((buf) => loadWASM(buf))
    .then(() => ({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) })));

/** Grammar texts by name. A file doesn't change while installed, so they are kept. */
const raw = new Map<string, Promise<IRawGrammar | null>>();
const readGrammar = (name: string) => {
  let p = raw.get(name);
  if (!p) {
    p = invoke<string>("grammar_read", { name })
      .then((text) => parseRawGrammar(text, `${name}.json`))
      .catch((e) => (console.warn(`grammar ${name}:`, e), raw.delete(name), null));
    raw.set(name, p);
  }
  return p;
};

/** A registry sees the grammars installed when it was made (an embedded language installed later
 *  is picked up by the next one), so one is kept per installed set. */
let registry: { key: string; reg: Registry } | undefined;
function registryNow(): Registry {
  const have = installedGrammars();
  const key = [...have].sort().join(" ");
  if (registry?.key !== key) {
    registry = {
      key,
      reg: new Registry({
        onigLib: onigLib(),
        loadGrammar: async (scope) => {
          const name = grammarOfScope(scope);
          return name && have.has(name) ? readGrammar(name) : null;
        },
        getInjections: (scope) => injectionsInto(scope, have),
      }),
    };
  }
  return registry.reg;
}

/** `lang` as a CodeMirror language, from its installed grammar. Rejects if it isn't installed. */
export async function textmateLanguage(lang: Lang): Promise<LanguageSupport> {
  const grammar = await registryNow().loadGrammar(GRAMMARS[lang.id].scope);
  if (!grammar) throw new Error(`${lang.name}'s grammar isn't installed`);
  return new LanguageSupport(StreamLanguage.define(parser(grammar, lang)));
}
