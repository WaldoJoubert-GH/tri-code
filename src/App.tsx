import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import {
  Project, TabKind, activeProject, addProject, addTab, app, isRemote,
  live, loadState, persistChanges, removeProject, removeTab, selectTab, setApp,
} from "./state";
import { closeSession, ensureSession, showOnly } from "./terms";

const KINDS: TabKind[] = ["claude", "pi", "shell"];

export default function App() {
  let termHost!: HTMLDivElement;
  const [ready, setReady] = createSignal(false);

  onMount(async () => {
    // After a webview reload, PTYs from the previous page are unreachable.
    await invoke("pty_kill_all");
    await loadState();
    setReady(true);
  });
  persistChanges(ready);

  // Create sessions for every persisted tab (remote tabs reattach to their
  // shpool/tmux session), then show only the active one.
  createEffect(() => {
    if (!ready()) return;
    for (const p of app.projects) for (const t of p.tabs) ensureSession(p, t, termHost);
    showOnly(activeProject()?.activeTab);
  });

  const closeTab = (p: Project, tabId: string) => {
    if (live[tabId]?.status === "running" && !confirm("Close this tab and end its session?")) return;
    closeSession(tabId);
    removeTab(p.id, tabId);
  };

  return (
    <div class="app">
      <Sidebar />
      <main>
        <Show when={activeProject()} fallback={<div class="empty">Add a project to get started.</div>}>
          {(p) => (
            <div class="tabbar">
              <For each={p().tabs}>
                {(t) => (
                  <div
                    class="tab"
                    classList={{ active: p().activeTab === t.id, attention: live[t.id]?.attention }}
                    title={live[t.id]?.title || t.kind}
                    onClick={() => selectTab(p().id, t.id)}
                    onAuxClick={(e) => e.button === 1 && closeTab(p(), t.id)}
                  >
                    <span class={`dot ${live[t.id]?.status ?? "connecting"}`} />
                    {t.kind}
                    <button class="x" onClick={(e) => (e.stopPropagation(), closeTab(p(), t.id))}>×</button>
                  </div>
                )}
              </For>
              <div class="new-tabs">
                <For each={KINDS}>
                  {(k) => <button onClick={() => addTab(p().id, k)}>+ {k}</button>}
                </For>
              </div>
              <span class="where">{isRemote(p()) ? `${p().host}:` : ""}{p().path}</span>
            </div>
          )}
        </Show>
        <div class="terms" ref={termHost} />
      </main>
    </div>
  );
}

function Sidebar() {
  const [adding, setAdding] = createSignal(false);

  const hosts = () => [...new Set(app.projects.map((p) => p.host))];
  const needsAttention = (p: Project) =>
    p.tabs.some((t) => live[t.id]?.attention) && app.activeProject !== p.id;

  const remove = (p: Project) => {
    if (!confirm(`Remove "${p.name}" and end its ${p.tabs.length} tab(s)?`)) return;
    for (const t of p.tabs) closeSession(t.id);
    removeProject(p.id);
  };

  return (
    <aside>
      <For each={hosts()}>
        {(host) => (
          <section>
            <h2>{host}</h2>
            <For each={app.projects.filter((p) => p.host === host)}>
              {(p) => (
                <div class="project" classList={{ active: app.activeProject === p.id }} onClick={() => setApp("activeProject", p.id)}>
                  <Show when={needsAttention(p)}><span class="badge" title="Needs input" /></Show>
                  <span class="name">{p.name}</span>
                  <span class="count">{p.tabs.length || ""}</span>
                  <button class="x" onClick={(e) => (e.stopPropagation(), remove(p))}>×</button>
                </div>
              )}
            </For>
          </section>
        )}
      </For>
      <Show when={adding()} fallback={<button class="add" onClick={() => setAdding(true)}>+ Add project</button>}>
        <AddProject done={() => setAdding(false)} />
      </Show>
    </aside>
  );
}

function AddProject(props: { done: () => void }) {
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const path = String(f.get("path")).trim();
    const host = String(f.get("host")).trim() || "local";
    const name = String(f.get("name")).trim() || path.split(/[\\/]/).filter(Boolean).pop() || path;
    if (!path) return;
    addProject(name, host, path);
    props.done();
  };
  const knownHosts = () => [...new Set(["local", ...app.projects.map((p) => p.host)])];

  return (
    <form class="add-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && props.done()}>
      <input name="host" placeholder="host (local or ssh alias)" list="hosts" value="local" />
      <datalist id="hosts">
        <For each={knownHosts()}>{(h) => <option value={h} />}</For>
      </datalist>
      <input name="path" placeholder="path, e.g. ~/code/app" autofocus />
      <input name="name" placeholder="name (optional)" />
      <div class="row">
        <button type="submit">Add</button>
        <button type="button" onClick={props.done}>Cancel</button>
      </div>
    </form>
  );
}
