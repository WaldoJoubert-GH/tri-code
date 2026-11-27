// A popup tied to an element: Appearance, Signals, Feedback, Leftovers, the browser window's
// Debug, Downloads and Profile menus, a favourite, a tunnel, Issues' dropdowns, an agent's pickers.
//
// It is a native popover in the top layer, so it shows above the canvas, its windows and any
// open dialog without a z-index. It's `manual`, not `auto`: an auto popover closes whenever a
// <dialog> opens (Appearance opens the icon picker), and each popup has presses that must not
// close it (its other buttons, a picker it opened), passed as `keep`. A press anywhere else
// calls `onClose`. Escape is not handled here: hotkeys.ts closes the overlays in order.
//
// Mount it while it's open (inside a <Show>) and unmount it to close. It is placed by script
// beside its anchor, kept on screen, and placed again when it or the window changes size. CSS
// anchor positioning would do that natively, but older macOS and Linux webviews don't have it,
// so the script stays the one placement everywhere.

import { type JSX, type ParentProps, createEffect, onCleanup, onMount } from "solid-js";

/**
 * below      under the anchor, left edges lined up (above it when there's no room below)
 * below-end  the same, right edges lined up
 * above      over the anchor, left edges lined up (the editor's status bar)
 * above-end  over the anchor, right edges lined up (the status line's buttons)
 * beside     right of the sidebar, its top a little above the anchor's (a sidebar row's button)
 * beside-up  right of the sidebar, its bottom on the anchor's (the media dock)
 */
export type Side = "below" | "below-end" | "above" | "above-end" | "beside" | "beside-up";

const MARGIN = 8;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Put `el` (position: fixed) at `side` of `anchor`, `gap` px away, inside the window. */
export function placeNear(el: HTMLElement, anchor: Element, side: Side = "below", gap = 6): void {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left: number, top: number;
  if (side === "below" || side === "below-end") {
    left = side === "below" ? r.left : r.right - w;
    top = r.bottom + gap;
    if (top + h > innerHeight - MARGIN && r.top - gap - h >= MARGIN) top = r.top - gap - h;
  } else if (side === "above" || side === "above-end") {
    left = side === "above" ? r.left : r.right - w;
    top = r.top - gap - h;
  } else {
    // The sidebar's edge, not the button's, or the popup would cover the sidebar.
    left = (anchor.closest("aside") ?? anchor).getBoundingClientRect().right + gap;
    top = side === "beside" ? r.top - 10 : r.bottom - h;
  }
  el.style.left = `${clamp(left, MARGIN, innerWidth - w - MARGIN)}px`;
  el.style.top = `${clamp(top, MARGIN, innerHeight - h - MARGIN)}px`;
}

export function Popover(
  props: ParentProps<{
    /** What it's tied to: placed beside it, and a press on it is the opener's to handle (a toggle). */
    anchor: Element | (() => Element | null | undefined);
    /** A press outside the popup, its anchor and `keep`. */
    onClose: () => void;
    side?: Side;
    gap?: number;
    /** A selector for more places a press doesn't close it from. */
    keep?: string;
    class?: string;
    role?: "dialog" | "menu";
    label?: string;
    tabindex?: number;
    ref?: (el: HTMLDivElement) => void;
    onKeyDown?: JSX.EventHandler<HTMLDivElement, KeyboardEvent>;
  }>,
): JSX.Element {
  let el!: HTMLDivElement;
  const anchor = () => (typeof props.anchor === "function" ? props.anchor() : props.anchor);
  const place = () => {
    const a = anchor();
    if (a?.isConnected) placeNear(el, a, props.side, props.gap);
  };

  onMount(() => {
    el.showPopover?.();
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    const down = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || el.contains(t) || anchor()?.contains(t)) return;
      if (props.keep && t instanceof Element && t.closest(props.keep)) return;
      props.onClose();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("scroll", place, true);
    addEventListener("resize", place);
    onCleanup(() => {
      ro.disconnect();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    });
    // An anchor given as a function can change (Issues' dropdown follows the selected row).
    createEffect(place);
  });

  return (
    <div
      ref={(e) => {
        el = e;
        props.ref?.(e);
      }}
      class={`tc-pop ${props.class ?? ""}`}
      {...({ popover: "manual" } as Record<string, string>)}
      role={props.role}
      aria-label={props.label}
      tabindex={props.tabindex}
      onKeyDown={props.onKeyDown}
    >
      {props.children}
    </div>
  );
}
