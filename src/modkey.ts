// The Hotkey Modifier: the key every window binding starts with. Alt by default; Settings can
// make it Cmd (Super / Win off macOS). The Keymap (keymap.ts) prints chords with `modLabel`.

import { app } from "./state";

export type ModKey = "alt" | "meta";

export const isMac = /Mac/i.test(navigator.userAgent);

/** The Meta key's name on this OS. */
export const metaName = isMac ? "Cmd" : /Windows/i.test(navigator.userAgent) ? "Win" : "Super";

/** The modifier as printed: Alt, or Cmd / Win / Super. */
export const modLabel = () => (app.settings.modKey === "meta" ? metaName : "Alt");

/** Is the hotkey modifier held? Matched alone, so Alt stays the terminal's in Cmd mode and the other way round. */
export const modDown = (e: KeyboardEvent) => (app.settings.modKey === "meta" ? e.metaKey && !e.altKey : e.altKey && !e.metaKey);

