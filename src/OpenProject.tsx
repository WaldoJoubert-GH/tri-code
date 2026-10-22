// The Open project dialog (Alt+O): environments on the left, a folder picker for the
// selected one on the right, and "New environment" in the same list. The folder picker's
// field is both the filter and the path: type to filter, Enter goes in (or opens the
// folder you are in when the filter is empty), Backspace on an empty field goes up, and a
// path starting with ~ or / jumps there.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createEffect, createSignal, on, onMount } from "solid-js";
import { type EnvSsh, addEnvironment, addProject, app, envIcon, envName, isLocalHost, setApp, setEnvLock, setEnvSsh } from "./state";
import { PinPad, envLocked, markUnlocked, parseSsh } from "./envlock";
import { Icon } from "./lucide";
import { autoIcon } from "./icons";
import { flash } from "./ui";

type DirList = { path: string; dirs: string[]; repos: string[]; drives: string[]; workspaces: string[] };
/** A row of the folder list: a folder, or a `.code-workspace` file (`ws`). */
type Entry = { name: string; ws?: boolean };

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
            <For each={shown()} fallback={<div class="note">{q() && !isPath() ? `No folder matches “${q()}”` : isPath() ? "Enter jumps to that path" : "No subfolders"}</div>}>
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
        <span><kbd>↵</kbd> in / open here</span>
        <span><kbd>⌫</kbd> up</span>
        <span><kbd>Ctrl</kbd><kbd>↵</kbd> open highlighted</span>
      </div>
    </div>
  );
}

type Test = { state: "wait" | "ok" | "bad"; msg: string; hint?: string };

const RELOCK = [5, 15, 60, 480];
const minutesText = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

