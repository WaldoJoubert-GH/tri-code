// Writes src/grammars.json, the Grammar Catalog: every TextMate grammar the editor can offer to
// install, from the tm-grammars package (the grammars VS Code extensions ship, collected by Shiki).
// The package version is pinned in package.json, and the app downloads the same version's files, so
// a grammar only changes when this script is run again after a bump.
//
//   bun run grammars
//
// Per grammar: its scope, its size, a SHA-256 the download is checked against, and the grammars it
// embeds (transitively), which are installed with it. Per language: the file types it is offered for.
// tm-grammars has no file types of its own, so they come from each grammar's `fileTypes`, cleaned up
// and completed by OWN below. A file type claimed by two grammars stops the script until OWN decides.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { grammars, injections } from "tm-grammars";

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("tm-grammars/package.json"));
const version: string = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const fileOf = (name: string) => readFileSync(join(pkgDir, "grammars", `${name}.json`));

/** File types (an extension without the dot, or a whole file name) by grammar, replacing its
 *  `fileTypes`: for grammars that have none, and to settle types two grammars claim. [] offers none. */
const OWN: Record<string, string[]> = {
  ada: ["adb", "ads", "ada"],
  apache: [".htaccess", "htaccess", "htpasswd", "htgroups", "apache2.conf", "httpd.conf"],
  asm: ["asm", "nasm", "yasm", "s"],
  bat: ["bat", "cmd"],
  bibtex: ["bib"],
  bird2: ["bird", "bird2", "bird.conf", "bird2.conf"],
  cadence: ["cdc"],
  cairo: ["cairo"],
  clarity: ["clar"],
  clojure: ["clj", "cljs", "cljc", "edn"],
  cobol: ["cob", "cbl", "cobol", "cpy"],
  codeowners: ["CODEOWNERS"],
  coffee: ["coffee", "cson"],
  coq: [],
  dart: ["dart"],
  dax: ["dax"],
  desktop: ["desktop"],
  diff: ["diff", "patch"],
  dotenv: [".env", "env"],
  edge: ["edge"],
  fennel: ["fnl"],
  fish: ["fish"],
  fluent: ["ftl"],
  fsharp: ["fs", "fsi", "fsx"],
  genie: [],
  "git-commit": ["COMMIT_EDITMSG", "MERGE_MSG", "TAG_EDITMSG"],
  "git-rebase": ["git-rebase-todo"],
  glsl: ["glsl", "vert", "frag", "geom", "fsh", "vshader", "fshader"],
  gn: ["gn", "gni"],
  groovy: ["groovy", "gradle", "gvy", "Jenkinsfile"],
  hack: ["hack", "hhi"],
  handlebars: ["hbs", "handlebars"],
  haxe: ["hx"],
  hlsl: ["hlsl", "hlsli", "fx", "fxh"],
  hurl: ["hurl"],
  hy: ["hy"],
  ini: ["ini", "cfg", "conf", "properties", ".editorconfig", ".gitconfig", ".npmrc"],
  jinja: ["jinja", "jinja2", "j2"],
  jsonl: ["jsonl", "ndjson"],
  jsonnet: ["jsonnet", "libsonnet"],
  julia: ["jl"],
  kdl: ["kdl"],
  latex: ["tex", "ltx"],
  lean: ["lean"],
  llvm: ["ll"],
  make: ["mk", "mak", "Makefile", "makefile", "GNUmakefile"],
  matlab: [],
  mdc: ["mdc"],
  mermaid: ["mmd", "mermaid"],
  mipsasm: ["mips", "spim"],
  mojo: ["mojo"],
  move: ["move"],
  narrat: ["narrat"],
  nextflow: ["nf"],
  nginx: ["nginx.conf", "nginx", "ngx"],
  nushell: ["nu"],
  "objective-c": ["m"],
  "objective-cpp": ["mm"],
  odin: ["odin"],
  org: ["org"],
  pascal: ["pas", "dpr", "dpk", "lpr", "lfm", "dfm"],
  perl: ["pl", "pm", "t", "pod"],
  php: ["php", "phtml", "php3", "php4", "php5", "phps"],
  polar: ["polar"],
  prolog: ["pro", "prolog"],
  pug: ["pug", "jade"],
  qml: ["qml"],
  qmldir: ["qmldir"],
  qss: ["qss"],
  racket: ["rkt"],
  raku: ["raku", "rakumod", "rakutest", "p6", "pm6"],
  rbs: ["rbs"],
  regexp: [],
  riscv: ["riscv"],
  ron: ["ron"],
  rst: ["rst"],
  scheme: ["scm", "ss", "sch"],
  shaderlab: ["shader"],
  "ssh-config": ["ssh_config", "sshd_config"],
  "system-verilog": ["sv", "svh"],
  systemd: ["service", "socket", "timer", "mount", "automount", "target", "path", "slice"],
  talonscript: ["talon"],
  templ: ["templ"],
  tex: ["sty", "dtx", "ins"],
  typst: ["typ"],
  v: ["vsh", "vv"],
  vala: ["vala", "vapi"],
  vb: ["vb", "vbs", "bas"],
  verilog: ["v", "vh"],
  viml: ["vim", ".vimrc", "_vimrc", ".gvimrc"],
  vue: ["vue"],
  vyper: ["vy"],
  wasm: ["wat", "wast"],
  wgsl: ["wgsl"],
  wikitext: ["wiki", "mediawiki"],
  wit: ["wit"],
  wolfram: ["wl", "wls", "nb"],
  xsl: ["xsl", "xslt"],
};

