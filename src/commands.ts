// Commands: everything the Command Palette (Alt+X) can run, built fresh from the app's state
// each time it opens. The window actions that also have a hotkey live here, so the palette and
// hotkeys.ts run the same code and flash the same message.

import {
  GAPS, Layout, Project, SPACES, Tab, activeProject, addTab, agentOf, app, focusTab, focusedTab, goSpace, isRemote, live,
  promote, sendTo, setApp, setGap, setLayout, space, tabName, toggleMono,
} from "./state";
import { requestClose } from "./Canvas";
import { toggleAppearance } from "./Appearance";
import { setHelpOpen } from "./Help";
import { openProjectDialog } from "./OpenProject";
import { toggleSidebar } from "./Sidebar";
import { openIssuePanel } from "./issues";
import { openFilesPanel } from "./files";
import { openGoToFile } from "./GoToFile";
import { openGitPanel } from "./git";
import { hotkeyKeys, hotkeyProblem, launchAgent, newTerminalLike, openAgentsPanel } from "./agents";
import { installUpdate, updateReady } from "./updater";
import { flash } from "./ui";

export type Command = {
  /** Stable across openings, so the palette can remember recent picks. */
  id: string;
  title: string;
  group: "New" | "Window" | "Layout" | "Project" | "Go to window" | "Switch project" | "App";
  /** The chord that also runs it, as <kbd> labels. */
  keys?: string[];
  /** Muted text after the title: a workspace, a process title, a host. */
  hint?: string;
  /** A lucide icon name, or a one-character glyph. */
  icon?: string;
  run: () => void;
};

export const LAYOUT_NAMES: Record<Layout, string> = { master: "main + stack", grid: "grid", mono: "mono" };

export function cycleLayout(p: Project) {
  const order: Layout[] = ["master", "grid", "mono"];
  const next = order[(order.indexOf(space(p).layout) + 1) % order.length];
  setLayout(p.id, next);
  flash(LAYOUT_NAMES[next]);
}

export function stepGap(dir: 1 | -1) {
  const i = GAPS.indexOf(app.gap) + dir;
  const gap = GAPS[Math.min(GAPS.length - 1, Math.max(0, i))];
  setGap(gap);
  flash(`gap ${gap}px`);
}

export function stepProject(p: Project, dir: 1 | -1) {
  const ids = app.projects.map((x) => x.id);
  const n = ids.length, i = ids.indexOf(p.id);
  setApp("activeProject", ids[(i + dir + n) % n]);
}

export function maximize(p: Project, f: Tab) {
  toggleMono(p.id, f.id);
  flash(space(p).mono ? "maximize" : "restore");
}

export function makeMain(p: Project, f: Tab) {
  if (space(p).layout !== "master") return flash("promote works in Main + stack");
  promote(p.id, f.id);
  flash(`${tabName(f)} is main`);
}

export function workspace(p: Project, i: number) {
  goSpace(p.id, i);
  flash(`workspace ${i + 1}`);
}

export function sendWindow(p: Project, f: Tab, i: number) {
  if (f.space === i) return flash(`already on workspace ${i + 1}`);
  sendTo(p.id, f.id, i);
  flash(`${tabName(f)} → workspace ${i + 1}`);
}

const PANEL_ICON = { browser: "globe", issues: "list-todo", files: "folder-tree", file: "file-text", git: "git-branch", agents: "settings-2" };

/** A window's icon: its agent's for a terminal, else its kind's. */
export const tabIcon = (t: Tab) => (t.kind === "term" ? agentOf(t)?.icon ?? "square-terminal" : PANEL_ICON[t.kind]);

/** What a window is called in the palette: a file window by its file. */
const windowTitle = (t: Tab) => (t.kind === "file" ? (t.path ?? "").split("/").pop() || "file" : tabName(t));

