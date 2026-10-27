// The Keymap: every action a hotkey can run, its default keys and the keys it has now. Settings ›
// Hotkeys changes them (an action can have several keys, or none); the changes live in
// `settings.hotkeys` and the rest keep their defaults. Window actions are Hotkey Modifier chords
// (modkey.ts); the text actions are plain Ctrl / Cmd chords that reach the focused window.

import { type Chord, app, setHotkeys } from "./state";
import { isMac, metaName, modDown, modLabel } from "./modkey";

export type Action = { id: string; group: string; desc: string; def: Chord[]; text?: true; seq?: true };

const k = (code: string, more: Partial<Chord> = {}): Chord => ({ code, ...more });
const sh = (code: string) => k(code, { shift: true });
const ct = (code: string) => k(code, { ctrl: true });
/** A text key: Cmd first on a Mac, where Ctrl works too; Ctrl elsewhere. */
const tx = (code: string) => (isMac ? [k(code, { bare: true, meta: true }), k(code, { bare: true, ctrl: true })] : [k(code, { bare: true, ctrl: true })]);
/** VS Code's two-key editor chord: Cmd+K then Cmd+<code> on a Mac, Ctrl elsewhere. */
const vs = (code: string): Chord[] => {
  const m = isMac ? { bare: true, meta: true } : { bare: true, ctrl: true };
  return [k("KeyK", { ...m, then: k(code, m) })];
};

const DIRS = [["left", "H", "ArrowLeft", "to the left"], ["down", "J", "ArrowDown", "below"], ["up", "K", "ArrowUp", "above"], ["right", "L", "ArrowRight", "to the right"]] as const;
const WS = [1, 2, 3, 4] as const;

