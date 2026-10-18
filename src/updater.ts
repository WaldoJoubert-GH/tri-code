// Auto-update: check GitHub Releases, download in the background, then offer a
// restart from the status bar. Restarting ends local terminal sessions, so it is
// never done without the user's click. "Check for updates" runs the same check now.

import { createSignal } from "solid-js";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { flash } from "./ui";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** The downloaded update waiting for a restart, if any. */
const [ready, setReady] = createSignal<Update | null>(null);
export { ready as updateReady };

/** What the last check found, for the About dialog. */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; version: string }
  | { kind: "current"; at: Date }
  | { kind: "failed"; error: string };
const [status, setStatus] = createSignal<UpdateStatus>({ kind: "idle" });
export { status as updateStatus };

export const appVersion = __APP_VERSION__;

let busy = false;

async function checkOnce(): Promise<UpdateStatus | null> {
  if (busy || ready()) return null;
  busy = true;
  setStatus({ kind: "checking" });
  try {
    const update = await check();
    if (!update) return setStatus({ kind: "current", at: new Date() });
    setStatus({ kind: "downloading", version: update.version });
    await update.download();
    setReady(update);
    return setStatus({ kind: "idle" });
  } catch (e) {
    console.error("update check failed:", e);
    return setStatus({ kind: "failed", error: String(e) });
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

/** Check now on the user's request, and say what came of it in the status line. */
export async function checkForUpdates() {
  if (import.meta.env.DEV) return flash("Dev builds don't update themselves");
  const u = ready();
  if (u) return flash(`${u.version} is ready: restart to update`);
  if (busy) return flash("Already checking for updates");
  flash("Checking for updates…");
  const s = await checkOnce();
  if (s?.kind === "current") flash(`tri-code ${appVersion} is up to date`);
  else if (s?.kind === "failed") flash(`Update check failed: ${s.error}`);
  else if (ready()) flash(`${ready()!.version} downloaded: restart to update`);
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