/** Every command that makes sense right now, in the order the empty palette lists them. */
export function commands(): Command[] {
  const p = activeProject();
  const out: Command[] = [];
  const add = (c: Command) => out.push(c);

  if (p) {
    const f = focusedTab(p);
    for (const a of app.agents) {
      add({
        id: `agent:${a.id}`, group: "New", title: `New ${a.name || "untitled"}`, icon: a.icon,
        hint: a.command.trim() || "login shell",
        keys: a.hotkey && !hotkeyProblem(a) ? hotkeyKeys(a.hotkey) : undefined,
        run: () => launchAgent(p, a),
      });
    }
    add({ id: "term-like", group: "New", title: "New terminal like this one", icon: "copy-plus", keys: ["Alt", "Enter"], run: () => newTerminalLike(p, f) });
    add({ id: "browser", group: "New", title: "New browser", icon: "globe", keys: ["Alt", "B"], run: () => { addTab(p.id, "browser"); flash("new browser"); } });
    add({ id: "issues", group: "New", title: "Issues", icon: "list-todo", keys: ["Alt", "I"], run: () => openIssuePanel(p) });
    add({ id: "files", group: "New", title: "Files", icon: "folder-tree", keys: ["Alt", "E"], run: () => void openFilesPanel(p) });
    add({ id: "git", group: "New", title: "Git", icon: "git-branch", keys: ["Alt", "C"], run: () => void openGitPanel(p) });
    add({ id: "agents", group: "New", title: "Agents", hint: "edit the + menu", icon: "settings-2", keys: ["Alt", ";"], run: () => void openAgentsPanel(p) });
    add({ id: "go-to-file", group: "New", title: "Go to file", icon: "search", keys: ["Alt", "T"], run: openGoToFile });

    if (f) {
      add({ id: "close", group: "Window", title: `Close ${windowTitle(f)}`, icon: "x", keys: ["Alt", "Q"], run: () => requestClose(p.id, f.id) });
      add({
        id: "maximize", group: "Window", title: space(p).mono === f.id ? `Restore ${windowTitle(f)}` : `Maximize ${windowTitle(f)}`,
        icon: space(p).mono === f.id ? "minimize-2" : "maximize-2", keys: ["Alt", "F"], run: () => maximize(p, f),
      });
      if (space(p).layout === "master") {
        add({ id: "main", group: "Window", title: `Make ${windowTitle(f)} main`, icon: "panel-left", keys: ["Alt", "M"], run: () => makeMain(p, f) });
      }
      for (let i = 0; i < SPACES; i++) {
        if (i === f.space) continue;
        add({ id: `send:${i}`, group: "Window", title: `Send ${windowTitle(f)} to workspace ${i + 1}`, icon: "arrow-right-to-line", keys: ["Alt", "Shift", String(i + 1)], run: () => sendWindow(p, f, i) });
      }
    }

    for (const l of ["master", "grid", "mono"] as const) {
      add({
        id: `layout:${l}`, group: "Layout", title: `Layout: ${LAYOUT_NAMES[l]}`, icon: l === "master" ? "layout-panel-left" : l === "grid" ? "layout-grid" : "rectangle-vertical",
        hint: space(p).layout === l ? "current" : undefined, keys: ["Alt", "G"], run: () => { setLayout(p.id, l); flash(LAYOUT_NAMES[l]); },
      });
    }
    add({ id: "gap-less", group: "Layout", title: "Less gap", hint: `${app.gap}px now`, icon: "fold-horizontal", keys: ["Alt", ","], run: () => stepGap(-1) });
    add({ id: "gap-more", group: "Layout", title: "More gap", hint: `${app.gap}px now`, icon: "unfold-horizontal", keys: ["Alt", "."], run: () => stepGap(1) });
    for (let i = 0; i < SPACES; i++) {
      if (i === p.ws) continue;
      const n = p.tabs.filter((t) => t.space === i).length;
      add({ id: `ws:${i}`, group: "Layout", title: `Workspace ${i + 1}`, hint: n ? `${n} window${n > 1 ? "s" : ""}` : "empty", icon: "square-stack", keys: ["Alt", String(i + 1)], run: () => workspace(p, i) });
    }

    add({ id: "appearance", group: "Project", title: "Appearance", hint: "name, icon, accent, background", icon: "palette", keys: ["Alt", "P"], run: () => toggleAppearance() });
  }

  add({ id: "open-project", group: "Project", title: "Open project", hint: "or add an environment", icon: "folder-open", keys: ["Alt", "O"], run: () => openProjectDialog() });
  if (p && app.projects.length > 1) {
    add({ id: "project-prev", group: "Project", title: "Previous project", icon: "chevron-up", keys: ["Alt", "["], run: () => stepProject(p, -1) });
    add({ id: "project-next", group: "Project", title: "Next project", icon: "chevron-down", keys: ["Alt", "]"], run: () => stepProject(p, 1) });
  }
  add({ id: "sidebar", group: "App", title: app.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar", icon: "panel-left-close", keys: ["Alt", "S"], run: toggleSidebar });
  add({ id: "help", group: "App", title: "Hotkeys", icon: "keyboard", keys: ["Alt", "/"], run: () => setHelpOpen(true) });
  const u = updateReady();
  if (u) add({ id: "update", group: "App", title: `Restart to update to ${u.version}`, icon: "refresh-cw", run: installUpdate });

  if (p) {
    for (const t of p.tabs) {
      if (t.id === space(p).focus && t.space === p.ws) continue;
      const detail = t.kind === "file" ? t.path : t.kind === "browser" ? t.url : live[t.id]?.title;
      add({
        id: `tab:${t.id}`, group: "Go to window", title: windowTitle(t), icon: tabIcon(t),
        hint: [t.space === p.ws ? "" : `workspace ${t.space + 1}`, detail].filter(Boolean).join(" · ") || undefined,
        run: () => focusTab(p.id, t.id),
      });
    }
  }
  for (const q of app.projects) {
    if (q.id === p?.id) continue;
    add({ id: `project:${q.id}`, group: "Switch project", title: q.name, hint: `${isRemote(q) ? `${q.host}:` : ""}${q.path}`, icon: "folder", run: () => setApp("activeProject", q.id) });
  }
  return out;
}
