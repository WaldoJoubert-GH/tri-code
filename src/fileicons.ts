// File Icon Themes (Settings › Appearance › File icons, or the palette's File Icon Theme…): how the
// editor's file tree, its tabs and Go to File draw a file or folder. Classic is the two-letter chip
// in FileList.tsx; Atom (in the style of Atom Material Icons) and Material (in the style of the
// Material Icon Theme) are SVG strings drawn here; None draws nothing. Chosen from
// design/editor-icons.html. The glyphs are drawn for tri-code in each set's style, not copied.

import { createSignal } from "solid-js";

export type IconTheme = "classic" | "atom" | "material" | "none";
export const ICON_THEMES: { id: IconTheme; name: string; blurb: string }[] = [
  { id: "classic", name: "Classic", blurb: "two-letter chips" },
  { id: "atom", name: "Atom", blurb: "flat glyphs, soft folders by name" },
  { id: "material", name: "Material", blurb: "solid colour, folders by name" },
  { id: "none", name: "None", blurb: "names only" },
];

/** The options under a theme. Unset is the default (named folders, hollow open folders, colour). */
export type IconOpts = { plainFolders?: boolean; filledOpen?: boolean; mono?: boolean };

/** A theme the palette is previewing, shown instead of the saved one until it closes. */
const [previewTheme, setPreviewTheme] = createSignal<IconTheme | undefined>();
export { previewTheme, setPreviewTheme };

// ── what a name is ──────────────────────────────────────────────────

/** Whole file names first, lower case. */
const NAMES: Record<string, string> = {
  "package.json": "npm", "package-lock.json": "npm", "readme.md": "readme", "readme": "readme", ".gitignore": "git",
  ".gitattributes": "git", ".gitmodules": "git", "license": "license", "license.md": "license", "changelog.md": "changelog",
  "cargo.toml": "cargo", "cargo.lock": "cargo", "tsconfig.json": "tsconfig", "jsconfig.json": "tsconfig",
  "tauri.conf.json": "tauri", "dockerfile": "docker", "docker-compose.yml": "docker", "compose.yaml": "docker",
  "makefile": "make", ".env": "env", "bun.lock": "lock", "bun.lockb": "lock", "yarn.lock": "lock", "pnpm-lock.yaml": "lock",
};
const EXTS: Record<string, string> = {
  ts: "ts", mts: "ts", cts: "ts", tsx: "react", jsx: "react", js: "js", mjs: "js", cjs: "js", json: "json", jsonc: "json",
  css: "css", scss: "css", less: "css", html: "html", htm: "html", md: "md", mdx: "md", rs: "rust", toml: "toml",
  yaml: "yaml", yml: "yaml", sh: "sh", bash: "sh", zsh: "sh", ps1: "sh", bat: "sh", svg: "svg", png: "image", jpg: "image",
  jpeg: "image", gif: "image", webp: "image", ico: "image", icns: "image", mp4: "video", webm: "video", mov: "video",
  lock: "lock", py: "py", go: "go", sql: "db", db: "db", sqlite: "db", txt: "text", log: "text", csv: "table",
  xlsx: "table", env: "env", xml: "html", vue: "vue", svelte: "svelte", java: "java", kt: "java", c: "c", h: "c",
  cpp: "c", hpp: "c", cs: "c", rb: "ruby", php: "php", swift: "swift", zip: "zip", gz: "zip", tar: "zip", pdf: "pdf",
  woff: "font", woff2: "font", ttf: "font", otf: "font", wasm: "bin", exe: "bin", dll: "bin",
};

/** The kind of file a name is: its whole name, then `*.config.*`, then its extension, then "file". */
export function kindOf(name: string): string {
  const n = (name.split("/").pop() ?? name).toLowerCase();
  if (NAMES[n]) return NAMES[n];
  if (/^vite\.config\./.test(n)) return "vite";
  if (n.startsWith(".env")) return "env";
  const dot = n.lastIndexOf(".");
  return (dot > 0 && EXTS[n.slice(dot + 1)]) || "file";
}

