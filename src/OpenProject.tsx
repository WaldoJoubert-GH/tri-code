// The Open project dialog (Alt+O): environments on the left; on the right three tabs (Ctrl+1–3):
// Open (a folder picker for the selected environment), New folder (a name, and the picker to say
// where), Clone (a repository URL, and the picker to say where). "New environment" in the list
// opens the Environment dialog over this one and comes back to what it added. The folder picker's
// field is both the filter and the path: type to filter, Enter goes in (or opens the folder you
// are in when the filter is empty), Backspace on an empty field goes up, and a path starting
// with ~ or / jumps there. Chosen from design/open-project.html (variant A).

import { Channel, invoke } from "@tauri-apps/api/core";
import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { addProject, app, envIcon, envName, isLocalHost, setApp } from "./state";
import { PinPad, envLocked } from "./envlock";
import { openEnvDialog } from "./EnvDialog";
import { Icon } from "./lucide";
import { autoIcon } from "./icons";
import { flash } from "./ui";
import { Key } from "./Keys";
import { addLines, caselessPath, isRepoUrl, nameProblem, progress, repoFolder, shortUrl, type CloneLine } from "./newfolder";

type DirList = { path: string; dirs: string[]; repos: string[]; drives: string[]; workspaces: string[] };
/** A row of the folder list: a folder, or a `.code-workspace` file (`ws`). */
type Entry = { name: string; ws?: boolean };
type Mode = "open" | "new" | "clone";

const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: "open", label: "Open", icon: "folder-open" },
  { id: "new", label: "New folder", icon: "folder-plus" },
  { id: "clone", label: "Clone", icon: "git-branch" },
];

/** The selected environment. */
const [selected, setSelected] = createSignal<string | null>(null);
const [mode, setMode] = createSignal<Mode>("open");
/** The folder each environment's picker was last in, so switching tabs keeps the place. */
const lastDir: Record<string, string> = {};

export const openProjectOpen = () => selected() !== null;

/** Open the dialog on `host` (default: the active project's), on tab `tab`. With no environment to open in, add one first. */
export function openProjectDialog(host?: string, tab: Mode = "open") {
  setMode(tab);
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

/** Open `path` on `host` as a project, or focus it if it already is one. Returns the project's id. Also `tri .` (cli.ts). */
export function openFolder(host: string, path: string): string {
  const existing = app.projects.find((p) => p.host === host && p.path === path);
  if (existing) {
    setApp("activeProject", existing.id);
    flash(`${existing.name} is already open`);
    return existing.id;
  }
  const id = addProject(baseName(path), host, path);
  autoIcon(id);
  return id;
}

function open(host: string, path: string) {
  openFolder(host, path);
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
  // Ctrl, not Alt: Alt+digit is the workspace hotkey, taken before this sees it.
  const onKey = (e: KeyboardEvent) => {
    const i = Number(e.key) - 1;
    if (!e.ctrlKey || e.altKey || e.shiftKey || !MODES[i]) return;
    e.preventDefault();
    setMode(MODES[i].id);
  };
  return (
    <Show when={!envLocked(props.host)} fallback={<div class="pane"><PinPad host={props.host} /></div>}>
      <div class="pane" onKeyDown={onKey}>
        <div class="seg" role="tablist">
          <For each={MODES}>
            {(m, i) => (
              <button type="button" role="tab" aria-selected={mode() === m.id} title={`Ctrl+${i() + 1}`} onClick={() => setMode(m.id)}>
                <Icon name={m.icon} size={12} />
                {m.label}
              </button>
            )}
          </For>
        </div>
        <Switch>
          <Match when={mode() === "open"}>
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
            <FolderPicker
              host={props.host}
              onHere={(path) => open(props.host, path)}
              onOpen={(path) => open(props.host, path)}
              onOpenWorkspace={(file) => open(props.host, dirOf(file))}
            />
          </Match>
          <Match when={mode() === "new"}>
            <NewFolder host={props.host} />
          </Match>
          <Match when={mode() === "clone"}>
            <CloneRepo host={props.host} />
          </Match>
        </Switch>
      </div>
    </Show>
  );
}

/** Where a new folder or a clone will land: the picker's folder, then the name in the accent. */
function Dest(props: { dir?: string; name: string; problem: string }) {
  return (
    <span class="dest">
      <span class="path" title={props.dir && props.name ? join(props.dir, props.name) : undefined}>
        <bdi>
          {props.dir ? join(props.dir, "") : ""}
          <b>{props.name || "…"}</b>
        </bdi>
      </span>
      <Show when={props.problem}>
        <span class="warn">{props.problem}</span>
      </Show>
    </span>
  );
}

function NewFolder(props: { host: string }) {
  const [name, setName] = createSignal("");
  const [init, setInit] = createSignal(true);
  const [list, setList] = createSignal<DirList>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const n = () => name().trim();
  const problem = () => (list() ? nameProblem(n(), list()!.dirs, caselessPath(list()!.path)) : "");
  const ready = () => !!list() && !!n() && !problem() && !busy();
  let input: HTMLInputElement | undefined;
  onMount(() => input?.focus());

  const create = async () => {
    if (!ready()) return void input?.focus();
    const parent = list()!.path;
    setBusy(true);
    setError("");
    try {
      await invoke("make_folder", { host: props.host, parent, name: n(), gitInit: init() });
      flash(`Made ${n()}`);
      open(props.host, join(parent, n()));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="field">
        <label for="nf-name">Name</label>
        <input
          id="nf-name"
          ref={input}
          placeholder="my-new-project"
          value={name()}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => { setName(e.currentTarget.value); setError(""); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void create(); }
          }}
        />
      </div>
      <Show when={error()}>
        <div class="note err">{error()}</div>
      </Show>
      <div class="mt">Create in</div>
      <FolderPicker
        host={props.host}
        pick
        onList={setList}
        onHere={() => void create()}
        footer={
          <>
            <Dest dir={list()?.path} name={n()} problem={problem()} />
            <label class="chk" title="Make it a git repository">
              <input type="checkbox" checked={init()} onChange={(e) => setInit(e.currentTarget.checked)} />
              git init
            </label>
            <button type="button" class="primary" disabled={!ready()} onClick={() => void create()}>
              {busy() ? "Making…" : "Create & open"}
            </button>
          </>
        }
        keys={
          <>
            <span><Key k="↵" /> in the name: create</span>
            <span><Key k="↵" /> in the list: go in</span>
            <span><Key k="⌫" /> up</span>
            <span><Key k="Ctrl" />1–3 tabs</span>
          </>
        }
      />
    </>
  );
}

