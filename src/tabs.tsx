// The toolbar's tab strip: the active workspace's windows as quiet underline tabs, then a `+`
// that opens the New window menu. The strip is "go to an open window", the menu is "make a new
// one". Chosen from design/tabs.html (variant E): the six labelled `+ kind` buttons it replaces
// took about 330px of the 34px toolbar — the widest thing in it — and said nothing about what
// was already open.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Project, Tab, TabKind, activePage, addTab, agentOf, app, focusTab, live, projectById, space, tabName, visibleTabs } from "./state";
import { openEditor } from "./files";
import { openIssuePanel } from "./issues";
import { openGitPanel } from "./git";
import { hotkeyProblem, hotkeyText, launchAgent, openAgentsPanel } from "./agents";
import { Icon } from "./lucide";
import { SIG_TEXT, sigOf } from "./signals";
import { flash } from "./ui";
import { keyOf } from "./keymap";

/** Glyphs of the windows that aren't terminals (those show their agent's icon). */
const GLYPH: Record<Exclude<TabKind, "term">, string> = {
  browser: "◎", issues: "☑", editor: "▤", git: "±", agents: "⚙",
};

/** The panels the New window menu offers under the agents, with the key that also opens one. */
const PANELS: { kind: Exclude<TabKind, "term">; /** The Keymap action that also opens it. */ key: string }[] = [
  { kind: "browser", key: "browser" },
  { kind: "issues", key: "issues" },
  { kind: "editor", key: "files" },
  { kind: "git", key: "git" },
  { kind: "agents", key: "agents" },
];

/** What the strip shows for a window. An editor is named by the file it shows. */
const label = (t: Tab) => (t.kind === "editor" ? (t.path ?? "").split("/").pop() || "editor" : tabName(t));

/** A window's glyph: its agent's lucide icon for a terminal or web app, else the kind's glyph. */
function Glyph(props: { tab: Tab }) {
  const agentIcon = () => agentOf(props.tab)?.icon ?? (props.tab.kind === "term" ? "square-terminal" : "globe");
  return (
    <Show when={props.tab.kind !== "term" && !props.tab.agent} fallback={<Icon name={agentIcon()} size={13} class="glyph" />}>
      <span class="glyph" aria-hidden="true">{GLYPH[props.tab.kind as Exclude<TabKind, "term">]}</span>
    </Show>
  );
}

/** Tooltip detail: the live process title, the browser address, or the file's path. */
function hint(t: Tab): string {
  if (t.kind === "editor") return t.path ?? "";
  if (t.kind === "browser") return activePage(t)?.url ?? "";
  return live[t.id]?.title ?? "";
}

/** Open a panel; the singleton ones are opened or focused, never duplicated. */
function newPanel(p: Project, kind: (typeof PANELS)[number]["kind"]) {
  if (kind === "issues") return openIssuePanel(p);
  if (kind === "editor") return void openEditor(p);
  if (kind === "git") return void openGitPanel(p);
  if (kind === "agents") return void openAgentsPanel(p);
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
              <For each={app.agents}>
                {(a) => (
                  <button
                    role="menuitem"
                    onClick={() => {
                      closeTabMenu();
                      launchAgent(p, a);
                    }}
                  >
                    <Icon name={a.icon} size={13} class="glyph" />
                    {a.name || "untitled"}
                    <Show when={a.hotkey && !hotkeyProblem(a) && a.hotkey}>{(h) => <kbd>{hotkeyText(h())}</kbd>}</Show>
                  </button>
                )}
              </For>
              <div class="msep" />
              <For each={PANELS}>
                {(k) => (
                  <button
                    role="menuitem"
                    onClick={() => {
                      closeTabMenu();
                      newPanel(p, k.kind);
                    }}
                  >
                    <span class="glyph" aria-hidden="true">{GLYPH[k.kind]}</span>
                    {k.kind}
                    <Show when={keyOf(k.key)}>{(t) => <kbd>{t()}</kbd>}</Show>
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
            classList={{ min: !!t.min }}
            aria-pressed={!t.min && space(props.project).focus === t.id}
            title={`${tabName(t)}${hint(t) ? " · " + hint(t) : ""}${sigOf(t) ? " · " + SIG_TEXT[sigOf(t)!] : ""}${t.min ? " · minimised, click to bring back" : ""}`}
            onClick={() => focusTab(props.project.id, t.id)}
          >
            <Glyph tab={t} />
            {label(t)}
            <Show when={sigOf(t)}>{(s) => <span class={`sg s-${s()}`} aria-hidden="true" />}</Show>
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
