import { invoke } from "@tauri-apps/api/core";
import { For, Show, createSignal, onMount } from "solid-js";
import { Project, addProject, app, isTerminal, live, removeProject, setApp, setSidebarCollapsed } from "./state";
import { closeBrowser } from "./browsers";
import { closeSession } from "./terms";
import { closeAppearance, forgetBgImage, openAppearance } from "./Appearance";
import { dev, forgetProject, isActive } from "./issues";
import { flash } from "./ui";

/** Collapse to the rail, or expand back to the full list. */
export function toggleSidebar() {
  const collapsed = !app.sidebarCollapsed;
  closeAppearance();
  setSidebarCollapsed(collapsed);
  flash(collapsed ? "sidebar collapsed" : "sidebar expanded");
}

export default function Sidebar() {
  const [adding, setAdding] = createSignal(false);

  const hosts = () => [...new Set(app.projects.map((p) => p.host))];
  const needsAttention = (p: Project) =>
    app.activeProject !== p.id && p.tabs.some((t) => live[t.id]?.attention);

  const remove = (p: Project) => {
    if (!confirm(`Remove "${p.name}" and end its ${p.tabs.length} tab(s)?`)) return;
    for (const t of p.tabs) {
      if (t.kind === "browser") closeBrowser(t.id);
      else if (isTerminal(t)) closeSession(t.id);
    }
    invoke("bg_delete", { projectId: p.id }).catch((e) => console.error("bg_delete failed:", e));
    forgetBgImage(p.id);
    forgetProject(p.id);
    removeProject(p.id);
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

  const expandThenAdd = () => {
    if (app.sidebarCollapsed) setSidebarCollapsed(false);
    setAdding(true);
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
      <For each={hosts()}>
        {(host) => (
          <section>
            <h2>{host}</h2>
            <For each={app.projects.filter((p) => p.host === host)}>
              {(p) => (
                <div
                  class="project"
                  classList={{ active: app.activeProject === p.id }}
                  style={{ "--pa": p.accent }}
                  title={app.sidebarCollapsed ? `${p.name} · ${p.host} · ${p.tabs.length} window${p.tabs.length === 1 ? "" : "s"}` : undefined}
                  onClick={() => setApp("activeProject", p.id)}
                >
                  <span class="swatch"><b>{p.name[0]}</b></span>
                  <span class="name">{p.name}</span>
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
      <Show
        when={adding()}
        fallback={
          <button class="add" title="Add project" onClick={expandThenAdd}>
            +<span class="label"> Add project</span>
          </button>
        }
      >
        <AddProject done={() => setAdding(false)} />
      </Show>
    </aside>
  );
}

type DirList = { path: string; dirs: string[] };

function AddProject(props: { done: () => void }) {
  const [host, setHost] = createSignal("local");
  const [path, setPath] = createSignal("");
  const [browsing, setBrowsing] = createSignal(false);

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const p = path().trim();
    const h = host().trim() || "local";
    const name = String(f.get("name")).trim() || p.split(/[\\/]/).filter(Boolean).pop() || p;
    if (!p) return;
    addProject(name, h, p);
    props.done();
  };
  const knownHosts = () => [...new Set(["local", ...app.projects.map((p) => p.host)])];

  return (
    <form class="add-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && props.done()}>
      <input name="host" placeholder="host (local or ssh alias)" list="hosts" value={host()} onInput={(e) => setHost(e.currentTarget.value)} />
      <datalist id="hosts">
        <For each={knownHosts()}>{(h) => <option value={h} />}</For>
      </datalist>
      <div class="path-row">
        <input name="path" placeholder="path, e.g. ~/code/app" autofocus value={path()} onInput={(e) => setPath(e.currentTarget.value)} />
        <button type="button" title="Browse folders" onClick={() => setBrowsing(!browsing())}>…</button>
      </div>
      <Show when={browsing()}>
        <DirBrowser host={host().trim() || "local"} start={path().trim() || "~"} pick={(p) => (setPath(p), setBrowsing(false))} />
      </Show>
      <input name="name" placeholder="name (optional)" />
      <div class="row">
        <button type="submit">Add</button>
        <button type="button" onClick={props.done}>Cancel</button>
      </div>
    </form>
  );
}

/** Folder picker that works the same for local and ssh hosts. */
function DirBrowser(props: { host: string; start: string; pick: (path: string) => void }) {
  const [list, setList] = createSignal<DirList>();
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  const go = async (path: string) => {
    setLoading(true);
    setError("");
    try {
      setList(await invoke<DirList>("list_dirs", { host: props.host, path }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  const into = (name: string) => `${list()!.path.replace(/[\\/]$/, "")}/${name}`;
  // Fall back to home if the typed path does not exist.
  onMount(() => go(props.start).then(() => { if (error()) go("~"); }));

  return (
    <div class="dirs" classList={{ loading: loading() }}>
      <Show when={list()}>
        {(l) => (
          <>
            <div class="dirs-head" title={l().path}><bdi>{l().path}</bdi></div>
            <div class="dirs-list">
              <div class="dir" onClick={() => go(into(".."))}>..</div>
              <For each={l().dirs}>
                {(d) => <div class="dir" onClick={() => go(into(d))}>{d}</div>}
              </For>
            </div>
            <button type="button" class="dirs-pick" onClick={() => props.pick(l().path)}>Use this folder</button>
          </>
        )}
      </Show>
      <Show when={error()}><div class="dirs-error">{error()}</div></Show>
      <Show when={!list() && loading()}><div class="dirs-head">Loading…</div></Show>
    </div>
  );
}
