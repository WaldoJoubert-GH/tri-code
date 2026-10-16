// Per-project appearance: accent colour, background preset or uploaded image, and dim.
// The popover is anchored under the toolbar button, or beside a sidebar gear.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { ACCENTS, Project, activeProject, projectById, setAppearance } from "./state";
import { flash } from "./ui";

const tint = (a: string, p: number) => `color-mix(in srgb, ${a} ${p}%, transparent)`;

/** Built-in backgrounds, drawn in CSS from the project's accent. They use var(--canvas) and var(--dusk-*), so they follow light and dark. */
export const BACKGROUNDS: Record<string, { name: string; css: (accent: string) => string }> = {
  none: { name: "None", css: () => "var(--canvas)" },
  aurora: { name: "Aurora", css: (a) => `radial-gradient(60% 80% at 12% 8%, ${tint(a, 48)}, transparent 70%), radial-gradient(50% 70% at 92% 95%, ${tint(a, 32)}, transparent 70%), var(--canvas)` },
  blueprint: { name: "Blueprint", css: (a) => `linear-gradient(${tint(a, 13)} 1px, transparent 1px) 0 0 / 32px 32px, linear-gradient(90deg, ${tint(a, 13)} 1px, transparent 1px) 0 0 / 32px 32px, radial-gradient(80% 80% at 50% 0%, ${tint(a, 12)}, transparent), var(--canvas)` },
  rings: { name: "Rings", css: (a) => `repeating-radial-gradient(circle at 78% 115%, transparent 0 26px, ${tint(a, 22)} 26px 27px), var(--canvas)` },
  dusk: { name: "Dusk", css: () => "linear-gradient(185deg, var(--dusk-a) 0%, var(--dusk-b) 40%, var(--dusk-c) 72%, var(--dusk-d) 100%)" },
};

/**
 * Uploaded background images by project id, as blob: URLs. Loaded once at startup, filled on upload.
 * Not data URLs: Chromium drops a `background` declaration whose data URL runs to megabytes, so photos never showed.
 */
const [bgImages, setBgImages] = createStore<Record<string, string>>({});
export { bgImages };

/** Show `image` (a Blob, or the data URL stored on disk) as a project's uploaded background. */
export async function setBgImage(projectId: string, image: Blob | string) {
  const blob = typeof image === "string" ? await (await fetch(image)).blob() : image;
  const old = bgImages[projectId];
  setBgImages(projectId, URL.createObjectURL(blob));
  if (old) URL.revokeObjectURL(old);
}

/** Drop a project's cached image (project removed). */
export function forgetBgImage(projectId: string) {
  const old = bgImages[projectId];
  setBgImages(produce((s) => { delete s[projectId]; }));
  if (old) URL.revokeObjectURL(old);
}

/** CSS `background` for a project's backdrop layer. */
export function backgroundCss(p: Project): string {
  if (p.bg === "image") {
    const url = bgImages[p.id];
    return url ? `center / cover no-repeat url("${url}"), var(--canvas)` : "var(--canvas)";
  }
  return (BACKGROUNDS[p.bg] ?? BACKGROUNDS.none).css(p.accent);
}

type PopState = { projectId: string; anchor: HTMLElement };
const [pop, setPop] = createSignal<PopState | null>(null);

export const appearanceOpen = () => pop() !== null;

/** Open the popover for a project (default: the active one), anchored under `anchor` (default: the toolbar button). */
export function openAppearance(anchor?: HTMLElement | null, projectId?: string) {
  const pid = projectId ?? activeProject()?.id;
  const a = anchor ?? document.getElementById("themeBtn");
  if (!pid || !a) return;
  setPop({ projectId: pid, anchor: a });
}

export function closeAppearance() {
  setPop(null);
}

export function toggleAppearance(anchor?: HTMLElement | null) {
  if (pop()) closeAppearance();
  else openAppearance(anchor);
}

/** Put the popover beside the anchor: under it in the toolbar, to its right when it is a sidebar gear. */
function placePop(el: HTMLElement, a: HTMLElement) {
  const r = a.getBoundingClientRect(), pw = 300, h = el.offsetHeight;
  let left: number, top: number;
  if (a.closest("aside")) {
    left = r.right + 10;
    top = Math.max(8, Math.min(r.top - 10, window.innerHeight - h - 8));
  } else {
    left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    top = Math.min(r.bottom + 6, window.innerHeight - h - 8);
  }
  el.style.left = left + "px";
  el.style.top = top + "px";
}

/** Mount once (in App). Renders the popover; closes it on an outside pointerdown (Escape is handled in hotkeys.ts). */
export function AppearancePopover() {
  const onDown = (e: PointerEvent) => {
    if (pop() && !(e.target as Element).closest(".pop, #themeBtn, .gear")) closeAppearance();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  let fileEl: HTMLInputElement | undefined;

  return (
    <Show when={pop()} keyed>
      {(s) => (
        <Show when={projectById(s.projectId)} keyed>
          {(p) => {
            const onFile = (e: Event) => {
              const input = e.currentTarget as HTMLInputElement;
              const f = input.files?.[0];
              input.value = "";
              if (!f) return;
              const r = new FileReader();
              r.onload = async () => {
                const dataUrl = String(r.result);
                try {
                  await invoke("bg_save", { projectId: p.id, dataUrl });
                } catch (err) {
                  flash(`couldn't save image: ${err}`);
                  return;
                }
                await setBgImage(p.id, f);
                setAppearance(p.id, { bg: "image", dim: p.dim || 30 });
              };
              r.readAsDataURL(f);
            };

            return (
              <div class="pop" role="dialog" aria-label="Project appearance" ref={(el) => requestAnimationFrame(() => placePop(el, s.anchor))}>
                <div class="ttl">{p.name} <span>appearance</span></div>
                <h4>Accent</h4>
                <div class="swatches">
                  <For each={ACCENTS}>
                    {(a) => (
                      <button
                        type="button"
                        style={{ background: a }}
                        aria-label={`Accent ${a}`}
                        aria-pressed={p.accent === a}
                        onClick={() => setAppearance(p.id, { accent: a })}
                      />
                    )}
                  </For>
                  <label title="Custom colour">
                    +
                    <input type="color" value={p.accent} onInput={(e) => setAppearance(p.id, { accent: e.currentTarget.value })} />
                  </label>
                </div>
                <h4>Background</h4>
                <div class="bgs">
                  <For each={Object.entries(BACKGROUNDS)}>
                    {([key, b]) => (
                      <button
                        type="button"
                        style={{ background: b.css(p.accent) }}
                        aria-pressed={p.bg === key}
                        onClick={() => setAppearance(p.id, { bg: key })}
                      >
                        {b.name}
                      </button>
                    )}
                  </For>
                  <Show when={bgImages[p.id]} keyed>
                    {(url) => (
                      <button
                        type="button"
                        style={{ background: `center / cover no-repeat url("${url}")` }}
                        aria-pressed={p.bg === "image"}
                        onClick={() => setAppearance(p.id, { bg: "image" })}
                      >
                        Your image
                      </button>
                    )}
                  </Show>
                  <label class="upload" role="button" tabindex="0" onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fileEl?.click())}>
                    Upload image…
                    <input ref={fileEl} type="file" accept="image/*" hidden onChange={onFile} />
                  </label>
                </div>
                <div class="row">
                  Dim
                  <input type="range" min="0" max="85" step="5" value={String(p.dim)} onInput={(e) => setAppearance(p.id, { dim: +e.currentTarget.value })} />
                  <span class="val">{p.dim}%</span>
                </div>
              </div>
            );
          }}
        </Show>
      )}
    </Show>
  );
}
