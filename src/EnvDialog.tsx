// The Environment dialog: New environment and Edit environment are this one form, so they can't
// drift apart. Its rules are in envform.ts. A change to the connection is tested before it is kept;
// a new destination moves the Environment and everything on it (state.moveEnvironment).

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { type EnvFields, type EnvKind, type EnvOriginal, emptyFields, envFormView, fieldsFrom, isSshCommand, optionsText, parseSsh, sshOf } from "./envform";
import { envLocked, markUnlocked, moveUnlock, tryPin } from "./envlock";
import { Icon, toggleIconPicker } from "./lucide";
import { addEnvironment, app, envIcon, envName, isLocalHost, isTerminal, moveEnvironment, setEnvLock, setEnvSsh, setEnvStyle } from "./state";
import { moveSessions } from "./terms";
import { flash } from "./ui";

/** `host` set = Edit it; unset = New. onAdded: where to go with a new Environment. */
type Target = { host?: string; onAdded?: (host: string) => void };
const [target, setTarget] = createSignal<Target | null>(null);

export const envDialogOpen = () => target() !== null;
export const closeEnvDialog = () => setTarget(null);
export const openEnvDialog = (host?: string, onAdded?: (host: string) => void) => setTarget({ host, onAdded });

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

export function EnvDialog() {
  return (
    <Show when={target()} keyed>
      {(t) => (
        <div class="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && closeEnvDialog()}>
          <EnvForm host={t.host} onAdded={t.onAdded} />
        </div>
      )}
    </Show>
  );
}

function originalOf(host: string): EnvOriginal {
  const ssh = app.envSsh[host];
  return {
    host, local: isLocalHost(host), hasPin: !!app.envLocks[host],
    port: ssh?.port ?? "", key: ssh?.identityFile ?? "", options: optionsText(ssh?.options),
  };
}

