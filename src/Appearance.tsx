// Per-project appearance: name, icon, accent colour, background preset or uploaded image, dim, the
// Backdrop Effect and Transparency;
// and on its Signals tab, the project's sounds and alerts for agent signals.
// The popover is anchored under the toolbar button, or beside a sidebar gear.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { CLEAR_MAX, type Clear, type Fx, type FxKind, fxOn, paintBackdrop } from "./backdrop";
import { createStore, produce } from "solid-js/store";
import { ACCENTS, GAP_MAX, Project, activeProject, app, projectById, renameProject, repoOf, setAppearance, setGap, setIcon } from "./state";
import { IconFace, Logo, PROJECT_ICONS, autoIcon, iconImages, letterOf, scanLogos, uploadIcon, useLogo } from "./icons";
import { Icon, toggleIconPicker } from "./lucide";
import { SignalsForm } from "./SignalSettings";
import { flash } from "./ui";
import { keyOf } from "./keymap";

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

/** Bumped when the theme changes, so a canvas backdrop draws again in the new colours. */
const [themeTick, setThemeTick] = createSignal(0);
new MutationObserver(() => setThemeTick((n) => n + 1)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setThemeTick((n) => n + 1));

/**
 * The project's backdrop (its repo's, for a Worktree), behind the canvas or the whole window (Transparency's
 * "Sidebar and bars too"). Plain CSS, or a canvas when the project has a Backdrop Effect: the effect needs pixels.
 */
export function Backdrop(props: { project?: Project }) {
  const withFx = () => (props.project && fxOn(props.project.fx) ? props.project : undefined);
  const css = () => {
    const p = props.project;
    return p ? { background: backgroundCss(p), "--dim": String(p.dim / 100) } : { background: "var(--canvas)", "--dim": "0" };
  };
  return (
    <Show when={withFx()} keyed fallback={<div class="bg" style={css()} />}>
      {(p) => <FxBackdrop project={p} />}
    </Show>
  );
}

