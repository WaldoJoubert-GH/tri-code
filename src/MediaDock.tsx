// Media Controls in the sidebar (design/media-controls.html, variant C): a card above Settings with
// the artwork, a scrubber and the transport buttons; on the collapsed rail, the artwork in a progress
// ring. The ring is its own hover zone so a click plays or pauses without peeking the list. Clicking
// the title, or the ring's badge, opens the popover beside the sidebar.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./shared/ui/lucide";
import { KeyList } from "./shared/keys/Keys";
import {
  type MediaSession, clock, closeMediaPop, currentMedia, dismissMedia, mediaControl, mediaPopAnchor, mediaPopOpen, mediaSessions,
  mediaShown, pickMedia, positionOf, progressOf, toggleMediaPop,
} from "./media";
import "./media.css";

/** Filled transport glyphs: lucide's are outlines, which read thin at this size. */
const GLYPHS = {
  play: "M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  prev: "M19 5.2v13.6a.8.8 0 0 1-1.25.66L8 12.66a.8.8 0 0 1 0-1.32l9.75-6.8A.8.8 0 0 1 19 5.2zM5 5h2.5v14H5z",
  next: "M5 5.2v13.6a.8.8 0 0 0 1.25.66L16 12.66a.8.8 0 0 0 0-1.32L6.25 4.54A.8.8 0 0 0 5 5.2zM16.5 5H19v14h-2.5z",
};
const Glyph = (props: { d: keyof typeof GLYPHS; size?: number }) => (
  <svg class="mglyph" viewBox="0 0 24 24" width={props.size ?? 12} height={props.size ?? 12} aria-hidden="true"><path d={GLYPHS[props.d]} /></svg>
);

/** The artwork, or a note on a tile tinted from the title when the app gives none. */
function Art(props: { s: MediaSession; class?: string }) {
  const hue = () => [...props.s.title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <Show
      when={props.s.art}
      fallback={<span class={`mart none ${props.class ?? ""}`} style={{ "--h": hue() }}><Icon name="music" size={14} /></span>}
    >
      {(src) => <img class={`mart ${props.class ?? ""}`} src={src()} alt="" draggable={false} />}
    </Show>
  );
}

/** A progress bar that seeks on click when the app allows it. */
function Scrub(props: { s: MediaSession }) {
  const pct = () => (progressOf(props.s) ?? 0) * 100;
  const seek = (e: MouseEvent) => {
    if (!props.s.canSeek || !props.s.duration) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    void mediaControl("seek", Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * props.s.duration);
  };
  return (
    <div class="mbar" classList={{ seekable: props.s.canSeek, unknown: progressOf(props.s) == null }} onClick={seek}
      role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={props.s.duration ?? 0} aria-valuenow={Math.round(positionOf(props.s) ?? 0)}>
      <i style={{ width: `${pct()}%` }} />
      <b style={{ left: `${pct()}%` }} />
    </div>
  );
}

const Eq = () => <span class="meq" aria-hidden="true"><i /><i /><i /></span>;

function Transport(props: { s: MediaSession; big?: boolean }) {
  return (
    <>
      <button class="mbtn" disabled={!props.s.canPrev} title="Previous" aria-label="Previous" onClick={() => void mediaControl("prev")}><Glyph d="prev" /></button>
      <button class="mbtn play" classList={{ big: props.big }} title={props.s.playing ? "Pause" : "Play"} aria-label={props.s.playing ? "Pause" : "Play"} onClick={() => void mediaControl("toggle")}>
        <Glyph d={props.s.playing ? "pause" : "play"} size={props.big ? 15 : 12} />
      </button>
      <button class="mbtn" disabled={!props.s.canNext} title="Next" aria-label="Next" onClick={() => void mediaControl("next")}><Glyph d="next" /></button>
    </>
  );
}

