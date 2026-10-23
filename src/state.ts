import { createEffect, on } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import type { DiffMode } from "./diff";

export type TabKind = "term" | "browser" | "issues" | "editor" | "git" | "agents";

/** A Hotkey Modifier chord, matched on e.code like every window binding. The modifier is implied. */
export type Hotkey = { code: string; shift?: boolean; ctrl?: boolean };
/** A key of a Keymap action: a Hotkey, or with `bare` a plain Ctrl / Cmd (`meta`) chord, as the text keys are. */
export type Chord = Hotkey & { meta?: boolean; bare?: boolean };

/** An app the New Window Menu offers: a terminal app (claude, pi, a shell, lazygit, ...) or, with a
 *  `url`, a web app that opens a browser window there. Global, not per project. */
export type Agent = {
  id: string;
  name: string;
  /** Run in the project folder on the project's host; "" is the login shell. Unused by a web app. */
  command: string;
  /** Set for a web app: the address its browser window opens ("" until typed). */
  url?: string;
  /** Web apps only: "app" hides the address and favourites bars, like an installed web app. */
  bar?: "app";
  /** A lucide icon name, kebab-case. */
  icon: string;
  hotkey?: Hotkey;
};

/** What a new state.json starts with: the three terminals tri-code used to hard-code. */
const defaultAgents = (): Agent[] => [
  { id: "claude", name: "claude", command: "claude", icon: "asterisk" },
  { id: "pi", name: "pi", command: "pi", icon: "pi" },
  { id: "shell", name: "shell", command: "", icon: "square-terminal" },
];

/** A page of a browser window, shown as a tab in its title bar once there are two. Each page
 *  has its own native webview, so a page in the background keeps its state. */
export type Page = {
  id: string;
  /** The current address ("" for a blank page). */
  url: string;
  /** The page it was opened from, so links opened from one page line up after it in order. */
  opener?: string;
};

/** A window on the canvas. Terminals run a PTY; browsers are native child webviews;
 *  issues panels render the project's `.dev/`; an editor is the project's file tree
 *  with a tab per open file; git takes the branch from changes to a merged PR and
 *  agents edits the agent list. */
export type Tab = {
  id: string;
  kind: TabKind;
  /** Workspace index, 0..SPACES-1. */
  space: number;
  /** Browser tabs only: its pages in tab order, at least one. */
  pages?: Page[];
  /** Browser tabs only: the id of the page that is shown. */
  page?: string;
  /** Editor tabs only: the file shown, one of `files` (unset when none is open). */
  path?: string;
  /** Editor tabs only: the open files, in tab order. */
  files?: string[];
  /** Editor tabs only: the file in the preview tab, which the next file opened replaces until it is kept. */
  preview?: string;
  /** Editor tabs only: `false` hides the file tree. */
  tree?: false;
  /** Editor tabs only: a line a drill asked for, and whether to show its diff. `seq` makes a repeat a new drill. */
  at?: { line: number; mode?: "source" | "diff"; seq: number };
  /** `term` and browser tabs: the agent (or web app) it was opened from. The name and icon follow the agent. */
  agent?: string;
  /** `term` and browser tabs: the agent's name at launch, shown once the agent is deleted. */
  name?: string;
  /** `term` tabs only: the command it runs ("" = login shell). Kept from launch, so editing an agent only changes new windows. */
  cmd?: string;
  /** Minimised: when (ms), so Alt+Shift+N brings back the latest. Off the canvas but still in the Tab Strip. */
  min?: number;
  /** `term` tabs of the tour's sample project only: a scripted session played in place of a PTY (see demo.ts). */
  demo?: DemoKind;
};

/** The tour's scripted terminals: claude at work, pi waiting to ask, a dev server. */
export type DemoKind = "claude" | "pi" | "server";

/** The page a browser window shows. */
export const activePage = (t: Tab): Page | undefined => t.pages?.find((p) => p.id === t.page) ?? t.pages?.[0];

/** Terminals own a PTY; browsers and panels do not. */
export const isTerminal = (t: Tab) => t.kind === "term";

export const agentOf = (t: Tab) => (t.agent ? app.agents.find((a) => a.id === t.agent) : undefined);

const PANEL_ICON = { browser: "globe", issues: "list-todo", editor: "file-code", git: "git-branch", agents: "settings-2" };

/** A window's lucide icon: its agent's for a terminal or web app, else its kind's. */
export const tabIcon = (t: Tab) =>
  t.kind === "term" ? agentOf(t)?.icon ?? "square-terminal" : (t.agent && agentOf(t)?.icon) || PANEL_ICON[t.kind];

/** A web app: an agent that opens a browser window rather than a terminal. */
export const isWebApp = (a: Agent) => a.url !== undefined;

/** What a window is called in the tab strip, title bar and messages: its agent for terminals and
 *  web apps, else its kind. */
