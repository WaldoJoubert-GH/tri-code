// App-level navigation: which Settings page is open, whether the New window menu is, and running a
// Keymap action. Here rather than in Settings.tsx, tabs.tsx and hotkeys.ts, so the modules that open a
// Settings page, the menu or a hotkey (the Tour) don't import the app files that draw or bind them.

import { createSignal } from "solid-js";
import { sandboxPreview } from "./preview";
import { hintChord } from "./keys/hints";

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

/** The New window menu a `+` click opened (tabs.tsx draws it): its project and its button. */
export type TabMenuAt = { projectId: string; anchor: HTMLElement };
const [tabMenu, setTabMenu] = createSignal<TabMenuAt | null>(null);
export { tabMenu };

export const tabMenuOpen = () => tabMenu() !== null;

export function closeTabMenu() {
  setTabMenu(null);
  hintChord(); // a pick from the menu the hold opened closes it too
}

/** Open the New window menu under its `+` button, or close it if it is already open. */
export function toggleTabMenu(anchor: HTMLElement, projectId: string) {
  if (tabMenu()) closeTabMenu();
  else setTabMenu({ projectId, anchor });
}

let hotkeyRunner: (id: string) => boolean = () => false;

/** hotkeys.ts hands over how it runs a Keymap action, at load. */
export function setHotkeyRunner(run: (id: string) => boolean) {
  hotkeyRunner = run;
}

/** Run a Keymap action as its key would, for the active project: the tour's keys can be clicked. */
export const runHotkey = (id: string): boolean => hotkeyRunner(id);
