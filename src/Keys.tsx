// Every key the app draws is a keycap from this file, so a key looks the same on a control, in a
// panel's footer, in a dialog and in Settings. keys.test.ts keeps it that way: no other file writes
// a <kbd>. `kbd` in styles.css is the look; Settings › Appearance picks its colour (look.ts).

import { For, type JSX, Show } from "solid-js";
import { THEN, capsOf, hintKeys, splitKeys } from "./keymap";
import { hintsShown } from "./hints";

const SHIFT = { label: "Shift", d: "M12 3l9 10h-5v8H8v-8H3z" };
const ENTER = { label: "Enter", d: "M20 5v6a3 3 0 0 1-3 3H5M10 9l-5 5 5 5" };
const BACKSPACE = { label: "Backspace", d: "M21 5H8l-6 7 6 7h13zM12 9l6 6M18 9l-6 6" };
/** The keys a keyboard marks with a symbol, drawn as that symbol. */
const KEY_ICONS: Record<string, typeof SHIFT> = { Shift: SHIFT, Enter: ENTER, "↵": ENTER, "⏎": ENTER, Backspace: BACKSPACE, "⌫": BACKSPACE };

/** One keycap. A letter prints as the keyboard prints it, in capitals. */
export const Key = (props: { k: string; big?: boolean }) => {
  const icon = () => KEY_ICONS[props.k];
  return (
    <kbd classList={{ big: props.big }}>
      <Show when={icon()} fallback={/^[a-z]$/.test(props.k) ? props.k.toUpperCase() : props.k}>
        {(i) => <svg viewBox="0 0 24 24" role="img" aria-label={i().label}><path d={i().d} /></svg>}
      </Show>
    </kbd>
  );
};

/** A chord's keys side by side; the second key of a two-key chord follows a gap word. */
export const KeyList = (props: { keys: string[]; big?: boolean; class?: string }) => (
  <span class={props.class ? `keycaps ${props.class}` : "keycaps"}>
    <For each={props.keys}>{(k) => (k === THEN ? <span class="key-then">then</span> : <Key k={k} big={props.big} />)}</For>
  </span>
);

/** A chord written as text ("Ctrl+Enter"), as keycaps. */
export const KeyText = (props: { text: string }) => <KeyList keys={splitKeys(props.text)} />;

/** An action's first key, following Settings › Hotkeys; nothing when it has no key. */
export const Caps = (props: { id: string; class?: string }) => (
  <Show when={capsOf(props.id)}>{(keys) => <KeyList keys={keys()} class={props.class} />}</Show>
);

/** The key alone, without the Hotkey Modifier that is being held (the Hold Hints). */
export const HintCaps = (props: { id: string; big?: boolean }) => <KeyList keys={hintKeys(props.id)} big={props.big} />;

/** The keys to draw for this control during a hold, if any. `when` limits them to when the key applies here. */
const heldFace = (props: { id?: string; keys?: string[]; when?: boolean }): string[] => {
  if (!hintsShown() || props.when === false) return [];
  return props.keys ?? (props.id ? hintKeys(props.id) : []);
};

/**
 * A control's icon, which turns into its key while the modifier is held (Hold Hints). The key takes
 * the icon's box, so nothing is added to the control or covered.
 */
export const HoldFace = (props: { id?: string; keys?: string[]; when?: boolean; children: JSX.Element }) => (
  <Show when={heldFace(props).length} fallback={props.children}>
    <KeyList keys={heldFace(props)} />
  </Show>
);

/** The key beside a control that has only a label, and no icon to turn into it. */
export const HoldKey = (props: { id: string; when?: boolean }) => (
  <Show when={heldFace(props).length}>
    <KeyList keys={heldFace(props)} class="holdkey" />
  </Show>
);
