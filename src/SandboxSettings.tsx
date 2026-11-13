// Settings › Sandbox: Docker Sandboxes (sbx) for Sandboxed Worktrees. Setting sbx up, whether New
// worktree starts sandboxed, the keys sbx adds to agents' requests, the network the sandboxes may
// reach, the folders every sandbox also sees, and the sandboxes themselves. Everything here is sbx's
// own state on the chosen host (this machine, or an ssh host whose projects are sandboxed by the sbx
// there), read fresh when the page opens or the host changes (sandbox.ts). Chosen from design/sandbox.html.

import { For, Show, createEffect, createSignal, on } from "solid-js";
import "./sandbox.css";
import { activeProject, addTab, app, focusTab, setSandboxSettings } from "./state";
import {
  type Blocked, type Box, type KeyHow, type Rule, type Secret, SERVICES,
  allowHost, hostKey, listBlocked, listBoxes, listRules, listSecrets, refreshSbx, removeRule, removeSandbox, removeSecret, sandboxHost, setSandboxHost,
  type Template, SIGNIN_BOX, connectGithub, listTemplates, removeTemplate, sandboxByDefault, signInBox, signOutClaude, sandboxFolders, sbxState, serviceLabel, setSecret, stopSandbox,
} from "./sandbox";
import { flash } from "./ui";

const windows = /Windows/i.test(navigator.userAgent);
const mac = /Mac/i.test(navigator.userAgent);

/** How a host is named on this page. */
const hostName = (host: string) => (hostKey(host) === "local" ? "this machine" : host);

/** The hosts with projects: this machine, then each ssh host, so each one's sbx can be set up. */
const hosts = () => ["local", ...new Set(app.projects.map((p) => hostKey(p.host)).filter((h) => h !== "local"))];

/** Run a setup step in a terminal on `host`, where its prompts and browser sign-in show: in the
 *  active project when it is on that host, else the first project there. */
async function inTerminal(host: string, name: string, command: string) {
  const key = hostKey(host);
  const a = activeProject();
  const p = a && hostKey(a.host) === key ? a : app.projects.find((x) => hostKey(x.host) === key && !x.parent) ?? app.projects.find((x) => hostKey(x.host) === key);
  if (!p) return flash(`open a project on ${hostName(host)} first: the step runs in one of its terminals`);
  const id = addTab(p.id, "term", { agent: { id: `sbx-${name}`, name, command, icon: "shield" } });
  focusTab(p.id, id);
  (await import("./Settings")).closeSettings();
}

const INSTALL = windows ? "winget install -h Docker.sbx" : mac ? "brew trust docker/tap\nbrew install docker/tap/sbx" : "";
const HYPERVISOR =
  "powershell -NoProfile -Command \"Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-Command','Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All'\"";

const STATE = { checking: "checking…", missing: "not installed", unreachable: "can't reach the host", stopped: "not running", signedOut: "not signed in", ready: "ready" } as const;

