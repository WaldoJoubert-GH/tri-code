// Window hotkeys. Every binding starts with Alt and is matched on e.code, so plain keys,
// Ctrl chords and terminal input keep reaching xterm. Listens in the capture phase so
// handled keys never reach the terminal.

import { Project, Tab, activeProject, addTab, focusedTab, setRatio, space, visibleTabs } from "./state";
import { focusDir, requestClose, swapDir } from "./Canvas";
import { appearanceOpen, closeAppearance, toggleAppearance } from "./Appearance";
import { helpOpen, setHelpOpen } from "./Help";
import { aboutOpen, setAboutOpen } from "./About";
import { closeOpenProject, openProjectDialog, openProjectOpen } from "./OpenProject";
import { toggleSidebar } from "./Sidebar";
import { closeTabMenu, tabMenuOpen } from "./tabs";
import { closeFavEdit, favEditOpen } from "./favs";
import { openIssuePanel } from "./issues";
import { openFilesPanel } from "./files";
import { closeGoToFile, goToFileOpen, toggleGoToFile } from "./GoToFile";
import { openGitPanel } from "./git";
import { agentForKey, launchAgent, newTerminalLike, openAgentsPanel, recording } from "./agents";
import { closeIconPicker, iconPickerOpen } from "./lucide";
import { closePalette, paletteOpen, togglePalette } from "./Palette";
import { cycleLayout, makeMain, maximize, sendWindow, stepGap, stepProject, workspace } from "./commands";
import { flash } from "./ui";

/**
 * Keys `run` binds, with what they do. They are taken with any Shift/Ctrl combination (the
 * switch below ignores those), so an agent can't be given one; keep in step with `run`.
 */
export const RESERVED: Record<string, string> = {
  KeyH: "focus left", KeyJ: "focus down", KeyK: "focus up", KeyL: "focus right",
  ArrowLeft: "focus left", ArrowRight: "focus right", ArrowUp: "focus up", ArrowDown: "focus down",
  Digit1: "workspace 1", Digit2: "workspace 2", Digit3: "workspace 3", Digit4: "workspace 4",
  Enter: "new terminal like this one", NumpadEnter: "new terminal like this one", KeyB: "new browser",
  KeyI: "issues", KeyE: "files", KeyT: "go to file", KeyC: "git", KeyQ: "close window", KeyF: "maximize", KeyM: "make main",
  KeyG: "switch layout", Comma: "less gap", Period: "more gap", Slash: "hotkey help", KeyS: "sidebar",
  KeyP: "appearance", BracketLeft: "previous project", BracketRight: "next project", KeyO: "open project",
  Semicolon: "agents", KeyX: "command palette",
};

const DIRS: Record<string, [number, number]> = {
  KeyH: [-1, 0], ArrowLeft: [-1, 0],
  KeyL: [1, 0], ArrowRight: [1, 0],
  KeyK: [0, -1], ArrowUp: [0, -1],
  KeyJ: [0, 1], ArrowDown: [0, 1],
};

/** Handle one Alt chord for the active project. Returns true if it was a bound key. */
function run(e: KeyboardEvent, p: Project, f: Tab | undefined): boolean {
  const d = DIRS[e.code];
  if (d) {
    if (e.ctrlKey) {
      if (d[0] === 0) {
        flash("stack windows share height equally");
      } else if (space(p).layout !== "master" || visibleTabs(p).length < 2) {
        flash("only Main + stack has a resizable split");
      } else {
        const ratio = Math.min(0.8, Math.max(0.2, space(p).ratio + d[0] * 0.05));
        setRatio(p.id, ratio);
        flash(`main ${Math.round(ratio * 100)}%`);
      }
    } else if (e.shiftKey) {
      if (!swapDir(p, d[0], d[1])) flash("nothing to swap with that way");
    } else if (!focusDir(p, d[0], d[1])) {
      flash("no window that way");
    }
    return true;
  }

  if (/^Digit[1-4]$/.test(e.code)) {
    const i = Number(e.code.slice(5)) - 1;
    if (!e.shiftKey) workspace(p, i);
    else if (!f) flash("no window to send");
    else sendWindow(p, f, i);
    return true;
  }

  switch (e.code) {
    case "Enter":
    case "NumpadEnter":
      newTerminalLike(p, f);
      return true;
    case "KeyB":
      addTab(p.id, "browser");
      flash("new browser");
      return true;
    case "KeyI":
      openIssuePanel(p);
      return true;
    case "KeyE":
      openFilesPanel(p);
      return true;
    case "KeyT":
      toggleGoToFile();
      return true;
    case "KeyC":
      openGitPanel(p);
      return true;
    case "Semicolon":
      openAgentsPanel(p);
      return true;
    case "KeyQ":
      if (!f) return false;
      requestClose(p.id, f.id);
      return true;
    case "KeyF":
      if (!f) return false;
      maximize(p, f);
      return true;
    case "KeyM":
      if (!f) return false;
      makeMain(p, f);
      return true;
    case "KeyG":
      cycleLayout(p);
      return true;
    case "Comma":
    case "Period":
      stepGap(e.code === "Period" ? 1 : -1);
      return true;
    case "Slash":
      setHelpOpen(!helpOpen());
      return true;
    case "KeyS":
      toggleSidebar();
      return true;
    case "KeyP":
      toggleAppearance();
      return true;
    case "BracketLeft":
    case "BracketRight":
      stepProject(p, e.code === "BracketRight" ? 1 : -1);
      return true;
    default: {
      const a = agentForKey(e);
      if (!a) return false;
      launchAgent(p, a);
      return true;
    }
  }
}

function onKey(e: KeyboardEvent) {
  // The agents window is recording a hotkey: the chord (and Escape) are its to take.
  if (recording()) return;
  // Escape closes the overlays first; it is never bound on its own.
  if (e.code === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (iconPickerOpen()) closeIconPicker();
    else if (paletteOpen()) closePalette();
    else if (helpOpen()) setHelpOpen(false);
    else if (aboutOpen()) setAboutOpen(false);
    else if (openProjectOpen()) closeOpenProject();
    else if (appearanceOpen()) closeAppearance();
    else if (tabMenuOpen()) closeTabMenu();
    else if (favEditOpen()) closeFavEdit();
    else if (goToFileOpen()) closeGoToFile();
    else return;
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (!e.altKey) return;
  // Alt+O and Alt+X work with no project yet: they are how the first one is opened.
  if ((e.code === "KeyO" || e.code === "KeyX") && !e.ctrlKey && !e.shiftKey) {
    if (e.code === "KeyX") togglePalette();
    else if (openProjectOpen()) closeOpenProject();
    else openProjectDialog();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const p = activeProject();
  if (!p) return;
  if (run(e, p, focusedTab(p))) {
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