function FxBackdrop(props: { project: Project }) {
  let el!: HTMLCanvasElement;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [image, setImage] = createSignal<HTMLImageElement>();

  createEffect(() => {
    const url = props.project.bg === "image" ? bgImages[props.project.id] : undefined;
    setImage(undefined);
    if (!url) return;
    let live = true;
    const im = new Image();
    im.onload = () => live && setImage(im);
    im.src = url;
    onCleanup(() => (live = false));
  });

  onMount(() => {
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  // One paint per frame however many settings change in it (a slider drag).
  let frame = 0;
  createEffect(() => {
    const p = props.project;
    themeTick();
    const job = { bg: p.bg, accent: p.accent, dim: p.dim, fx: { ...p.fx! }, image: image(), ...size() };
    cancelAnimationFrame(frame);
    if (!job.width || !job.height) return;
    frame = requestAnimationFrame(() => {
      const style = getComputedStyle(document.documentElement), token = (n: string) => style.getPropertyValue(n).trim();
      paintBackdrop(el, {
        ...job,
        scale: window.devicePixelRatio || 1,
        light: style.colorScheme !== "dark",
        tokens: { canvas: token("--canvas"), dusk: [token("--dusk-a"), token("--dusk-b"), token("--dusk-c"), token("--dusk-d")] },
      });
    });
  });
  onCleanup(() => cancelAnimationFrame(frame));

  return <canvas class="bg fx" ref={el} aria-hidden="true" />;
}

export type AppearanceSection = "look" | "signals";
type PopState = { projectId: string; anchor: HTMLElement; section: AppearanceSection };
const [pop, setPop] = createSignal<PopState | null>(null);

export const appearanceOpen = () => pop() !== null;

/** Open the popover for a project (default: the active one), anchored under `anchor` (default: the toolbar button). */
export function openAppearance(anchor?: HTMLElement | null, projectId?: string, section: AppearanceSection = "look") {
  // A Worktree's look and signals are its repo's, so its gear and Alt+P edit the repo project.
  const p = projectId ? projectById(projectId) : activeProject();
  const pid = p && repoOf(p).id;
  const a = anchor ?? document.getElementById("themeBtn");
  if (!pid || !a) return;
  setPop({ projectId: pid, anchor: a, section });
}

export function closeAppearance() {
  setPop(null);
}

export function toggleAppearance(anchor?: HTMLElement | null) {
  if (pop()) closeAppearance();
  else openAppearance(anchor);
}

/** Put the popover beside the anchor: under it in the toolbar, right of the sidebar when it is a sidebar gear. */
function placePop(el: HTMLElement, a: HTMLElement) {
  const r = a.getBoundingClientRect(), pw = 300, h = el.offsetHeight;
  const aside = a.closest("aside");
  let left: number, top: number;
  if (aside) {
    // the gear sits inside the sidebar, so measure from the sidebar's edge or the panel covers it
    left = Math.min(aside.getBoundingClientRect().right + 8, window.innerWidth - pw - 8);
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
    if (pop() && !(e.target as Element).closest(".pop, .iconpick, #themeBtn, .gear")) closeAppearance();
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
              <div
                class="pop"
                role="dialog"
                aria-label="Project appearance"
                ref={(el) => {
                  // place again whenever it changes size (logos arrive, the tab changes), so it stays on screen
                  const ro = new ResizeObserver(() => placePop(el, s.anchor));
                  ro.observe(el);
                  onCleanup(() => ro.disconnect());
                }}
              >
                <div class="ttl">
                  <input
                    class="name"
                    value={p.name}
                    title="Rename project"
                    aria-label="Project name"
                    spellcheck={false}
                    onChange={(e) => renameProject(p.id, e.currentTarget.value.trim() || p.path.split(/[\\/]/).filter(Boolean).pop() || p.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      else if (e.key === "Escape") (e.currentTarget.value = p.name), e.currentTarget.blur();
                    }}
                  />
                  <span>{s.section === "look" ? "appearance" : "signals"}</span>
                </div>
                <div class="seg wide" role="group" aria-label="Section">
                  <button type="button" aria-pressed={s.section === "look"} onClick={() => setPop({ ...s, section: "look" })}>Appearance</button>
                  <button type="button" aria-pressed={s.section === "signals"} onClick={() => setPop({ ...s, section: "signals" })}>Signals</button>
                </div>
                <Show when={s.section === "signals"}><SignalsForm project={p} /></Show>
                <Show when={s.section === "look"}>
                  <IconSection project={p} />
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
                    <span class="lb">Dim</span>
                    <input type="range" min="0" max="85" step="5" value={String(p.dim)} aria-label="Dim" onInput={(e) => setAppearance(p.id, { dim: +e.currentTarget.value })} />
                    <span class="val">{p.dim}%</span>
                  </div>
                  <BackdropSection project={p} />
                  <label class="row" title={`Between windows, in every project${keyOf("gap-less") || keyOf("gap-more") ? ` (${[keyOf("gap-less"), keyOf("gap-more")].filter(Boolean).join(" / ")})` : ""}`}>
                    Gap
                    <span class="px">
                      <input
                        type="number" min={0} max={GAP_MAX} value={app.gap}
                        onInput={(e) => e.currentTarget.value !== "" && setGap(+e.currentTarget.value)}
                        onBlur={(e) => (e.currentTarget.value = String(app.gap))}
                      />
                      px · all projects
                    </span>
                  </label>
                </Show>
              </div>
            );
          }}
        </Show>
      )}
    </Show>
  );
}

const FX_NAMES: Record<FxKind, string> = { dither: "Dither", halftone: "Halftone" };
/** What a newly picked effect starts at: Zeron's "medium". */
const FX_START = 75;