export const tabName = (t: Tab) =>
  t.kind === "term" ? agentOf(t)?.name || t.name || "terminal"
  : t.agent ? agentOf(t)?.name || t.name || t.kind
  : t.kind;

export type Layout = "master" | "grid" | "mono";

/** Per-workspace tiling state. */
export type Space = {
  layout: Layout;
  /** Width share of the main window in the master layout, 0.2..0.8. */
  ratio: number;
  focus?: string;
  /** Maximized tab, if any. */
  mono?: string;
};

/**
 * How a project is drawn in the sidebar. `auto` marks the one tri-code chose (the first logo
 * file found in the folder, else the letter); anything else is an override from the
 * Appearance panel. An `image` is stored by icon_save: a logo from the project (`file`,
 * relative to the project folder) or an upload (no `file`). Undefined = not scanned yet.
 */
export type ProjectIcon =
  | { kind: "image"; file?: string; auto?: boolean }
  | { kind: "lucide"; name: string }
  /** From before lucide icons: still drawn, no longer offered. */
  | { kind: "glyph"; glyph: string }
  | { kind: "letter"; auto?: boolean };

/** A folder opened before, offered as Recent in the Open project dialog. */
export type RecentFolder = { host: string; path: string };

/** A favourite page of a project's browser windows. Keyed by `url`. */
export type Fav = { url: string; name: string };

export type Project = {
  id: string;
  name: string;
  /** "local" or an ssh destination (alias from ~/.ssh/config, user@host, ...) */
  host: string;
  path: string;
  /** All windows of the project, in tiling order; each lives on one workspace. */
  tabs: Tab[];
  /** Active workspace index. */
  ws: number;
  spaces: Space[];
  /** Accent colour as #rrggbb. */
  accent: string;
  /** Background: a preset key (see BACKGROUNDS in Appearance) or "image" for an uploaded file. */
  bg: string;
  /** Dim over the background, 0..85 (percent). */
  dim: number;
  /** Favourite pages, in bar order; shared by every browser window of the project. */
  favs: Fav[];
  /** The git window's and the editor diff's orientation; split unless chosen otherwise. */
  diffMode?: DiffMode;
  icon?: ProjectIcon;
  /** Sounds and alerts for agent signals; a missing field follows the app-wide `notify`. */
  notify?: ProjectNotify;
  /** A Worktree only: the project of the repo it was added to. Its icon, background and
   *  signal settings are the repo's (see repoOf); its own `accent` tells the branches apart. */
  parent?: string;
  /** A Worktree only: the branch it was made for (the checkout can move on; the sidebar shows what git says). */
  branch?: string;
  /** A Worktree only: the Slug-ID of the issue it was made for, if any. */
  issue?: string;
  /** A Worktree of a folder that is not a git repo: a copy of the folder. `repos` are the repos
   *  nested in it, each added back as a git worktree on `branch` (see worktrees.ts). */
  copy?: { repos: string[] };
  /** The tour's sample project: its terminals are scripted, and it can be closed with nothing lost. */
  sample?: boolean;
};

/** The signals that alert. `working` only badges. */
export type SoundEvent = "blocked" | "done" | "error";
/** When a signal plays its sound and shows a desktop notification: only while you aren't looking at that window, always, or never (badges only). */
export type AlertMode = "away" | "always" | "badge";
/** A sound per signal: a built-in name (see SOUNDS in signals.ts), "off", or "custom" for a project's uploaded file. */
export type NotifySettings = Record<SoundEvent, string> & { alert: AlertMode; desktop: boolean; volume: number; dnd: boolean };
export type ProjectNotify = Partial<Record<SoundEvent, string>> & {
  alert?: AlertMode;
  desktop?: boolean;
  /** The uploaded file's name per signal, shown in the picker while that signal's sound is "custom". */
  files?: Partial<Record<SoundEvent, string>>;
};

const defaultNotify = (): NotifySettings => ({ blocked: "chime", done: "soft", error: "knock", alert: "away", desktop: true, volume: 70, dnd: false });

export type EnvStyle = { name?: string; icon?: string };
/** ssh options an ssh destination alone can't carry (`-i`, `-p`, `-o`); passed on every ssh call to that host. */
export type EnvSsh = { identityFile?: string; port?: string; options?: string[] };
/** A PIN lock: salt and hash from `env_pin_hash`, and how long an unlock lasts. */
export type EnvLock = { salt: string; hash: string; minutes: number };

