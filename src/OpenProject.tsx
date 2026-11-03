// The Open project dialog (Alt+O): environments on the left, a folder picker for the
// selected one on the right. "New environment" in that list opens the Environment dialog
// over this one and comes back to what it added. The folder picker's field is both the
// filter and the path: type to filter, Enter goes in (or opens the folder you are in when
// the filter is empty), Backspace on an empty field goes up, and a path starting with ~ or
// / jumps there.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, on, onMount } from "solid-js";
import { addProject, app, envIcon, envName, isLocalHost, setApp } from "./state";
import { PinPad, envLocked } from "./envlock";
import { openEnvDialog } from "./EnvDialog";
import { Icon } from "./lucide";
import { autoIcon } from "./icons";
import { flash } from "./ui";
import { Key } from "./Keys";

type DirList = { path: string; dirs: string[]; repos: string[]; drives: string[]; workspaces: string[] };
/** A row of the folder list: a folder, or a `.code-workspace` file (`ws`). */
type Entry = { name: string; ws?: boolean };

/** The selected environment. */
const [selected, setSelected] = createSignal<string | null>(null);

export const openProjectOpen = () => selected() !== null;

/** Open the dialog on `host` (default: the active project's). With no environment to open in, add one first. */
export function openProjectDialog(host?: string) {
  const active = app.projects.find((p) => p.id === app.activeProject)?.host;
  const on = host ?? active ?? app.environments[0];
  if (on === undefined) openEnvDialog(undefined, (added) => setSelected(added));
  else setSelected(on);
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

/** A VS Code `.code-workspace` file opens the folder that holds it, as a plain project. */
const dirOf = (file: string) => file.replace(/[\\/][^\\/]*$/, "") || "/";

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
                    <Icon name={envIcon(h)} size={13} />
                    <span class="nm" title={envName(h) !== h ? h : undefined}>{envName(h)}</span>
                    <span class="kind">{isLocalHost(h) ? "local" : "ssh"}</span>
                  </button>
                )}
              </For>
              <button type="button" class="env new" onClick={() => openEnvDialog(undefined, (added) => setSelected(added))}>
                + New environment
              </button>
            </nav>
            <Show when={sel()} keyed>
              {(host) => <FolderPane host={host} />}
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
    <Show when={!envLocked(props.host)} fallback={<div class="pane"><PinPad host={props.host} /></div>}>
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
        <FolderPicker host={props.host} onOpen={(path) => open(props.host, path)} onOpenWorkspace={(file) => open(props.host, dirOf(file))} />
      </div>
    </Show>
  );
}

function FolderPicker(props: { host: string; onOpen: (path: string) => void; onOpenWorkspace: (file: string) => void }) {
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
  /** `.code-workspace` files first, then folders, matching the filter, prefix matches first. */
  const shown = (): Entry[] => {
    const l = list();
    if (!l) return [];
    const all = [...(l.workspaces ?? []).map((name) => ({ name, ws: true })), ...l.dirs.map((name) => ({ name }))];
    const f = q().toLowerCase();
    if (!f || isPath()) return all;
    return all
      .filter((d) => d.name.toLowerCase().includes(f))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(f)) - Number(a.name.toLowerCase().startsWith(f)));
  };
  /** Go into a folder, or open a workspace file. */
  const enter = (e: Entry) => (e.ws ? props.onOpenWorkspace(into(e.name)) : go(into(e.name)));
  const use = (e: Entry) => (e.ws ? props.onOpenWorkspace(into(e.name)) : props.onOpen(into(e.name)));
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
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { if (cur) use(cur); }
    else if (e.key === "Enter") {
      if (isPath()) go(q());
      else if (q() && cur) enter(cur);
      else if (!q() && list()) props.onOpen(list()!.path);
    }
    else if ((e.key === "Tab" || (e.key === "ArrowRight" && input?.selectionStart === q().length)) && cur && !cur.ws && !isPath()) go(into(cur.name));
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
            <For each={shown()} fallback={<div class="note">{q() && !isPath() ? `No folder matches “${q()}”` : isPath() ? <><Key k="Enter" /> jumps to that path</> : "No subfolders"}</div>}>
              {(d, i) => (
                <div class="row" classList={{ sel: i() === sel(), ws: d.ws }} onClick={() => enter(d)} onMouseMove={() => setSel(i())}>
                  <span class="ic">{d.ws ? <Icon name="braces" size={11} /> : "▸"}</span>
                  <span class="nm">{d.name}</span>
                  <Show when={isRepo(d.name) && !d.ws}><span class="git">git</span></Show>
                  <Show when={d.ws}><span class="git" title="A VS Code workspace: opens the folder it is in">workspace</span></Show>
                  <button type="button" class="use" onClick={(e) => (e.stopPropagation(), use(d))}>open</button>
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
        <span><Key k="↵" /> in / open here</span>
        <span><Key k="⌫" /> up</span>
        <span><Key k="Ctrl" /><Key k="↵" /> open highlighted</span>
      </div>
    </div>
  );
}