/** In the sidebar's foot, above Settings. `onRing` reports the pointer entering or leaving the rail's ring. */
export function MediaDock(props: { onRing: (inside: boolean) => void }) {
  return (
    <Show when={mediaShown() && currentMedia()}>
      {(s) => (
        <div class="media" classList={{ playing: s().playing }}>
          <div
            class="media-ring"
            style={{ "--p": `${(progressOf(s()) ?? 0) * 100}%` }}
            title={`${s().title} · ${s().artist}\n${s().app} · click to ${s().playing ? "pause" : "play"}`}
            onMouseEnter={() => props.onRing(true)}
            onMouseLeave={() => props.onRing(false)}
            onClick={() => void mediaControl("toggle")}
          >
            <Art s={s()} />
            <span class="ov"><Glyph d={s().playing ? "pause" : "play"} /></span>
            <button class="more" title="Now playing" aria-label="Now playing" onClick={(e) => (e.stopPropagation(), toggleMediaPop(e.currentTarget))}>
              <Eq />
            </button>
          </div>
          <div class="media-dock">
            <button class="x" title="Hide until the next track" aria-label="Hide media controls until the next track" onClick={dismissMedia}>
              <Icon name="x" size={11} />
            </button>
            <button class="row" title={`${s().app}: more`} onClick={(e) => toggleMediaPop(e.currentTarget)} aria-haspopup="dialog" aria-expanded={mediaPopOpen()}>
              <Art s={s()} />
              <span class="w">
                <span class="ttl">{s().title || s().app}</span>
                <span class="sub">{s().artist || s().app}</span>
              </span>
            </button>
            <Show when={s().duration}>
              <Scrub s={s()} />
              <div class="mtimes"><span>{clock(positionOf(s()))}</span><span>{clock(s().duration)}</span></div>
            </Show>
            <div class="mctl">
              <span class="msrc" title={s().app}><Eq />{s().app}</span>
              <Transport s={s()} />
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

/** Mount once (in App): the popover beside the sidebar. */
export function MediaPopover() {
  let el: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  const place = () => {
    const a = mediaPopAnchor();
    if (!a || !el) return;
    const aside = a.closest("aside")?.getBoundingClientRect();
    const r = a.getBoundingClientRect(), h = el.offsetHeight, w = el.offsetWidth;
    const left = Math.min((aside?.right ?? r.right) + 8, window.innerWidth - w - 8);
    const top = Math.max(8, Math.min(r.bottom - h, window.innerHeight - h - 8));
    setPos({ left, top });
  };
  const onDown = (e: PointerEvent) => {
    if (mediaPopOpen() && !(e.target as Element).closest(".media-pop, .media-dock .row, .media-ring .more")) closeMediaPop();
  };
  onMount(() => {
    document.addEventListener("pointerdown", onDown);
    addEventListener("resize", place);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDown);
    removeEventListener("resize", place);
  });

  const others = () => mediaSessions().filter((x) => x.id !== currentMedia()?.id);

  return (
    <Show when={mediaPopOpen() && currentMedia()}>
      {(s) => (
        <div
          class="pop media-pop"
          role="dialog"
          aria-label="Now playing"
          tabindex="-1"
          style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          ref={(e) => {
            el = e;
            const ro = new ResizeObserver(place);
            ro.observe(e);
            onCleanup(() => ro.disconnect());
            requestAnimationFrame(() => (place(), e.focus()));
          }}
          onKeyDown={(e) => {
            if (e.target instanceof HTMLButtonElement && (e.key === " " || e.key === "Enter")) return;
            if (e.key === " ") (e.preventDefault(), void mediaControl("toggle"));
            else if (e.key === "ArrowRight" && s().canNext) (e.preventDefault(), void mediaControl("next"));
            else if (e.key === "ArrowLeft" && s().canPrev) (e.preventDefault(), void mediaControl("prev"));
          }}
        >
          <div class="hero">
            <Art s={s()} class="big" />
            <div class="meta">
              <span class="msrc"><Show when={s().playing} fallback={<Icon name="pause" size={10} />}><Eq /></Show>{s().app}</span>
              <b title={s().title}>{s().title || s().app}</b>
              <span title={s().artist}>{s().artist}</span>
              <Show when={s().album}><span class="alb" title={s().album}>{s().album}</span></Show>
            </div>
          </div>
          <Show when={s().duration}>
            <div>
              <Scrub s={s()} />
              <div class="mtimes"><span>{clock(positionOf(s()))}</span><span>-{clock((s().duration ?? 0) - (positionOf(s()) ?? 0))}</span></div>
            </div>
          </Show>
          <div class="mctl center"><Transport s={s()} big /></div>
          <Show when={others().length}>
            <div class="others">
              <h4>Also playing</h4>
              <For each={others()}>
                {(o) => (
                  <div class="other">
                    <button class="pick" title={`Control ${o.app} here`} onClick={() => pickMedia(o.id)}>
                      <Art s={o} />
                      <span class="w"><span class="ttl">{o.title || o.app}</span><span class="sub">{o.app} · {o.playing ? "playing" : "paused"}</span></span>
                    </button>
                    <button class="mbtn" title={o.playing ? "Pause" : "Play"} aria-label={`${o.playing ? "Pause" : "Play"} ${o.app}`} onClick={() => void mediaControl("toggle", undefined, o.id)}>
                      <Glyph d={o.playing ? "pause" : "play"} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="pf"><KeyList keys={["Space"]} /> play / pause <KeyList keys={["←", "→"]} /> skip</div>
        </div>
      )}
    </Show>
  );
}
