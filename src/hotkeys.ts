// Window hotkeys. Every binding starts with Alt and is matched on e.code, so plain keys,
// Ctrl chords and terminal input keep reaching xterm. Listens in the capture phase so
// handled keys never reach the terminal.

import {
  GAPS, Layout, Project, Tab, activeProject, addTab, app, focusedTab, goSpace, isTerminal, promote, sendTo, setApp, setGap,
  setLayout, setRatio, space, toggleMono, visibleTabs,
} from "./state";
import { focusDir, requestClose, swapDir } from "./Canvas";
import { appearanceOpen, closeAppearance, toggleAppearance } from "./Appearance";
import { helpOpen, setHelpOpen } from "./Help";
import { closeOpenProject, openProjectDialog, openProjectOpen } from "./OpenProject";
import { toggleSidebar } from "./Sidebar";
import { closeTabMenu, tabMenuOpen } from "./tabs";
import { closeFavEdit, favEditOpen } from "./favs";
import { openIssuePanel } from "./issues";
import { openFilesPanel } from "./files";
import { flash } from "./ui";

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
    if (e.shiftKey) {
      if (!f) flash("no window to send");
      else if (f.space === i) flash(`already on workspace ${i + 1}`);
      else {
        sendTo(p.id, f.id, i);
        flash(`${f.kind} → workspace ${i + 1}`);
      }
    } else {
      goSpace(p.id, i);
      flash(`workspace ${i + 1}`);
    }
    return true;
  }

  switch (e.code) {
    case "Enter":
    case "NumpadEnter": {
      const kind = f && isTerminal(f) ? f.kind : "shell";
      addTab(p.id, kind);
      flash(`new ${kind}`);
      return true;
    }
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
    case "KeyQ":
      if (!f) return false;
      requestClose(p.id, f.id);
      return true;
    case "KeyF":
      if (!f) return false;
      toggleMono(p.id, f.id);
      flash(space(p).mono ? "maximize" : "restore");
      return true;
    case "KeyM":
      if (!f) return false;
      if (space(p).layout !== "master") flash("promote works in Main + stack");
      else {
        promote(p.id, f.id);
        flash(`${f.kind} is main`);
      }
      return true;
    case "KeyG": {
      const order: Layout[] = ["master", "grid", "mono"];
      const next = order[(order.indexOf(space(p).layout) + 1) % order.length];
      setLayout(p.id, next);
      flash(next === "master" ? "main + stack" : next);
      return true;
    }
    case "Comma":
    case "Period": {
      const i = GAPS.indexOf(app.gap) + (e.code === "Period" ? 1 : -1);
      const gap = GAPS[Math.min(GAPS.length - 1, Math.max(0, i))];
      setGap(gap);
      flash(`gap ${gap}px`);
      return true;
    }
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
    case "BracketRight": {
      const ids = app.projects.map((x) => x.id);
      const n = ids.length, i = ids.indexOf(p.id);
      setApp("activeProject", ids[(i + (e.code === "BracketRight" ? 1 : n - 1)) % n]);
      return true;
    }
    default:
      return false;
  }
}

function onKey(e: KeyboardEvent) {
  // Escape closes the overlays first; it is never bound on its own.
  if (e.code === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (helpOpen()) setHelpOpen(false);
    else if (openProjectOpen()) closeOpenProject();
    else if (appearanceOpen()) closeAppearance();
    else if (tabMenuOpen()) closeTabMenu();
    else if (favEditOpen()) closeFavEdit();
    else return;
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (!e.altKey) return;
  // Alt+O works with no project yet: it is how the first one is opened.
  if (e.code === "KeyO" && !e.ctrlKey && !e.shiftKey) {
    if (openProjectOpen()) closeOpenProject();
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
