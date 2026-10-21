// An action's first key as <kbd>s, following Settings › Hotkeys; nothing when it has no key.

import { For } from "solid-js";
import { capsOf } from "./keymap";

export const Caps = (props: { id: string }) => <For each={capsOf(props.id) ?? []}>{(k) => <kbd>{k}</kbd>}</For>;