/** Effect (Zeron's dither or halftone over the background) and Transparency (the backdrop through windows). */
function BackdropSection(props: { project: Project }) {
  const p = () => props.project;
  const fx = (): Fx => p().fx ?? { kind: "dither", strength: 0 };
  const on = () => fxOn(p().fx);
  const setFx = (patch: Partial<Fx>) => setAppearance(p().id, { fx: { ...fx(), ...patch } });
  const clear = (): Clear => p().clear ?? { panels: 0, terms: 0 };
  const setClear = (patch: Partial<Clear>) => setAppearance(p().id, { clear: { ...clear(), ...patch } });
  const slider = (label: string, value: number, max: number, set: (v: number) => void) => (
    <div class="row">
      <span class="lb">{label}</span>
      <input type="range" min="0" max={String(max)} step="5" value={String(value)} aria-label={label} onInput={(e) => set(+e.currentTarget.value)} />
      <span class="val">{value}%</span>
    </div>
  );

  return (
    <>
      <h4>Effect</h4>
      <div class="seg wide" role="group" aria-label="Effect">
        <button type="button" aria-pressed={!on()} onClick={() => setFx({ strength: 0 })}>Off</button>
        <For each={Object.entries(FX_NAMES) as [FxKind, string][]}>
          {([kind, name]) => (
            <button type="button" aria-pressed={on() && fx().kind === kind} onClick={() => setFx({ kind, strength: on() ? fx().strength : FX_START })}>
              {name}
            </button>
          )}
        </For>
      </div>
      <Show when={on()}>
        {slider("Strength", fx().strength, 100, (v) => setFx({ strength: Math.max(5, v) }))}
        <div class="seg wide" role="group" aria-label="Effect colours">
          <button type="button" aria-pressed={fx().tone !== "accent"} onClick={() => setFx({ tone: undefined })}>Picture colours</button>
          <button type="button" aria-pressed={fx().tone === "accent"} onClick={() => setFx({ tone: "accent" })}>Accent only</button>
        </div>
      </Show>
      <h4>Transparency</h4>
      {slider("Panels", clear().panels, CLEAR_MAX, (v) => setClear({ panels: v }))}
      {slider("Terminals", clear().terms, CLEAR_MAX, (v) => setClear({ terms: v }))}
      <Show when={clear().panels > 0 || clear().terms > 0}>
        <label class="chk">
          <input type="checkbox" checked={!!clear().blur} onChange={(e) => setClear({ blur: e.currentTarget.checked || undefined })} />
          Blur what shows through
        </label>
        <label class="chk" title="At the panels' value">
          <input type="checkbox" checked={!!clear().chrome} disabled={clear().panels === 0} onChange={(e) => setClear({ chrome: e.currentTarget.checked || undefined })} />
          Sidebar and bars too
        </label>
        <div class="note">Browser windows stay solid.</div>
      </Show>
    </>
  );
}

