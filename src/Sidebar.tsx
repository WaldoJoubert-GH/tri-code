import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import {
  Project, app, envIcon, envName, isLocalHost, isTerminal, moveProject, projectById, removeEnvironment, removeProject, renameProject, setApp, setEnvStyle,
  setSidebarCollapsed, worktreesOf,
} from "./state";
import { closeBrowser, setBrowsersCovered } from "./browsers";
import { closeSession } from "./terms";
import { appearanceOpen, closeAppearance, forgetBgImage, openAppearance } from "./Appearance";
import { dev, forgetProject, isActive, sourcesOf, stateOf } from "./issues";
import { IconFace, forgetIcon } from "./icons";
import { Icon, iconPickerOpen, toggleIconPicker } from "./lucide";
import { openProjectDialog } from "./OpenProject";
import { SIG_TEXT, forgetSounds, sigOf, sigSummary, topSig } from "./signals";
import { adoptWorktrees, branchOf, loadWorktrees, openNewWorktree, removeWorktree, tileLabel } from "./worktrees";
import { flash } from "./ui";
import { keyOf, withKey } from "./keymap";
import { envLocked, lockEnv } from "./envlock";
import { settingsOpen, toggleSettings } from "./Settings";

/** Width of the full sidebar, which the peek floats out to. Matches .app's first grid column. */
const FULL = 220;

// Peek (like Edge's vertical tabs): hovering the rail floats the full list over the canvas
// without reflowing the windows; leaving folds it back.
const [hover, setHover] = createSignal(false);
const [peek, setPeek] = createSignal(false);
export const sidebarPeek = peek;
/** Something opened from the peeked list (appearance, icon picker, a rename) holds it open until it closes. */
const [renaming, setRenaming] = createSignal<string | null>(null);
const held = () => appearanceOpen() || iconPickerOpen() || settingsOpen() || renaming() !== null;

// Press and drag a project row to move it within its environment. Pointer events rather than HTML5
// drag and drop, so a press that barely moves is still a click and the rail works the same way.
const [dragging, setDragging] = createSignal<string | null>(null);
const [dropAt, setDropAt] = createSignal<{ id: string; after: boolean } | null>(null);
/** The click that follows the pointerup of a drag must not select the project. */
let dragged = false;

function dragProject(e: PointerEvent, p: Project) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
  const x0 = e.clientX, y0 = e.clientY;
  const move = (m: PointerEvent) => {
    if (!dragging()) {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
      setDragging(p.id);
    }
    // A repo's Worktree list counts as its lower half, so dropping there lands below the whole family.
    const el = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>("[data-drop]");
    const q = el && projectById(el.dataset.drop!);
    if (!el || !q || q.id === p.id || q.host !== p.host) return void setDropAt(null);
    const r = el.getBoundingClientRect();
    setDropAt({ id: q.id, after: el.classList.contains("wts") || m.clientY > r.top + r.height / 2 });
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
    const d = dropAt();
    if (d) moveProject(p.id, d.id, d.after);
    if (dragging()) (dragged = true), setTimeout(() => (dragged = false));
    setDragging(null);
    setDropAt(null);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}

/** Collapse to the rail, or expand back to the full list. */
export function toggleSidebar() {
  const collapsed = !app.sidebarCollapsed;
  closeAppearance();
  setPeek(false);
  setSidebarCollapsed(collapsed);
  flash(collapsed ? "sidebar collapsed" : "sidebar expanded");
}

