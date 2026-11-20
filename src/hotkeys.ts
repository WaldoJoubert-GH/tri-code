// Window hotkeys. Every binding is a Hotkey Modifier chord (Alt unless Settings makes it Cmd, see
// modkey.ts) from the Keymap (keymap.ts), matched on e.code, so plain keys, Ctrl chords and
// terminal input keep reaching xterm. Listens in the capture phase so handled keys never reach
// the terminal.

import { listen } from "@tauri-apps/api/event";
import { Project, Tab, activeProject, addTab, canvasTabs, focusedTab, setRatio, space } from "./state";
import { focusDir, requestClose, swapDir } from "./Canvas";
import { appearanceOpen, closeAppearance, toggleAppearance } from "./Appearance";
import { closeSettings, settingsOpen, toggleHotkeys } from "./Settings";
import { aboutOpen, setAboutOpen } from "./About";
import { closeOpenProject, openProjectDialog, openProjectOpen } from "./OpenProject";
import { closeLinkDialog, linkDialogOpen } from "./LinkFolder";
import { closeEnvDialog, envDialogOpen } from "./EnvDialog";
import { closeWelcome, welcomeOpen } from "./Welcome";
import { toggleSidebar } from "./Sidebar";
import { closeNewWorktree, newWorktreeOpen, openNewWorktree } from "./worktrees";
import { closeTabMenu, tabMenuOpen } from "./tabs";
import { closeCtxMenu, ctxMenuOpen } from "./ctxmenu";
import { closeFavEdit, favEditOpen } from "./favs";
import { closeTunnelPop, tunnelPopOpen } from "./tunnelui";
import { closeProfileMenu, profileMenuOpen } from "./profiles";
import { closeDebugMenu, debugMenuOpen } from "./debugmenu";
import { closeDownloadMenu, downloadMenuOpen } from "./downloads";
import { openIssuePanel } from "./issues";
import { openEditor } from "./files";
import { openDockerPanel } from "./docker";
import { openMonitorPanel } from "./monitor";
import { openGitPanel } from "./git";
import { openDbWindow } from "./db";
import { diffKeys } from "./DiffView";
import { agentForKey, launchAgent, newShell, openAgentsPanel, recording } from "./agents";
import { closeIconPicker, iconPickerOpen } from "./lucide";
import { closePalette, paletteOpen, togglePalette } from "./Palette";
import { cycleLayout, makeMain, maximize, minimise, restoreLast, sendWindow, stepGap, stepProject, stepWorkspace, workspace } from "./commands";
import { nextSignal } from "./signals";
import { closeSignals, signalsOpen } from "./SignalSettings";
import { closeFeedback, feedbackOpen } from "./Feedback";
import { closeLeftovers, leftoversOpen } from "./leftovers";
import { closeMediaPop, mediaPlayPause, mediaPopOpen, mediaSkip } from "./media";
import { flash } from "./ui";
import { hasSelection } from "./terms";
import { actionFor, editorKey } from "./keymap";
import { hintChord, hintDown, hintsShown, hintUp, isHintModifier } from "./hints";
import { modDown } from "./modkey";

const DIRS: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** With Cmd as the modifier, Cmd+C and Cmd+X copy and cut while text is selected. */
function textChord(e: KeyboardEvent, f: Tab | undefined): boolean {
  if (!e.metaKey || e.shiftKey || e.ctrlKey || (e.code !== "KeyC" && e.code !== "KeyX")) return false;
  const el = document.activeElement;
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.selectionStart !== el.selectionEnd : false;
  return field || !!window.getSelection()?.toString() || (!!f && hasSelection(f.id));
}

/** A text field (not a terminal's), popover or dialog keeps Cmd+Enter: it sends, runs or commits.
 *  Ctrl+Enter never reaches the Keymap in Cmd mode, so Cmd must not be stolen for New shell either. */
function fieldEnter(e: KeyboardEvent): boolean {
  if (!e.metaKey || (e.code !== "Enter" && e.code !== "NumpadEnter")) return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el || el.closest(".xterm")) return false;
  return !!el.closest(".pop, [role=dialog]") || el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["button", "checkbox", "radio"].includes(el.type));
}

