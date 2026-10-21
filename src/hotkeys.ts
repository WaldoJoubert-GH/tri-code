// Window hotkeys. Every binding is a Hotkey Modifier chord (Alt unless Settings makes it Cmd, see
// modkey.ts) from the Keymap (keymap.ts), matched on e.code, so plain keys, Ctrl chords and
// terminal input keep reaching xterm. Listens in the capture phase so handled keys never reach
// the terminal.

import { Project, Tab, activeProject, addTab, canvasTabs, focusedTab, setRatio, space } from "./state";
import { focusDir, requestClose, swapDir } from "./Canvas";
import { appearanceOpen, closeAppearance, toggleAppearance } from "./Appearance";
import { closeSettings, settingsOpen, toggleHotkeys } from "./Settings";
import { aboutOpen, setAboutOpen } from "./About";
import { closeOpenProject, openProjectDialog, openProjectOpen } from "./OpenProject";
import { toggleSidebar } from "./Sidebar";
import { closeNewWorktree, newWorktreeOpen, openNewWorktree } from "./worktrees";
import { closeTabMenu, tabMenuOpen } from "./tabs";
import { closeFavEdit, favEditOpen } from "./favs";
import { openIssuePanel } from "./issues";
import { ask, cancelAsk, openFilesPanel } from "./files";
import { closeGoToFile, goToFileOpen, toggleGoToFile } from "./GoToFile";
import { openGitPanel } from "./git";
import { agentForKey, launchAgent, newTerminalLike, openAgentsPanel, recording } from "./agents";
import { closeIconPicker, iconPickerOpen } from "./lucide";
import { closePalette, paletteOpen, togglePalette } from "./Palette";
import { cycleLayout, makeMain, maximize, minimise, restoreLast, sendWindow, stepGap, stepProject, workspace } from "./commands";
import { nextSignal } from "./signals";
import { closeSignals, signalsOpen } from "./SignalSettings";
import { flash } from "./ui";
import { hasSelection } from "./terms";
import { actionFor } from "./keymap";

const DIRS: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** With Cmd as the modifier, Cmd+C and Cmd+X copy and cut while text is selected. */
function textChord(e: KeyboardEvent, f: Tab | undefined): boolean {
  if (!e.metaKey || e.shiftKey || e.ctrlKey || (e.code !== "KeyC" && e.code !== "KeyX")) return false;
  const el = document.activeElement;
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.selectionStart !== el.selectionEnd : false;
  return field || !!window.getSelection()?.toString() || (!!f && hasSelection(f.id));
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
      newTerminalLike(p, f);
      return true;
    case "browser":
      addTab(p.id, "browser");
      flash("new browser");
      return true;
    case "issues":
      openIssuePanel(p);
      return true;
    case "files":
      openFilesPanel(p);
      return true;
    case "go-to-file":
      toggleGoToFile();
      return true;
    case "git":
      openGitPanel(p);
      return true;
    case "agents":
      openAgentsPanel(p);
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
    case "new-worktree":
      if (newWorktreeOpen()) closeNewWorktree();
      else openNewWorktree(p);
      return true;
    case "project-prev":
    case "project-next":
      stepProject(p, id === "project-next" ? 1 : -1);
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
  // Escape closes the overlays first; it is never bound on its own.
  if (e.code === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (iconPickerOpen()) closeIconPicker();
    else if (paletteOpen()) closePalette();
    else if (aboutOpen()) setAboutOpen(false);
    else if (openProjectOpen()) closeOpenProject();
    else if (newWorktreeOpen()) closeNewWorktree();
    else if (appearanceOpen()) closeAppearance();
    else if (settingsOpen()) closeSettings();
    else if (ask()) cancelAsk();
    else if (signalsOpen()) closeSignals();
    else if (tabMenuOpen()) closeTabMenu();
    else if (favEditOpen()) closeFavEdit();
    else if (goToFileOpen()) closeGoToFile();
    else return;
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  const p = activeProject();
  const f = p && focusedTab(p);
  if (textChord(e, f)) return;
  const id = actionFor(e);
  let done = false;
  if (id) done = runAnywhere(id) || (!!p && run(id, p, f));
  else if (p) {
    const a = agentForKey(e);
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

let installed = false;

/** Register the window keydown listener once (called from App's onMount). */
export function installHotkeys() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKey, { capture: true });
}