export const ACTIONS: Action[] = [
  ...DIRS.map(([d, l, a, w]) => ({ id: `focus-${d}`, group: "Focus", desc: `Focus the window ${w}`, def: [k("Key" + l), k(a)] })),
  ...WS.map((i) => ({ id: `ws-${i}`, group: "Focus", desc: `Go to workspace ${i}`, def: [k("Digit" + i)] })),
  { id: "workspace-prev", group: "Focus", desc: "Previous workspace", def: [sh("BracketLeft")] },
  { id: "workspace-next", group: "Focus", desc: "Next workspace", def: [sh("BracketRight")] },
  { id: "project-prev", group: "Focus", desc: "Previous project", def: [k("BracketLeft")] },
  { id: "project-next", group: "Focus", desc: "Next project", def: [k("BracketRight")] },
  ...DIRS.map(([d, l, a, w]) => ({ id: `swap-${d}`, group: "Arrange", desc: `Swap with the window ${w}`, def: [sh("Key" + l), sh(a)] })),
  ...WS.map((i) => ({ id: `send-${i}`, group: "Arrange", desc: `Send the focused window to workspace ${i}`, def: [sh("Digit" + i)] })),
  { id: "split-left", group: "Arrange", desc: "Move the main / stack split left", def: [ct("KeyH"), ct("ArrowLeft")] },
  { id: "split-right", group: "Arrange", desc: "Move the main / stack split right", def: [ct("KeyL"), ct("ArrowRight")] },
  { id: "main", group: "Arrange", desc: "Make the focused window the main one (Main + stack)", def: [k("KeyM")] },
  { id: "layout", group: "Arrange", desc: "Switch layout: main + stack, grid, or mono", def: [k("KeyG")] },
  { id: "gap-less", group: "Arrange", desc: "Less gap between windows", def: [k("Comma")] },
  { id: "gap-more", group: "Arrange", desc: "More gap between windows", def: [k("Period")] },
  { id: "maximize", group: "Arrange", desc: "Maximize the focused window, again to restore", def: [k("KeyF")] },
  { id: "minimise", group: "Arrange", desc: "Minimise the focused window", def: [k("KeyN")] },
  { id: "restore-last", group: "Arrange", desc: "Bring back the window minimised last", def: [sh("KeyN")] },
  { id: "close", group: "Arrange", desc: "Close the focused window (undo for 5s)", def: [k("KeyW")] },
  { id: "open-project", group: "Project", desc: "Open a project, or add an environment", def: [k("KeyO")] },
  { id: "sidebar", group: "Project", desc: "Collapse or expand the sidebar", def: [k("KeyS")] },
  { id: "new-worktree", group: "Project", desc: "New worktree", def: [sh("KeyW")] },
  { id: "appearance", group: "Project", desc: "Project appearance: name, icon, accent, background", def: [k("KeyP")] },
  { id: "term-like", group: "Windows and links", desc: "New shell", def: [k("Enter"), k("NumpadEnter")] },
  { id: "browser", group: "Windows and links", desc: "New browser window", def: [k("KeyB")] },
  { id: "issues", group: "Windows and links", desc: "Issues", def: [k("KeyI")] },
  { id: "files", group: "Windows and links", desc: "Editor", def: [k("KeyE")] },
  { id: "go-to-file", group: "Windows and links", desc: "Command palette (a second key for it)", def: [k("KeyT")] },
  { id: "git", group: "Windows and links", desc: "Git", def: [k("KeyC")] },
  { id: "db", group: "Windows and links", desc: "Database: the latest database window, or a new one", def: [sh("KeyD")] },
  { id: "diff", group: "Windows and links", desc: "Editor: switch between Source and Diff. Git: open the file's diff in the editor", def: [k("KeyD")] },
  { id: "agents", group: "Windows and links", desc: "Commands window", def: [k("Semicolon")] },
  { id: "palette", group: "Windows and links", desc: "Command palette: run a command or open a file", def: [k("KeyX")] },
  { id: "help", group: "Windows and links", desc: "Hotkeys (this page)", def: [k("Slash")] },
  { id: "next-signal", group: "Signals", desc: "Go to the next agent that needs you", def: [k("KeyU")] },
  { id: "fold-recursive", group: "Editor", desc: "Fold the block at the cursor and every block inside it", def: vs("BracketLeft"), text: true, seq: true },
  { id: "unfold-recursive", group: "Editor", desc: "Unfold the block at the cursor and every block inside it", def: vs("BracketRight"), text: true, seq: true },
  { id: "fold-all", group: "Editor", desc: "Fold every top-level block", def: vs("Digit0"), text: true, seq: true },
  { id: "unfold-all", group: "Editor", desc: "Unfold everything", def: vs("KeyJ"), text: true, seq: true },
  { id: "copy", group: "Text", desc: "Copy the selection (sends it on to the app when nothing is selected)", def: tx("KeyC"), text: true },
  { id: "paste", group: "Text", desc: "Paste into the focused window", def: tx("KeyV"), text: true },
  { id: "favourite", group: "Text", desc: "Favourite the browser's page", def: tx("KeyD"), text: true },
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
export const actionById = (id: string) => BY_ID.get(id);

const KEY_LABELS: Record<string, string> = {
  Enter: "Enter", NumpadEnter: "Num Enter", Semicolon: ";", Quote: "'", Minus: "-", Equal: "=", Backquote: "`", Comma: ",", Period: ".",
  Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Space: "Space", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
};

/** The key part of a chord as printed: `KeyX` → X, `Digit5` → 5, `F2` stays. */
export function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad") && code !== "NumpadEnter") return "Num " + code.slice(6);
  return KEY_LABELS[code] ?? code;
}

const sameKey = (a: Chord, b: Chord) =>
  a.code === b.code && !!a.shift === !!b.shift && !!a.ctrl === !!b.ctrl && !!a.meta === !!b.meta && !!a.bare === !!b.bare;
export const sameChord = (a: Chord, b: Chord): boolean =>
  sameKey(a, b) && (a.then && b.then ? sameChord(a.then, b.then) : !a.then && !b.then);

/** An action's keys now. */
export const keysOf = (id: string): Chord[] => app.settings.hotkeys?.[id] ?? BY_ID.get(id)?.def ?? [];
/** One key of the chord as <kbd> labels, the modifier first. */
const strokeKeys = (c: Chord) => [
  ...(c.bare ? [] : [modLabel()]), ...(c.ctrl ? ["Ctrl"] : []), ...(c.meta ? [metaName] : []), ...(c.shift ? ["Shift"] : []), keyLabel(c.code),
];
/** The chord as <kbd> labels; a second key follows a `then` label. */
export const chordKeys = (c: Chord): string[] => [...strokeKeys(c), ...(c.then ? [THEN, ...strokeKeys(c.then)] : [])];
/** Stands between a chord's two keys in `chordKeys`, printed as a gap rather than a key. */
export const THEN = "then";
export const chordText = (c: Chord) => strokeKeys(c).join("+") + (c.then ? " " + strokeKeys(c.then).join("+") : "");
/** An action's first key as <kbd> labels, if it has one (the palette shows these). */
export const capsOf = (id: string) => {
  const c = keysOf(id)[0];
  return c && chordKeys(c);
};
/** An action's first key as text ("Alt+W", or "Alt W" with sep " "), or "". */
export const keyOf = (id: string, sep = "+") => {
  const c = keysOf(id)[0];
  return c ? chordKeys(c).join(sep) : "";
};
/** A label with the action's key after it: "Close (Alt+W)", or just "Close" with no key. */
export const withKey = (label: string, id: string) => {
  const key = keyOf(id);
  return key ? `${label} (${key})` : label;
};

