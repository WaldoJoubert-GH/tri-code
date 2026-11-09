// The Leftovers popover: one row's leftovers (its count in the sidebar) or every one (the status
// line's chip), each with its own end button and End all. See leftovers.ts.

import { For, Show, onCleanup, onMount } from "solid-js";
import { type Leftover, closeLeftovers, endAll, endLeftover, leftovers, leftoversAt, leftoversPop, toggleLeftovers } from "./leftovers";
import { envName, projectById } from "./state";
import { labelOf } from "./worktrees";
import { Icon } from "./lucide";

const KIND: Record<Leftover["kind"], { icon: string; name: string; verb: string }> = {
  ghost: { icon: "ghost", name: "Terminal with no window", verb: "End" },
  stray: { icon: "cpu", name: "Process left running in the folder", verb: "End" },
  remote: { icon: "server", name: "Remote session with no window", verb: "End" },
  folder: { icon: "folder-x", name: "Folder git no longer lists", verb: "Delete" },
  prune: { icon: "unlink", name: "Worktree whose folder is gone", verb: "Prune" },
};

/** Where a leftover is, for the list of all of them. */
function whereOf(l: Leftover): string {
  const p = projectById(l.place ?? "");
  if (!p) return l.host === "local" ? "no project" : envName(l.host);
  const repo = p.parent ? projectById(p.parent) : undefined;
  return repo ? `${repo.name} › ${labelOf(p).text}` : p.name;
}

/** The status line's chip: shown only while something is left behind. */
export function LeftoversChip() {
  const n = () => leftovers().length;
  return (
    <Show when={n()}>
      <button
        class="bellbtn leftbtn"
        id="leftoversBtn"
        title={`${n()} left behind: terminals, processes or folders nothing uses any more`}
        aria-label={`${n()} left behind`}
        aria-haspopup="dialog"
        aria-expanded={leftoversPop()?.place === "*"}
        onClick={(e) => toggleLeftovers("*", e.currentTarget)}
      >
        <Icon name="ghost" size={13} />
        <span>{n()} left behind</span>
      </button>
    </Show>
  );
}

/** A row's count in the sidebar, opening that row's list. */
export function LeftoverCount(props: { place: string }) {
  const n = () => leftoversAt(props.place).length;
  return (
    <Show when={n()}>
      <button
        class="left-count"
        title={`${n()} left behind here: click to see and end`}
        aria-label={`${n()} left behind`}
        onClick={(e) => (e.stopPropagation(), toggleLeftovers(props.place, e.currentTarget))}
      >
        {n()}
      </button>
    </Show>
  );
}

/** Mount once (in App); Escape is handled in hotkeys.ts. */
export function LeftoversPopover() {
  const onDown = (e: PointerEvent) => {
    if (leftoversPop() && !(e.target as Element).closest(".pop.leftovers, #leftoversBtn, .left-count")) closeLeftovers();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  const list = () => {
    const at = leftoversPop()?.place;
    return at === "*" ? leftovers() : at ? leftoversAt(at) : [];
  };
  const title = () => {
    const at = leftoversPop()?.place;
    const p = at && at !== "*" ? projectById(at) : undefined;
    return `${p ? `${p.parent ? labelOf(p).text : p.name}: ` : ""}${list().length} left behind`;
  };

  /** Above a status line button, beside a sidebar one; kept inside the window. */
  const place = (el: HTMLElement, a: HTMLElement) => {
    const r = a.getBoundingClientRect();
    if (a.id === "leftoversBtn") {
      el.style.left = Math.max(8, Math.min(r.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8)) + "px";
      el.style.top = Math.max(8, r.top - el.offsetHeight - 6) + "px";
    } else {
      el.style.left = Math.min(r.right + 8, window.innerWidth - el.offsetWidth - 8) + "px";
      el.style.top = Math.max(8, Math.min(r.top - 10, window.innerHeight - el.offsetHeight - 8)) + "px";
    }
  };

  return (
    <Show when={leftoversPop()} keyed>
      {(at) => (
        <div class="pop leftovers" role="dialog" aria-label="Left behind" ref={(el) => requestAnimationFrame(() => place(el, at.anchor))}>
          <div class="ttl">
            {title()}
            <Show when={list().some((l) => l.kind !== "folder")}>
              <button class="danger" onClick={() => void endAll(list())}>End all</button>
            </Show>
          </div>
          <Show when={list().length} fallback={<div class="note">Nothing left behind.</div>}>
            <div class="lrows">
              <For each={list()}>
                {(l) => (
                  <div class="lrow" title={KIND[l.kind].name}>
                    <span class={`lk-${l.kind}`}><Icon name={KIND[l.kind].icon} size={12} /></span>
                    <span class="lmain">
                      <b>{l.label}</b>
                      <span>{l.detail}</span>
                      <Show when={at.place === "*"}><span>· {whereOf(l)}</span></Show>
                    </span>
                    <button class="lend" title={`${KIND[l.kind].verb} ${l.label}`} aria-label={`${KIND[l.kind].verb} ${l.label}`} onClick={() => void endLeftover(l)}>
                      {KIND[l.kind].verb}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="snote">Only what tri-code started, or what is in a project's folder with nothing left that started it.</div>
        </div>
      )}
    </Show>
  );
}
