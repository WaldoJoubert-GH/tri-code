// Hold Hints: hold the Hotkey Modifier (Alt; Cmd in Cmd mode) with no other key for 120 ms and
// the focused window's title bar draws its keys — N / F / W on its – ▢ ×, and a chip for each
// direction it can move in. Let go to hide them. A chord pressed inside those 120 ms runs exactly
// as before and draws nothing, so quick Alt+W stays instant and silent. The Keymap is untouched:
// the chips read it (keymap.ts `hintKeys`), so they follow Settings › Hotkeys. Chosen from
// design/alt-hold.html (variant A). Only the focused window draws: Alt+W closes *that* window, and
// a hint on every title bar would say otherwise. The arrows sit in its title bar rather than on its
// edges because a native webview (a browser window's page) draws above the canvas HTML.

import { createSignal } from "solid-js";
import { app } from "./state";

/** How long the modifier must be held before the hints appear. */
export const HINT_HOLD_MS = 120;

const [shown, setShown] = createSignal(false);
/** True while the hints are drawn (Canvas.tsx). */
export const hintsShown = shown;

let down = false;
/** Another key went down during this hold, so it was a chord and not a hint gesture. */
let chorded = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The Hotkey Modifier itself (modkey.ts), as a key event; AltGr is a different key and is left out. */
export function isHintModifier(e: KeyboardEvent): boolean {
  if (e.key === "AltGraph") return false;
  return app.settings.modKey === "meta"
    ? e.code === "MetaLeft" || e.code === "MetaRight"
    : e.code === "AltLeft" || e.code === "AltRight";
}

/** The modifier went down on its own: start the clock. */
export function hintDown(): void {
  if (down) return;
  down = true;
  chorded = false;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (down && !chorded) setShown(true);
  }, HINT_HOLD_MS);
}

/** A key other than the modifier went down: this hold is a chord, so it never becomes a hint. */
export function hintChord(): void {
  if (!down) return;
  chorded = true;
  clearTimeout(timer);
}

/** The modifier came up, or the window lost focus: hide them. */
export function hintUp(): void {
  down = false;
  chorded = false;
  clearTimeout(timer);
  setShown(false);
}