/** A folder's colour and badge, by name, for the themes that tint folders. */
const FOLDERS: Record<string, [string, string]> = {};
const folder = (color: string, badge: string, names: string) => names.split(" ").forEach((n) => (FOLDERS[n] = [color, badge]));
folder("#4caf50", "code", "src lib app source");
folder("#ff7043", "gear", "src-tauri config configs .config .vscode .idea settings");
folder("#26a69a", "image", "assets images img icons screenshots media static public");
folder("#42a5f5", "lines", "docs doc adr documentation");
folder("#7e57c2", "term", "scripts bin tools");
folder("#29b6f6", "globe", "site web www dist build out target");
folder("#ab47bc", "plug", "mcp plugins extensions api server");
folder("#546e7a", "cat", ".github .git .gitlab");
folder("#8bc34a", "hex", "node_modules vendor packages");
folder("#ec407a", "pen", "design styles css theme themes");
folder("#ef5350", "check", "test tests __tests__ spec e2e");
folder("#ffb300", "star", "components ui");
folder("#78909c", "lines", "types typings");
// A few names are worth a different badge than their group.
FOLDERS.icons = ["#ffb300", "star"];
FOLDERS.workflows = ["#546e7a", "gear"];
export const folderOf = (name: string): [string, string] | undefined => FOLDERS[name.toLowerCase()];

// ── svg helpers ─────────────────────────────────────────────────────
const svg = (inner: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${inner}</svg>`;
const T = (x: number, y: number, size: number, fill: string, str: string, anchor = "middle") =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="ui-monospace,Consolas,monospace" font-weight="800" font-size="${size}" fill="${fill}">${str}</text>`;
const S = (d: string, c: string, w = 1.2) =>
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const F = (d: string, c: string) => `<path d="${d}" fill="${c}"/>`;
const C = (cx: number, cy: number, r: number, c: string) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}"/>`;
const ring = (cx: number, cy: number, r: number, c: string, w: number) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="${w}"/>`;

/** Mix a hex colour toward black (f < 0) or white (f > 0). */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16), t = f < 0 ? 0 : 255, p = Math.abs(f);
  const ch = (v: number) => Math.round((t - v) * p + v);
  return "#" + ((1 << 24) | (ch(n >> 16) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1);
}

/** Folder badges, drawn in the bottom-right quarter (around 11.6, 11). */
const BADGE: Record<string, (d: string) => string> = {
  code: (d) => S("M10.4 9.2 8.8 11l1.6 1.8M12.8 9.2l1.6 1.8-1.6 1.8", d, 1.3),
  gear: (d) => ring(11.6, 11, 2.1, d, 1.4) + C(11.6, 11, 0.7, d),
  image: (d) => F("M8.6 13.2l2-2.7 1.4 1.6 1-1.1 1.7 2.2z", d) + C(13.1, 8.9, 0.85, d),
  lines: (d) => S("M9 9.2h5M9 11.2h5M9 13.2h3.3", d, 1.2),
  term: (d) => S("M9 9.3l1.7 1.6L9 12.5M11.7 12.8h2.6", d, 1.3),
  globe: (d) => ring(11.6, 11, 2.4, d, 1.1) + S("M9.2 11h4.8M11.6 8.6c-1.3 1.4-1.3 3.4 0 4.8M11.6 8.6c1.3 1.4 1.3 3.4 0 4.8", d, 0.9),
  plug: (d) => S("M10.4 8.6v1.5M12.8 8.6v1.5", d, 1.2) + F("M9.6 10.1h4v1.3a2 2 0 0 1-4 0z", d) + S("M11.6 13.3v1", d, 1.2),
  cat: (d) => F("M9.3 8.6l1.2 1.3h2.2l1.2-1.3v3.2a2.3 2.3 0 0 1-4.6 0z", d),
  hex: (d) => F("M11.6 8.3l2.6 1.5v3l-2.6 1.5-2.6-1.5v-3z", d),
  pen: (d) => F("M9 14.2l.5-2.1 3.6-3.6 1.6 1.6-3.6 3.6z", d),
  star: (d) => F("M11.6 8.2l.85 1.8 1.95.2-1.45 1.35.4 1.95-1.75-1-1.75 1 .4-1.95-1.45-1.35 1.95-.2z", d),
  check: (d) => S("M9.2 11.2l1.6 1.6 3.2-3.4", d, 1.5),
};

// ── Material ────────────────────────────────────────────────────────
const MAT_FOLDER = "M1.5 3.5a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z";
const MAT_GREY = "#90a4ae";

function materialFolder(name: string, open: boolean, o: IconOpts): string {
  const [c, g] = (!o.plainFolders && folderOf(name)) || [MAT_GREY, ""];
  const back = F(MAT_FOLDER, open ? shade(c, -0.18) : c);
  const front = open ? F("M3.4 6.6h12a.5.5 0 0 1 .48.64l-1.6 5.6a1 1 0 0 1-.96.66H1.5z", c) : "";
  return svg(back + front + (g ? BADGE[g](shade(c, -0.5)) : ""));
}

const page = (c: string) =>
  F("M3.5 1.5h6l3.5 3.5v9a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z", c) + F("M9.5 1.5V5H13z", shade(c, 0.45));
const tile = (c: string, inner: string) => `<rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="${c}"/>` + inner;
const tileText = (c: string, ink: string, s: string, size = 7.2) => tile(c, T(14, 13.2, size, ink, s, "end"));
const picture = (c: string) => tile(c, F("M3.5 12.5l3-4 2 2.4 1.5-1.6 2.5 3.2z", "#fff") + C(11.2, 5, 1.3, "#fff"));
const atomRings = (c: string, w: number, r: number) =>
  `<g fill="none" stroke="${c}" stroke-width="${w}"><ellipse cx="8" cy="8" rx="6.6" ry="${r}"/><ellipse cx="8" cy="8" rx="6.6" ry="${r}" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6.6" ry="${r}" transform="rotate(120 8 8)"/></g>`;

