// Enter in a text field, as an action key. While an IME (Chinese, Japanese, Korean input) is
// composing, Enter confirms the candidate characters and must not also submit, rename or blur.
// `isComposing` is the standard check; WebKit can deliver compositionend before the confirming
// keydown, so `keyCode === 229` (the IME's "process key") catches what it misses.

type KeyLike = Pick<KeyboardEvent, "key" | "isComposing" | "keyCode">;

/** Is this keydown an Enter meant for the app, not one confirming IME composition? */
export const isEnter = (e: KeyLike): boolean => e.key === "Enter" && !e.isComposing && e.keyCode !== 229;
