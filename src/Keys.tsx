// An action's first key as <kbd>s, following Settings › Hotkeys; nothing when it has no key.

import { For } from "solid-js";
import { capsOf, hintKeys } from "./keymap";

export const Caps = (props: { id: string }) => <For each={capsOf(props.id) ?? []}>{(k) => <kbd>{k}</kbd>}</For>;

/** The key alone, without the Hotkey Modifier that is being held (the Hold Hints). */
export const HintCaps = (props: { id: string }) => <For each={hintKeys(props.id)}>{(k) => <kbd>{k}</kbd>}</For>;