type Persisted = {
  /** Environments in sidebar order: "local" or an ssh destination. Each project's host is one of them. */
  environments: string[];
  /** Per environment, by host: a display name and a lucide icon. The host stays the key, so a rename never changes where projects run. */
  envStyles: Record<string, EnvStyle>;
  /** Per environment, by host: its key file, port and extra ssh options. */
  envSsh: Record<string, EnvSsh>;
  /** Per environment, by host: its PIN lock, if it has one. */
  envLocks: Record<string, EnvLock>;
  projects: Project[];
  /** Most recent first, at most RECENT_MAX. */
  recent: RecentFolder[];
  activeProject?: string;
  /** In New Window Menu order. */
  agents: Agent[];
  /** Gap between tiled windows and around the edge, px. */
  gap: number;
  sidebarCollapsed: boolean;
  /** App-wide sounds and alerts for agent signals (the bell in the status line). */
  notify: NotifySettings;
  /** The tour was finished or skipped, so a launch with no projects no longer starts it. */
  toured: boolean;
  /** App-wide settings (the Settings button at the foot of the sidebar). */
  settings: Settings;
};

export type Settings = {
  /** Carousel (mono) layout: px each side of the centred window, where its neighbours peek.
   *  Unset is auto: the window takes 62% of the width, up to MONO_MAX. */
  monoGutter?: number;
  /** Folder names Go to File leaves out wherever they are. Unset is SKIP_FOLDERS. */
  skipFolders?: string[];
  /** The key window hotkeys start with (modkey.ts). */
  modKey: "alt" | "meta";
  /** Keymap actions whose keys were changed, by action id (keymap.ts); the rest keep their defaults. */
  hotkeys?: Record<string, Chord[]>;
  /** How diffs read unless a project's own toggle says otherwise. Unset is split. */
  diffMode?: DiffMode;
  /** Git status and diff colours that were changed; the rest follow the theme (--git-* in styles.css). */
  gitColors?: Partial<Record<GitColor, string>>;
  /** How strongly diff lines are tinted, %. Unset is GIT_TINT. */
  gitTint?: number;
  /** Remote Control (phone.ts): the signals that push to a phone (unset: all of them). Whether
   *  it is on lives in phone.json. */
  remote?: { push?: Partial<Record<SoundEvent, boolean>> };
};

export type GitColor = "add" | "del" | "mod" | "ren";
export const GIT_TINT = 18;

const defaultSettings = (): Settings => ({ modKey: "alt" });

export type TabStatus = "connecting" | "running" | "reconnecting" | "exited";

/** An agent's state as it reports it over OSC 7501 (the Program Status Protocol). */
export type AgentState = "working" | "blocked" | "done" | "error";
/** The last report; `seen` once its window was on screen after a done or error. */
export type AgentReport = { state: AgentState; msg: string; at: number; seen: boolean };

/** Runtime-only info about live tabs; never persisted. `attention` is the terminal bell; `pty` is
 *  the running PTY's id, which phones watch it by. */
export type Live = { status: TabStatus; attention: boolean; title: string; agent?: AgentReport; pty?: number };

export const SPACES = 4;
/** Steps for Alt+, / Alt+. ; any whole px up to GAP_MAX can be typed in Settings or the status line. */
export const GAPS = [0, 4, 8, 12, 16, 24, 32];
export const GAP_MAX = 64;
export const ACCENTS = ["#7aa2f7", "#f7768e", "#9ece6a", "#bb9af7", "#7dcfff", "#ff9e64", "#f5a3d0", "#73daca"];

const RECENT_MAX = 12;

export const [app, setApp] = createStore<Persisted>({ environments: ["local"], envStyles: {}, envSsh: {}, envLocks: {}, projects: [], recent: [], agents: defaultAgents(), gap: 12, sidebarCollapsed: false, notify: defaultNotify(), toured: false, settings: defaultSettings() });
export const [live, setLive] = createStore<Record<string, Live>>({});

export const newId = () => Math.random().toString(36).slice(2, 10);

export const isRemote = (p: Project) => p.host !== "local" && p.host !== "";
export const isLocalHost = (host: string) => host === "local" || host === "";

/** Stable name of the persistent remote session behind a tab. */
export const sessionName = (p: Project, t: Tab) => `tri-${p.id}-${t.id}`;

const newSpace = (): Space => ({ layout: "master", ratio: 0.55 });

/** The project that owns the repo: a Worktree's parent, else the project itself. Appearance,
 *  signal settings and the Dev Directory are the repo's. */
export const repoOf = (p: Project): Project => (p.parent && projectById(p.parent)) || p;
/** A repo project's Worktrees, in sidebar order. */
export const worktreesOf = (projectId: string) => app.projects.filter((p) => p.parent === projectId);

export const activeProject = () => app.projects.find((p) => p.id === app.activeProject);
export const projectById = (id: string) => app.projects.find((p) => p.id === id);
export const space = (p: Project) => p.spaces[p.ws];
/** Tabs on the project's active workspace, in tiling order. */
export const visibleTabs = (p: Project) => p.tabs.filter((t) => t.space === p.ws);
/** Tabs on the active workspace that are tiled: the visible ones that are not minimised. */
export const canvasTabs = (p: Project) => visibleTabs(p).filter((t) => !t.min);
export const focusedTab = (p: Project) => canvasTabs(p).find((t) => t.id === space(p).focus);