/** Grammars never offered for a file: parts of other languages, or duplicates. They can still be
 *  installed as another grammar's dependency. */
const SKIP = new Set([
  "angular-html", "angular-ts", "glimmer-js", "glimmer-ts", "html-derivative", "vue-html", "vue-vine",
  "ts-tags", "nextflow-groovy", "shellsession", "jison", "ahk2", "logo", "wenyan", "rel", "fortran-fixed-form",
]);

/** Comment tokens for Toggle Line / Block Comment (a grammar doesn't carry them). */
const HASH = { line: "#" }, SLASH = { line: "//", block: { open: "/*", close: "*/" } }, DASH = { line: "--" }, SEMI = { line: ";" };
const COMMENTS: Record<string, { line?: string; block?: { open: string; close: string } }> = {
  apache: HASH, awk: HASH, bird2: HASH, cmake: HASH, coffee: HASH, crystal: HASH, desktop: HASH, dotenv: HASH, elixir: HASH,
  fish: HASH, gdscript: HASH, gn: HASH, graphql: HASH, hcl: { line: "#", block: { open: "/*", close: "*/" } }, ini: SEMI,
  julia: HASH, just: HASH, make: HASH, mojo: HASH, nginx: HASH, nim: HASH, nix: { line: "#", block: { open: "/*", close: "*/" } },
  nushell: HASH, perl: HASH, puppet: HASH, r: HASH, raku: HASH, "ssh-config": HASH, systemd: HASH, tcl: HASH, talonscript: HASH,
  terraform: { line: "#", block: { open: "/*", close: "*/" } }, codeowners: HASH, gnuplot: HASH, stata: { line: "//" },
  ada: DASH, elm: { line: "--", block: { open: "{-", close: "-}" } }, haskell: { line: "--", block: { open: "{-", close: "-}" } },
  purescript: DASH, vhdl: DASH, luau: DASH, cypher: { line: "//" }, plsql: DASH, sparql: HASH, surrealql: DASH,
  asm: SEMI, clojure: SEMI, "common-lisp": SEMI, "emacs-lisp": SEMI, fennel: SEMI, hy: SEMI, racket: SEMI, scheme: SEMI, llvm: SEMI,
  matlab: { line: "%" }, erlang: { line: "%" }, latex: { line: "%" }, tex: { line: "%" }, prolog: { line: "%" }, bibtex: { line: "%" },
  vb: { line: "'" }, viml: { line: "\"" }, bat: { line: "REM" }, fortran: { line: "!" }, "fortran-free-form": { line: "!" },
  apex: SLASH, ballerina: SLASH, c3: SLASH, cairo: SLASH, cadence: SLASH, chapel: SLASH, cue: SLASH, d: SLASH, dart: SLASH,
  fsharp: { line: "//", block: { open: "(*", close: "*)" } }, ocaml: { block: { open: "(*", close: "*)" } }, gleam: { line: "//" },
  glsl: SLASH, groovy: SLASH, hack: SLASH, haxe: SLASH, hlsl: SLASH, jsonnet: SLASH, move: SLASH, "objective-c": SLASH,
  "objective-cpp": SLASH, odin: SLASH, php: SLASH, prisma: { line: "//" }, proto: SLASH, qml: SLASH, scala: SLASH, smithy: { line: "//" },
  solidity: SLASH, stylus: SLASH, sass: { line: "//" }, typespec: SLASH, v: SLASH, vala: SLASH, verilog: SLASH,
  "system-verilog": SLASH, wgsl: SLASH, wit: { line: "//" }, zig: { line: "//" }, kdl: SLASH, kotlin: SLASH, typst: SLASH,
  pascal: { line: "//", block: { open: "{", close: "}" } }, wasm: { line: ";;", block: { open: "(;", close: ";)" } },
  twig: { block: { open: "{#", close: "#}" } }, jinja: { block: { open: "{#", close: "#}" } }, liquid: { block: { open: "{% comment %}", close: "{% endcomment %}" } },
  handlebars: { block: { open: "{{!--", close: "--}}" } }, vue: { block: { open: "<!--", close: "-->" } }, svelte: { block: { open: "<!--", close: "-->" } },
  astro: { block: { open: "<!--", close: "-->" } }, xsl: { block: { open: "<!--", close: "-->" } }, pug: { line: "//-" },
  haml: { line: "-#" }, erb: { block: { open: "<%#", close: "%>" } }, razor: { block: { open: "@*", close: "*@" } }, lean: DASH,
  dax: { line: "//" }, kusto: { line: "//" }, powerquery: SLASH, sql: DASH, toml: HASH, yaml: HASH,
};

