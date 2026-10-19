// Favourite pages of a project's browser windows: the star in the address field, the bar under
// the nav, the tiles on a new tab, and the popover that names or removes one. Favourites belong
// to the project, so every browser window in it shows the same list. Chosen from design/canvas.html.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Fav, addFav, moveFav, projectById, removeFav, renameFav } from "./state";
import { browserInfo } from "./browsers";
import { flash } from "./ui";

const ICON_COLOURS = ["#7aa2f7", "#f7768e", "#9ece6a", "#bb9af7", "#2ac3de", "#ff9e64", "#e0af68", "#73daca"];

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A stand-in favicon: the name's first letter on a colour picked from the host, so one site keeps one colour. */
export function FavIcon(props: { fav: Fav }) {
  const colour = () => {
    const h = hostOf(props.fav.url);
    return ICON_COLOURS[[...h].reduce((a, c) => a + c.charCodeAt(0), 0) % ICON_COLOURS.length];
  };
  const letter = () => (props.fav.name.trim()[0] || hostOf(props.fav.url)[0] || "?").toUpperCase();
  return <i class="ico" style={{ "--c": colour() }} aria-hidden="true">{letter()}</i>;
}

type Edit = { projectId: string; url: string; anchor: HTMLElement; added: boolean };
const [editing, setEditing] = createSignal<Edit | null>(null);

/** The popover is HTML, so native browser webviews are hidden while it is open (see App). */
export const favEditOpen = () => editing() !== null;
export const favEditFor = () => editing();

export function closeFavEdit() {
  setEditing(null);
}

export function openFavEdit(projectId: string, url: string, anchor: HTMLElement, added = false) {
  setEditing({ projectId, url, anchor, added });
}

/** The star (or Ctrl+D): favourite the page if it isn't one yet, then show the editor either way. */
export function starPage(projectId: string, pageId: string, url: string, anchor: HTMLElement) {
  const p = projectById(projectId);
  if (!p) return;
  if (!url || url === "about:blank") return flash("nothing to favourite on a new tab");
  const added = !p.favs.some((f) => f.url === url);
  if (added) {
    const title = browserInfo[pageId]?.title ?? "";
    const name = (title && title !== "New tab" ? title : hostOf(url)).slice(0, 40);
    addFav(projectId, { url, name });
  }
  openFavEdit(projectId, url, anchor, added);
}

/** The favourites bar under a browser window's nav. Hidden while the project has none. */
export function FavBar(props: { projectId: string; favs: Fav[]; url: string; onOpen: (url: string) => void }) {
  const [dragged, setDragged] = createSignal<string | null>(null);
  const [over, setOver] = createSignal<string | null>(null);
  return (
    <Show when={props.favs.length}>
      <div class="favs" role="toolbar" aria-label="Favourites">
        <For each={props.favs}>
          {(f) => (
            <button
              class="fav"
              classList={{ on: f.url === props.url, over: over() === f.url && dragged() !== f.url }}
              draggable={true}
              title={`${f.name}\n${f.url}\nRight-click to rename or remove · drag to reorder`}
              onClick={() => props.onOpen(f.url)}
              onContextMenu={(e) => {
                e.preventDefault();
                openFavEdit(props.projectId, f.url, e.currentTarget);
              }}
              onDragStart={(e) => {
                setDragged(f.url);
                e.dataTransfer!.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!dragged()) return;
                e.preventDefault();
                setOver(f.url);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const d = dragged();
                if (d) moveFav(props.projectId, d, f.url);
              }}
              onDragEnd={() => {
                setDragged(null);
                setOver(null);
              }}
            >
              <FavIcon fav={f} />
              <span>{f.name}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

/** What a new (blank) browser window shows: the project's favourites as tiles. */
export function StartPage(props: { favs: Fav[]; onOpen: (url: string) => void }) {
  return (
    <div class="start">
      <Show
        when={props.favs.length}
        fallback={
          <>
            <b>New browser window</b>
            <span>Type an address above, or Ctrl+click a link in a terminal. Star a page (☆ or Ctrl+D) to keep it here.</span>
          </>
        }
      >
        <b>Favourites</b>
        <div class="tiles">
          <For each={props.favs}>
            {(f) => (
              <button class="tile" title={f.url} onClick={() => props.onOpen(f.url)}>
                <FavIcon fav={f} />
                <span>{f.name}</span>
                <small>{hostOf(f.url)}</small>
              </button>
            )}
          </For>
        </div>
        <span>Type an address above, or Ctrl+click a link in a terminal.</span>
      </Show>
    </div>
  );
}

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function FavPopover() {
  const onDown = (e: PointerEvent) => {
    if (editing() && !(e.target as Element).closest(".favpop, .star")) closeFavEdit();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  const place = (el: HTMLElement, a: HTMLElement) => {
    const r = a.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth)) + "px";
    el.style.top = Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 6) + "px";
  };

  return (
    <Show when={editing()} keyed>
      {(s) => (
        <Show when={projectById(s.projectId)} keyed>
          {(p) => (
            <Show when={p.favs.find((f) => f.url === s.url)} keyed>
              {(f) => (
                <div
                  class="pop favpop"
                  role="dialog"
                  aria-label="Favourite"
                  ref={(el) => requestAnimationFrame(() => place(el, s.anchor))}
                >
                  <div class="ttl">{s.added ? "Favourite added" : "Edit favourite"} <span>{p.name}</span></div>
                  <h4>Name</h4>
                  <input
                    class="fname"
                    value={f.name}
                    spellcheck={false}
                    aria-label="Name"
                    ref={(el) => requestAnimationFrame(() => { el.focus(); el.select(); })}
                    onInput={(e) => renameFav(p.id, f.url, e.currentTarget.value.trim() || hostOf(f.url))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") closeFavEdit();
                    }}
                  />
                  <h4>Address</h4>
                  <div class="furl">{f.url}</div>
                  <div class="acts">
                    <button
                      onClick={() => {
                        const name = f.name;
                        removeFav(p.id, f.url);
                        closeFavEdit();
                        flash(`removed ${name} from favourites`);
                      }}
                    >
                      Remove
                    </button>
                    <button class="primary" onClick={closeFavEdit}>Done</button>
                  </div>
                </div>
              )}
            </Show>
          )}
        </Show>
      )}
    </Show>
  );
}
