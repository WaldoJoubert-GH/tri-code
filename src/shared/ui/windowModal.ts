// A modal over one canvas window rather than the app (Issues' New issue form, Database's Review):
// while it's up, the rest of that window is inert, so Tab, clicks and screen readers stay in the
// overlay. The other windows keep working, and focus goes back to where it was when it closes.
// An app-wide modal is <Modal>, a native <dialog> in the top layer; these stay inside their window.

import { onCleanup, onMount } from "solid-js";

/** Call in the overlay's component; `el` is its outermost element. */
export function useWindowModal(el: () => HTMLElement | undefined): void {
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  onMount(() => {
    const root = el();
    if (!root) return;
    const stop = root.closest(".win") ?? document.body;
    const made: HTMLElement[] = [];
    // Every sibling on the way up to the window, so its title bar and panels go quiet too.
    for (let n: HTMLElement = root; n !== stop && n.parentElement; n = n.parentElement) {
      for (const s of n.parentElement.children) {
        if (s !== n && s instanceof HTMLElement && !s.inert) {
          s.inert = true;
          made.push(s);
        }
      }
    }
    onCleanup(() => {
      for (const s of made) s.inert = false;
      if (back?.isConnected && !back.closest("[inert]")) back.focus({ preventScroll: true });
    });
  });
}