export const changed = (id: string) => {
  const now = app.settings.hotkeys?.[id];
  const def = BY_ID.get(id)?.def ?? [];
  return !!now && !(now.length === def.length && now.every((c, i) => sameChord(c, def[i])));
};

/** Store an action's keys, dropping the override when they are its defaults again. */
export function setKeys(id: string, keys: Chord[]) {
  const def = BY_ID.get(id)?.def ?? [];
  setHotkeys(id, keys.length === def.length && keys.every((c, i) => sameChord(c, def[i])) ? undefined : keys);
}

/** Cmd chords the OS keeps for text and quitting, so nothing can have them in Cmd mode. */
const OS_KEYS: Record<string, string> = { KeyA: "select all", KeyV: "paste", KeyZ: "undo", KeyQ: "quit" };

/** Why a chord can't work now, or "". */
export function chordProblem(c: Chord): string {
  if (c.then && !c.then.ctrl && !c.then.meta) return "The second key needs Ctrl or Cmd too.";
  if (c.bare && !c.ctrl && !c.meta) return "Text keys need Ctrl or Cmd, so typing a letter still types it.";
  if (!c.bare && app.settings.modKey === "meta" && !c.ctrl && OS_KEYS[c.code]) return `${chordText(c)} stays ${OS_KEYS[c.code]} while ${metaName} is the modifier.`;
  return "";
}

/** The chord this key press is, as an action would hold it. */
function pressed(e: KeyboardEvent, bare: boolean): Chord {
  return bare
    ? { code: e.code, bare: true, ...(e.ctrlKey ? { ctrl: true } : {}), ...(e.metaKey ? { meta: true } : {}), ...(e.shiftKey ? { shift: true } : {}) }
    : { code: e.code, ...(e.shiftKey ? { shift: true } : {}), ...(e.ctrlKey ? { ctrl: true } : {}) };
}

/** A text key press as an action's chord would hold it, or undefined with Alt held. */
export const textPress = (e: KeyboardEvent): Chord | undefined => (e.altKey ? undefined : pressed(e, true));

/** Does this key press run the action? For text actions (terms.ts, clipboard.ts, the browser's Ctrl+D). */
export function isKey(id: string, e: KeyboardEvent): boolean {
  if (e.altKey) return false;
  const p = pressed(e, true);
  return keysOf(id).some((c) => c.bare && sameChord(c, p));
}

let editorKeys: ((e: KeyboardEvent) => boolean) | undefined;
/** cm.ts hands over its Editor actions once the editor has loaded (it is loaded lazily). */
export const setEditorKeys = (f: (e: KeyboardEvent) => boolean) => { editorKeys = f; };
/** Did the focused editor take this key press for one of its actions? hotkeys.ts asks first. */
export const editorKey = (e: KeyboardEvent) => !!editorKeys?.(e);

/** The window action this Hotkey Modifier chord runs, if any (hotkeys.ts). */
export function actionFor(e: KeyboardEvent): string | undefined {
  if (!modDown(e)) return;
  const p = pressed(e, false);
  if (chordProblem(p)) return;
  return ACTIONS.find((a) => !a.text && keysOf(a.id).some((c) => sameChord(c, p)))?.id;
}

/** The action holding this chord, other than `except`: its id and which of its keys. */
export function owner(c: Chord, except?: string): { id: string; index: number } | undefined {
  for (const a of ACTIONS) {
    if (a.id === except) continue;
    const index = keysOf(a.id).findIndex((x) => sameChord(x, c));
    if (index >= 0) return { id: a.id, index };
  }
}

/** The chord a key press records in Settings: the modifier is implied, so it needn't be held. */
export const recorded = (e: KeyboardEvent, text: boolean): Chord => pressed(e, text);