type Run = { url: string; dest: string; id?: number; code: number | null };

function CloneRepo(props: { host: string }) {
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  /** The folder name was typed, so a new URL no longer renames it. */
  let typedName = false;
  const [list, setList] = createSignal<DirList>();
  const [run, setRun] = createSignal<Run | null>(null);
  const [log, setLog] = createSignal<CloneLine[]>([]);
  let input: HTMLInputElement | undefined;
  let logEl: HTMLPreElement | undefined;
  onMount(() => input?.focus());

  const u = () => url().trim();
  const n = () => name().trim();
  const problem = () => {
    if (u() && !isRepoUrl(u())) return "not a repository URL";
    return list() ? nameProblem(n(), list()!.dirs, caselessPath(list()!.path)) : "";
  };
  const ready = () => !!list() && isRepoUrl(u()) && !!n() && !problem();

  /** The dialog was closed during the clone: it carries on, and says how it went in the status line. */
  let gone = false;
  onCleanup(() => (gone = true));

  const start = async () => {
    if (!ready()) return void input?.focus();
    const parent = list()!.path, folder = n(), dest = join(parent, folder), host = props.host;
    const r: Run = { url: u(), dest, code: null };
    setLog([]);
    setRun(r);
    const onLines = new Channel<CloneLine[]>();
    onLines.onmessage = (batch) => {
      if (run() === r) setLog((l) => addLines(l, batch));
    };
    const onExit = new Channel<number>();
    onExit.onmessage = (code) => {
      if (run() !== r && !gone) return; // cancelled
      if (code === 0) {
        if (gone) { openFolder(host, dest); flash(`Cloned ${folder}`); }
        else { flash(`Cloned ${folder}`); open(host, dest); }
      } else if (gone) {
        flash(`Clone of ${folder} failed`);
      } else {
        setRun({ ...r, code });
      }
    };
    try {
      r.id = await invoke<number>("git_clone", { host, parent, url: r.url, name: folder, onLines, onExit });
    } catch (e) {
      setLog([{ text: String(e), partial: false }]);
      setRun({ ...r, code: -1 });
    }
  };

  const cancel = () => {
    const r = run();
    if (r?.id !== undefined && r.code === null) void invoke("git_clone_cancel", { id: r.id });
    setRun(null);
    requestAnimationFrame(() => input?.focus());
  };

  createEffect(on(log, () => { if (logEl) logEl.scrollTop = logEl.scrollHeight; }));
  const meter = () => progress(log());
  const failed = () => (run()?.code ?? null) !== null;

  return (
    <Show
      when={run()}
      fallback={
        <>
          <div class="field">
            <label for="cl-url">URL</label>
            <input
              id="cl-url"
              ref={input}
              placeholder="https://github.com/owner/repo.git"
              value={url()}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => {
                setUrl(e.currentTarget.value);
                if (!typedName) setName(repoFolder(e.currentTarget.value));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void start(); }
              }}
            />
            <label for="cl-name">Folder</label>
            <input
              id="cl-name"
              placeholder="folder name"
              value={name()}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => {
                setName(e.currentTarget.value);
                typedName = e.currentTarget.value !== "";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void start(); }
              }}
            />
          </div>
          <div class="mt">Clone into</div>
          <FolderPicker
            host={props.host}
            pick
            onList={setList}
            onHere={() => void start()}
            footer={
              <>
                <Dest dir={list()?.path} name={n()} problem={problem()} />
                <button type="button" class="primary" disabled={!ready()} onClick={() => void start()}>Clone & open</button>
              </>
            }
            keys={
              <>
                <span><Key k="↵" /> in a field: clone</span>
                <span><Key k="↵" /> in the list: go in</span>
                <span><Key k="⌫" /> up</span>
                <span><Key k="Ctrl" />1–3 tabs</span>
              </>
            }
          />
        </>
      }
    >
      {(r) => (
        <div class="clone-run" classList={{ failed: failed() }}>
          <div class="cr-h">
            <Icon name="git-branch" size={13} />
            <span class="what">Cloning <b>{shortUrl(r().url)}</b></span>
            <span class="r">{failed() ? "failed" : meter() ? `${meter()!.pct}%` : "starting…"}</span>
          </div>
          <div class="dest">→ <bdi>{r().dest}</bdi></div>
          <div class="bar"><i style={{ width: `${failed() ? 100 : meter()?.pct ?? 0}%` }} /></div>
          <div class="phase">{failed() ? "" : meter()?.phase ?? ""}</div>
          <pre class="log" ref={logEl}>{log().map((l) => l.text).join("\n")}</pre>
          <div class="cr-f">
            <Show when={!failed()}>
              <span class="hint">Closing this dialog leaves the clone running; it opens when done.</span>
            </Show>
            <Show
              when={failed()}
              fallback={<button type="button" class="ghost" onClick={cancel}>Cancel</button>}
            >
              <button type="button" class="ghost" onClick={cancel}>Back</button>
              <button type="button" class="primary" onClick={() => void start()}>Retry</button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

function FolderPicker(props: {
  host: string;
  /** Picking a place for something new: no workspace files, no per-row open. */
  pick?: boolean;
  /** Enter on an empty filter, and the default footer's button. */
  onHere: (path: string) => void;
  onOpen?: (path: string) => void;
  onOpenWorkspace?: (file: string) => void;
  /** Each listing, as it loads. */
  onList?: (list: DirList) => void;
  footer?: JSX.Element;
  keys?: JSX.Element;
}) {
  const [list, setList] = createSignal<DirList>();
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;
  /** A picker under a name field leaves the focus there until it is used. */
  let quiet = !!props.pick;

  const go = async (path: string) => {
    setLoading(true);
    setError("");
    try {
      const l = await invoke<DirList>("list_dirs", { host: props.host, path });
      setList(l);
      lastDir[props.host] = l.path;
      props.onList?.(l);
      setQ("");
      setSel(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      if (!quiet) input?.focus();
      quiet = false;
    }
  };
  onMount(() => go(lastDir[props.host] ?? "~"));

  const isPath = () => /^[~/]/.test(q()) || /^[a-zA-Z]:([\\/]|$)/.test(q());
  /** `.code-workspace` files first, then folders, matching the filter, prefix matches first. */
  const shown = (): Entry[] => {
    const l = list();
    if (!l) return [];
    const ws = props.pick ? [] : (l.workspaces ?? []).map((name) => ({ name, ws: true }));
    const all = [...ws, ...l.dirs.map((name) => ({ name }))];
    const f = q().toLowerCase();
    if (!f || isPath()) return all;
    return all
      .filter((d) => d.name.toLowerCase().includes(f))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(f)) - Number(a.name.toLowerCase().startsWith(f)));
  };
  /** Go into a folder, or open a workspace file. */
  const enter = (e: Entry) => (e.ws ? props.onOpenWorkspace?.(into(e.name)) : go(into(e.name)));
  const use = (e: Entry) => (e.ws ? props.onOpenWorkspace?.(into(e.name)) : props.onOpen?.(into(e.name)));
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
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { if (cur && props.onOpen) use(cur); }
    else if (e.key === "Enter") {
      if (isPath()) go(q());
      else if (q() && cur) enter(cur);
      else if (!q() && list()) props.onHere(list()!.path);
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
        placeholder={props.pick ? "Filter, or type ~/path or D: to go there" : "Filter, or type ~/path or D:"}
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
                  <Show when={props.onOpen}>
                    <button type="button" class="use" onClick={(e) => (e.stopPropagation(), use(d))}>open</button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
      <div class="pfoot">
        {props.footer ?? (
          <>
            <span class="here" title={list()?.path}><bdi>{list()?.path ?? ""}</bdi></span>
            <button type="button" class="primary" disabled={!list()} onClick={() => list() && props.onHere(list()!.path)}>Open here</button>
          </>
        )}
      </div>
      <div class="keys">
        {props.keys ?? (
          <>
            <span><Key k="↵" /> in / open here</span>
            <span><Key k="⌫" /> up</span>
            <span><Key k="Ctrl" /><Key k="↵" /> open highlighted</span>
            <span><Key k="Ctrl" />1–3 tabs</span>
          </>
        )}
      </div>
    </div>
  );
}