type Info = (typeof grammars)[number];
const all = new Map<string, Info>([...grammars, ...injections].map((g) => [g.name, g]));
const injectionNames = new Set(injections.map((g) => g.name));

/** Embedded grammars that come along when a language is installed: the web's own (a Vue or PHP file
 *  is mostly HTML, CSS and script), and what NEEDS adds. The rest a grammar embeds (Markdown's dozens
 *  of code-fence languages, the C++ in a Julia string) is coloured only when that language's own
 *  grammar is installed, so installing Svelte doesn't download Stylus, Pug and CoffeeScript. */
const CORE = new Set(["javascript", "typescript", "jsx", "tsx", "css", "scss", "html", "html-derivative", "json", "jsonc", "xml", "yaml"]);
const NEEDS: Record<string, string[]> = {
  erb: ["ruby"], haml: ["ruby"], mdx: ["markdown", "toml"], latex: ["tex"], jinja: ["jinja-html"], blade: ["php"], razor: ["csharp"],
  "objective-cpp": ["cpp", "objective-c"], cpp: ["c"], twig: ["php"], liquid: ["markdown"],
};

/** A grammar's embedded grammars that come along (CORE, NEEDS) and the injections into it, then theirs. */
function closure(name: string): string[] {
  const out = new Set<string>(), todo = [name];
  while (todo.length) {
    const n = todo.pop()!;
    const g = all.get(n);
    if (!g) continue;
    const own = [...(g.embedded ?? []).filter((e) => CORE.has(e)), ...(NEEDS[n] ?? [])];
    const next = [...own, ...injections.filter((i) => i.embeddedIn?.includes(n)).map((i) => i.name)];
    for (const e of next) if (e !== name && !out.has(e) && all.has(e)) (out.add(e), todo.push(e));
  }
  return [...out].sort();
}

const clean = (types: string[]) =>
  [...new Set(types.filter((t) => !/[\s/]/.test(t)).map((t) => (/[A-Z]/.test(t) && t.length > 1 && /[a-z]/.test(t) ? t : t.toLowerCase())))];

// Offered languages and their file types.
const langs: { id: string; name: string; types: string[]; comment?: (typeof COMMENTS)[string] }[] = [];
for (const g of grammars) {
  if (SKIP.has(g.name)) continue;
  const raw = OWN[g.name] ?? (JSON.parse(fileOf(g.name).toString()).fileTypes as string[] | undefined) ?? [];
  const types = clean(raw);
  if (!types.length) continue;
  langs.push({ id: g.name, name: g.displayName, types, ...(COMMENTS[g.name] ? { comment: COMMENTS[g.name] } : {}) });
}

// One grammar per file type, case-insensitively, as the editor matches them.
const owner = new Map<string, string>(), clashes: string[] = [];
for (const l of langs) for (const t of l.types) {
  const k = t.toLowerCase(), had = owner.get(k);
  if (had && had !== l.id) clashes.push(`${t}: ${had} and ${l.id}`);
  else owner.set(k, l.id);
}
if (clashes.length) {
  console.error(`File types claimed twice; settle them in OWN:\n  ${clashes.join("\n  ")}`);
  process.exit(1);
}

// Every grammar an offered language needs.
const needed = new Set<string>();
for (const l of langs) for (const n of [l.id, ...closure(l.id)]) needed.add(n);

const table: Record<string, { scope: string; bytes: number; sha256: string; deps?: string[]; injectTo?: string[] }> = {};
for (const n of [...needed].sort()) {
  const g = all.get(n)!;
  const file = fileOf(n);
  const json = JSON.parse(file.toString());
  const deps = langs.some((l) => l.id === n) ? closure(n) : [];
  const injectTo: string[] | undefined = injectionNames.has(n)
    ? [...new Set([...(json.injectTo ?? []), ...(g.embeddedIn ?? []).map((e: string) => all.get(e)?.scopeName).filter(Boolean)])]
    : undefined;
  table[n] = {
    scope: g.scopeName,
    bytes: file.length,
    sha256: createHash("sha256").update(file).digest("hex"),
    ...(deps.length ? { deps } : {}),
    ...(injectTo?.length ? { injectTo } : {}),
  };
}

langs.sort((a, b) => a.name.localeCompare(b.name));
const out = { version, grammars: table, langs };
writeFileSync(new URL("../src/grammars.json", import.meta.url), JSON.stringify(out) + "\n");
const total = (id: string) => [id, ...(table[id].deps ?? [])].reduce((s, n) => s + table[n].bytes, 0);
const big = langs.map((l) => [l.id, total(l.id)] as const).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`tm-grammars ${version}: ${langs.length} languages, ${Object.keys(table).length} grammars`);
console.log(`largest installs: ${big.map(([id, b]) => `${id} ${Math.round(b / 1024)} KB`).join(", ")}`);