const MAT: Record<string, () => string> = {
  file: () => page(MAT_GREY),
  text: () => page(MAT_GREY) + S("M5 8h6M5 10.2h6M5 12.4h4", "#fff", 1),
  ts: () => tileText("#0288d1", "#fff", "TS"),
  tsconfig: () => tileText("#0288d1", "#fff", "TS") + ring(4.6, 4.6, 1.6, "#fff", 1.1),
  js: () => tileText("#ffca28", "#263238", "JS"),
  react: () => atomRings("#00bcd4", 1, 2.6) + C(8, 8, 1.4, "#00bcd4"),
  vue: () => F("M1 2.5h3L8 9.4l4-6.9h3L8 14.5z", "#41b883") + F("M4 2.5h2.4L8 5.3l1.6-2.8H12L8 9.4z", "#35495e"),
  svelte: () => tile("#ff3e00", S("M10.6 4.6c-1.5-1-3.6-.6-4.6.9-1 1.6.6 2.6 2 3.2 1.4.6 2.9 1.6 1.9 3.1-1 1.5-3.1 1.9-4.6.9", "#fff", 1.5)),
  json: () => T(8, 12.2, 10, "#fbc02d", "{}"),
  css: () => S("M6 2.5 4.8 13.5M11.2 2.5 10 13.5M2.6 6h11M2.2 10h11", "#42a5f5", 1.9),
  html: () => S("M5.2 3.8 1.6 8l3.6 4.2M10.8 3.8 14.4 8l-3.6 4.2", "#e44d26", 2.1),
  md: () => F("M1 12V4h2.2l2 2.8 2-2.8h2.2v8H7.2V7.6l-2 2.6-2-2.6V12zM11.9 4h1.8v4.4h1.7l-2.6 3.6-2.6-3.6h1.7z", "#42a5f5"),
  readme: () => C(8, 8, 6.5, "#42a5f5") + F("M7.1 7h1.8v4.8H7.1z", "#fff") + C(8, 4.9, 1.05, "#fff"),
  rust: () => C(8, 8, 6.5, "#ff7043") + T(8, 11.2, 8.5, "#fff", "R"),
  cargo: () => C(8, 8, 6.5, "#ff7043") + F("M4.5 6.2 8 4.4l3.5 1.8v3.9L8 11.9l-3.5-1.8z", "#fff"),
  go: () => tileText("#00acc1", "#fff", "GO", 6.6),
  py: () =>
    F("M7.9 1.5c-2.8 0-3.2 1.2-3.2 2.2V5.5H8v.6H3.4C2.2 6.1 1.4 7 1.4 8.6s.8 2.6 2 2.6h1.2V9.6c0-1.2 1-2.2 2.2-2.2h3.1c1 0 1.9-.8 1.9-1.9V3.7c0-1.1-.9-2.2-3.9-2.2z", "#3d7ab8") +
    F("M8.1 14.5c2.8 0 3.2-1.2 3.2-2.2v-1.8H8v-.6h4.6c1.2 0 2-.9 2-2.5s-.8-2.6-2-2.6h-1.2v1.6c0 1.2-1 2.2-2.2 2.2H6.1c-1 0-1.9.8-1.9 1.9v1.8c0 1.1.9 2.2 3.9 2.2z", "#fdd835"),
  java: () => tileText("#f44336", "#fff", "J", 8),
  c: () => tileText("#5c6bc0", "#fff", "C", 8),
  ruby: () => F("M4 2.5h8l2.5 3.5L8 14 1.5 6z", "#e53935"),
  php: () => `<ellipse cx="8" cy="8" rx="7" ry="4.6" fill="#7986cb"/>` + T(8, 10, 5.5, "#fff", "php"),
  swift: () => tile("#ff6f00", S("M3.6 5c2.4 2.2 4.6 3.6 6.4 4.4M5 3.8c1.8 1.8 3.4 3 5.2 4M12 4.2c1.2 2.8.4 5.6-1.4 6.6-1.8 1-4.6.6-6.8-1.4", "#fff", 1.2)),
  toml: () => `<circle cx="8" cy="8" r="5.6" fill="none" stroke="#9e9e9e" stroke-width="2.6" stroke-dasharray="2.2 1.3"/>` + C(8, 8, 2, "#9e9e9e"),
  tauri: () => ring(6, 6.2, 3.2, "#ffc131", 2) + ring(10, 9.8, 3.2, "#24c8db", 2),
  yaml: () => tile("#ff5252", T(8, 12, 9, "#fff", "Y")),
  svg: () => picture("#ffb300"),
  image: () => picture("#26a69a"),
  video: () => tile("#ff7043", F("M6 4.8v6.4l5.2-3.2z", "#fff")),
  lock: () => S("M5 7V5.2a3 3 0 0 1 6 0V7", "#ffd54f", 1.8) + `<rect x="3" y="7" width="10" height="7.5" rx="1.3" fill="#ffd54f"/>` + C(8, 10.6, 1.1, "#8d6e00"),
  env: () => S("M5 7V5.2a3 3 0 0 1 6 0V7", "#fbc02d", 1.8) + `<rect x="3" y="7" width="10" height="7.5" rx="1.3" fill="#fbc02d"/>` + T(8, 13.2, 5, "#5d4300", "env"),
  sh: () => tile("#4caf50", S("M4.2 5.4 6.8 8l-2.6 2.6M8.4 11h3.6", "#fff", 1.6)),
  make: () => tile("#ef5350", S("M4 11.5V4.5l4 4 4-4v7", "#fff", 1.6)),
  docker: () => F("M1 8.4h12.2c.5-1 1.4-1.5 2.3-1.4-.4 3.6-3.2 6.5-7.6 6.5C4.4 13.5 1.6 12 1 8.4z", "#0288d1") +
    [2.6, 4.6, 6.6, 8.6].map((x) => `<rect x="${x}" y="6" width="1.6" height="1.6" fill="#0288d1"/>`).join("") + `<rect x="6.6" y="4" width="1.6" height="1.6" fill="#0288d1"/>`,
  npm: () => F("M8 1.2l6 3.4v6.8l-6 3.4-6-3.4V4.6z", "#8bc34a") + T(8, 11, 7, "#fff", "n"),
  git: () => F("M8 .9 15.1 8 8 15.1.9 8z", "#e64a19") + S("M6 5.8v4.4M6 7.6c3 0 4.2-.4 4.2-1.8", "#fff", 1.2) + C(6, 10.7, 1, "#fff") + C(10.2, 5.3, 1, "#fff"),
  license: () => `<rect x="2" y="1.5" width="12" height="13" rx="1.5" fill="#ffca28"/>` + S("M4.5 4.5h7M4.5 6.8h7", "#7a5b00", 1.1) + C(9.8, 10.6, 2, "#e65100"),
  changelog: () => C(8, 8, 6.5, "#8bc34a") + S("M8 4.4V8l2.4 1.6", "#fff", 1.5),
  vite: () => F("M1.4 2.6 8 14.6l6.6-12L8 4z", "#7c4dff") + F("M9 1.8 5.4 3l.7 4.8 1.4-.3-.5 3.6 3.2-5.3-1.5.3z", "#ffca28"),
  db: () => `<ellipse cx="8" cy="3.8" rx="5.5" ry="2" fill="#ffca28"/>` + F("M2.5 4.6v7.6c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4.6c0 1.1-2.5 2-5.5 2s-5.5-.9-5.5-2z", "#ffa000"),
  table: () => tile("#43a047", S("M1.5 6h13M1.5 10h13M6 6v8.5", "#fff", 1.1)),
  zip: () => page("#afb42b") + S("M7.5 3v1.2M8.5 4.8V6M7.5 6.6v1.2M8.5 8.4v1.2", "#fff", 1) + `<rect x="6.8" y="10" width="2.4" height="2.6" rx=".5" fill="#fff"/>`,
  pdf: () => tileText("#e53935", "#fff", "PDF", 5.2),
  font: () => tile("#f44336", T(8, 12.2, 9.5, "#fff", "F")),
  bin: () => page("#78909c") + T(8, 13, 5, "#fff", "01"),
};

