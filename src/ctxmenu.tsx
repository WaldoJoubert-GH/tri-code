// The right-click menu: one at a time, opened at the pointer with the items its caller builds
// (the editor's Cut / Copy / Paste and the rest, the file tree's New File). Drawn like the New
// window menu. Arrow keys move, Enter runs, Escape closes (hotkeys.ts).

import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";

export type CtxItem = { label: string; kbd?: string; disabled?: boolean; run: () => void } | "sep";
type Menu = { x: number; y: number; items: CtxItem[] };

const [menu, setMenu] = createSignal<Menu | null>(null);
export const ctxMenuOpen = () => menu() !== null;
export const closeCtxMenu = () => setMenu(null);

/** Open the menu at the pointer, in place of the webview's own. */
export function openCtxMenu(e: MouseEvent, items: CtxItem[]) {
  e.preventDefault();
  e.stopPropagation();
  setMenu({ x: e.clientX, y: e.clientY, items });
}

/** Kept inside the window: flipped left or up when it would run off an edge. */
function place(el: HTMLElement, m: Menu) {
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = (m.x + w + 8 > window.innerWidth ? Math.max(8, m.x - w) : m.x) + "px";
  el.style.top = (m.y + h + 8 > window.innerHeight ? Math.max(8, m.y - h) : m.y) + "px";
  el.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
}

/** Mount once (in App). Closes on an outside pointerdown, a scroll or the window losing focus. */
export function CtxMenu(): JSX.Element {
  const onDown = (e: PointerEvent) => {
    if (menu() && !(e.target as Element).closest(".ctxmenu")) closeCtxMenu();
  };
  const onScroll = (e: Event) => {
    if (menu() && !(e.target as Element).closest?.(".ctxmenu")) closeCtxMenu();
  };
  onMount(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", closeCtxMenu);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("blur", closeCtxMenu);
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
  };

  return (
    <Show when={menu()} keyed>
      {(m) => (
        <div
          class="tabmenu ctxmenu"
          role="menu"
          ref={(el) => requestAnimationFrame(() => place(el, m))}
          onKeyDown={onKey}
          onContextMenu={(e) => e.preventDefault()}
        >
          <For each={m.items}>
            {(it) =>
              it === "sep" ? (
                <div class="msep" />
              ) : (
                <button
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    closeCtxMenu();
                    it.run();
                  }}
                >
                  {it.label}
                  <Show when={it.kbd}>{(k) => <kbd>{k()}</kbd>}</Show>
                </button>
              )
            }
          </For>
        </div>
      )}
    </Show>
  );
}
