// Auto-update: check GitHub Releases, download in the background, then offer a
// restart from the status bar. Restarting ends local terminal sessions, so it is
// never done without the user's click.

import { createSignal } from "solid-js";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { flash } from "./ui";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** The downloaded update waiting for a restart, if any. */
const [ready, setReady] = createSignal<Update | null>(null);
export { ready as updateReady };

let busy = false;

async function checkOnce() {
  if (busy || ready()) return;
  busy = true;
  try {
    const update = await check();
    if (!update) return;
    await update.download();
    setReady(update);
  } catch (e) {
    console.error("update check failed:", e);
  } finally {
    busy = false;
  }
}

/** Check now and then periodically. Dev builds don't update themselves. */
export function startUpdateChecks() {
  if (import.meta.env.DEV) return;
  checkOnce();
  window.setInterval(checkOnce, CHECK_EVERY_MS);
}

/** Install the downloaded update and restart into it. */
export async function installUpdate() {
  const update = ready();
  if (!update) return;
  try {
    await update.install(); // Windows: the installer quits the app itself
    await relaunch();
  } catch (e) {
    console.error("update install failed:", e);
    flash(`Update failed: ${e}`);
  }
}
