// Small shared UI signals: the status-line flash message and the undo toast.

import { createSignal } from "solid-js";

const [flashMsg, setFlashMsg] = createSignal("");
let flashTimer: number | undefined;
export { flashMsg };

/** Show a short message in the status line for ~1.8s. */
export function flash(msg: string) {
  setFlashMsg(msg);
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => setFlashMsg(""), 1800);
}

export type Toast = { msg: string; undo?: () => void };
const [toast, setToastSig] = createSignal<Toast | null>(null);
let toastTimer: number | undefined;
export { toast };

/** Show a toast (with an optional Undo button) for 5s. `onExpire` runs if it was not undone. */
export function showToast(t: Toast, onExpire?: () => void) {
  const prev = pendingExpire;
  pendingExpire = undefined;
  prev?.(); // a toast replaced by a newer one counts as expired
  clearTimeout(toastTimer);
  setToastSig(t);
  pendingExpire = onExpire;
  toastTimer = window.setTimeout(() => {
    setToastSig(null);
    const f = pendingExpire;
    pendingExpire = undefined;
    f?.();
  }, 5000);
}
let pendingExpire: (() => void) | undefined;

/** Called by the toast's Undo button. */
export function undoToast() {
  const t = toast();
  clearTimeout(toastTimer);
  pendingExpire = undefined;
  setToastSig(null);
  t?.undo?.();
}