/** Run a mutation against one project inside a single store update. */
function edit(projectId: string, fn: (p: Project, s: Persisted) => void) {
  setApp(produce((s) => {
    const p = s.projects.find((p) => p.id === projectId);
    if (p) fn(p, s);
  }));
}

/** Add a project and make it active. Returns its id. */
export function addProject(name: string, host: string, path: string): string {
  const id = newId();
  host = host || "local";
  // A new project picks the next accent so neighbours in the sidebar differ.
  const accent = ACCENTS[app.projects.length % ACCENTS.length];
  setApp(produce((s) => {
    s.projects.push({
      id, name, host, path, tabs: [], ws: 0,
      spaces: Array.from({ length: SPACES }, newSpace), accent, bg: "none", dim: 0, favs: [],
    });
    s.activeProject = id;
    if (!s.environments.includes(host)) s.environments.push(host);
    s.recent = [{ host, path }, ...s.recent.filter((r) => r.host !== host || r.path !== path)].slice(0, RECENT_MAX);
  }));
  return id;
}

/**
 * Add the tour's sample project at `path` and make it active: claude at work, a dev server and
 * the editor on workspace 1, pi on workspace 2. Not added to Recent. Returns its id.
 */
export function addSampleProject(path: string): string {
  const id = newId();
  const agent = (a: string) => app.agents.find((x) => x.id === a);
  const term = (space: number, demo: DemoKind, a: string, name: string, cmd: string): Tab =>
    ({ id: newId(), kind: "term", space, demo, agent: agent(a)?.id, name, cmd });
  const tabs = [term(0, "claude", "claude", "claude", "claude"), term(0, "server", "shell", "shell", ""), { id: newId(), kind: "editor", space: 0 } as Tab, term(1, "pi", "pi", "pi", "pi")];
  const spaces = Array.from({ length: SPACES }, newSpace);
  spaces[0].focus = tabs[0].id;
  spaces[1].focus = tabs[3].id;
  setApp(produce((s) => {
    s.projects.push({ id, name: "tour", host: "local", path, tabs, ws: 0, spaces, accent: "#bb9af7", bg: "none", dim: 0, favs: [], sample: true });
    s.activeProject = id;
  }));
  return id;
}

/** Add a Worktree under `parentId` and, unless `activate` is false, make it active. Returns its id. */
export function addWorktree(parentId: string, w: { path: string; branch: string; issue?: string; copy?: { repos: string[] } }, activate = true): string {
  const id = newId();
  setApp(produce((s) => {
    const parent = s.projects.find((p) => p.id === parentId);
    if (!parent) return;
    // An accent no other checkout of the repo has, so each branch's windows look different.
    const family = s.projects.filter((p) => p.id === parentId || p.parent === parentId).map((p) => p.accent);
    const accent = ACCENTS.find((a) => !family.includes(a)) ?? ACCENTS[family.length % ACCENTS.length];
    let at = 0;
    s.projects.forEach((p, i) => { if (p.id === parentId || p.parent === parentId) at = i + 1; });
    s.projects.splice(at, 0, {
      id, name: w.branch, host: parent.host, path: w.path, tabs: [], ws: 0,
      spaces: Array.from({ length: SPACES }, newSpace), accent, bg: "none", dim: 0, favs: [...parent.favs],
      parent: parentId, branch: w.branch, ...(w.issue ? { issue: w.issue } : {}), ...(w.copy ? { copy: w.copy } : {}),
    });
    if (activate) s.activeProject = id;
  }));
  return id;
}

export function renameProject(projectId: string, name: string) {
  edit(projectId, (p) => { p.name = name; });
}

export function setIcon(projectId: string, icon: ProjectIcon) {
  edit(projectId, (p) => { p.icon = icon; });
}

export function addEnvironment(host: string) {
  setApp(produce((s) => {
    if (!s.environments.includes(host)) s.environments.push(host);
  }));
}

/** Drop an environment from the sidebar. Its projects must be removed first. */
export function removeEnvironment(host: string) {
  setApp(produce((s) => {
    s.environments = s.environments.filter((h) => h !== host);
    delete s.envStyles[host];
    delete s.envSsh[host];
    delete s.envLocks[host];
  }));
}

export function setEnvSsh(host: string, ssh: EnvSsh | undefined) {
  setApp(produce((s) => {
    if (ssh) s.envSsh[host] = ssh;
    else delete s.envSsh[host];
  }));
}

export function setEnvLock(host: string, lock: EnvLock | undefined) {
  setApp(produce((s) => {
    if (lock) s.envLocks[host] = lock;
    else delete s.envLocks[host];
  }));
}

/** The environment's display name: the one given, else the host. */
export const envName = (host: string) => app.envStyles[host]?.name || host;
export const envIcon = (host: string) => app.envStyles[host]?.icon || (isLocalHost(host) ? "laptop" : "server");