function material(name: string, dir: boolean, open: boolean, o: IconOpts): string {
  if (dir) return materialFolder(name, open, o);
  return svg((MAT[kindOf(name)] ?? MAT.file)());
}

// ── Atom (Atom Material Icons' style) ────────────────────────────────
const ATOM_FOLDER = "M1 4a1.5 1.5 0 0 1 1.5-1.5h3.2c.4 0 .8.2 1 .5l.8 1h6a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12z";
const ATOM_GREY = "#8fa1b3";

/** Rounder, softer folders; the badge is larger and centred, knocked out pale. Open folders go hollow. */
function atomFolder(name: string, open: boolean, o: IconOpts): string {
  const hit = o.plainFolders ? undefined : folderOf(name);
  const c = o.mono ? "currentColor" : hit ? shade(hit[0], 0.22) : ATOM_GREY;
  const hollow = open && !o.filledOpen;
  const body = hollow
    ? `<path d="${ATOM_FOLDER}" fill="none" stroke="${c}" stroke-width="1.3" transform="translate(.4 .4) scale(.95)"/>`
    : F(ATOM_FOLDER, c);
  if (!hit) return svg(body);
  // In mono a filled folder is currentColor, so the badge is cut out in the panel's colour.
  const ink = hollow ? c : o.mono ? "var(--panel)" : shade(hit[0], 0.62);
  const badge = BADGE[hit[1]](ink).replace(/(fill|stroke)="var\(--panel\)"/g, 'style="$1:var(--panel)"');
  return svg(body + `<g transform="translate(8 8.4) scale(1.2) translate(-11.6 -11.2)">${badge}</g>`);
}

