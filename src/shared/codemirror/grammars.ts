// The Grammar Catalog (grammars.json, made by scripts/grammar-catalog.ts): the TextMate grammars the
// editor can install, the file types each is offered for, and how TextMate scopes are coloured.
// Pure, so grammars.test.ts can run it; langs.ts installs and textmate.ts tokenizes.

import catalog from "./grammars.json";

export type Comment = { line?: string; block?: { open: string; close: string } };
/** A language the editor can offer: its grammar's name in tm-grammars (`zig`) and the file types,
 *  an extension without its dot or a whole file name, it is offered for. */
export type Lang = { id: string; name: string; types: string[]; comment?: Comment };
/** One grammar file: its root scope, size, SHA-256 (hex), what is installed with it, and for an
 *  injection the scopes it injects into. */
export type Grammar = { scope: string; bytes: number; sha256: string; deps?: string[]; injectTo?: string[] };

export const VERSION: string = catalog.version;
export const LANGS: Lang[] = catalog.langs as Lang[];
export const GRAMMARS: Record<string, Grammar> = catalog.grammars as Record<string, Grammar>;

const byId = new Map(LANGS.map((l) => [l.id, l]));
export const langById = (id: string) => byId.get(id);

/** File type (lowercase) → language. The script made sure no type has two. */
const byType = new Map<string, Lang>();
for (const l of LANGS) for (const t of l.types) byType.set(t.toLowerCase(), l);

/** The catalog language for a file name: the longest file type it is or ends with (`.blade.php`
 *  before `.php`, `nginx.conf` before `.conf`). */
export function langOfName(base: string): Lang | undefined {
  const b = base.toLowerCase();
  const whole = byType.get(b);
  if (whole) return whole;
  for (let i = b.indexOf("."); i >= 0; i = b.indexOf(".", i + 1)) {
    const hit = byType.get(b.slice(i + 1));
    if (hit) return hit;
  }
  return undefined;
}

/** Every grammar a language needs: its own and its dependencies. */
export const grammarsOf = (id: string): string[] => (GRAMMARS[id] ? [id, ...(GRAMMARS[id].deps ?? [])] : []);

/** Bytes still to download to install `id`, given what is installed. */
export const downloadSize = (id: string, installed: ReadonlySet<string>) =>
  grammarsOf(id).filter((n) => !installed.has(n)).reduce((s, n) => s + GRAMMARS[n].bytes, 0);

/** The grammar name for a root scope (`source.zig` → `zig`). */
const byScope = new Map(Object.entries(GRAMMARS).map(([n, g]) => [g.scope, n]));
export const grammarOfScope = (scope: string) => byScope.get(scope);

/** Installed injections that inject into `scope`. */
export const injectionsInto = (scope: string, installed: ReadonlySet<string>) =>
  Object.entries(GRAMMARS).filter(([n, g]) => installed.has(n) && g.injectTo?.includes(scope)).map(([, g]) => g.scope);

/** What removing `id` deletes: its own grammar, and each of its dependencies that no other installed
 *  language needs, so nothing is left behind unlisted. */
export function removable(id: string, installed: ReadonlySet<string>): string[] {
  const keep = new Set<string>();
  for (const n of installed) {
    if (n === id || !byId.has(n)) continue;
    for (const d of grammarsOf(n)) keep.add(d);
  }
  return grammarsOf(id).filter((n) => installed.has(n) && (n === id || !keep.has(n)));
}

export const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

// ---- colours: TextMate scopes → the @lezer/highlight tag names StreamLanguage understands, which
// cm.ts's `highlight` colours. The innermost scope with a rule wins (a string's quote has no rule of
// its own, so it takes the string's).

const RULES: [prefix: string, style: string][] = [
  ["comment", "comment"],
  ["punctuation.definition.comment", "comment"],
  ["string.regexp", "regexp"],
  ["constant.character.escape", "string.special"],
  ["constant.other.placeholder", "string.special"],
  ["string", "string"],
  ["constant.numeric", "number"],
  ["constant.language", "bool"],
  ["constant.character", "string"],
  ["constant", "atom"],
  ["keyword.operator.new", "keyword"],
  ["keyword.operator.expression", "keyword"],
  ["keyword.operator.word", "keyword"],
  ["keyword.operator.logical.python", "keyword"],
  ["keyword.operator", "operator"],
  ["keyword.type", "typeName"],
  ["keyword", "keyword"],
  ["storage.type.primitive", "typeName"],
  ["storage.type.built-in", "typeName"],
  ["storage.type.annotation", "meta"],
  ["storage", "keyword"],
  ["variable.language", "keyword"],
  ["entity.name.function", "variableName.function"],
  ["support.function", "variableName.function"],
  ["meta.function-call.generic", "variableName.function"],
  ["entity.name.tag", "tagName"],
  ["entity.other.attribute-name", "attributeName"],
  ["entity.name.type", "typeName"],
  ["entity.name.class", "typeName"],
  ["entity.name.namespace", "typeName"],
  ["entity.name.module", "typeName"],
  ["entity.other.inherited-class", "typeName"],
  ["support.type.property-name", "propertyName"],
  ["support.type", "typeName"],
  ["support.class", "typeName"],
  ["entity.name.section", "heading"],
  ["entity.name.label", "labelName"],
  ["entity.name.decorator", "meta"],
  ["meta.decorator", "meta"],
  ["meta.annotation", "meta"],
  ["meta.preprocessor", "meta"],
  ["variable.other.property", "propertyName"],
  ["variable.other.object.property", "propertyName"],
  ["variable.other.member", "propertyName"],
  ["meta.object-literal.key", "propertyName"],
  ["support.variable.property", "propertyName"],
  ["variable.parameter", "variableName"],
  ["variable", "variableName"],
  ["markup.heading", "heading"],
  ["markup.bold", "strong"],
  ["markup.italic", "emphasis"],
  ["markup.underline.link", "link"],
  ["markup.inserted", "inserted"],
  ["markup.deleted", "deleted"],
  ["markup.changed", "changed"],
  ["invalid", "invalid"],
];

const matches = (scope: string, prefix: string) => scope === prefix || (scope.startsWith(prefix) && scope[prefix.length] === ".");

function styleOfScope(scope: string): string | null {
  for (const [p, s] of RULES) if (matches(scope, p)) return s;
  return null;
}

const memo = new Map<string, string | null>();

/** The style of a token from its scopes, outermost first as vscode-textmate gives them. */
export function styleOf(scopes: readonly string[]): string | null {
  const key = scopes.join(" ");
  let s = memo.get(key);
  if (s !== undefined) return s;
  s = null;
  for (let i = scopes.length - 1; i >= 0 && s === null; i--) s = styleOfScope(scopes[i]);
  if (memo.size > 5000) memo.clear();
  memo.set(key, s);
  return s;
}
