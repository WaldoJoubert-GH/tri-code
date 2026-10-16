// The Open project dialog (Alt+O): environments on the left, a folder picker for the
// selected one on the right, and "New environment" in the same list. The folder picker's
// field is both the filter and the path: type to filter, Enter goes in (or opens the
// folder you are in when the filter is empty), Backspace on an empty field goes up, and a
// path starting with ~ or / jumps there.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, on, onMount } from "solid-js";
import { addEnvironment, addProject, app, isLocalHost, setApp } from "./state";
import { autoIcon } from "./icons";
import { flash } from "./ui";

type DirList = { path: string; dirs: string[]; repos: string[]; drives: string[] };

/** The selected environment, or NEW for the New environment form. */
const NEW = "+";
const [selected, setSelected] = createSignal<string | null>(null);

export const openProjectOpen = () => selected() !== null;

/** Open the dialog on `host` (default: the active project's), or on the New environment form. */
export function openProjectDialog(host?: string, newEnv = false) {
  const active = app.projects.find((p) => p.id === app.activeProject)?.host;
  setSelected(newEnv ? NEW : host ?? active ?? app.environments[0] ?? NEW);
}

export function closeOpenProject() {
  setSelected(null);
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const join = (dir: string, name: string) => `${dir.replace(/[\\/]$/, "")}/${name}`;

/** Open `path` on `host` as a project, or focus it if it already is one. */
function open(host: string, path: string) {
  const existing = app.projects.find((p) => p.host === host && p.path === path);
  if (existing) {
    setApp("activeProject", existing.id);
    flash(`${existing.name} is already open`);
  } else {
    autoIcon(addProject(baseName(path), host, path));
  }
  closeOpenProject();
}

export function OpenProjectDialog() {
  return (
    <Show when={selected()}>
      {(sel) => (
        <div class="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && closeOpenProject()}>
          <div class="open-dlg" role="dialog" aria-label="Open project">
            <header>
              <span>Open project</span>
              <button type="button" title="Close (Esc)" aria-label="Close" onClick={closeOpenProject}>×</button>
            </header>
            <nav>
              <div class="mt">Environments</div>
              <For each={app.environments}>
                {(h) => (
                  <button type="button" class="env" aria-pressed={sel() === h} onClick={() => setSelected(h)}>
                    <span class="nm">{h}</span>
                    <span class="kind">{isLocalHost(h) ? "local" : "ssh"}</span>
                  </button>
                )}
              </For>
              <button type="button" class="env new" aria-pressed={sel() === NEW} onClick={() => setSelected(NEW)}>
                + New environment
              </button>
            </nav>
            <Show when={sel() !== NEW} fallback={<EnvForm />}>
              <Show when={sel()} keyed>
                {(host) => <FolderPane host={host} />}
              </Show>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

function FolderPane(props: { host: string }) {
  const recent = () => app.recent.filter((r) => r.host === props.host);
  return (
    <div class="pane">
      <Show when={recent().length}>
        <div class="recent">
          <span>Recent</span>
          <For each={recent()}>
            {(r) => (
              <button type="button" class="chip" title={r.path} onClick={() => open(r.host, r.path)}>
                {baseName(r.path)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <FolderPicker host={props.host} onOpen={(path) => open(props.host, path)} />
    </div>
  );
}

function FolderPicker(props: { host: string; onOpen: (path: string) => void }) {
  const [list, setList] = createSignal<DirList>();
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;

  const go = async (path: string) => {
    setLoading(true);
    setError("");
    try {
      setList(await invoke<DirList>("list_dirs", { host: props.host, path }));
      setQ("");
      setSel(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      input?.focus();
    }
  };
  onMount(() => go("~"));

  const isPath = () => /^[~/]/.test(q()) || /^[a-zA-Z]:([\\/]|$)/.test(q());
  /** Folders matching the filter, prefix matches first. */
  const shown = () => {
    const l = list();
    if (!l) return [];
    const f = q().toLowerCase();
    if (!f || isPath()) return l.dirs;
    return l.dirs
      .filter((d) => d.toLowerCase().includes(f))
      .sort((a, b) => Number(b.toLowerCase().startsWith(f)) - Number(a.toLowerCase().startsWith(f)));
  };
  const isRepo = (d: string) => list()?.repos.includes(d) ?? false;
  const into = (d: string) => join(list()!.path, d);
  const crumbs = () => {
    const path = list()?.path ?? "";
    const parts = path.split(/[\\/]/).filter(Boolean);
    const root = path.startsWith("/") ? "/" : "";
    return parts.map((name, i) => ({ name, path: root + parts.slice(0, i + 1).join("/") + (root ? "" : "/") }));
  };

  createEffect(on(sel, (i) => listEl?.children[i]?.scrollIntoView({ block: "nearest" })));

  const onKey = (e: KeyboardEvent) => {
    const s = shown(), cur = s[sel()];
    if (e.key === "ArrowDown") setSel(Math.min(sel() + 1, s.length - 1));
    else if (e.key === "ArrowUp") setSel(Math.max(sel() - 1, 0));
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { if (cur) props.onOpen(into(cur)); }
    else if (e.key === "Enter") {
      if (isPath()) go(q());
      else if (q() && cur) go(into(cur));
      else if (!q() && list()) props.onOpen(list()!.path);
    }
    else if ((e.key === "Tab" || (e.key === "ArrowRight" && input?.selectionStart === q().length)) && cur && !isPath()) go(into(cur));
    else if (e.key === "Backspace" && !q() && list()) go(join(list()!.path, ".."));
    else return;
    e.preventDefault();
  };

  return (
    <div class="picker" classList={{ loading: loading() }}>
      <Show when={(list()?.drives.length ?? 0) > 1}>
        <div class="drives">
          <For each={list()!.drives}>
            {(d) => (
              <button type="button" aria-pressed={list()!.path.toUpperCase().startsWith(d.slice(0, 2))} onClick={() => go(d)}>
                {d.slice(0, 2)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="crumbs">
        <Show when={list()?.path.startsWith("/")}>
          <button type="button" onClick={() => go("/")}>/</button>
        </Show>
        <For each={crumbs()}>
          {(c, i) => (
            <>
              <button type="button" onClick={() => go(c.path)}>{c.name}</button>
              <Show when={i() < crumbs().length - 1}><span class="sl">/</span></Show>
            </>
          )}
        </For>
      </div>
      <input
        ref={input}
        class="q"
        placeholder="Filter, or type ~/path or D:"
        value={q()}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => { setQ(e.currentTarget.value); setSel(0); }}
        onKeyDown={onKey}
      />
      <div class="list" ref={listEl}>
        <Show when={!error()} fallback={<div class="note err">{error()}</div>}>
          <Show when={list()} fallback={<div class="note">{isLocalHost(props.host) ? "Loading…" : `Connecting to ${props.host}…`}</div>}>
            <For each={shown()} fallback={<div class="note">{q() && !isPath() ? `No folder matches “${q()}”` : isPath() ? "Enter jumps to that path" : "No subfolders"}</div>}>
              {(d, i) => (
                <div class="row" classList={{ sel: i() === sel() }} onClick={() => go(into(d))} onMouseMove={() => setSel(i())}>
                  <span class="ic">▸</span>
                  <span class="nm">{d}</span>
                  <Show when={isRepo(d)}><span class="git">git</span></Show>
                  <button type="button" class="use" onClick={(e) => (e.stopPropagation(), props.onOpen(into(d)))}>open</button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
      <div class="pfoot">
        <span class="here" title={list()?.path}><bdi>{list()?.path ?? ""}</bdi></span>
        <button type="button" class="primary" disabled={!list()} onClick={() => list() && props.onOpen(list()!.path)}>Open here</button>
      </div>
      <div class="keys">
        <span><kbd>↵</kbd> in / open here</span>
        <span><kbd>⌫</kbd> up</span>
        <span><kbd>Ctrl</kbd><kbd>↵</kbd> open highlighted</span>
      </div>
    </div>
  );
}

type Test = { state: "wait" | "ok" | "bad"; msg: string };

/** New environment: this machine, or an ssh host (an alias from ~/.ssh/config or user@host), tested before it is added. */
function EnvForm() {
  const hasLocal = () => app.environments.some(isLocalHost);
  const [kind, setKind] = createSignal<"local" | "ssh">(hasLocal() ? "ssh" : "local");
  const [dest, setDest] = createSignal("");
  const [test, setTest] = createSignal<Test | null>(null);
  const [aliases, setAliases] = createSignal<string[]>([]);
  let input: HTMLInputElement | undefined;

  onMount(() => {
    invoke<string[]>("ssh_hosts").then(setAliases).catch(() => {});
    input?.focus();
  });

  const host = () => (kind() === "local" ? "local" : dest().trim());
  const pick = (h: string) => {
    setDest(h);
    runTest();
  };
  const runTest = async () => {
    const h = host();
    if (!h) return false;
    setTest({ state: "wait", msg: `ssh ${h} …` });
    try {
      const l = await invoke<DirList>("list_dirs", { host: h, path: "~" });
      if (host() !== h) return false;
      setTest({ state: "ok", msg: `✓ connected · ${l.path} · ${l.dirs.length} folders` });
      return true;
    } catch (e) {
      if (host() === h) setTest({ state: "bad", msg: `✗ ${e}` });
      return false;
    }
  };
  const add = async () => {
    const h = host();
    if (!h) return;
    if (app.environments.includes(h)) return setSelected(h);
    if (kind() === "ssh" && test()?.state !== "ok" && !(await runTest())) return;
    addEnvironment(h);
    setSelected(h);
  };

  return (
    <form class="pane env-form" onSubmit={(e) => (e.preventDefault(), add())}>
      <h3>New environment</h3>
      <div class="env-kind">
        <button type="button" aria-pressed={kind() === "local"} disabled={hasLocal()} title={hasLocal() ? "local is already added" : undefined} onClick={() => (setKind("local"), setTest(null))}>
          ⌂ Local
        </button>
        <button type="button" aria-pressed={kind() === "ssh"} onClick={() => (setKind("ssh"), setTest(null))}>⇄ SSH</button>
      </div>
      <Show when={kind() === "ssh"} fallback={<p class="hint">This machine. Projects run in local shells.</p>}>
        <Show when={aliases().length}>
          <span class="hint">From ~/.ssh/config</span>
          <div class="chips">
            <For each={aliases()}>
              {(h) => (
                <button type="button" class="chip" classList={{ on: dest() === h }} disabled={app.environments.includes(h)} onClick={() => pick(h)}>
                  {h}
                </button>
              )}
            </For>
          </div>
        </Show>
        <input
          ref={input}
          placeholder="alias or user@host"
          value={dest()}
          spellcheck={false}
          onInput={(e) => (setDest(e.currentTarget.value), setTest(null))}
        />
      </Show>
      <Show when={test()}>{(t) => <div class="test" classList={{ [t().state]: true }}>{t().msg}</div>}</Show>
      <div class="actions">
        <button type="button" onClick={() => setSelected(app.environments[0] ?? null)}>Cancel</button>
        <button type="submit" class="primary" disabled={!host() || test()?.state === "wait"}>
          {kind() === "local" || test()?.state === "ok" ? "Add" : "Test & add"}
        </button>
      </div>
    </form>
  );
}