/** An empty name (or the host itself) goes back to showing the host. */
export function setEnvStyle(host: string, patch: EnvStyle) {
  setApp(produce((s) => {
    const next = { ...s.envStyles[host], ...patch };
    if (next.name === host) next.name = "";
    s.envStyles[host] = next;
  }));
}

/** Move a repo project, with its Worktrees, to just before or after another repo project. */
export function moveProject(id: string, target: string, after: boolean) {
  setApp(produce((s) => {
    const family = (p: Project, root: string) => p.id === root || p.parent === root;
    const moving = s.projects.filter((p) => family(p, id));
    const rest = s.projects.filter((p) => !family(p, id));
    let at = -1;
    rest.forEach((p, i) => { if (family(p, target)) at = after ? i + 1 : at < 0 ? i : at; });
    if (id === target || !moving.length || at < 0) return;
    rest.splice(at, 0, ...moving);
    s.projects = rest;
  }));
}

export function removeProject(id: string) {
  setApp(produce((s) => {
    s.projects = s.projects.filter((p) => p.id !== id);
    if (s.activeProject === id) s.activeProject = s.projects[0]?.id;
  }));
}

/** Add a window on the active workspace and focus it. `after` inserts it right after that tab. */
export function addTab(projectId: string, kind: TabKind, opts: { url?: string; path?: string; after?: string; agent?: Agent } = {}) {
  const id = newId();
  edit(projectId, (p) => {
    const a = opts.agent;
    const tab: Tab = {
      id, kind, space: p.ws,
      ...(kind === "browser" ? { ...newPages(opts.url ?? ""), ...(a ? { agent: a.id, name: a.name } : {}) } : {}),
      ...(kind === "editor" && opts.path ? { path: opts.path, files: [opts.path] } : {}),
      ...(kind === "term" ? { agent: a?.id, name: a?.name ?? "shell", cmd: a?.command ?? "" } : {}),
    };
    const i = opts.after ? p.tabs.findIndex((t) => t.id === opts.after) : -1;
    if (i >= 0) p.tabs.splice(i + 1, 0, tab);
    else p.tabs.push(tab);
    p.spaces[p.ws].focus = id;
    p.spaces[p.ws].mono = undefined;
  });
  return id;
}

export function removeTab(projectId: string, tabId: string) {
  edit(projectId, (p) => {
    const i = p.tabs.findIndex((t) => t.id === tabId);
    if (i < 0) return;
    const [tab] = p.tabs.splice(i, 1);
    const sp = p.spaces[tab.space];
    if (sp.mono === tabId) sp.mono = undefined;
    if (sp.focus === tabId) {
      const same = p.tabs.filter((t) => t.space === tab.space && !t.min);
      const before = same.filter((t) => p.tabs.indexOf(t) < i).pop();
      sp.focus = (before ?? same[0])?.id;
    }
  });
  setLive(produce((l) => delete l[tabId]));
}

/** Re-insert a tab removed with removeTab (undo), at its old index. */
export function restoreTab(projectId: string, tab: Tab, index: number) {
  edit(projectId, (p) => {
    p.tabs.splice(Math.min(index, p.tabs.length), 0, tab);
    p.ws = tab.space;
    p.spaces[tab.space].focus = tab.id;
  });
}

/** Focus a tab, switching to its project and workspace if needed. A minimised tab comes back. */
export function focusTab(projectId: string, tabId: string) {
  edit(projectId, (p, s) => {
    const t = p.tabs.find((t) => t.id === tabId);
    if (!t) return;
    delete t.min;
    s.activeProject = projectId;
    p.ws = t.space;
    p.spaces[t.space].focus = tabId;
  });
  if (live[tabId]?.attention) setLive(tabId, "attention", false);
}

export function goSpace(projectId: string, i: number) {
  edit(projectId, (p) => {
    p.ws = i;
    const sp = p.spaces[i];
    if (!p.tabs.some((t) => t.space === i && !t.min && t.id === sp.focus)) sp.focus = p.tabs.find((t) => t.space === i && !t.min)?.id;
  });
}

/** Move a tab to another workspace without following it. */
export function sendTo(projectId: string, tabId: string, i: number) {
  edit(projectId, (p) => {
    const t = p.tabs.find((t) => t.id === tabId);
    if (!t || t.space === i) return;
    const fromIndex = t.space, from = p.spaces[fromIndex];
    t.space = i;
    if (from.mono === tabId) from.mono = undefined;
    if (from.focus === tabId) from.focus = p.tabs.find((x) => x.space === fromIndex && !x.min)?.id;
    if (!t.min) p.spaces[i].focus = tabId;
  });
}

export function swapTabs(projectId: string, a: string, b: string) {
  edit(projectId, (p) => {
    const i = p.tabs.findIndex((t) => t.id === a), j = p.tabs.findIndex((t) => t.id === b);
    if (i < 0 || j < 0) return;
    [p.tabs[i], p.tabs[j]] = [p.tabs[j], p.tabs[i]];
    p.spaces[p.ws].mono = undefined;
  });
}