/** End a project's windows and drop everything stored for it. */
export function dropProject(p: Project) {
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
  createEffect(() => document.body.classList.toggle("dragging-project", dragging() !== null));
  onCleanup(() => clearTimeout(timer));

  /** The loudest signal among another project's windows, and how many windows share it. A repo
   *  with Worktrees counts the windows of every checkout but the one you are in. */
  const badge = (p: Project) => {
    const tabs = [p, ...worktreesOf(p.id)].filter((x) => x.id !== app.activeProject).flatMap((x) => x.tabs);
    const s = topSig(tabs);
    return s ? { s, n: tabs.filter((t) => sigOf(t) === s).length } : null;
  };
  const ownBadge = (p: Project) => {
    const s = app.activeProject === p.id ? null : topSig(p.tabs);
    return s ? { s, n: p.tabs.filter((t) => sigOf(t) === s).length } : null;
  };
  /** The repo project or one of its Worktrees is the active project. */
  const inFamily = (p: Project) => app.activeProject === p.id || worktreesOf(p.id).some((w) => w.id === app.activeProject);

  // Branch names come from `git worktree list`; ask again whenever a repo's set of Worktrees changes.
  createEffect(() => {
    for (const p of app.projects) {
      if (!p.parent && worktreesOf(p.id).length && !envLocked(p.host)) void loadWorktrees(p);
    }
  });
  // Once a session, pick up the checkouts already in each repo's `.worktrees/` folder.
  const adopted = new Set<string>();
  createEffect(() => {
    for (const p of app.projects) {
      if (p.parent || p.sample || envLocked(p.host) || adopted.has(p.id)) continue;
      adopted.add(p.id);
      void adoptWorktrees(p).catch(() => {});
    }
  });

  const remove = (p: Project) => {
    const wts = worktreesOf(p.id);
    const tabs = [p, ...wts].reduce((n, x) => n + x.tabs.length, 0);
    if (!confirm(`Remove "${p.name}"${wts.length ? ` and its ${wts.length} worktree(s)` : ""} and end its ${tabs} tab(s)? Worktree folders stay on disk.`)) return;
    wts.forEach(dropProject);
    dropProject(p);
  };

  const removeEnv = (host: string) => {
    const ps = app.projects.filter((p) => p.host === host);
    const tabs = ps.reduce((n, p) => n + p.tabs.length, 0);
    if (ps.length && !confirm(`Remove environment "${envName(host)}", its ${ps.length} project(s) and ${tabs} tab(s)?`)) return;
    ps.forEach(dropProject);
    removeEnvironment(host);
    void invoke("env_ssh_set", { host, ssh: null });
    void invoke("env_forget_lock", { host });
  };

  /** Active issues per State, in each Source's colours (the pi-todos widget). */
  const miniBar = (p: Project) => {
    const d = dev[p.id];
    if (!d?.connected) return [];
    const on = sourcesOf(d.config);
    const counts = new Map<string, { color: string; name: string; n: number }>();
    for (const i of d.issues) {
      if (i.source === "sentry" || !on.includes(i.source) || !isActive(d, i)) continue;
      const s = stateOf(d, i);
      const key = `${i.source}/${s?.id ?? "?"}`;
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
          title={withKey(peek() ? "Keep sidebar open" : app.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar", "sidebar")}
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
              <Show when={app.envLocks[host]}>
                <button
                  class="env-lock"
                  classList={{ on: envLocked(host) }}
                  title={envLocked(host) ? "Locked: open a project to enter the PIN" : "Unlocked: click to lock now"}
                  aria-label={envLocked(host) ? `${envName(host)} is locked` : `Lock ${envName(host)}`}
                  onClick={() => {
                    if (!envLocked(host)) return void lockEnv(host);
                    const first = app.projects.find((p) => p.host === host);
                    if (first) setApp("activeProject", first.id);
                  }}
                >
                  <Icon name={envLocked(host) ? "lock" : "lock-open"} size={12} />
                </button>
              </Show>
              <button class="env-add" title={`Open a project on ${host}`} aria-label={`Open a project on ${host}`} onClick={() => openProjectDialog(host)}>+</button>
              <button class="env-x" title="Remove environment" aria-label={`Remove environment ${host}`} onClick={() => removeEnv(host)}>×</button>
            </h2>
            <For
              each={app.projects.filter((p) => p.host === host && !p.parent)}
              fallback={<button class="env-empty" onClick={() => openProjectDialog(host)}>No projects · open one</button>}
            >
              {(p) => (
                <>
                <div
                  class="project"
                  classList={{
                    active: inFamily(p),
                    lifted: dragging() === p.id,
                    "drop-before": dropAt()?.id === p.id && !dropAt()!.after,
                    "drop-after": dropAt()?.id === p.id && dropAt()!.after && !worktreesOf(p.id).length,
                  }}
                  data-drop={p.id}
                  style={{ "--pa": p.accent }}
                  title={[app.sidebarCollapsed && !peek() ? `${p.name} · ${envName(p.host)} · ${p.tabs.length} window${p.tabs.length === 1 ? "" : "s"}` : "", sigSummary(p)].filter(Boolean).join("\n") || undefined}
                  onPointerDown={(e) => renaming() !== p.id && dragProject(e, p)}
                  onClick={() => !dragged && !inFamily(p) && setApp("activeProject", p.id)}
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
                  <Show when={p.sample}>
                    <span class="sample" title="The tour's sample project: its agents are recordings. Close it with × when you're done.">sample</span>
                  </Show>
                  <Show when={miniBar(p).length}>
                    <span class="minibar" title={miniBar(p).map((c) => `${c.n} ${c.name}`).join(" · ")}>
                      <For each={miniBar(p)}>{(c) => <i style={{ flex: String(c.n), background: c.color }} />}</For>
                    </span>
                  </Show>
                  <span class="count">{worktreesOf(p.id).length ? "" : p.tabs.length || ""}</span>
                  <Show when={!p.sample}>
                    <button
                      class="gear"
                      title={withKey("New worktree", "new-worktree")}
                      aria-label={`New worktree of ${p.name}`}
                      onClick={(e) => (e.stopPropagation(), openNewWorktree(p))}
                    >
                      <Icon name="git-branch-plus" size={13} />
                    </button>
                  </Show>
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
                <Show when={worktreesOf(p.id).length}>
                  {/* Every checkout of the repo, the repo's own folder first: one row each, open or
                      collapsed, with the tile in the same place so nothing moves when the rail peeks. */}
                  <div class="wts" classList={{ "drop-after": dropAt()?.id === p.id && dropAt()!.after }} data-drop={p.id}>
                    <For each={[p, ...worktreesOf(p.id)]}>
                      {(w) => (
                        <div
                          class="wt"
                          classList={{ active: app.activeProject === w.id }}
                          style={{ "--wa": w.accent }}
                          title={[`${branchOf(w)} · ${w.path}${w.tabs.length ? ` · ${w.tabs.length} window${w.tabs.length === 1 ? "" : "s"}` : ""}`, sigSummary(w)].filter(Boolean).join("\n")}
                          onClick={() => setApp("activeProject", w.id)}
                        >
                          <span class="wtile">{w.parent ? tileLabel(w) : <Icon name="git-branch" size={12} />}</span>
                          <Show when={ownBadge(w)}>
                            {(b) => <span class={`sb s-${b().s}`} aria-label={`${b().n} ${SIG_TEXT[b().s]}`}>{b().n > 1 ? b().n : ""}</span>}
                          </Show>
                          <span class="bn">{branchOf(w)}</span>
                          <span class="count">{w.tabs.length || ""}</span>
                          <Show when={w.parent}>
                            <button
                              class="x"
                              title={w.copy ? "Finish: copy the changes back and delete the copy" : "Remove worktree"}
                              aria-label={`${w.copy ? "Finish" : "Remove worktree"} ${branchOf(w)}`}
                              onClick={(e) => (e.stopPropagation(), void removeWorktree(w))}
                            >×</button>
                          </Show>
                        </div>
                      )}
                    </For>
                    <button class="wt new" title={withKey("New worktree", "new-worktree")} onClick={() => openNewWorktree(p)}>
                      <span class="wtile"><Icon name="git-branch-plus" size={12} /></span><span class="bn">New worktree</span>
                    </button>
                  </div>
                </Show>
                </>
              )}
            </For>
          </section>
        )}
      </For>
      <div class="side-actions">
        <button class="add" title={withKey("Open project", "open-project")} onClick={() => openProjectDialog()}>
          <span class="glyph">+</span><span class="label">Open project</span><Show when={keyOf("open-project", " ")}>{(k) => <kbd class="label">{k()}</kbd>}</Show>
        </button>
        <button class="add env" title="Add environment" onClick={() => openProjectDialog(undefined, true)}>
          <span class="glyph">⇄</span><span class="label">Add environment</span>
        </button>
      </div>
      <div class="side-foot">
        <button class="add" id="settingsBtn" title="Settings" aria-expanded={settingsOpen()} aria-haspopup="dialog" onClick={toggleSettings}>
          <span class="glyph"><Icon name="settings" size={15} /></span><span class="label">Settings</span>
        </button>
      </div>
    </aside>
  );
}
