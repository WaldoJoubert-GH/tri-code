// Lucide icons for agents: an <Icon> by kebab-case name and the picker the agents window opens.
// The icon set (~2000 icons) is its own chunk, loaded once at startup; until it arrives an
// icon renders as an empty square of the right size.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

type IconNode = [tag: string, attrs: Record<string, string>][];

const toKebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([a-zA-Z])(\d)/g, "$1-$2").toLowerCase();

const [icons, setIcons] = createSignal<Record<string, IconNode> | null>(null);
/** One name per icon (lucide also exports old names as aliases), sorted. */
const [names, setNames] = createSignal<string[]>([]);

import("lucide").then((m) => {
  const byName: Record<string, IconNode> = {};
  const seen = new Set<IconNode>();
  const unique: string[] = [];
  for (const [k, node] of Object.entries(m.icons as unknown as Record<string, IconNode>)) {
    const name = toKebab(k);
    byName[name] = node;
    if (!seen.has(node)) {
      seen.add(node);
      unique.push(name);
    }
  }
  setIcons(byName);
  setNames(unique.sort());
});

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const markup = (node: IconNode) =>
  node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(String(v))}"`).join(" ")}/>`).join("");

export function Icon(props: { name: string; size?: number; class?: string }) {
  const node = () => icons()?.[props.name];
  return (
    <svg
      class={`lucide ${props.class ?? ""}`}
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      innerHTML={node() ? markup(node()!) : ""}
    />
  );
}

/** Offered before anything is typed: icons that read as terminal apps and agents. */
const SUGGESTED = [
  "asterisk", "sparkles", "bot", "brain", "pi", "square-terminal", "terminal", "code", "git-branch",
  "git-pull-request", "github", "database", "server", "container", "cloud", "activity", "gauge", "cpu",
  "bug", "flask-conical", "rocket", "zap", "wand-sparkles", "hammer", "wrench", "package", "globe",
  "file-code", "notebook-pen", "list-todo", "folder-tree", "search", "message-square", "ghost", "cat",
  "bird", "flame", "leaf", "star", "heart", "sigma", "hash", "command", "keyboard", "monitor",
];

type Picker = { anchor: HTMLElement; value: string; onPick: (name: string) => void };
const [picker, setPicker] = createSignal<Picker | null>(null);

export const iconPickerOpen = () => picker() !== null;
export const closeIconPicker = () => setPicker(null);

/** Open the picker under `anchor`, or close it if it is already open there. */
export function toggleIconPicker(anchor: HTMLElement, value: string, onPick: (name: string) => void) {
  setPicker((p) => (p?.anchor === anchor ? null : { anchor, value, onPick }));
}

function place(el: HTMLElement, a: HTMLElement) {
  const r = a.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)) + "px";
  const below = r.bottom + 5;
  el.style.top = (below + el.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - el.offsetHeight - 5) : below) + "px";
}

const SHOWN = 144;

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function IconPicker() {
  const onDown = (e: PointerEvent) => {
    const p = picker();
    if (p && !(e.target as Element).closest(".iconpick") && !p.anchor.contains(e.target as Node)) closeIconPicker();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  return (
    <Show when={picker()} keyed>
      {(p) => {
        const [q, setQ] = createSignal("");
        const matches = createMemo(() => {
          const s = q().trim().toLowerCase();
          return s ? names().filter((n) => n.includes(s)) : SUGGESTED.filter((n) => !icons() || icons()![n]);
        });
        const pick = (name: string) => {
          closeIconPicker();
          p.onPick(name);
        };
        return (
          <div class="iconpick" role="dialog" aria-label="Choose an icon" ref={(el) => requestAnimationFrame(() => place(el, p.anchor))}>
            <input
              class="q"
              placeholder={`Search ${names().length || ""} lucide icons…`}
              spellcheck={false}
              ref={(el) => requestAnimationFrame(() => el.focus())}
              onInput={(e) => setQ(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches()[0]) pick(matches()[0]);
              }}
            />
            <div class="grid">
              <For each={matches().slice(0, SHOWN)} fallback={<span class="none">No icon is called “{q()}”</span>}>
                {(n) => (
                  <button aria-pressed={n === p.value} title={n} onClick={() => pick(n)}>
                    <Icon name={n} size={16} />
                  </button>
                )}
              </For>
            </div>
            <div class="meta">
              <span>
                {q().trim()
                  ? `${matches().length} match${matches().length === 1 ? "" : "es"}${matches().length > SHOWN ? `, first ${SHOWN}` : ""}`
                  : "suggested · type to search"}
              </span>
              <code>{p.value}</code>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