/** Make a tab the main window of its workspace (first in tiling order). */
export function promote(projectId: string, tabId: string) {
  edit(projectId, (p) => {
    const i = p.tabs.findIndex((t) => t.id === tabId);
    if (i < 0) return;
    const [t] = p.tabs.splice(i, 1);
    p.tabs.unshift(t);
    p.spaces[t.space].mono = undefined;
  });
}

/** Take a tab off the canvas, keeping its place in tiling order; focus moves to the open tab before it. */
export function minimiseTab(projectId: string, tabId: string) {
  edit(projectId, (p) => {
    const i = p.tabs.findIndex((t) => t.id === tabId);
    const t = p.tabs[i];
    if (!t || t.min) return;
    t.min = Date.now();
    const sp = p.spaces[t.space];
    if (sp.mono === tabId) sp.mono = undefined;
    if (sp.focus === tabId) {
      const open = p.tabs.filter((x) => x.space === t.space && !x.min);
      sp.focus = (open.filter((x) => p.tabs.indexOf(x) < i).pop() ?? open[0])?.id;
    }
  });
}

/** The active workspace's most recently minimised tab, if any. */
export const lastMinimised = (p: Project) =>
  visibleTabs(p).filter((t) => t.min).sort((a, b) => b.min! - a.min!)[0];

export function setLayout(projectId: string, layout: Layout) {
  edit(projectId, (p) => { p.spaces[p.ws].layout = layout; p.spaces[p.ws].mono = undefined; });
}

export function setRatio(projectId: string, ratio: number) {
  edit(projectId, (p) => { p.spaces[p.ws].ratio = Math.min(0.8, Math.max(0.2, ratio)); });
}

export function toggleMono(projectId: string, tabId: string) {
  edit(projectId, (p) => {
    const sp = p.spaces[p.ws];
    sp.mono = sp.mono === tabId ? undefined : tabId;
    sp.focus = tabId;
  });
}

export function setGap(gap: number) {
  setApp("gap", Math.round(Math.min(GAP_MAX, Math.max(0, gap))));
}

/** Carousel gutter in px each side, or undefined for auto. */
export function setMonoGutter(px: number | undefined) {
  setApp("settings", "monoGutter", px === undefined ? undefined : Math.round(Math.max(0, px)));
}

/** One git colour, or undefined to follow the theme again. */
export function setGitColor(key: GitColor, color: string | undefined) {
  setApp(produce((s) => {
    const c = (s.settings.gitColors ??= {});
    if (color) c[key] = color;
    else delete c[key];
    if (!Object.keys(c).length) delete s.settings.gitColors;
  }));
}

/** Diff line tint in %, or undefined for GIT_TINT. */
export function setGitTint(pct: number | undefined) {
  setApp("settings", "gitTint", pct === undefined ? undefined : Math.round(Math.min(60, Math.max(0, pct))));
}