/** Icon: the automatic pick, another logo found in the project, an upload, a lucide icon or the letter. */
function IconSection(props: { project: Project }) {
  const p = () => props.project;
  const [logos, setLogos] = createSignal<Logo[] | null>(null);
  const [scanError, setScanError] = createSignal("");
  const [tab, setTab] = createSignal<"project" | "icon">(
    ["lucide", "glyph"].includes(props.project.icon?.kind ?? "") || (props.project.icon?.kind === "letter" && !props.project.icon.auto) ? "icon" : "project",
  );
  let fileEl: HTMLInputElement | undefined;

  onMount(() => {
    scanLogos(p()).then(setLogos, (e) => (setLogos([]), setScanError(String(e))));
  });

  const icon = () => p().icon;
  const isAuto = () => icon() === undefined || (icon()?.kind !== "glyph" && icon()?.kind !== "lucide" && !!(icon() as { auto?: boolean }).auto);
  const summary = () => {
    const i = icon();
    if (!i) return { label: "Auto", sub: "looking for a logo…" };
    if (i.kind === "lucide") return { label: "Icon · override", sub: i.name };
    if (i.kind === "glyph") return { label: "Glyph · override", sub: i.glyph };
    if (i.kind === "letter") return i.auto ? { label: "Auto", sub: "no logo found, using the letter" } : { label: "Letter · override", sub: letterOf(p()) };
    if (i.auto) return { label: "Auto", sub: i.file ?? "" };
    return { label: i.file ? "Logo · override" : "Uploaded image · override", sub: i.file ?? "your image" };
  };
  const lucideName = () => {
    const i = icon();
    return i?.kind === "lucide" ? i.name : undefined;
  };
  const pickedLogo = (file: string) => icon()?.kind === "image" && (icon() as { file?: string }).file === file && !isAuto();
  const uploaded = () => icon()?.kind === "image" && !(icon() as { file?: string }).file;

  const onFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (f) uploadIcon(p().id, f);
  };

  return (
    <>
      <h4 class="with-action">
        Icon
        <Show when={!isAuto()}>
          <button type="button" title="Back to the logo found in the project" onClick={() => autoIcon(p().id, logos() ?? undefined)}>reset to auto</button>
        </Show>
      </h4>
      <div class="icon-now">
        <span class="tile" style={{ "--pa": p().accent }}><IconFace project={p()} /></span>
        <span class="what"><b>{summary().label}</b><code>{summary().sub}</code></span>
      </div>
      <div class="icon-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab() === "project"} onClick={() => setTab("project")}>
          From project{logos()?.length ? ` (${logos()!.length})` : ""}
        </button>
        <button type="button" role="tab" aria-selected={tab() === "icon"} onClick={() => setTab("icon")}>Icon</button>
      </div>
      <Show when={tab() === "project"}>
        <div class="logos">
          <button type="button" aria-pressed={isAuto()} onClick={() => autoIcon(p().id, logos() ?? undefined)}>
            <Show when={logos()?.[0]} fallback={<b>{letterOf(p())}</b>}>{(l) => <img src={l().data_url} alt="" />}</Show>
            <code>Auto{logos() && !logos()!.length ? " (letter)" : ""}</code>
            <span class="tag">default</span>
          </button>
          <For each={logos() ?? []}>
            {(l) => (
              <button type="button" aria-pressed={pickedLogo(l.file)} onClick={() => useLogo(p().id, l)}>
                <img src={l.data_url} alt="" />
                <code>{l.file}</code>
              </button>
            )}
          </For>
          <Show when={uploaded() && iconImages[p().id]}>
            {(src) => (
              <button type="button" aria-pressed="true">
                <img src={src()} alt="" />
                <code>your image</code>
              </button>
            )}
          </Show>
        </div>
        <Show when={logos() === null}><div class="note">Looking for logos…</div></Show>
        <Show when={logos()?.length === 0}><div class="note">{scanError() || `No logo files found in ${p().name}`}</div></Show>
        <label class="upload" role="button" tabindex="0" onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fileEl?.click())}>
          Upload image…
          <input ref={fileEl} type="file" accept="image/*" hidden onChange={onFile} />
        </label>
      </Show>
      <Show when={tab() === "icon"}>
        <div class="glyphs">
          <button
            type="button"
            class="letter"
            title="Letter"
            aria-pressed={icon()?.kind === "letter" && !isAuto()}
            onClick={() => setIcon(p().id, { kind: "letter" })}
          >
            {letterOf(p())}
          </button>
          <For each={PROJECT_ICONS}>
            {(n) => (
              <button
                type="button"
                title={n}
                aria-pressed={lucideName() === n}
                onClick={() => setIcon(p().id, { kind: "lucide", name: n })}
              >
                <Icon name={n} size={15} />
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="upload"
          onClick={(e) => toggleIconPicker(e.currentTarget, lucideName() ?? "", (name) => setIcon(p().id, { kind: "lucide", name }))}
        >
          Search all icons…
        </button>
      </Show>
    </>
  );
}