/** Run one Keymap action for the active project. Returns false to let the key through. */
function run(id: string, p: Project, f: Tab | undefined): boolean {
  const [verb, arg] = id.split("-");
  const d = DIRS[arg];
  if (verb === "focus" && d) {
    if (!focusDir(p, d[0], d[1])) flash("no window that way");
    return true;
  }
  if (verb === "swap" && d) {
    if (!swapDir(p, d[0], d[1])) flash("nothing to swap with that way");
    return true;
  }
  if (verb === "split" && d) {
    if (space(p).layout !== "master" || canvasTabs(p).length < 2) {
      flash("only Main + stack has a resizable split");
    } else {
      const ratio = Math.min(0.8, Math.max(0.2, space(p).ratio + d[0] * 0.05));
      setRatio(p.id, ratio);
      flash(`main ${Math.round(ratio * 100)}%`);
    }
    return true;
  }
  if (verb === "ws") {
    workspace(p, Number(arg) - 1);
    return true;
  }
  if (verb === "send") {
    if (!f) flash("no window to send");
    else sendWindow(p, f, Number(arg) - 1);
    return true;
  }

  switch (id) {
    case "term-like":
      newShell(p);
      return true;
    case "browser":
      addTab(p.id, "browser");
      flash("new browser");
      return true;
    case "issues":
      openIssuePanel(p);
      return true;
    case "files":
      openEditor(p);
      return true;
    case "git":
      openGitPanel(p);
      return true;
    case "db":
      openDbWindow(p);
      return true;
    case "docker":
      openDockerPanel(p);
      return true;
    case "monitor":
      openMonitorPanel(p);
      return true;
    case "agents":
      openAgentsPanel(p);
      return true;
    case "diff":
      if (!f || !diffKeys.get(f.id)?.()) flash(f?.kind === "editor" ? "no changes since HEAD" : "no diff here");
      return true;
    case "close":
      if (!f) return false;
      requestClose(p.id, f.id);
      return true;
    case "maximize":
      if (!f) return false;
      maximize(p, f);
      return true;
    case "minimise":
      if (!f) return false;
      minimise(p, f);
      return true;
    case "restore-last":
      restoreLast(p);
      return true;
    case "main":
      if (!f) return false;
      makeMain(p, f);
      return true;
    case "layout":
      cycleLayout(p);
      return true;
    case "gap-less":
    case "gap-more":
      stepGap(id === "gap-more" ? 1 : -1);
      return true;
    case "help":
      toggleHotkeys();
      return true;
    case "sidebar":
      toggleSidebar();
      return true;
    case "appearance":
      toggleAppearance();
      return true;
    case "next-signal":
      nextSignal();
      return true;
    case "media-play":
      mediaPlayPause();
      return true;
    case "media-next":
      mediaSkip("next");
      return true;
    case "media-prev":
      mediaSkip("prev");
      return true;
    case "new-worktree":
      if (newWorktreeOpen()) closeNewWorktree();
      else openNewWorktree(p);
      return true;
    case "project-prev":
    case "project-next":
      stepProject(p, id === "project-next" ? 1 : -1);
      return true;
    case "workspace-prev":
    case "workspace-next":
      stepWorkspace(p, id === "workspace-next" ? 1 : -1);
      return true;
  }
  return false;
}

/** Actions that work with no project yet: they are how the first one is opened. */
function runAnywhere(id: string): boolean {
  if (id === "palette") togglePalette();
  else if (id === "open-project") openProjectOpen() ? closeOpenProject() : openProjectDialog();
  else if (id === "help") toggleHotkeys();
  else return false;
  return true;
}

