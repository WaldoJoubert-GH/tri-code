// Hold Hints: hold the Hotkey Modifier (Alt; Cmd in Cmd mode) with no other key for 120 ms and each
// control's icon turns into its key, in the same box (`HoldFace`, Keys.tsx). Let go to hide them. A
// chord pressed inside those 120 ms runs exactly as before and draws nothing, so quick Alt+W stays
// instant and silent. The Keymap is untouched: the keys read it (keymap.ts `hintKeys`), so they
// follow Settings › Hotkeys. Chosen from design/hold-hints.html (Flip).
//
// The focused window's – ▢ × turn into N / F / W, and the windows it can jump to carry a large key
// (Canvas.tsx). A browser window takes that key in its title bar, because a native webview's page
// draws above the canvas HTML. The New Window menu opens under its `+` with its rows' icons turned
// into keys (tabs.tsx), and the status line lists the keys with no control (`HoldBar`). A key pressed
// during the hold closes the menu so its result shows; the keys stay. Shift or Ctrl alone is only the
// start of a chord and leaves it open.

import { createSignal } from "solid-js";
import { app } from "./state";

/** How long the modifier must be held before the hints appear. */
export const HINT_HOLD_MS = 120;

const [shown, setShown] = createSignal(false);
/** True while the hints are drawn (Canvas.tsx). */
export const hintsShown = shown;

const [menuShown, setMenuShown] = createSignal(false);
/** True while the hold has the New Window menu open (tabs.tsx, and App hides the webviews under it). */
export const holdMenuShown = menuShown;

let down = false;
/** Another key went down during this hold, so it was a chord and not a hint gesture. */
let chorded = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Which step key lands on project `id` from the active one, going round like `stepProject`. */
export function projectStepKey(ids: string[], active: string | null | undefined, id: string): "project-prev" | "project-next" | undefined {
  const i = ids.indexOf(active ?? "");
  if (i < 0 || id === active) return;
  if (ids[(i + 1) % ids.length] === id) return "project-next";
  if (ids[(i - 1 + ids.length) % ids.length] === id) return "project-prev";
}

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
    if (down && !chorded) {
      setShown(true);
      setMenuShown(true);
    }
  }, HINT_HOLD_MS);
}

/**
 * A key other than the modifier went down: this hold is a chord, so it never becomes a hint.
 * `modifier` says it was Shift or Ctrl alone, which leaves the New Window menu open.
 */
export function hintChord(modifier = false): void {
  if (!down) return;
  chorded = true;
  clearTimeout(timer);
  if (!modifier) setMenuShown(false);
}

/** The modifier came up, or the window lost focus: hide them. */
export function hintUp(): void {
  down = false;
  chorded = false;
  clearTimeout(timer);
  setShown(false);
  setMenuShown(false);
}