const pageO = (c: string) => S("M3.5 1.6h5.6l3.4 3.4v9.4h-9z", c) + S("M9 1.6v3.5h3.5", c);
const mountain = (c: string) => S("M5.4 12l1.8-2.3 1.2 1.2 1-1 1.4 2.1", c, 1);
const ATOM_C: Record<string, string> = {
  ts: "#2f74c0", tsconfig: "#2f74c0", js: "#c9a227", react: "#13a6c9", vue: "#41b883", svelte: "#ff3e00", json: "#c9a227",
  css: "#3c99dc", html: "#e2652d", md: "#5b8fd6", readme: "#5b8fd6", rust: "#c9663a", cargo: "#c9663a", go: "#00acc1",
  py: "#3d7ab8", java: "#e0443a", c: "#5c6bc0", ruby: "#d13a32", php: "#7986cb", swift: "#f05138", toml: "#9c6b4e",
  tauri: "#d9a400", yaml: "#c5604c", svg: "#e2952d", image: "#9b6fcf", video: "#9b6fcf", sh: "#5ca33d", make: "#d0573f",
  docker: "#1d91e6", npm: "#cb3837", git: "#e2652d", license: "#c9a227", changelog: "#5ca33d", vite: "#8f5cff", db: "#d39b0b",
  table: "#43a047", env: "#c9a227", zip: "#9e9d24", pdf: "#e53935", font: "#e0443a",
};
const ATOM: Record<string, (c: string) => string> = {
  file: (c) => pageO(c),
  text: (c) => pageO(c) + S("M5.5 8.5h5M5.5 11h5", c, 1),
  ts: (c) => T(8, 11.6, 8, c, "TS"),
  tsconfig: (c) => T(8, 11.6, 8, c, "TS"),
  js: (c) => T(8, 11.6, 8, c, "JS"),
  react: (c) => atomRings(c, 0.9, 2.5) + C(8, 8, 1.1, c),
  vue: (c) => S("M1.5 3h3L8 9l3.5-6h3L8 14z", c, 1.1),
  svelte: (c) => S("M10.6 3.6c-1.6-1.1-3.9-.6-5 1-1.1 1.7.7 2.8 2.2 3.4 1.5.6 3.2 1.7 2.1 3.4-1.1 1.6-3.4 2.1-5 1", c, 1.3),
  json: (c) => T(8, 11.8, 9, c, "{}"),
  css: (c) => S("M6 3 5 13M10.8 3l-1 10M3.3 6.4h10M2.8 9.8h10", c, 1.2),
  html: (c) => S("M5.4 4.4 2 8l3.4 3.6M10.6 4.4 14 8l-3.4 3.6M9 3.4 7 12.6", c, 1.2),
  md: (c) => `<rect x="1.1" y="3.6" width="13.8" height="8.8" rx="1.6" fill="none" stroke="${c}" stroke-width="1.1"/>` + S("M3.6 10.2V5.8l1.7 1.9 1.7-1.9v4.4M11.4 5.8v4.4M9.9 8.8l1.5 1.5 1.5-1.5", c, 1.1),
  readme: (c) => S("M2 3.2c2-.6 4.2-.3 6 .9 1.8-1.2 4-1.5 6-.9v9.4c-2-.6-4.2-.3-6 .9-1.8-1.2-4-1.5-6-.9zM8 4.1v9.4", c, 1.1),
  rust: (c) => `<circle cx="8" cy="8" r="5.8" fill="none" stroke="${c}" stroke-width="1.2" stroke-dasharray="1.6 1"/>` + T(8, 10.8, 7.5, c, "R"),
  cargo: (c) => S("M2.5 5 8 2.2 13.5 5v6L8 13.8 2.5 11zM2.5 5 8 7.8 13.5 5M8 7.8v6", c, 1.1),
  go: (c) => T(8, 11.4, 7.5, c, "GO"),
  py: (c) => T(8, 11.4, 7.5, c, "py"),
  java: (c) => S("M5 13c2 .8 5 .8 6.5-.4M5.5 10.6c1.6.6 4 .6 5.2-.2M8.6 2.4c1.6 1.6-1.8 2.6 0 4.6M10.8 4.2c-1.4.8-.8 1.8 0 2.6", c, 1.1),
  c: (c) => T(8, 11.6, 9, c, "C"),
  ruby: (c) => S("M4 2.5h8l2.5 3.5L8 14 1.5 6zM1.5 6h13M5.5 6 8 14l2.5-8M4 2.5 5.5 6 8 2.5 10.5 6 12 2.5", c, 0.9),
  php: (c) => `<ellipse cx="8" cy="8" rx="6.8" ry="4.4" fill="none" stroke="${c}" stroke-width="1.1"/>` + T(8, 9.9, 5, c, "php"),
  swift: (c) => S("M2.5 5c2.6 2.4 5 3.8 7 4.6M4 3.6c2 2 3.8 3.3 5.8 4.4M13 4c1.3 3.1.4 6.2-1.6 7.3-2 1.1-5.1.7-7.6-1.6", c, 1.1),
  toml: (c) => S("M3 3.5h10M8 3.5v9", c, 1.6),
  tauri: (c) => ring(6, 6.2, 3, c, 1.3) + ring(10, 9.8, 3, c, 1.3),
  yaml: (c) => S("M3 3.5l3 4.2 3-4.2M6 7.7v5M10.5 10h3M10.5 12.5h3", c, 1.3),
  svg: (c) => pageO(c) + mountain(c),
  image: (c) => pageO(c) + mountain(c),
  video: (c) => pageO(c) + F("M6.6 8.4v3.6l3-1.8z", c),
  lock: (c) => S("M5.2 7.2V5.4a2.8 2.8 0 0 1 5.6 0v1.8", c, 1.2) + `<rect x="3.4" y="7.2" width="9.2" height="7" rx="1" fill="none" stroke="${c}" stroke-width="1.2"/>`,
  env: (c) => S("M5.2 7.2V5.4a2.8 2.8 0 0 1 5.6 0v1.8", c, 1.2) + `<rect x="3.4" y="7.2" width="9.2" height="7" rx="1" fill="none" stroke="${c}" stroke-width="1.2"/>` + C(8, 10.7, 0.9, c),
  sh: (c) => S("M2.6 4.6 6 8l-3.4 3.4M7.6 12h5.8", c, 1.4),
  make: (c) => S("M2.5 12.5v-9l5.5 5.5 5.5-5.5v9", c, 1.3),
  docker: (c) => S("M1.2 8.6h12c.5-1 1.3-1.4 2.1-1.3-.5 3.4-3.2 6-7.3 6-3.8 0-6.3-1.6-6.8-4.7z", c, 1.1) + S("M3 6.6h1.4M5 6.6h1.4M7 6.6h1.4M7 4.6h1.4", c, 1.3),
  npm: (c) => `<rect x="1.2" y="4.6" width="13.6" height="6.8" fill="none" stroke="${c}" stroke-width="1.2"/>` + S("M3.6 9.6V6.6h2.6v3M5 6.6v3", c, 1),
  git: (c) => S("M8 1.6 14.4 8 8 14.4 1.6 8z", c, 1.1) + S("M6.4 5.6v4.6M6.4 7.6c2.6 0 3.4-.6 3.4-1.9", c, 1) + C(6.4, 10.6, 0.9, c) + C(9.8, 5.4, 0.9, c),
  license: (c) => S("M8 2.2v11.6M4 13.8h8M2.6 4.6h10.8M4.4 4.6 2.6 9a1.9 1.9 0 0 0 3.6 0zM11.6 4.6 9.8 9a1.9 1.9 0 0 0 3.6 0z", c, 1),
  changelog: (c) => ring(8, 8, 5.8, c, 1.2) + S("M8 4.8V8l2.2 1.4", c, 1.2),
  vite: (c) => S("M9 1.8 4.2 9h3.6l-1 5.2L12 6.8H8.2z", c, 1.1),
  db: (c) => `<ellipse cx="8" cy="4" rx="5.2" ry="1.9" fill="none" stroke="${c}" stroke-width="1.1"/>` + S("M2.8 4v8c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9V4M2.8 8c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9", c, 1.1),
  table: (c) => `<rect x="1.8" y="2.5" width="12.4" height="11" rx="1" fill="none" stroke="${c}" stroke-width="1.1"/>` + S("M1.8 6h12.4M1.8 9.6h12.4M6 6v7.5", c, 1),
  zip: (c) => pageO(c) + S("M7.5 3.4v1M8.5 5v1M7.5 6.6v1M8.5 8.2v1", c, 1) + `<rect x="6.8" y="10" width="2.4" height="2.6" rx=".5" fill="none" stroke="${c}" stroke-width="1"/>`,
  pdf: (c) => pageO(c) + T(8, 12.6, 4.6, c, "PDF"),
  font: (c) => T(8, 12, 10, c, "A") + S("M10.5 12.2h3", c, 1),
  bin: (c) => pageO(c) + T(8, 12.6, 4.8, c, "01"),
};

function atom(name: string, dir: boolean, open: boolean, o: IconOpts): string {
  if (dir) return atomFolder(name, open, o);
  const k = kindOf(name);
  const c = o.mono ? "currentColor" : ATOM_C[k] ?? "currentColor";
  return svg((ATOM[k] ?? ATOM.file)(c));
}

/** The SVG markup for a name in an SVG theme. Classic and None are drawn by FileIcon, so they return "". */
export function iconSvg(theme: IconTheme, name: string, dir: boolean, open = false, o: IconOpts = {}): string {
  const base = name.split("/").pop() ?? name;
  if (theme === "atom") return atom(base, dir, open, o);
  if (theme === "material") return material(base, dir, open, o);
  return "";
}