export function SandboxPage() {
  const [secrets, setSecrets] = createSignal<Secret[]>([]);
  const [rules, setRules] = createSignal<Rule[]>([]);
  const [blocked, setBlocked] = createSignal<Blocked[]>([]);
  const [boxes, setBoxes] = createSignal<Box[]>([]);
  const [templates, setTemplates] = createSignal<Template[]>([]);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // A host no project is on any more falls back to this machine.
  const host = () => (hosts().includes(sandboxHost()) ? sandboxHost() : "local");
  const local = () => host() === "local";
  const state = () => sbxState(host());

  let reading = 0;
  const load = async () => {
    const h = host();
    const n = ++reading;
    const s = await refreshSbx(h);
    if (n !== reading) return; // the host changed meanwhile
    if (s.state !== "ready") {
      for (const set of [setSecrets, setRules, setBlocked, setBoxes, setTemplates] as ((v: never[]) => void)[]) set([]);
      return setError("");
    }
    const errs: string[] = [];
    const get = <T,>(p: Promise<T>, set: (v: T) => void) => p.then((v) => n === reading && set(v), (e) => errs.push(String(e)));
    await Promise.all([get(listSecrets(h), setSecrets), get(listRules(h), setRules), get(listBlocked(h), setBlocked), get(listBoxes(h), setBoxes), get(listTemplates(h), setTemplates)]);
    if (n === reading) setError(errs.join("\n"));
  };
  createEffect(on(host, () => void load()));

  /** Run an sbx change, then read everything again. */
  const change = async (what: Promise<unknown>) => {
    setBusy(true);
    try {
      await what;
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const ready = () => state().state === "ready";
  const install = () => (local() ? INSTALL : "");

  return (
    <>
      <h4>Docker Sandboxes</h4>
      <p class="note">
        A Sandboxed Worktree runs claude in a small VM that sees only the worktree and the repo's .git: nothing else of its host. Shells, pi and your
        other commands stay on the host. The VM is made and given what the project needs (git as on the host, Node, bun, Rust, Go) in the background. Keys stay on the host and are added to agents' requests on the way out. Turned on per worktree in New worktree. An ssh host's projects use the sbx installed on that host, set up here with the host picked below.
      </p>
      <Show when={hosts().length > 1}>
        <div class="row">
          Host
          <select class="sbx-host" value={host()} aria-label="Host" disabled={busy()} onChange={(e) => setSandboxHost(e.currentTarget.value)}>
            <For each={hosts()}>{(h) => <option value={h}>{hostName(h)}</option>}</For>
          </select>
        </div>
      </Show>
      <div class="row">
        sbx
        <span class={`ag-state ${ready() ? "ok" : state().state === "checking" ? "" : "warn"}`}>
          {STATE[state().state]}{state().version ? ` · ${state().version}` : ""}
        </span>
        <span class="ag-acts">
          <Show when={state().state === "missing" && install()}>
            <button type="button" class="sb-btn primary" onClick={() => void inTerminal(host(), "install sbx", install())}>Install</button>
          </Show>
          <Show when={state().state === "stopped"}>
            <Show when={windows && local()}>
              <button type="button" class="sb-btn" title="Needs admin, then a restart of Windows" onClick={() => void inTerminal(host(), "hypervisor", HYPERVISOR)}>Turn on Hypervisor Platform…</button>
            </Show>
            <button type="button" class="sb-btn" onClick={() => void inTerminal(host(), "sbx diagnose", "sbx diagnose")}>Diagnose</button>
          </Show>
          <Show when={state().state === "signedOut"}>
            <button type="button" class="sb-btn primary" onClick={() => void inTerminal(host(), "sbx login", "sbx login")}>Sign in to Docker</button>
          </Show>
          <button type="button" class="sb-btn quiet" disabled={busy()} onClick={() => void load()}>Check again</button>
        </span>
      </div>
      <Show when={state().state === "missing" && !install()}>
        <p class="note">
          Install sbx on {hostName(host())} as the Docker Sandboxes docs describe for that system, then check again.
          <Show when={!local()}> Its sandboxes are VMs, so the host needs hardware virtualization (KVM on Linux); many cloud VMs don't offer it.</Show>
        </p>
      </Show>
      <Show when={state().error && !ready()}>
        <p class="sbx-err">{state().error}</p>
      </Show>

      <Show when={ready()}>
        <div class="row">
          New worktrees start sandboxed
          <span class="set-seg" role="radiogroup" aria-label="New worktrees start sandboxed">
            <For each={[[true, "Yes"], [false, "No"]] as const}>
              {([on, label]) => (
                <button type="button" role="radio" aria-checked={sandboxByDefault() === on} onClick={() => setSandboxSettings({ byDefault: on })}>
                  {label}
                </button>
              )}
            </For>
          </span>
        </div>

        <SignIns host={host()} busy={busy()} change={change} />

        <h4>Keys</h4>
        <p class="note">
          Kept in {local() ? "this machine's" : `${host()}'s`} credential store and added to requests as they leave a sandbox; agents never see them. Changes reach running sandboxes at once.
        </p>
        <KeyList host={host()} secrets={secrets()} busy={busy()} change={change} />

        <h4>Network</h4>
        <p class="note">
          Sandboxes reach only what is allowed: AI services, package registries and other common development hosts, plus what you add. Applies to every sandbox{local() ? "" : ` on ${host()}`}.
        </p>
        <Network host={host()} rules={rules()} blocked={blocked()} busy={busy()} change={change} />

        <h4>Folders</h4>
        <p class="note">
          What every new sandbox sees besides its worktree and the repo's .git, one per line. <code>{"{repo}"}</code> is the repo's folder; end a line with
          <code>:ro</code> for read only. An existing sandbox keeps what it was made with. The same lines for every host: a path must exist on the host the sandbox is on.
        </p>
        <div class="sbx-folders">
          <textarea
            spellcheck={false}
            placeholder={"{repo}\\docs:ro"}
            value={sandboxFolders().join("\n")}
            onChange={(e) => setSandboxSettings({ folders: e.currentTarget.value.split("\n") })}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>

        <h4>Sandboxes</h4>
        <Boxes host={host()} boxes={boxes()} busy={busy()} change={change} />

        <h4>Templates</h4>
        <p class="note">
          A repo's first sandbox that needed tools installed is saved as its template, and its next worktrees start from it with those tools in place.
          Remove one to have it built again.
        </p>
        <div class="sbx-list">
          <For each={templates()} fallback={<div class="sbx-item"><span class="sbx-none">None yet.</span></div>}>
            {(t) => (
              <div class="sbx-item">
                <div class="grow"><code>{t.tag}</code><span class="sub">{t.size ? `${Math.round(t.size / 1e6)} MB` : ""}</span></div>
                <button type="button" class="sb-btn quiet" disabled={busy()} onClick={() => void change(removeTemplate(host(), t.tag))}>Remove</button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        <p class="sbx-err">{error()}</p>
      </Show>
    </>
  );
}

type Change = (p: Promise<unknown>) => Promise<void>;

/** Sign claude in once per host, in a sandbox of its own: sbx keeps the login on that host and gives
 *  every sandbox made there after it stand-in tokens (sandbox.ts). claude asks for /login there. */
async function signInWithClaude(host: string) {
  try {
    flash(`making the sign-in sandbox on ${hostName(host)}…`);
    await signInBox(host);
    await inTerminal(host, "claude sign-in", `sbx run --name ${SIGNIN_BOX}`);
  } catch (e) {
    flash(`couldn't make the sign-in sandbox: ${e}`);
  }
}

/** Agents signed in, in every sandbox of a host, set up once: claude with your Claude login (or an
 *  Anthropic API key under Keys), gh and git pushes with that host's gh login. */
function SignIns(props: { host: string; busy: boolean; change: Change }) {
  const st = () => sbxState(props.host);
  const signIn = () => st().signIn;
  const where = () => hostName(props.host);
  return (
    <>
      <h4>Agent sign-in</h4>
      <p class="note">
        Set up once{hostKey(props.host) === "local" ? "" : ` for ${props.host}`}, here: sign in with /login in the claude that opens, then close it. sbx keeps the login on {where()} and refreshes it; every
        sandbox made after that starts signed in, holding only stand-ins for the tokens. Sandboxes made before still ask.
      </p>
      <div class="sbx-list">
        <div class="sbx-item">
          <div class="grow">
            <span>Claude</span>
            <span class="sub">
              {signIn() === "subscription" ? "your Claude login" : signIn() === "apikey" ? "your Anthropic API key (under Keys)" : "not signed in: claude in a sandbox will ask"}
            </span>
          </div>
          <Show
            when={signIn()}
            fallback={
              <button type="button" class="sb-btn primary" disabled={props.busy} onClick={() => void signInWithClaude(props.host)}>
                Sign in with Claude…
              </button>
            }
          >
            <span class="sbx-tag ok">signed in</span>
            <button type="button" class="sbx-x" title="Sign out of every sandbox (sbx secret rm anthropic)" aria-label="Sign out" disabled={props.busy} onClick={() => void props.change(signOutClaude(props.host))}>×</button>
          </Show>
        </div>
        <div class="sbx-item">
          <div class="grow">
            <span>GitHub</span>
            <span class="sub">{st().github ? "gh and git pushes work in every sandbox" : "gh and git pushes in a sandbox need a sign-in"}</span>
          </div>
          <Show when={!st().github} fallback={<span class="sbx-tag ok">signed in</span>}>
            <button type="button" class="sb-btn" disabled={props.busy} title={`sbx asks gh on ${where()} for its token when it is needed`} onClick={() => void props.change(connectGithub(props.host))}>
              Use {hostKey(props.host) === "local" ? "this machine's" : `${props.host}'s`} gh login
            </button>
          </Show>
        </div>
      </div>
    </>
  );
}

function KeyList(props: { host: string; secrets: Secret[]; busy: boolean; change: Change }) {
  const [service, setService] = createSignal("anthropic");
  const [how, setHow] = createSignal<KeyHow>("value");
  const [text, setText] = createSignal("");
  const free = () => SERVICES.filter((s) => !props.secrets.some((x) => x.service === s.id && x.scope.replace(/[()]/g, "") === "global"));
  const add = () => {
    if (!text().trim()) return;
    void props.change(setSecret(props.host, service(), how(), text().trim()));
    setText("");
  };
  return (
    <>
      <div class="sbx-list">
        <For each={props.secrets} fallback={<div class="sbx-item"><span class="sbx-none">No keys yet.</span></div>}>
          {(s) => (
            <div class="sbx-item">
              <div class="grow">
                <span>{serviceLabel(s.service)}</span>
                <span class="sub">{s.shown || "stored"}</span>
              </div>
              <span class="sbx-tag">{s.scope.replace(/[()]/g, "")}</span>
              <button type="button" class="sbx-x" title={`sbx secret rm ${s.service}`} aria-label={`Remove ${serviceLabel(s.service)}`} disabled={props.busy} onClick={() => void props.change(removeSecret(props.host, s.service))}>×</button>
            </div>
          )}
        </For>
      </div>
      <div class="sbx-add">
        <select value={service()} aria-label="Service" onChange={(e) => setService(e.currentTarget.value)}>
          <For each={free().length ? free() : SERVICES}>{(s) => <option value={s.id}>{s.label}</option>}</For>
        </select>
        <select value={how()} aria-label="How" onChange={(e) => { setHow(e.currentTarget.value as KeyHow); setText(""); }}>
          <option value="value">paste a key</option>
          <option value="command">run a command</option>
          <option value="ref">1Password / AWS ref</option>
        </select>
        <input
          type={how() === "value" ? "password" : "text"}
          value={text()}
          placeholder={how() === "value" ? "key" : how() === "command" ? "gh auth token" : "op://Vault/Item/credential"}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") add(); }}
        />
        <button type="button" class="sb-btn" disabled={props.busy || !text().trim()} onClick={add}>Add</button>
      </div>
    </>
  );
}

function Network(props: { host: string; rules: Rule[]; blocked: Blocked[]; busy: boolean; change: Change }) {
  const [dest, setDest] = createSignal("");
  const presets = () => props.rules.filter((r) => !r.own);
  const own = () => props.rules.filter((r) => r.own);
  const add = () => {
    if (!dest().trim()) return;
    void props.change(allowHost(props.host, dest()));
    setDest("");
  };
  const label = (r: Rule) => r.name.replace(/^default-/, "").replace(/-/g, " ");
  return (
    <>
      <div class="sbx-presets">
        <For each={presets()}>
          {(r) => <span class={`sbx-tag ${r.decision === "allow" ? "ok" : "bad"}`} title={r.resources.join("\n")}>{label(r)} · {r.resources.length}</span>}
        </For>
      </div>
      <div class="sbx-list">
        <For each={props.blocked}>
          {(b) => (
            <div class="sbx-item">
              <span class="sbx-tag bad">blocked ×{b.count}</span>
              <div class="grow"><code>{b.host}</code><Show when={b.sandbox}><span class="sub">{b.sandbox}</span></Show></div>
              <button type="button" class="sb-btn" disabled={props.busy} onClick={() => void props.change(allowHost(props.host, b.host))}>Allow</button>
            </div>
          )}
        </For>
        <For each={own()}>
          {(r) => (
            <div class="sbx-item">
              <span class={`sbx-tag ${r.decision === "allow" ? "ok" : "bad"}`}>{r.decision === "allow" ? "allowed" : "denied"}</span>
              <div class="grow"><code>{r.resources.join(", ")}</code><Show when={r.scope !== "global"}><span class="sub">{r.scope}</span></Show></div>
              <button type="button" class="sbx-x" title="sbx policy rm network" aria-label="Remove rule" disabled={props.busy || !r.id} onClick={() => void props.change(removeRule(props.host, r.id))}>×</button>
            </div>
          )}
        </For>
        <Show when={!props.blocked.length && !own().length}>
          <div class="sbx-item"><span class="sbx-none">Nothing blocked or added yet.</span></div>
        </Show>
      </div>
      <div class="sbx-add">
        <input
          value={dest()}
          placeholder="example.com, *.example.com or localhost:5432"
          spellcheck={false}
          onInput={(e) => setDest(e.currentTarget.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") add(); }}
        />
        <button type="button" class="sb-btn" disabled={props.busy || !dest().trim()} onClick={add}>Allow</button>
      </div>
    </>
  );
}

function Boxes(props: { host: string; boxes: Box[]; busy: boolean; change: Change }) {
  const worktreeOf = (name: string) => app.projects.find((p) => p.sandbox === name && hostKey(p.host) === hostKey(props.host));
  return (
    <div class="sbx-list">
      <For each={props.boxes} fallback={<div class="sbx-item"><span class="sbx-none">No sandboxes. New worktree makes one when Sandbox is on.</span></div>}>
        {(b) => {
          const wt = () => worktreeOf(b.name);
          return (
            <div class="sbx-item">
              <div class="grow">
                <code>{b.name}</code>
                <span class="sub">{[b.status, b.agent, b.ports && `ports ${b.ports}`].filter(Boolean).join(" · ")}</span>
              </div>
              <Show
                when={wt()}
                fallback={
                  b.name === SIGNIN_BOX
                    ? <span class="sbx-tag">sign-in</span>
                    : <span class={`sbx-tag ${b.name.startsWith("tri-") ? "bad" : ""}`} title={b.workspace}>{b.name.startsWith("tri-") ? "worktree gone" : "not tri-code's"}</span>
                }
              >
                <span class="sbx-tag" title={wt()!.path}>{wt()!.name}</span>
              </Show>
              <Show when={/run/i.test(b.status)}>
                <button type="button" class="sb-btn quiet" disabled={props.busy} onClick={() => void props.change(stopSandbox(props.host, b.name))}>Stop</button>
              </Show>
              {/* A worktree's sandbox goes with the worktree; removing it here would leave its terminals nowhere to run. */}
              <Show when={!wt()}>
                <button type="button" class="sb-btn quiet" disabled={props.busy} onClick={() => void props.change(removeSandbox(props.host, b.name))}>Remove</button>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
