// Screenshots from a browser page (pick.js, browser/shot.rs): its description names each image
// as ⟦shot N⟧ until the image is saved where the agent can read it.

/** `text` with each ⟦shot N⟧ replaced by image N's path (1-based), quoted when it has a space.
 *  An image with no path is named by `missing`. */
export function fillShots(text: string, paths: (string | undefined)[], missing = "(screenshot not saved)"): string {
  return text.replace(/⟦shot (\d+)⟧/g, (_, n: string) => {
    const p = paths[Number(n) - 1];
    if (!p) return missing;
    return p.includes(" ") ? `"${p}"` : p;
  });
}

const PREF_KEY = "tricode.pickShot";

/** The Select element Screenshot switch, as last left in project `id`. */
export function shotPref(id: string): boolean {
  try {
    return !!JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}")[id];
  } catch {
    return false;
  }
}

export function setShotPref(id: string, on: boolean): void {
  try {
    const all = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    if (on) all[id] = true;
    else delete all[id];
    localStorage.setItem(PREF_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the switch starts off next time.
  }
}