function onKey(e: KeyboardEvent) {
  // The agents window or Settings is recording a hotkey: the chord (and Escape) are its to take.
  if (recording()) return;
  // The modifier on its own is not a chord: the focused window keeps the key (a terminal wants
  // Alt), and the Hold Hints start their clock. Any other key means a chord, not a hint gesture.
  if (isHintModifier(e)) {
    hintDown();
    return;
  }
  hintChord(e.key === "Shift" || e.key === "Control");
  // A keyup the OS took from us (focus kept) would leave the hints up: the modifier is not down.
  if (hintsShown() && !modDown(e)) hintUp();
  // Escape closes the overlays first; it is never bound on its own.
  if (e.code === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (ctxMenuOpen()) closeCtxMenu();
    else if (iconPickerOpen()) closeIconPicker();
    else if (paletteOpen()) closePalette();
    else if (aboutOpen()) setAboutOpen(false);
    else if (envDialogOpen()) closeEnvDialog();
    else if (openProjectOpen()) closeOpenProject();
    else if (linkDialogOpen()) closeLinkDialog();
    else if (welcomeOpen()) closeWelcome();
    else if (newWorktreeOpen()) closeNewWorktree();
    else if (mediaPopOpen()) closeMediaPop();
    else if (appearanceOpen()) closeAppearance();
    else if (settingsOpen()) closeSettings();
    else if (signalsOpen()) closeSignals();
    else if (feedbackOpen()) closeFeedback();
    else if (leftoversOpen()) closeLeftovers();
    else if (tabMenuOpen()) closeTabMenu();
    else if (favEditOpen()) closeFavEdit();
    else if (tunnelPopOpen()) closeTunnelPop();
    else if (profileMenuOpen()) closeProfileMenu();
    else if (debugMenuOpen()) closeDebugMenu();
    else if (downloadMenuOpen()) closeDownloadMenu();
    else return;
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  const p = activeProject();
  const f = p && focusedTab(p);
  if (textChord(e, f) || fieldEnter(e)) return;
  const id = actionFor(e);
  // The focused editor's own actions (fold recursively and the rest) come before window hotkeys.
  let done = editorKey(e);
  if (!done && id) done = runAnywhere(id) || (!!p && run(id, p, f));
  else if (!done && p) {
    const a = agentForKey(e, p);
    if (a) {
      launchAgent(p, a);
      done = true;
    }
  }
  if (done) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/** Run a Keymap action as its key would, for the active project: the tour's keys can be clicked. */
export function runHotkey(id: string): boolean {
  const p = activeProject();
  return runAnywhere(id) || (!!p && run(id, p, focusedTab(p)));
}

let installed = false;

/** The modifier came up: whatever the hold drew goes away. */
function onKeyUp(e: KeyboardEvent) {
  if (isHintModifier(e)) hintUp();
}

/** When Alt+Space last arrived, by either road, so the other road's copy is dropped. */
const altSpaceAt = { real: 0, relayed: 0 };
const SAME_PRESS_MS = 250;
const isAltSpace = (e: KeyboardEvent) => e.code === "Space" && e.altKey && !e.metaKey;

/** WebView2 gives Alt+Space to Windows (the window menu), not the page; altspace.rs takes it back
 *  and emits `alt-space`. Replayed as a keydown, it reaches the hotkeys and the key recorders. */
function relayAltSpace(p: { shift: boolean; ctrl: boolean }) {
  if (Date.now() - altSpaceAt.real < SAME_PRESS_MS) return;
  altSpaceAt.relayed = Date.now();
  const init = { code: "Space", key: " ", altKey: true, shiftKey: p.shift, ctrlKey: p.ctrl, bubbles: true, cancelable: true };
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", init));
}

/** A real Alt+Space keydown right after the relayed one is the same press: drop it. */
function dedupeAltSpace(e: KeyboardEvent) {
  if (!e.isTrusted || !isAltSpace(e)) return;
  if (Date.now() - altSpaceAt.relayed < SAME_PRESS_MS) {
    e.preventDefault();
    e.stopImmediatePropagation();
  } else altSpaceAt.real = Date.now();
}

/** Register the window keydown listener once (called from App's onMount). */
export function installHotkeys() {
  if (installed) return;
  installed = true;
  // First, so a duplicate never reaches onKey or a key recorder.
  window.addEventListener("keydown", dedupeAltSpace, { capture: true });
  if ("__TAURI_INTERNALS__" in window) void listen<{ shift: boolean; ctrl: boolean }>("alt-space", (e) => relayAltSpace(e.payload));
  window.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("keyup", onKeyUp, { capture: true });
  // Alt+Tab and the rest take the keyup to another window; leaving the app must not leave hints up.
  window.addEventListener("blur", hintUp);
}
