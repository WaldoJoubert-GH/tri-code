import { createEffect, on } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";

export type TabKind = "claude" | "pi" | "shell";

export const TAB_COMMANDS: Record<TabKind, string | null> = {
  claude: "claude",
  pi: "pi",
  shell: null,
};

export type Tab = { id: string; kind: TabKind };

export type Project = {
  id: string;
  name: string;
  /** "local" or an ssh destination (alias from ~/.ssh/config, user@host, ...) */
  host: string;
  path: string;
  tabs: Tab[];
  activeTab?: string;
};

type Persisted = { projects: Project[]; activeProject?: string };

export type TabStatus = "connecting" | "running" | "reconnecting" | "exited";

/** Runtime-only info about live tabs; never persisted. */
type Live = { status: TabStatus; attention: boolean; title: string };

export const [app, setApp] = createStore<Persisted>({ projects: [] });
export const [live, setLive] = createStore<Record<string, Live>>({});

export const newId = () => Math.random().toString(36).slice(2, 10);

export const isRemote = (p: Project) => p.host !== "local" && p.host !== "";

/** Stable name of the persistent remote session behind a tab. */
export const sessionName = (p: Project, t: Tab) => `tri-${p.id}-${t.id}`;

export const activeProject = () =>
  app.projects.find((p) => p.id === app.activeProject);

export function addProject(name: string, host: string, path: string) {
  const id = newId();
  setApp(produce((s) => {
    s.projects.push({ id, name, host: host || "local", path, tabs: [] });
    s.activeProject = id;
  }));
}

export function removeProject(id: string) {
  setApp(produce((s) => {
    s.projects = s.projects.filter((p) => p.id !== id);
    if (s.activeProject === id) s.activeProject = s.projects[0]?.id;
  }));
}

export function addTab(projectId: string, kind: TabKind) {
  const id = newId();
  setApp(produce((s) => {
    const p = s.projects.find((p) => p.id === projectId)!;
    p.tabs.push({ id, kind });
    p.activeTab = id;
  }));
  return id;
}

export function removeTab(projectId: string, tabId: string) {
  setApp(produce((s) => {
    const p = s.projects.find((p) => p.id === projectId)!;
    const i = p.tabs.findIndex((t) => t.id === tabId);
    p.tabs.splice(i, 1);
    if (p.activeTab === tabId) p.activeTab = p.tabs[Math.max(0, i - 1)]?.id;
  }));
  setLive(produce((l) => delete l[tabId]));
}

export function selectTab(projectId: string, tabId: string) {
  setApp("activeProject", projectId);
  setApp("projects", (p) => p.id === projectId, "activeTab", tabId);
}

export async function loadState() {
  const json = await invoke<string | null>("state_load");
  if (json) setApp(JSON.parse(json) as Persisted);
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
