import { createEffect, on } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";

export type TabKind = "term" | "browser" | "issues" | "files" | "file" | "git" | "agents";

/** An Alt chord, matched on e.code like every window binding. Alt is implied. */
export type Hotkey = { code: string; shift?: boolean; ctrl?: boolean };

/** A terminal app the New Window Menu offers: claude, pi, a shell, lazygit, ... Global, not per project. */
export type Agent = {
  id: string;
  name: string;
  /** Run in the project folder on the project's host; "" is the login shell. */
  command: string;
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
 *  issues panels render the project's `.dev/`; files lists the project folder,
 *  file shows one file, git takes the branch from changes to a merged PR and
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
  /** `file` tabs only: the path being viewed. */
  path?: string;
  /** `term` tabs only: the agent it was opened from. The name and icon follow the agent. */
  agent?: string;
  /** `term` tabs only: the agent's name at launch, shown once the agent is deleted. */
  name?: string;
  /** `term` tabs only: the command it runs ("" = login shell). Kept from launch, so editing an agent only changes new windows. */
  cmd?: string;
};

/** The page a browser window shows. */
export const activePage = (t: Tab): Page | undefined => t.pages?.find((p) => p.id === t.page) ?? t.pages?.[0];

/** Terminals own a PTY; browsers and panels do not. */
export const isTerminal = (t: Tab) => t.kind === "term";

export const agentOf = (t: Tab) => (t.agent ? app.agents.find((a) => a.id === t.agent) : undefined);

/** What a window is called in the tab strip, title bar and messages: its agent for terminals, else its kind. */
export const tabName = (t: Tab) => (t.kind === "term" ? agentOf(t)?.name || t.name || "terminal" : t.kind);

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
  icon?: ProjectIcon;
};

export type EnvStyle = { name?: string; icon?: string };

type Persisted = {
  /** Environments in sidebar order: "local" or an ssh destination. Each project's host is one of them. */
  environments: string[];
  /** Per environment, by host: a display name and a lucide icon. The host stays the key, so a rename never changes where projects run. */
  envStyles: Record<string, EnvStyle>;
  projects: Project[];
  /** Most recent first, at most RECENT_MAX. */
  recent: RecentFolder[];
  activeProject?: string;
  /** In New Window Menu order. */
  agents: Agent[];
  /** Gap between tiled windows and around the edge, px. */
  gap: number;
  sidebarCollapsed: boolean;
};

export type TabStatus = "connecting" | "running" | "reconnecting" | "exited";

/** Runtime-only info about live tabs; never persisted. */
export type Live = { status: TabStatus; attention: boolean; title: string };

export const SPACES = 4;
export const GAPS = [0, 4, 8, 12, 16, 24, 32];
export const ACCENTS = ["#7aa2f7", "#f7768e", "#9ece6a", "#bb9af7", "#7dcfff", "#ff9e64", "#f5a3d0", "#73daca"];

const RECENT_MAX = 12;

export const [app, setApp] = createStore<Persisted>({ environments: ["local"], envStyles: {}, projects: [], recent: [], agents: defaultAgents(), gap: 12, sidebarCollapsed: false });
export const [live, setLive] = createStore<Record<string, Live>>({});

export const newId = () => Math.random().toString(36).slice(2, 10);

export const isRemote = (p: Project) => p.host !== "local" && p.host !== "";
export const isLocalHost = (host: string) => host === "local" || host === "";

/** Stable name of the persistent remote session behind a tab. */
export const sessionName = (p: Project, t: Tab) => `tri-${p.id}-${t.id}`;

const newSpace = (): Space => ({ layout: "master", ratio: 0.55 });

export const activeProject = () => app.projects.find((p) => p.id === app.activeProject);
export const projectById = (id: string) => app.projects.find((p) => p.id === id);
export const space = (p: Project) => p.spaces[p.ws];
/** Tabs on the project's active workspace, in tiling order. */
export const visibleTabs = (p: Project) => p.tabs.filter((t) => t.space === p.ws);
export const focusedTab = (p: Project) => visibleTabs(p).find((t) => t.id === space(p).focus);

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
      ...(kind === "browser" ? newPages(opts.url ?? "") : {}),
      ...(kind === "file" ? { path: opts.path ?? "" } : {}),
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
      const same = p.tabs.filter((t) => t.space === tab.space);
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

/** Focus a tab, switching to its project and workspace if needed. */
export function focusTab(projectId: string, tabId: string) {
  edit(projectId, (p, s) => {
    const t = p.tabs.find((t) => t.id === tabId);
    if (!t) return;
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
    if (!p.tabs.some((t) => t.space === i && t.id === sp.focus)) sp.focus = p.tabs.find((t) => t.space === i)?.id;
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
    if (from.focus === tabId) from.focus = p.tabs.find((x) => x.space === fromIndex)?.id;
    p.spaces[i].focus = tabId;
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
  setApp("gap", gap);
}

export function setSidebarCollapsed(collapsed: boolean) {
  setApp("sidebarCollapsed", collapsed);
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

/** Point a `file` tab at another file (the window is reused). */
export function setTabPath(projectId: string, tabId: string, path: string) {
  edit(projectId, (p) => {
    const t = p.tabs.find((t) => t.id === tabId);
    if (t) t.path = path;
  });
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
      favs: p.favs ?? [], icon: p.icon,
    };
  });
  // Before environments existed, hosts only came from projects.
  const environments: string[] = raw.environments ?? ["local"];
  for (const p of projects) if (!environments.includes(p.host)) environments.push(p.host);
  return {
    environments, envStyles: raw.envStyles ?? {}, projects, recent: raw.recent ?? [],
    activeProject: raw.activeProject, agents: raw.agents ?? defaultAgents(), gap: raw.gap ?? 12, sidebarCollapsed: raw.sidebarCollapsed ?? false,
  };
}

export async function loadState() {
  const json = await invoke<string | null>("state_load");
  if (json) setApp(migrate(JSON.parse(json)));
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
