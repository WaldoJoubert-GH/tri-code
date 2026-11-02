// The app-wide theme and fonts (Settings › Appearance), applied to <html> as data-theme, --ui and --mono.
// The last look is kept in localStorage too: state.json loads after the first paint, and a forced
// theme would otherwise start in the OS's colours on every launch.

export type Theme = "system" | "light" | "dark";
export type FontKind = "ui" | "mono";
/** The settings this module reads. Unset is the system theme and the default fonts. */
export type Look = { theme?: "light" | "dark"; fontUi?: string; fontMono?: string };

const KEY = "tri-code-look";

/** The default fonts, from styles.css. Terminals have their own: see TERMINAL_STACK. */
const STACK: Record<FontKind, string> = {
  ui: 'system-ui, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
};
const TERMINAL_STACK = '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/** `name` as a CSS font family. It can come from an imported file, so it can't close the string. */
const family = (name: string) => `"${name.replace(/["\\]/g, "\\$&")}"`;

/** The value of --ui or --mono: the chosen font, falling back to the default when it isn't installed. */
export const fontStack = (kind: FontKind, name?: string) => (name ? `${family(name)}, ${STACK[kind]}` : STACK[kind]);

/** The fontFamily of every terminal. */
export const terminalFont = (name?: string) => (name ? `${family(name)}, ${TERMINAL_STACK}` : TERMINAL_STACK);

/** The theme a Look asks for; anything else, as from a hand-edited file, is the system theme. */
export const themeOf = (look: Look): Theme => (look.theme === "light" || look.theme === "dark" ? look.theme : "system");

function paint(look: Look) {
  const root = document.documentElement;
  const theme = themeOf(look);
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  // Set or removed, as the git colours are, so an unset font is exactly what styles.css says.
  if (look.fontUi) root.style.setProperty("--ui", fontStack("ui", look.fontUi));
  else root.style.removeProperty("--ui");
  if (look.fontMono) root.style.setProperty("--mono", fontStack("mono", look.fontMono));
  else root.style.removeProperty("--mono");
}

/** Paint a Look and remember it for the next launch. */
export function applyLook(look: Look) {
  paint(look);
  try {
    localStorage.setItem(KEY, JSON.stringify({ theme: look.theme, fontUi: look.fontUi, fontMono: look.fontMono }));
  } catch {
    // only costs the first paint of the next launch
  }
}

/** Paint the last launch's Look, before the app renders. */
export function restoreLook() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved === "object") paint(saved);
  } catch {
    // nothing usable saved: the OS's theme and the default fonts
  }
}

/** Whether a saved font should warn: it isn't in the installed list. Unknown until the list has loaded. */
export const fontMissing = (name: string | undefined, installed: string[] | null) =>
  !!name && !!installed && !installed.some((f) => f.toLowerCase() === name.toLowerCase());
