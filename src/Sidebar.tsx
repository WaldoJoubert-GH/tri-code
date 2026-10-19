import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import {
  Project, app, envIcon, envName, isLocalHost, isTerminal, removeEnvironment, removeProject, renameProject, setApp, setEnvStyle,
  setSidebarCollapsed,
} from "./state";
import { closeBrowser, setBrowsersCovered } from "./browsers";
import { closeSession } from "./terms";
import { appearanceOpen, closeAppearance, forgetBgImage, openAppearance } from "./Appearance";
import { dev, forgetProject, isActive } from "./issues";
import { IconFace, forgetIcon } from "./icons";
import { Icon, iconPickerOpen, toggleIconPicker } from "./lucide";
import { openProjectDialog } from "./OpenProject";
import { SIG_TEXT, forgetSounds, sigOf, sigSummary, topSig } from "./signals";
import { flash } from "./ui";

/** Width of the full sidebar, which the peek floats out to. Matches .app's first grid column. */
const FULL = 220;

// Peek (like Edge's vertical tabs): hovering the rail floats the full list over the canvas
// without reflowing the windows; leaving folds it back.
const [hover, setHover] = createSignal(false);
const [peek, setPeek] = createSignal(false);
export const sidebarPeek = peek;
/** Something opened from the peeked list (appearance, icon picker, a rename) holds it open until it closes. */
const [renaming, setRenaming] = createSignal<string | null>(null);
const held = () => appearanceOpen() || iconPickerOpen() || renaming() !== null;

/** Collapse to the rail, or expand back to the full list. */
export function toggleSidebar() {
  const collapsed = !app.sidebarCollapsed;
  closeAppearance();
  setPeek(false);
  setSidebarCollapsed(collapsed);
  flash(collapsed ? "sidebar collapsed" : "sidebar expanded");
}

/** End a project's windows and drop everything stored for it. */
function dropProject(p: Project) {
  for (const t of p.tabs) {
    if (t.kind === "browser") closeBrowser(t);
    else if (isTerminal(t)) closeSession(t.id);
  }
  invoke("bg_delete", { projectId: p.id }).catch((e) => console.error("bg_delete failed:", e));
  forgetBgImage(p.id);
  forgetIcon(p.id);
  forgetProject(p.id);
  forgetSounds(p.id);
  removeProject(p.id);
}

/** Rename in place: Enter or blur saves, Escape cancels. `save` gets the trimmed value, possibly empty. */
function RenameInput(props: { value: string; placeholder?: string; save: (value: string) => void; done: () => void }) {
  let cancelled = false;
  const save = (value: string) => {
    if (!cancelled) props.save(value.trim());
    props.done();
  };
  return (
    <input
      class="rename"
      value={props.value}
      placeholder={props.placeholder}
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
  // A short delay on the way in so sweeping past the rail doesn't flicker it open, a longer one on the way out.
  let timer: number | undefined;
  createEffect(() => {
    const want = app.sidebarCollapsed && (hover() || (peek() && held()));
    clearTimeout(timer);
    if (want !== peek()) timer = window.setTimeout(() => setPeek(want), want ? 180 : 260);
  });
  createEffect(() => setBrowsersCovered(peek() ? FULL : 0));
  onCleanup(() => clearTimeout(timer));

  /** The loudest signal among another project's windows, and how many windows share it. */
  const badge = (p: Project) => {
    const s = app.activeProject === p.id ? null : topSig(p.tabs);
    return s ? { s, n: p.tabs.filter((t) => sigOf(t) === s).length } : null;
  };

  const remove = (p: Project) => {
    if (!confirm(`Remove "${p.name}" and end its ${p.tabs.length} tab(s)?`)) return;
    dropProject(p);
  };

  const removeEnv = (host: string) => {
    const ps = app.projects.filter((p) => p.host === host);
    const tabs = ps.reduce((n, p) => n + p.tabs.length, 0);
    if (ps.length && !confirm(`Remove environment "${envName(host)}", its ${ps.length} project(s) and ${tabs} tab(s)?`)) return;
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
    <aside onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div class="side-head">
        <span>Projects</span>
        <button
          class="collapse"
          onClick={toggleSidebar}
          title={`${peek() ? "Keep sidebar open" : app.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} (Alt+S)`}
          aria-label={peek() ? "Keep sidebar open" : app.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!app.sidebarCollapsed || peek()}
        >
          {peek() ? "⇥" : app.sidebarCollapsed ? "»" : "«"}
        </button>
      </div>
      <For each={app.environments}>
        {(host) => (
          <section>
            <h2 title={app.sidebarCollapsed && !peek() ? (envName(host) === host ? host : `${envName(host)} · ${host}`) : undefined}>
              <button
                class="env-icon"
                title="Change icon"
                aria-label={`Icon of ${envName(host)}`}
                onClick={(e) => toggleIconPicker(e.currentTarget, envIcon(host), (icon) => setEnvStyle(host, { icon }))}
              >
                <Icon name={envIcon(host)} size={14} />
              </button>
              <Show
                when={renaming() === `env:${host}`}
                fallback={
                  <span class="host" title={`${isLocalHost(host) ? "This machine" : `ssh ${host}`} · double-click to rename`} onDblClick={() => setRenaming(`env:${host}`)}>
                    {envName(host)}
                    <Show when={envName(host) !== host}><span class="real">{host}</span></Show>
                  </span>
                }
              >
                <RenameInput value={envName(host)} placeholder={host} save={(name) => setEnvStyle(host, { name })} done={() => setRenaming(null)} />
              </Show>
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
                  title={[app.sidebarCollapsed && !peek() ? `${p.name} · ${envName(p.host)} · ${p.tabs.length} window${p.tabs.length === 1 ? "" : "s"}` : "", sigSummary(p)].filter(Boolean).join("\n") || undefined}
                  onClick={() => setApp("activeProject", p.id)}
                >
                  <span class="swatch"><IconFace project={p} /></span>
                  <Show when={badge(p)}>
                    {(b) => <span class={`sb s-${b().s}`} aria-label={`${b().n} ${SIG_TEXT[b().s]}`}>{b().n > 1 ? b().n : ""}</span>}
                  </Show>
                  <Show when={renaming() === p.id} fallback={<span class="name" title="Double-click to rename" onDblClick={() => setRenaming(p.id)}>{p.name}</span>}>
                    <RenameInput
                      value={p.name}
                      save={(name) => renameProject(p.id, name || p.path.split(/[\\/]/).filter(Boolean).pop() || p.name)}
                      done={() => setRenaming(null)}
                    />
                  </Show>
                  <Show when={miniBar(p).length}>
                    <span class="minibar" title={miniBar(p).map((c) => `${c.n} ${c.name}`).join(" · ")}>
                      <For each={miniBar(p)}>{(c) => <i style={{ flex: String(c.n), background: c.color }} />}</For>
                    </span>
                  </Show>
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
          <span class="glyph">+</span><span class="label">Open project</span><kbd class="label">Alt O</kbd>
        </button>
        <button class="add env" title="Add environment" onClick={() => openProjectDialog(undefined, true)}>
          <span class="glyph">⇄</span><span class="label">Add environment</span>
        </button>
      </div>
    </aside>
  );
}