/** What to do about a failed test, when the error says. */
function testHint(err: string, key: string | undefined): string | undefined {
  if (/UNPROTECTED PRIVATE KEY|bad permissions/i.test(err))
    return `Other users can read the key, so ssh won't use it. Restrict it with:\nicacls "${key}" /inheritance:r /grant:r "%USERNAME%:R"`;
  if (/Permission denied \(publickey/i.test(err))
    return key
      ? "The server refused this key. If it has a passphrase, add it to ssh-agent first (ssh-add): tri-code can't ask for one."
      : "The server wants a key. Paste the full ssh command, or fill in the key file.";
  return undefined;
}

/** New environment: this machine, or an ssh host (an alias from ~/.ssh/config, user@host, or a
 *  pasted `ssh -i key -p port user@host` command), tested before it is added. An ssh
 *  environment can be locked with a PIN. */
function EnvForm() {
  const hasLocal = () => app.environments.some(isLocalHost);
  const [kind, setKind] = createSignal<"local" | "ssh">(hasLocal() ? "ssh" : "local");
  const [raw, setRaw] = createSignal("");
  const [key, setKey] = createSignal("");
  const [test, setTest] = createSignal<Test | null>(null);
  const [aliases, setAliases] = createSignal<string[]>([]);
  const [pinOn, setPinOn] = createSignal(false);
  const [pin, setPin] = createSignal("");
  const [pin2, setPin2] = createSignal("");
  const [relock, setRelock] = createSignal(15);
  let input: HTMLInputElement | undefined;

  onMount(() => {
    invoke<string[]>("ssh_hosts").then(setAliases).catch(() => {});
    input?.focus();
  });

  const parsed = () => parseSsh(raw());
  const host = () => (kind() === "local" ? "local" : parsed().dest);
  const ssh = (): EnvSsh | undefined => {
    const p = parsed(), identityFile = key().trim() || undefined;
    return identityFile || p.port || p.options ? { identityFile, port: p.port, options: p.options } : undefined;
  };
  const pinProblem = () => {
    if (!pinOn()) return "";
    if (!/^\d{4,8}$/.test(pin())) return "PIN must be 4–8 digits";
    if (pin() !== pin2()) return "PINs don't match";
    return "";
  };
  const edited = () => setTest(null);
  const onRaw = (v: string) => {
    setRaw(v);
    const k = parseSsh(v).identityFile;
    if (k) setKey(k);
    edited();
  };
  const pick = (h: string) => {
    onRaw(h);
    runTest();
  };
  const runTest = async () => {
    const h = host();
    if (!h) return false;
    const opts = ssh();
    setTest({ state: "wait", msg: `ssh${opts?.identityFile ? ` -i "${opts.identityFile}"` : ""}${opts?.port ? ` -p ${opts.port}` : ""} ${h} …` });
    try {
      await invoke("env_ssh_set", { host: h, ssh: opts ?? null });
      const l = await invoke<DirList>("list_dirs", { host: h, path: "~" });
      if (host() !== h) return false;
      setTest({ state: "ok", msg: `✓ connected · ${l.path} · ${l.dirs.length} folders` });
      return true;
    } catch (e) {
      if (host() === h) setTest({ state: "bad", msg: `✗ ${e}`, hint: testHint(String(e), opts?.identityFile) });
      return false;
    }
  };
  const add = async () => {
    const h = host();
    if (!h || pinProblem()) return;
    if (app.environments.includes(h)) return setSelected(h);
    if (kind() === "ssh" && test()?.state !== "ok" && !(await runTest())) return;
    if (kind() === "ssh") {
      if (pinOn()) {
        try {
          const { salt, hash } = await invoke<{ salt: string; hash: string }>("env_pin_hash", { pin: pin() });
          setEnvLock(h, { salt, hash, minutes: relock() });
          markUnlocked(h, relock());
        } catch (e) {
          return setTest({ state: "bad", msg: `✗ ${e}` });
        }
      }
      setEnvSsh(h, ssh());
    }
    addEnvironment(h);
    setSelected(h);
  };

  return (
    <form class="pane env-form" onSubmit={(e) => (e.preventDefault(), add())}>
      <h3>New environment</h3>
      <div class="env-kind">
        <button type="button" aria-pressed={kind() === "local"} disabled={hasLocal()} title={hasLocal() ? "local is already added" : undefined} onClick={() => (setKind("local"), edited())}>
          <Icon name="laptop" size={12} /> Local
        </button>
        <button type="button" aria-pressed={kind() === "ssh"} onClick={() => (setKind("ssh"), edited())}>
          <Icon name="server" size={12} /> SSH
        </button>
      </div>
      <Show when={kind() === "ssh"} fallback={<p class="hint">This machine. Projects run in local shells.</p>}>
        <Show when={aliases().length}>
          <span class="hint">From ~/.ssh/config</span>
          <div class="chips">
            <For each={aliases()}>
              {(h) => (
                <button type="button" class="chip" classList={{ on: raw() === h }} disabled={app.environments.includes(h)} onClick={() => pick(h)}>
                  {h}
                </button>
              )}
            </For>
          </div>
        </Show>
        <input
          ref={input}
          placeholder="alias, user@host, or paste: ssh -i key.pem user@host"
          value={raw()}
          spellcheck={false}
          onInput={(e) => onRaw(e.currentTarget.value)}
        />
        <Show when={parsed().dest && raw().trim() !== parsed().dest}>
          <div class="parsed">
            <span><b>host</b>{parsed().dest}</span>
            <Show when={parsed().port}><span><b>port</b>{parsed().port}</span></Show>
            <For each={parsed().options ?? []}>{(o) => <span><b>-o</b>{o}</span>}</For>
          </div>
        </Show>
        <label class="field">
          <span class="hint"><Icon name="key-round" size={12} /> Key file</span>
          <input
            placeholder="none: ~/.ssh/config and ~/.ssh/id_* decide"
            value={key()}
            spellcheck={false}
            onInput={(e) => (setKey(e.currentTarget.value), edited())}
          />
        </label>
      </Show>
      <Show when={test()}>
        {(t) => (
          <>
            <div class="test" classList={{ [t().state]: true }}>{t().msg}</div>
            <Show when={t().hint}><div class="test tip">{t().hint}</div></Show>
          </>
        )}
      </Show>
      <Show when={kind() === "ssh"}>
        <button type="button" class="pin-switch" role="switch" aria-checked={pinOn()} onClick={() => setPinOn(!pinOn())}>
          <span class="track" />
          <Icon name="lock" size={12} /> Lock with PIN
        </button>
        <Show when={pinOn()}>
          <div class="pin-fields">
            <input class="pin" type="password" inputmode="numeric" maxlength={8} placeholder="PIN" autocomplete="off" value={pin()} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ""))} />
            <input class="pin" type="password" inputmode="numeric" maxlength={8} placeholder="again" autocomplete="off" value={pin2()} onInput={(e) => setPin2(e.currentTarget.value.replace(/\D/g, ""))} />
          </div>
          <label class="relock">
            <span class="hint">Relock</span>
            <select value={String(relock())} onChange={(e) => setRelock(Number(e.currentTarget.value))}>
              <For each={RELOCK}>{(m) => <option value={String(m)}>{minutesText(m)} after unlock</option>}</For>
            </select>
            <span class="hint">and on restart</span>
          </label>
          <Show when={pinProblem() && (pin() || pin2())}><p class="hint bad">{pinProblem()}</p></Show>
        </Show>
      </Show>
      <div class="actions">
        <button type="button" onClick={() => setSelected(app.environments[0] ?? null)}>Cancel</button>
        <button type="submit" class="primary" disabled={!host() || test()?.state === "wait" || !!pinProblem()}>
          {kind() === "local" || test()?.state === "ok" ? "Add" : "Test & add"}
        </button>
      </div>
    </form>
  );
}
