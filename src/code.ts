// Syntax colouring for the file view. One regex pass per line, so a keyword
// inside a comment or string is not highlighted twice. The text is escaped
// before the spans are added, so the returned HTML is safe to inject.

const KEYWORDS =
  "import|export|from|type|const|let|var|function|return|if|else|for|while|of|in|new|class|extends|implements|interface|as|default|async|await|false|true|null|undefined|pub|fn|use|mod|struct|enum|impl|match|mut|package|func|def|require|yield";
const TOK = new RegExp(
  `(\\/\\/.*$)|(^\\s*#.*$)|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')|\\b(${KEYWORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`,
  "g",
);

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

function highlight(line: string): string {
  return escape(line).replace(TOK, (m, comment, hash, str, kw, num) =>
    comment || hash ? `<span class="t-c">${m}</span>`
    : str ? `<span class="t-s">${str}</span>`
    : kw ? `<span class="t-k">${kw}</span>`
    : `<span class="t-n">${num}</span>`,
  );
}

/** Render `src` as line-numbered, colour-coded rows. Safe to pass to innerHTML. */
export function codeHtml(src: string): string {
  return src
    .split("\n")
    .map((line, i) => `<div class="cl"><span class="ln">${i + 1}</span><span class="ct">${highlight(line) || " "}</span></div>`)
    .join("");
}