function EnvForm(props: { host?: string; onAdded?: (host: string) => void }) {
  const original = props.host === undefined ? undefined : originalOf(props.host);
  const hasLocal = app.environments.some(isLocalHost);
  const [f, setF] = createStore<EnvFields>(original ? fieldsFrom(original) : emptyFields(hasLocal ? "ssh" : "local"));
  const [name, setName] = createSignal(original ? (app.envStyles[original.host]?.name ?? "") : "");
  const [icon, setIcon] = createSignal<string | undefined>(original && app.envStyles[original.host]?.icon);
  const [relock, setRelock] = createSignal(original ? (app.envLocks[original.host]?.minutes ?? 15) : 15);
  const [aliases, setAliases] = createSignal<string[]>([]);
  const [testMsg, setTestMsg] = createSignal("");
  const [testTip, setTestTip] = createSignal<string | undefined>();
  const [pinError, setPinError] = createSignal("");
  const [unlockPin, setUnlockPin] = createSignal("");
  const [unlockError, setUnlockError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  let nameEl: HTMLInputElement | undefined, destEl: HTMLInputElement | undefined;

  const onHost = () => (original ? app.projects.filter((p) => p.host === original.host) : []);
  const view = createMemo(() =>
    envFormView(f, {
      original,
      hosts: [...app.environments],
      locked: !!original && envLocked(original.host),
      projects: onHost().filter((p) => !p.parent).length,
      terminals: onHost().reduce((n, p) => n + p.tabs.filter(isTerminal).length, 0),
    }),
  );
  const shownIcon = () => icon() ?? (original ? envIcon(original.host) : f.kind === "local" ? "laptop" : "server");

  // A test sets ssh options for the host it tries. What's kept goes back when the dialog closes.
  const tried = new Set<string>();
  let testRun = 0;
  onCleanup(() => {
    testRun++;
    for (const h of tried) void invoke("env_ssh_set", { host: h, ssh: app.envSsh[h] ?? null });
  });

  onMount(() => {
    invoke<string[]>("ssh_hosts").then(setAliases).catch(() => {});
    (f.kind === "ssh" && !original ? destEl : nameEl)?.focus();
  });

  const connEdited = () => {
    testRun++;
    setF("test", null);
    setTestMsg("");
    setTestTip(undefined);
  };
  const setConn = (patch: Partial<EnvFields>) => {
    setF(patch);
    connEdited();
  };
  /** `ssh -i key -p 22 user@host` in the destination field fills in the fields it names. */
  const takeCommand = (raw: string) => {
    const p = parseSsh(raw);
    setConn({
      dest: p.dest,
      ...(p.identityFile ? { key: p.identityFile } : {}),
      ...(p.port ? { port: p.port } : {}),
      ...(p.options ? { options: optionsText(p.options) } : {}),
    });
  };

  const runTest = async (): Promise<boolean> => {
    if (isSshCommand(f.dest)) takeCommand(f.dest);
    const h = f.dest.trim(), ssh = sshOf(f);
    if (!h) return false;
    const run = ++testRun;
    setF("test", "wait");
    setTestTip(undefined);
    setTestMsg(`ssh${ssh?.identityFile ? ` -i "${ssh.identityFile}"` : ""}${ssh?.port ? ` -p ${ssh.port}` : ""} ${h} …`);
    try {
      tried.add(h);
      await invoke("env_ssh_set", { host: h, ssh: ssh ?? null });
      const l = await invoke<{ path: string; dirs: string[] }>("list_dirs", { host: h, path: "~" });
      if (run !== testRun) return false;
      setF("test", "ok");
      setTestMsg(`✓ connected · ${l.path} · ${l.dirs.length} folders`);
      return true;
    } catch (e) {
      if (run === testRun) {
        setF("test", "bad");
        setTestMsg(`✗ ${e}`);
        setTestTip(testHint(String(e), ssh?.identityFile));
      }
      return false;
    }
  };

  const unlock = async () => {
    if (!original || !unlockPin()) return;
    const problem = await tryPin(original.host, unlockPin());
    setUnlockPin("");
    setUnlockError(problem);
  };

  /** Make the new destination the Environment's home: its terminals restart there, and the old
   *  host's options and lock go once its sessions are ended. */
  const move = (from: string, to: string) => {
    const tabs = onHost().flatMap((p) => p.tabs.filter(isTerminal).map((t) => t.id));
    moveEnvironment(from, to);
    moveUnlock(from, to);
    void moveSessions(tabs, from).finally(() => {
      void invoke("env_ssh_set", { host: from, ssh: null });
      void invoke("env_forget_lock", { host: from });
    });
  };

  const save = async () => {
    if (isSshCommand(f.dest)) takeCommand(f.dest);
    const v = view();
    if (v.blocked || saving()) return;
    if (v.needsTest && !(await runTest())) return;
    setSaving(true);
    try {
      if (v.needCur) {
        const problem = await tryPin(original!.host, f.cur);
        if (problem) {
          setF("cur", "");
          return setPinError(problem);
        }
      }
      const fresh = v.needNew ? await invoke<{ salt: string; hash: string }>("env_pin_hash", { pin: f.pin }) : undefined;
      const h = v.host;
      if (v.open) {
        // Before the move, so terminals restarting on the new host connect with these.
        const ssh = sshOf(f);
        await invoke("env_ssh_set", { host: h, ssh: ssh ?? null });
        if (v.moving) move(original!.host, h);
        setEnvSsh(h, ssh);
      }
      if (!original) addEnvironment(h);
      if (name().trim() || icon() || original) setEnvStyle(h, { name: name().trim(), icon: icon() });
      if (v.open) {
        if (fresh) {
          setEnvLock(h, { ...fresh, minutes: relock() });
          markUnlocked(h, relock());
        } else if (v.removing) {
          setEnvLock(h, undefined);
          void invoke("env_forget_lock", { host: h });
        } else if (app.envLocks[h]) setEnvLock(h, { ...app.envLocks[h], minutes: relock() });
      }
      if (v.moving) flash(`${envName(h)} moved to ${h}`);
      closeEnvDialog();
      props.onAdded?.(h);
    } catch (e) {
      flash(String(e));
    } finally {
      setSaving(false);
    }
  };

  const kindDisabled = (k: EnvKind) => (original ? k !== f.kind : k === "local" && view().localDisabled);
  const kindTitle = (k: EnvKind) => (!kindDisabled(k) ? undefined : original ? "An environment keeps its kind. Add a new one instead." : "local is already added");
  const setKind = (k: EnvKind) => setConn({ kind: k });
  const digits = (el: HTMLInputElement) => el.value.replace(/\D/g, "");

  return (
    <form class="env-dlg" role="dialog" aria-label={original ? "Edit environment" : "New environment"} onSubmit={(e) => (e.preventDefault(), save())}>
      <header>
        <span>{original ? "Edit environment" : "New environment"}</span>
        <button type="button" title="Close (Esc)" aria-label="Close" onClick={closeEnvDialog}>×</button>
      </header>
      <div class="body">
        <div class="env-kind" role="group" aria-label="Kind">
          <button type="button" aria-pressed={f.kind === "local"} disabled={kindDisabled("local")} title={kindTitle("local")} onClick={() => setKind("local")}>
            <Icon name="laptop" size={12} /> Local
          </button>
          <button type="button" aria-pressed={f.kind === "ssh"} disabled={kindDisabled("ssh")} title={kindTitle("ssh")} onClick={() => setKind("ssh")}>
            <Icon name="server" size={12} /> SSH
          </button>
        </div>

        <div class="identity">
          <button type="button" class="icon-btn" title="Change icon" aria-label="Change icon" onClick={(e) => toggleIconPicker(e.currentTarget, shownIcon(), setIcon)}>
            <Icon name={shownIcon()} size={15} />
          </button>
          <label class="field">
            <span class="hint">Name</span>
            <input ref={nameEl} value={name()} placeholder={view().host || "the destination"} spellcheck={false} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
        </div>

        <Show when={view().local}>
          <p class="note">This machine. Projects run in local shells, so there is no connection or PIN to set.</p>
        </Show>

        <Show when={view().locked}>
          <div class="section">
            <div class="locked-head"><Icon name="lock" size={13} /> {envName(original!.host)} is locked</div>
            <p class="note">You can rename it now. Enter the PIN to change its connection or lock.</p>
            <div class="locked-row">
              <input
                class="pin" type="password" inputmode="numeric" maxlength={8} autocomplete="off" aria-label="PIN" placeholder="PIN" value={unlockPin()}
                onInput={(e) => (setUnlockPin(digits(e.currentTarget)), setUnlockError(""))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void unlock(); } }}
              />
              <button type="button" onClick={unlock}>Unlock</button>
            </div>
            <Show when={unlockError()}><p class="bad">{unlockError()}</p></Show>
          </div>
        </Show>

        <Show when={view().open}>
          <section class="section">
            <h3>Connection</h3>
            <Show when={aliases().length}>
              <span class="hint">From ~/.ssh/config</span>
              <div class="chips">
                <For each={aliases()}>
                  {(a) => (
                    <button
                      type="button" class="chip" classList={{ on: f.dest.trim() === a }}
                      disabled={a !== original?.host && app.environments.includes(a)}
                      onClick={() => { setConn({ dest: a }); void runTest(); }}
                    >{a}</button>
                  )}
                </For>
              </div>
            </Show>
            <label class="field">
              <span class="hint">Destination</span>
              <input
                ref={destEl} class="m" value={f.dest} placeholder="alias, user@host, or paste: ssh -i key.pem user@host" spellcheck={false}
                onInput={(e) => setConn({ dest: e.currentTarget.value })}
                onChange={(e) => { if (isSshCommand(e.currentTarget.value)) takeCommand(e.currentTarget.value); }}
                onPaste={(e) => {
                  const raw = e.clipboardData?.getData("text") ?? "";
                  if (!isSshCommand(raw)) return;
                  e.preventDefault();
                  takeCommand(raw);
                }}
              />
            </label>
            <Show when={view().taken}><p class="bad">{view().host} is already an environment.</p></Show>
            <Show when={view().badDest && !isSshCommand(f.dest)}><p class="bad">A destination is an alias or user@host, with no spaces.</p></Show>
            <div class="row">
              <label class="field port">
                <span class="hint">Port</span>
                <input class="m" inputmode="numeric" value={f.port} placeholder="22" onInput={(e) => setConn({ port: (e.currentTarget.value = digits(e.currentTarget)) })} />
              </label>
              <label class="field">
                <span class="hint"><Icon name="key-round" size={12} /> Key file</span>
                <input class="m" value={f.key} placeholder="none: ~/.ssh/config and ~/.ssh/id_* decide" spellcheck={false} onInput={(e) => setConn({ key: e.currentTarget.value })} />
              </label>
            </div>
            <label class="field">
              <span class="hint">ssh -o options, separated by spaces</span>
              <input class="m" value={f.options} placeholder="ServerAliveInterval=30" spellcheck={false} onInput={(e) => setConn({ options: e.currentTarget.value })} />
            </label>
            <button type="button" class="test-btn" disabled={view().testing || !f.dest.trim()} onClick={runTest}>
              {view().testing ? "Testing…" : f.test === "bad" ? "Test again" : "Test connection"}
            </button>
            <Show when={testMsg()}><div class={`test ${f.test ?? ""}`} role="status">{testMsg()}</div></Show>
            <Show when={testTip()}><div class="test tip">{testTip()}</div></Show>
            <Show when={view().moveText}>
              <div class="warn-box"><Icon name="triangle-alert" size={14} /><span>{view().moveText}</span></div>
            </Show>
          </section>

          <section class="section">
            <h3>PIN lock</h3>
            <div class="pin-row">
              <button
                type="button" class="pin-switch" role="switch" aria-checked={f.pinOn}
                onClick={() => { setF({ pinOn: !f.pinOn, changing: false, cur: "", pin: "", pin2: "" }); setPinError(""); }}
              >
                <span class="track" /> <Icon name="lock" size={12} /> Lock with PIN
              </button>
              <Show when={view().hasPin && f.pinOn && !f.changing}>
                <button type="button" class="link-btn" onClick={() => setF("changing", true)}>Change PIN…</button>
              </Show>
            </div>
            <Show when={view().removing}>
              <p class="note">Saving removes the lock. Anyone at this computer can then open this environment.</p>
            </Show>
            <Show when={view().needCur}>
              <input
                class="pin" type="password" inputmode="numeric" maxlength={8} autocomplete="off" aria-label="Current PIN" placeholder="current PIN" value={f.cur}
                onInput={(e) => (setF("cur", (e.currentTarget.value = digits(e.currentTarget))), setPinError(""))}
              />
            </Show>
            <Show when={view().needNew}>
              <div class="pin-fields">
                <input class="pin" type="password" inputmode="numeric" maxlength={8} autocomplete="off" aria-label="New PIN" placeholder="PIN" value={f.pin} onInput={(e) => setF("pin", (e.currentTarget.value = digits(e.currentTarget)))} />
                <input class="pin" type="password" inputmode="numeric" maxlength={8} autocomplete="off" aria-label="PIN again" placeholder="again" value={f.pin2} onInput={(e) => setF("pin2", (e.currentTarget.value = digits(e.currentTarget)))} />
              </div>
            </Show>
            <Show when={pinError() || (f.cur || f.pin || f.pin2 ? view().pinProblem : "")}>
              {(msg) => <p class="bad">{msg()}</p>}
            </Show>
            <Show when={f.pinOn}>
              <label class="relock">
                <span>Relock</span>
                <select value={String(relock())} onChange={(e) => setRelock(Number(e.currentTarget.value))}>
                  <For each={RELOCK}>{(m) => <option value={String(m)}>{minutesText(m)} after unlock</option>}</For>
                </select>
                <span>and on restart</span>
              </label>
            </Show>
          </section>
        </Show>
      </div>
      <footer>
        <button type="button" onClick={closeEnvDialog}>Cancel</button>
        <button type="submit" class="primary" disabled={view().blocked || saving()}>{view().primary}</button>
      </footer>
    </form>
  );
}
