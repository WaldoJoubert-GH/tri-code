import { invoke } from "@tauri-apps/api/core";
import { For, Show, createSignal } from "solid-js";
import {
  Project, app, isLocalHost, isTerminal, live, removeEnvironment, removeProject, renameProject, setApp, setSidebarCollapsed,
} from "./state";
import { closeBrowser } from "./browsers";
import { closeSession } from "./terms";
import { closeAppearance, forgetBgImage, openAppearance } from "./Appearance";
import { dev, forgetProject, isActive } from "./issues";
import { IconFace, forgetIcon } from "./icons";
import { openProjectDialog } from "./OpenProject";
import { flash } from "./ui";

/** Collapse to the rail, or expand back to the full list. */
export function toggleSidebar() {
  const collapsed = !app.sidebarCollapsed;
  closeAppearance();
  setSidebarCollapsed(collapsed);
  flash(collapsed ? "sidebar collapsed" : "sidebar expanded");
}

/** End a project's windows and drop everything stored for it. */
function dropProject(p: Project) {
  for (const t of p.tabs) {
    if (t.kind === "browser") closeBrowser(t.id);
    else if (isTerminal(t)) closeSession(t.id);
  }
  invoke("bg_delete", { projectId: p.id }).catch((e) => console.error("bg_delete failed:", e));
  forgetBgImage(p.id);
  forgetIcon(p.id);
  forgetProject(p.id);
  removeProject(p.id);
}

/** Rename in place: Enter or blur saves, Escape cancels, empty falls back to the folder name. */
function RenameInput(props: { project: Project; done: () => void }) {
  let cancelled = false;
  const save = (value: string) => {
    if (!cancelled) renameProject(props.project.id, value.trim() || props.project.path.split(/[\\/]/).filter(Boolean).pop() || props.project.name);
    props.done();
  };
  return (
    <input
      class="rename"
      value={props.project.name}
      spellcheck={false}
      ref={(el) => requestAnimationFrame(() => (el.focus(), el.select()))}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => save(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") (cancelled = true), e.currentTarget.blur();
      }}
    />
  );
}

export default function Sidebar() {
  const [renaming, setRenaming] = createSignal<string | null>(null);

  const needsAttention = (p: Project) =>
    app.activeProject !== p.id && p.tabs.some((t) => live[t.id]?.attention);

  const remove = (p: Project) => {
    if (!confirm(`Remove "${p.name}" and end its ${p.tabs.length} tab(s)?`)) return;
    dropProject(p);
  };

  const removeEnv = (host: string) => {
    const ps = app.projects.filter((p) => p.host === host);
    const tabs = ps.reduce((n, p) => n + p.tabs.length, 0);
    if (ps.length && !confirm(`Remove environment "${host}", its ${ps.length} project(s) and ${tabs} tab(s)?`)) return;
    ps.forEach(dropProject);
    removeEnvironment(host);
  };

  /** Active Plane issues per State, in Plane's colours (the pi-todos widget). */
  const miniBar = (p: Project) => {
    const d = dev[p.id];
    if (!d?.connected) return [];
    const counts = new Map<string, { color: string; name: string; n: number }>();
    for (const i of d.issues) {
      if (i.source !== "plane" || !isActive(d, i)) continue;
      const s = d.states.find((x) => x.id === i.state_id);
      const key = s?.id ?? "?";
      const entry = counts.get(key) ?? { color: s?.color ?? "#888", name: s?.name ?? "Unknown", n: 0 };
      entry.n += 1;
      counts.set(key, entry);
    }
    return [...counts.values()];
  };


  return (
    <aside>
      <div class="side-head">
        <span>Projects</span>
        <button
          class="collapse"
          onClick={toggleSidebar}
          title={`${app.sidebarCollapsed ? "Expand" : "Collapse"} sidebar (Alt+S)`}
          aria-label={`${app.sidebarCollapsed ? "Expand" : "Collapse"} sidebar`}
          aria-expanded={!app.sidebarCollapsed}
        >
          {app.sidebarCollapsed ? "»" : "«"}
        </button>
      </div>
      <For each={app.environments}>
        {(host) => (
          <section>
            <h2>
              <span class="host" title={isLocalHost(host) ? "This machine" : `ssh ${host}`}>{host}</span>
              <button class="env-add" title={`Open a project on ${host}`} aria-label={`Open a project on ${host}`} onClick={() => openProjectDialog(host)}>+</button>
              <button class="env-x" title="Remove environment" aria-label={`Remove environment ${host}`} onClick={() => removeEnv(host)}>×</button>
            </h2>
            <For
              each={app.projects.filter((p) => p.host === host)}
              fallback={<button class="env-empty" onClick={() => openProjectDialog(host)}>No projects · open one</button>}
            >
              {(p) => (
                <div
                  class="project"
                  classList={{ active: app.activeProject === p.id }}
                  style={{ "--pa": p.accent }}
                  title={app.sidebarCollapsed ? `${p.name} · ${p.host} · ${p.tabs.length} window${p.tabs.length === 1 ? "" : "s"}` : undefined}
                  onClick={() => setApp("activeProject", p.id)}
                >
                  <span class="swatch"><IconFace project={p} /></span>
                  <Show when={renaming() === p.id} fallback={<span class="name" title="Double-click to rename" onDblClick={() => setRenaming(p.id)}>{p.name}</span>}>
                    <RenameInput project={p} done={() => setRenaming(null)} />
                  </Show>
                  <Show when={miniBar(p).length}>
                    <span class="minibar" title={miniBar(p).map((c) => `${c.n} ${c.name}`).join(" · ")}>
                      <For each={miniBar(p)}>{(c) => <i style={{ flex: String(c.n), background: c.color }} />}</For>
                    </span>
                  </Show>
                  <Show when={needsAttention(p)}><span class="badge" title="Needs input" /></Show>
                  <span class="count">{p.tabs.length || ""}</span>
                  <button
                    class="gear"
                    title="Appearance"
                    aria-label={`Appearance of ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setApp("activeProject", p.id);
                      openAppearance(e.currentTarget, p.id);
                    }}
                  >
                    ◐
                  </button>
                  <button class="x" title="Remove project" aria-label={`Remove ${p.name}`} onClick={(e) => (e.stopPropagation(), remove(p))}>×</button>
                </div>
              )}
            </For>
          </section>
        )}
      </For>
      <div class="side-actions">
        <button class="add" title="Open project (Alt+O)" onClick={() => openProjectDialog()}>
          +<span class="label"> Open project</span><kbd class="label">Alt O</kbd>
        </button>
        <button class="add env" title="Add environment" onClick={() => openProjectDialog(undefined, true)}>
          ⇄<span class="label"> Add environment</span>
        </button>
      </div>
    </aside>
  );
}
