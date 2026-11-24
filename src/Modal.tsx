// A modal window on the native <dialog>, opened with showModal(). The browser then keeps focus in
// it, makes everything behind it inert, puts it in the top layer (above every z-index) and hands
// focus back to whatever opened it. Windows opened from one (Environment over Open project, the
// icon picker over Settings) stack on top, newest first.
//
// The <dialog> fills the viewport and is itself the scrim (the `.dialog-scrim` look), with the
// window's own box inside it, so a press on the dialog itself is a press outside that box.
// Its open state stays the caller's signal: Escape and a press outside ask `onClose`, and the
// dialog closes by unmounting.

import { onCleanup, onMount, type JSX, type ParentProps } from "solid-js";

export function Modal(
  props: ParentProps<{
    /** Escape and (with `dismiss`) a press outside the box. Without it the window stays until it closes itself. */
    onClose?: () => void;
    /** Close on a press outside the box. On by default. */
    dismiss?: boolean;
    label?: string;
    role?: "alertdialog";
    /** Extra classes on the scrim: `clear` drops the dimming. */
    class?: string;
    onKeyDown?: JSX.EventHandler<HTMLDialogElement, KeyboardEvent>;
  }>,
) {
  let el!: HTMLDialogElement;
  onMount(() => {
    if (!el.open) el.showModal();
  });
  // Closing (not only removing) is what returns focus to the opener.
  onCleanup(() => el.open && el.close());

  return (
    <dialog
      ref={el}
      class={`dialog-scrim ${props.class ?? ""}`}
      role={props.role}
      aria-label={props.label}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose?.();
      }}
      onPointerDown={(e) => {
        if (props.dismiss === false || e.target !== e.currentTarget || !props.onClose) return;
        // Else the press's mousedown moves focus to <body> after close() gave it back to the opener.
        e.preventDefault();
        props.onClose();
      }}
      onKeyDown={props.onKeyDown}
    >
      {props.children}
    </dialog>
  );
}
