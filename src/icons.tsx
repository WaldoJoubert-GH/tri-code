// Project icons: a logo file found in the project (picked automatically or by hand), an
// uploaded image, a glyph, or the name's first letter. Image icons are data URLs kept by
// icon_save outside state.json, like background images.

import { invoke } from "@tauri-apps/api/core";
import { JSX, Match, Switch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Project, app, projectById, setIcon } from "./state";
import { flash } from "./ui";

/** A logo file in a project folder, as scan_logos returns it. */
export type Logo = { file: string; data_url: string };

/** Glyphs offered by the Appearance panel, after the letter. */
export const GLYPHS = [
  "◆", "●", "▲", "■", "★", "✦", "⬢", "◐", "⚡", "⚙", "⌘", "λ", "π", "∑", "♪", "☁",
  "☀", "☾", "✿", "♦", "♣", "⚑", "✎", "⌂", "∞", "Ω", "#", "@", "&", "§", "¶", "†",
];

/** Icon images by project id, as data URLs (small: logos are capped at 256 KB). */
const [iconImages, setIconImages] = createStore<Record<string, string>>({});
export { iconImages };

export const letterOf = (p: Project) => (p.name.trim()[0] ?? "?").toUpperCase();

export function scanLogos(p: Project): Promise<Logo[]> {
  return invoke<Logo[]>("scan_logos", { host: p.host, path: p.path });
}

async function storeImage(projectId: string, dataUrl: string) {
  await invoke("icon_save", { projectId, dataUrl });
  setIconImages(projectId, dataUrl);
}

/** Use a logo from the project. `auto` keeps it marked as tri-code's own choice. */
export async function useLogo(projectId: string, logo: Logo, auto = false) {
  try {
    await storeImage(projectId, logo.data_url);
    setIcon(projectId, { kind: "image", file: logo.file, ...(auto ? { auto: true } : {}) });
  } catch (e) {
    flash(`couldn't save icon: ${e}`);
  }
}

const readDataUrl = (file: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });

/** Downscale a raster image to fit 128px; SVGs and small files are kept as they are. */
async function shrink(file: File): Promise<string> {
  const max = 128;
  if (file.type === "image/svg+xml" || file.size < 32 * 1024) return readDataUrl(file);
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  } catch {
    return readDataUrl(file);
  }
}

/** Upload an image file as the icon. */
export async function uploadIcon(projectId: string, file: File) {
  try {
    await storeImage(projectId, await shrink(file));
    setIcon(projectId, { kind: "image" });
  } catch (e) {
    flash(`couldn't save icon: ${e}`);
  }
}

/**
 * Back to the automatic icon: the first logo the scan finds, else the letter. `logos`
 * skips the scan when the caller already has it. A failed scan (host down) leaves the
 * icon as it is, so it is tried again on the next start.
 */
export async function autoIcon(projectId: string, logos?: Logo[]) {
  const p = projectById(projectId);
  if (!p) return;
  try {
    logos ??= await scanLogos(p);
  } catch (e) {
    console.warn(`scan_logos ${p.host}:${p.path} failed:`, e);
    return;
  }
  if (logos[0]) return useLogo(projectId, logos[0], true);
  setIcon(projectId, { kind: "letter", auto: true });
}

/** Startup: load stored icon images, and pick an icon for projects that have none yet. */
export function loadIcons() {
  for (const p of app.projects) {
    if (p.icon === undefined) {
      autoIcon(p.id);
    } else if (p.icon.kind === "image") {
      invoke<string | null>("icon_load", { projectId: p.id })
        .then((url) => url && setIconImages(p.id, url))
        .catch((e) => console.error("icon_load failed:", e));
    }
  }
}

/** Drop a removed project's icon image. */
export function forgetIcon(projectId: string) {
  setIconImages(produce((s) => { delete s[projectId]; }));
  invoke("icon_delete", { projectId }).catch((e) => console.error("icon_delete failed:", e));
}

/** The icon's content: an <img>, a glyph or the letter. The caller draws the tile. */
export function IconFace(props: { project: Project }): JSX.Element {
  const image = () => props.project.icon?.kind === "image" && iconImages[props.project.id];
  const glyph = () => {
    const i = props.project.icon;
    return i?.kind === "glyph" ? i.glyph : undefined;
  };
  return (
    <Switch fallback={<b>{letterOf(props.project)}</b>}>
      <Match when={image()}>{(src) => <img src={src()} alt="" draggable={false} />}</Match>
      <Match when={glyph()}>{(g) => <i>{g()}</i>}</Match>
    </Switch>
  );
}