/** Go to File's default skip list; the same as `fs::SKIP` in fs.rs. `.git` is always skipped. */
export const SKIP_FOLDERS = ["node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".cache"];

export const skipFolders = () => app.settings.skipFolders ?? SKIP_FOLDERS;

/** Folder names Go to File leaves out, or undefined for the default list. */
export function setSkipFolders(names: string[] | undefined) {
  const clean = names && [...new Set(names.map((n) => n.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean))];
  setApp("settings", "skipFolders", clean);
}

export function setSidebarCollapsed(collapsed: boolean) {
  setApp("sidebarCollapsed", collapsed);
}

export function setNotify(patch: Partial<NotifySettings>) {
  setApp(produce((s) => Object.assign(s.notify, patch)));
}

/** Change a project's signal settings; an undefined value goes back to the app-wide default. */
export function setProjectNotify(projectId: string, patch: ProjectNotify) {
  edit(projectId, (p) => {
    const n = (p.notify ??= {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete n[k];
      else n[k] = v;
    }
  });
}

export function setAppearance(projectId: string, patch: Partial<Pick<Project, "accent" | "bg" | "dim">>) {
  edit(projectId, (p) => Object.assign(p, patch));
}

function newPages(url: string): Pick<Tab, "pages" | "page"> {
  const id = newId();
  return { pages: [{ id, url }], page: id };
}

function editTab(projectId: string, tabId: string, fn: (t: Tab) => void) {
  edit(projectId, (p) => {
    const t = p.tabs.find((t) => t.id === tabId);
    if (t) fn(t);
  });
}

/** A terminal whose agent quit carries on as a plain login shell. */
export function becomeShell(projectId: string, tabId: string) {
  editTab(projectId, tabId, (t) => Object.assign(t, { agent: undefined, name: "shell", cmd: "" }));
}

export function setPageUrl(projectId: string, tabId: string, pageId: string, url: string) {
  editTab(projectId, tabId, (t) => {
    const pg = t.pages?.find((x) => x.id === pageId);
    if (pg) pg.url = url;
  });
}

/**
 * Add a page to a browser window, after `opener` and the pages it already opened (so several
 * Ctrl+clicks line up in click order), or at the end. `show` makes it the shown page.
 */
export function addPage(projectId: string, tabId: string, url: string, opts: { opener?: string; show?: boolean } = {}) {
  const id = newId();
  editTab(projectId, tabId, (t) => {
    const pages = (t.pages ??= []);
    let at = opts.opener ? pages.findIndex((x) => x.id === opts.opener) : -1;
    if (at < 0) at = pages.length - 1;
    else while (pages[at + 1]?.opener === opts.opener) at++;
    pages.splice(at + 1, 0, { id, url, ...(opts.opener ? { opener: opts.opener } : {}) });
    if (opts.show || !t.page) t.page = id;
  });
  return id;
}

export function showPage(projectId: string, tabId: string, pageId: string) {
  editTab(projectId, tabId, (t) => { t.page = pageId; });
}

/** Remove a page; the next one to the right is shown, else the one to the left. The caller closes the window instead of removing its last page. */
export function removePage(projectId: string, tabId: string, pageId: string) {
  editTab(projectId, tabId, (t) => {
    const pages = t.pages ?? [];
    const i = pages.findIndex((x) => x.id === pageId);
    if (i < 0 || pages.length < 2) return;
    pages.splice(i, 1);
    if (t.page === pageId) t.page = (pages[i] ?? pages[i - 1]).id;
  });
}

/** Add a favourite at the end of the bar; a URL that is already one is left as it is. */
export function addFav(projectId: string, fav: Fav) {
  edit(projectId, (p) => {
    if (!p.favs.some((f) => f.url === fav.url)) p.favs.push(fav);
  });
}

export function renameFav(projectId: string, url: string, name: string) {
  edit(projectId, (p) => {
    const f = p.favs.find((f) => f.url === url);
    if (f) f.name = name;
  });
}

export function removeFav(projectId: string, url: string) {
  edit(projectId, (p) => { p.favs = p.favs.filter((f) => f.url !== url); });
}

/** Move the favourite `url` to just before `before` on the bar. */
export function moveFav(projectId: string, url: string, before: string) {
  edit(projectId, (p) => {
    const from = p.favs.findIndex((f) => f.url === url);
    if (from < 0 || url === before) return;
    const [f] = p.favs.splice(from, 1);
    const to = p.favs.findIndex((x) => x.url === before);
    p.favs.splice(to < 0 ? p.favs.length : to, 0, f);
  });
}

/** Change what an editor tab shows: its file, its open files, its preview tab, its tree. An `undefined` drops the field. */
export function setEditorTab(projectId: string, tabId: string, patch: Partial<Pick<Tab, "path" | "files" | "preview" | "tree" | "at">>) {
  editTab(projectId, tabId, (t) => {
    for (const [k, v] of Object.entries(patch) as [keyof typeof patch, never][]) {
      if (v === undefined) delete t[k];
      else t[k] = v;
    }
  });
}

/** The git window's and the editor's diff orientation, kept per project. */
export function setProjectDiffMode(projectId: string, mode: DiffMode) {
  edit(projectId, (p) => { p.diffMode = mode; });
}

/** A project's diff orientation: its own toggle, else the Settings default. */
export const diffModeOf = (p: Project): DiffMode => p.diffMode ?? app.settings.diffMode ?? "split";

/** Settings › Files: the default for every project. Choosing it clears the projects' own toggles,
 *  so it shows everywhere at once. */
export function setDiffDefault(mode: DiffMode) {
  setApp(produce((s) => {
    s.settings.diffMode = mode;
    for (const p of s.projects) delete p.diffMode;
  }));
}

export function setSettings(patch: Partial<Settings>) {
  setApp(produce((s) => Object.assign(s.settings, patch)));
}

/** Change an action's keys; undefined goes back to its defaults. */
export function setHotkeys(id: string, keys: Chord[] | undefined) {
  setApp(produce((s) => {
    const h = (s.settings.hotkeys ??= {});
    if (keys) h[id] = keys;
    else delete h[id];
    if (!Object.keys(h).length) delete s.settings.hotkeys;
  }));
}

export function addAgent(agent: Agent) {
  setApp(produce((s) => { s.agents.push(agent); }));
}

export function updateAgent(id: string, patch: Partial<Omit<Agent, "id">>) {
  setApp(produce((s) => {
    const a = s.agents.find((a) => a.id === id);
    if (a) Object.assign(a, patch);
  }));
}

/** Delete an agent. Its open windows keep running under their last name. */
export function removeAgent(id: string) {
  setApp(produce((s) => { s.agents = s.agents.filter((a) => a.id !== id); }));
}

/** Put back an agent removed with removeAgent (undo), at its old index. */
export function restoreAgent(agent: Agent, index: number) {
  setApp(produce((s) => { s.agents.splice(Math.min(index, s.agents.length), 0, agent); }));
}

/** Move agent `id` to just before `before` (the end when `before` is missing). */
export function moveAgent(id: string, before: string | null) {
  setApp(produce((s) => {
    const from = s.agents.findIndex((a) => a.id === id);
    if (from < 0 || id === before) return;
    const [a] = s.agents.splice(from, 1);
    const to = before ? s.agents.findIndex((x) => x.id === before) : -1;
    s.agents.splice(to < 0 ? s.agents.length : to, 0, a);
  }));
}

/** Tabs from before agents: kind was "claude", "pi" or "shell", and the command came from that. */
function migrateTab(t: any): Tab {
  const tab = { ...t, space: t.space ?? 0 };
  if (t.kind === "claude" || t.kind === "pi" || t.kind === "shell") {
    Object.assign(tab, { kind: "term", agent: t.kind, name: t.kind, cmd: t.kind === "shell" ? "" : t.kind });
  }
  // The files window (a tree) and file windows (one file, or a strip of them) became editors.
  if (t.kind === "files") tab.kind = "editor";
  if (t.kind === "file") {
    const files: string[] = t.files ?? (t.path ? [t.path] : []);
    Object.assign(tab, { kind: "editor", files, path: t.path || undefined, preview: t.preview ? t.path : undefined, tree: false });
    if (!files.length) delete tab.files;
  }
  // Browser windows had one address before they had pages.
  if (t.kind === "browser" && !t.pages) {
    Object.assign(tab, { pages: [{ id: t.id, url: t.url ?? "" }], page: t.id });
    delete tab.url;
  }
  return tab;
}

/** Fill in fields added after the first release so older state.json files keep working. */
function migrate(raw: any): Persisted {
  const projects: Project[] = (raw.projects ?? []).map((p: any, i: number) => {
    const spaces: Space[] = Array.from({ length: SPACES }, (_, k) => ({ ...newSpace(), ...(p.spaces?.[k] ?? {}) }));
    const tabs: Tab[] = (p.tabs ?? []).map(migrateTab);
    if (!p.spaces && p.activeTab) spaces[0].focus = p.activeTab;
    spaces.forEach((sp, k) => {
      if (!tabs.some((t) => t.space === k && t.id === sp.focus)) sp.focus = tabs.find((t) => t.space === k)?.id;
    });
    return {
      id: p.id, name: p.name, host: p.host || "local", path: p.path, tabs,
      ws: p.ws ?? 0, spaces,
      accent: p.accent ?? ACCENTS[i % ACCENTS.length], bg: p.bg ?? "none", dim: p.dim ?? 0,
      favs: p.favs ?? [], diffMode: p.diffMode, icon: p.icon, notify: p.notify,
      ...(p.parent ? { parent: p.parent, branch: p.branch, issue: p.issue, ...(p.copy ? { copy: p.copy } : {}) } : {}),
      ...(p.sample ? { sample: true } : {}),
    };
  });
  // A Worktree whose repo project is gone stands on its own.
  for (const p of projects) if (p.parent && !projects.some((q) => q.id === p.parent)) delete p.parent;
  // Before environments existed, hosts only came from projects.
  const environments: string[] = raw.environments ?? ["local"];
  for (const p of projects) if (!environments.includes(p.host)) environments.push(p.host);
  return {
    environments, envStyles: raw.envStyles ?? {}, envSsh: raw.envSsh ?? {}, envLocks: raw.envLocks ?? {}, projects, recent: raw.recent ?? [],
    activeProject: raw.activeProject, agents: raw.agents ?? defaultAgents(), gap: raw.gap ?? 12, sidebarCollapsed: raw.sidebarCollapsed ?? false,
    notify: { ...defaultNotify(), ...raw.notify },
    // Anyone with a state file from before the tour already knows their way around.
    toured: raw.toured ?? true,
    // `fileOpen` chose how a file window opened the next file; the editor's preview tab replaced it.
    settings: (({ fileOpen: _, ...rest }) => ({ ...defaultSettings(), ...rest }))(raw.settings ?? {}),
  };
}

export async function loadState() {
  const json = await invoke<string | null>("state_load");
  if (json) setApp(migrate(JSON.parse(json)));
}

export function setToured() {
  setApp("toured", true);
}

/** Debounced save on any change. Call inside a component, after loadState. */
export function persistChanges(ready: () => boolean) {
  let timer: number | undefined;
  createEffect(on(() => ready() && JSON.stringify(app), (json) => {
    if (!json) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      invoke("state_save", { json }).catch((e) => console.error("state_save failed:", e));
    }, 300);
  }, { defer: true }));
}
