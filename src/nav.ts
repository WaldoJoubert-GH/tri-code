// App-level navigation: which Settings page is open. Here rather than in Settings.tsx, so the
// windows and dialogs that open a Settings page don't import the dialog (which imports their pages).

import { createSignal } from "solid-js";
import { sandboxPreview } from "./preview";

export type SettingsPage = "appearance" | "windows" | "agents" | "environments" | "files" | "languages" | "git" | "sandbox" | "signals" | "browser" | "remote" | "cli" | "hotkeys" | "backup" | "preview" | "news";

/** Pages that belong to a preview feature: listed only while it is on. */
export const pageShown = (p: SettingsPage) => p !== "sandbox" || sandboxPreview();

/** The open Settings page; null while Settings is closed. */
export const [settingsPage, setSettingsPage] = createSignal<SettingsPage | null>(null);
let lastPage: SettingsPage = "windows";

export const settingsOpen = () => settingsPage() !== null;
export const hotkeysOpen = () => settingsPage() === "hotkeys";

export function closeSettings() {
  if (settingsPage()) lastPage = settingsPage()!;
  setSettingsPage(null);
}

/** Open on `page`, or the page used last (Windows when that page is hidden now). */
export function openSettings(p?: SettingsPage) {
  const want = p ?? lastPage;
  setSettingsPage(pageShown(want) ? want : "windows");
}

/** The sidebar button and the palette: open on the last page, or close. */
export function toggleSettings() {
  if (settingsOpen()) closeSettings();
  else openSettings();
}

/** The ? button and the "help" hotkey: open on Hotkeys, or close it. */
export function toggleHotkeys() {
  if (hotkeysOpen()) closeSettings();
  else openSettings("hotkeys");
}
