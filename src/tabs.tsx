// The toolbar's tab strip: the active workspace's windows as quiet underline tabs, then a `+`
// that opens the New window menu. The strip is "go to an open window", the menu is "make a new
// one". Chosen from design/tabs.html (variant E): the six labelled `+ kind` buttons it replaces
// took about 330px of the 34px toolbar — the widest thing in it — and said nothing about what
// was already open.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Project, Tab, TabKind, addTab, focusTab, live, projectById, space, visibleTabs } from "./state";
import { openFilesPanel } from "./files";
import { openIssuePanel } from "./issues";
import { flash } from "./ui";

/** Window glyphs. A `file` window shows the file name as its label, so it shares the files glyph. */
const GLYPH: Record<TabKind, string> = {
  claude: "✳", pi: "π", shell: "›", browser: "◎", issues: "☑", files: "▤", file: "▤",
};

/** The kinds the New window menu offers, in toolbar order, with the key that also makes one. */
const NEW_KINDS: { kind: TabKind; key: string }[] = [
  { kind: "claude", key: "Alt+↵" },
  { kind: "pi", key: "Alt+↵" },
  { kind: "shell", key: "Alt+↵" },
  { kind: "browser", key: "Alt+B" },
  { kind: "issues", key: "Alt+I" },
  { kind: "files", key: "Alt+E" },
];

/** What the strip shows for a window. `file` windows are named by their file. */
const label = (t: Tab) => (t.kind === "file" ? (t.path ?? "").split("/").pop() || "file" : t.kind);

/** Tooltip detail: the live process title, the browser address, or the file's path. */
function hint(t: Tab): string {
  if (t.kind === "file") return t.path ?? "";
  if (t.kind === "browser") return t.url ?? "";
  return live[t.id]?.title ?? "";
}

/** Open a new window of `kind`; the singleton panels are opened or focused, never duplicated. */
function newWindow(p: Project, kind: TabKind) {
  if (kind === "issues") return openIssuePanel(p);
  if (kind === "files") return void openFilesPanel(p);
  addTab(p.id, kind);
  flash(`new ${kind}`);
}

type Menu = { projectId: string; anchor: HTMLElement };
const [menu, setMenu] = createSignal<Menu | null>(null);

export const tabMenuOpen = () => menu() !== null;

export function closeTabMenu() {
  setMenu(null);
}

/** Open the New window menu under its `+` button, or close it if it is already open. */
export function toggleTabMenu(anchor: HTMLElement, projectId: string) {
  if (menu()) closeTabMenu();
  else setMenu({ projectId, anchor });
}

/** Put the menu under its button, kept inside the window (the toolbar is 34px tall). */
function placeMenu(el: HTMLElement, a: HTMLElement) {
  const r = a.getBoundingClientRect();
  el.style.left = Math.min(Math.max(8, r.left - 4), window.innerWidth - el.offsetWidth - 8) + "px";
  el.style.top = Math.min(r.bottom + 5, window.innerHeight - el.offsetHeight - 8) + "px";
}

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function TabMenu() {
  const onDown = (e: PointerEvent) => {
    if (menu() && !(e.target as Element).closest(".tabmenu, .tab-add")) closeTabMenu();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  return (
    <Show when={menu()} keyed>
      {(m) => (
        <Show when={projectById(m.projectId)} keyed>
          {(p) => (
            <div class="tabmenu" role="menu" aria-label="New window" ref={(el) => requestAnimationFrame(() => placeMenu(el, m.anchor))}>
              <div class="mt">New window</div>
              <For each={NEW_KINDS}>
                {(k) => (
                  <button
                    role="menuitem"
                    onClick={() => {
                      closeTabMenu();
                      newWindow(p, k.kind);
                    }}
                  >
                    <span class="glyph" aria-hidden="true">{GLYPH[k.kind]}</span>
                    {k.kind}
                    <kbd>{k.key}</kbd>
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
      )}
    </Show>
  );
}

/** The workspace's windows, in tiling order, plus `+`. */
export function TabStrip(props: { project: Project }) {
  return (
    <div class="tabs" role="group" aria-label="Windows on this workspace">
      <For each={visibleTabs(props.project)}>
        {(t) => (
          <button
            class="tab"
            aria-pressed={space(props.project).focus === t.id}
            title={`${t.kind}${hint(t) ? " · " + hint(t) : ""}`}
            onClick={() => focusTab(props.project.id, t.id)}
          >
            <span class="glyph" aria-hidden="true">{GLYPH[t.kind]}</span>
            {label(t)}
            <Show when={live[t.id]?.attention}>
              <span class="att" title="needs attention" />
            </Show>
          </button>
        )}
      </For>
      <button
        class="tab-add"
        aria-haspopup="menu"
        aria-expanded={tabMenuOpen()}
        title="New window"
        onClick={(e) => toggleTabMenu(e.currentTarget, props.project.id)}
      >
        +
      </button>
    </div>
  );
}
