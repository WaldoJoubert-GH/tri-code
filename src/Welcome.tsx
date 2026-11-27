// The Welcome window: set up tri-code on a first launch. Five steps over the empty app: the theme
// and the hotkey key, the agents the + menu offers (found on PATH, or how to get them, and the
// agent-windows server for claude and pi), how signals alert, the machines you work on, and a
// first project or the tour. Every choice is the same setting Settings and the commands window
// change, saved as it is made, so closing early keeps what was chosen. Reopened from Alt+X ›
// Set up tri-code. Chosen from design/new-user.html (variant A); the rules are in welcomedata.ts.

import { invoke } from "@tauri-apps/api/core";
import { For, JSX, Show, createEffect, createSignal, on } from "solid-js";
import { Dynamic } from "solid-js/web";
import logo from "../assets/icon.svg";
import "./welcome.css";
import { AlertMode, SoundEvent, addAgent, app, envIcon, envName, isLocalHost, newId, removeAgent, setClaudeUsage, setLinkedFolders, setNotify, setSettings, setTheme, setToured, setWelcomed } from "./shared/state/state";
import { type Known, KNOWN, NODE_INSTALL, commandOf, foundOf, lookups, ownCommand, platform, serverBlocker } from "./welcomedata";
import { installAgent, refreshSetup, setupBusy, setupError, setupStatus } from "./agentsetup";
import { looksLikeUrl } from "./agents";
import { themeOf } from "./look";
import { EVENTS, playSound } from "./signals";
import { SoundSelect } from "./SoundSelect";
import { openEnvDialog } from "./EnvDialog";
import { openProjectDialog } from "./OpenProject";
import { startTour } from "./Tour";
import { Icon } from "./shared/ui/lucide";
import { Modal } from "./shared/ui/Modal";
import { linksOn } from "./links";
import { Caps, KeyList } from "./Keys";
import { metaName, modLabel } from "./modkey";
import { copyText } from "./shared/ui/clipboard";

const PLATFORM = platform(navigator.userAgent);

const STEPS = [
  { title: "Look & keys" },
  { title: "Your agents" },
  { title: "Signals" },
  { title: "Machines" },
  { title: "First project" },
];

const [open, setOpen] = createSignal(false);
const [step, setStep] = createSignal(0);
/** Steps you continued past, ticked in the rail. */
const [passed, setPassed] = createSignal<number[]>([]);
/** Which commands are on PATH; null while looking. */
const [present, setPresent] = createSignal<Record<string, boolean> | null>(null);
const [lookupError, setLookupError] = createSignal("");

export const welcomeOpen = open;

/** Open the Welcome window at a step (the first unless said). */
export function openWelcome(at = 0) {
  setStep(at);
  setPassed([]);
  setOpen(true);
  void lookForAgents();
}

/** Close it for good: Esc, Skip setup, Done, or a first project picked. */
export function closeWelcome(then?: "open" | "clone" | "tour") {
  setWelcomed();
  setOpen(false);
  if (then === "tour") return void startTour();
  // Set up, or skipped: either way the tour doesn't start by itself any more. Alt+X still has it.
  setToured();
  if (then) openProjectDialog(undefined, then);
}

/** Look on PATH for the known agents and the user's own, and read the agent-windows state.
 *  Settings › Agents calls it too, for the same list. */
export async function lookForAgents() {
  setPresent(null);
  setLookupError("");
  void refreshSetup(true);
  try {
    setPresent(await invoke<Record<string, boolean>>("commands_present", { cmds: lookups(app.agents) }));
  } catch (e) {
    setLookupError(String(e));
    setPresent({});
  }
}

const go = (i: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, i)));
function next() {
  setPassed((p) => (p.includes(step()) ? p : [...p, step()]));
  go(step() + 1);
}

// ---------- shared bits ----------

function Seg<T extends string>(props: { label: string; value: T; options: { v: T; name: string; icon?: string; note?: string }[]; set: (v: T) => void; big?: boolean }) {
  return (
    <div class="wel-opts" classList={{ big: props.big }} role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(o) => (
          <button type="button" role="radio" class="wel-opt" aria-checked={props.value === o.v} onClick={() => props.set(o.v)}>
            <b>
              <Show when={o.icon}><Icon name={o.icon!} size={13} /></Show>
              {o.name}
            </b>
            <Show when={o.note}><small>{o.note}</small></Show>
          </button>
        )}
      </For>
    </div>
  );
}

function InstallLine(props: { line: string; onCheck: () => void }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="wel-install">
      <code>{props.line}</code>
      <button type="button" class="wel-btn sm" onClick={() => { copyText(props.line); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
        <Icon name={copied() ? "check" : "copy"} size={12} />
        {copied() ? "Copied" : "Copy"}
      </button>
      <button type="button" class="wel-btn sm" onClick={props.onCheck}>
        <Icon name="refresh-cw" size={12} />
        Check again
      </button>
    </div>
  );
}

// ---------- 1. Look & keys ----------

function LookStep() {
  return (
    <>
      <h2>Welcome to tri-code</h2>
      <p class="wel-lede">A place to run your coding agents side by side, on this computer or over ssh. A few choices and you're in. Each one is saved as you make it, and all of them are in Settings later.</p>
      <h3>Theme</h3>
      <Seg
        label="Theme" big value={themeOf(app.settings)} set={setTheme}
        options={[
          { v: "system", name: "System", icon: "monitor", note: "Follows your OS" },
          { v: "light", name: "Light", icon: "sun", note: "Always light" },
          { v: "dark", name: "Dark", icon: "moon", note: "Always dark" },
        ]}
      />
      <h3>Hotkey key</h3>
      <p class="wel-note">
        Every window hotkey starts with it: <KeyList keys={[modLabel(), "Enter"]} /> opens a shell, <Caps id="palette" /> finds anything. Hold it for a moment to see every key on screen.
      </p>
      <Seg
        label="Hotkey key" big value={app.settings.modKey} set={(modKey) => setSettings({ modKey })}
        options={[
          { v: "alt", name: "Alt", note: "Leaves Ctrl to terminals and agents" },
          { v: "meta", name: metaName, note: "If your fingers already live there" },
        ]}
      />
    </>
  );
}

// ---------- 2. Agents ----------

/** One known agent with its + menu switch. `brief` (Settings › Agents) leaves out agent windows and
 *  usage, which Settings has on their own pages. */
function AgentRow(props: { k: Known; brief?: boolean }) {
  const k = props.k;
  const on = () => app.agents.some((a) => a.id === k.id);
  const found = () => foundOf(k, present());
  const install = () => k.install?.[PLATFORM];
  const server = () => (k.server ? setupStatus()?.[k.server] : undefined);
  const blocker = () => serverBlocker(found(), setupStatus()?.node);
  const toggle = () => (on() ? removeAgent(k.id) : addAgent(commandOf(k)));
  return (
    <div class="wel-agent" classList={{ on: on() }}>
      <div class="wel-agent-head">
        <span class="wel-ico"><Icon name={k.icon} size={16} /></span>
        <span class="wel-grow">
          <span class="wel-name">{k.title}<Show when={k.command && k.command !== k.title}><code>{k.command}</code></Show></span>
          <span class="wel-sub">{k.blurb}</span>
        </span>
        <Show when={k.command}>
          <span class={`wel-chip ${found() === "yes" ? "ok" : ""}`}>
            <Show when={found() === "checking"} fallback={found() === "yes" ? <><Icon name="check" size={11} />found</> : "not installed"}>
              <i class="wel-spin" />checking
            </Show>
          </span>
        </Show>
        <button type="button" class="wel-switch" role="switch" aria-checked={on()} aria-label={`${k.title} in the + menu`} onClick={toggle} />
      </div>
      <Show when={on() && found() !== "checking" && (found() === "no" || (!props.brief && (k.server || k.signals || k.usage)))}>
        <div class="wel-agent-body">
          <Show when={found() === "no"}>
            <Show
              when={install()}
              fallback={
                <div class="wel-row">
                  <span class="wel-note wel-grow">Not on PATH yet. Install it from its site, then check again.</span>
                  <button type="button" class="wel-btn sm" onClick={() => void lookForAgents()}><Icon name="refresh-cw" size={12} />Check again</button>
                </div>
              }
            >
              <span class="wel-note">Not on PATH yet. Run this in any terminal, then check again:</span>
              <InstallLine line={install()!} onCheck={() => void lookForAgents()} />
            </Show>
          </Show>
          <Show when={k.server && !props.brief}>
            <div class="wel-row">
              <Show
                when={server()?.state === "installed"}
                fallback={
                  <>
                    <span class="wel-grow">
                      <b>Let {k.name} open windows</b>
                      <span class="wel-note"> · adds tri-code's server, so it can start a dev server, read it and wait for it. It only sees its project's windows.</span>
                      <Show when={blocker()}><span class="wel-warn"> ({blocker()})</span></Show>
                    </span>
                    <button type="button" class="wel-btn sm" disabled={!!blocker() || !!setupBusy()} onClick={() => void installAgent(k.server!)}>
                      {setupBusy() === k.server ? "Setting up…" : server()?.state === "stale" ? "Update" : "Set up"}
                    </button>
                  </>
                }
              >
                <span class="wel-chip ok"><Icon name="check" size={11} />can open windows</span>
              </Show>
            </div>
          </Show>
          <Show when={k.signals && !props.brief}>
            <span class="wel-note wel-row"><Icon name="bell" size={12} />Says when it's working, needs you, is done or failed. Nothing to set up.</span>
          </Show>
          <Show when={k.usage && !props.brief}>
            <label class="wel-check">
              <input type="checkbox" checked={app.settings.claudeUsage !== false} onChange={(e) => setClaudeUsage(e.currentTarget.checked)} />
              <span>Show its plan usage in the status line <span class="wel-note">· read from its own login</span></span>
            </label>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function OwnRows() {
  const known = new Set(KNOWN.map((k) => k.id));
  const own = () => app.agents.filter((a) => !known.has(a.id));
  const [adding, setAdding] = createSignal(false);
  let nameEl: HTMLInputElement | undefined, cmdEl: HTMLInputElement | undefined;
  const add = () => {
    const a = ownCommand(nameEl?.value ?? "", cmdEl?.value ?? "", newId(), looksLikeUrl);
    if (!a) return cmdEl?.focus();
    addAgent(a);
    setAdding(false);
    void lookForAgents();
  };
  const where = (a: { command: string; url?: string }) => a.url ?? a.command.split("\n")[0];
  return (
    <>
      <For each={own()}>
        {(a) => (
          <div class="wel-agent on">
            <div class="wel-agent-head">
              <span class="wel-ico"><Icon name={a.icon} size={16} /></span>
              <span class="wel-grow">
                <span class="wel-name">{a.name || "unnamed"}<code>{where(a)}</code></span>
                <span class="wel-sub">{a.url !== undefined ? "Web app" : "Your command"}</span>
              </span>
              <button type="button" class="wel-btn sm quiet" onClick={() => removeAgent(a.id)}>Remove</button>
            </div>
          </div>
        )}
      </For>
      <Show
        when={adding()}
        fallback={
          <button type="button" class="wel-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} />
            <span><b>Add another</b> · any CLI agent or terminal app, or a web app's address</span>
          </button>
        }
      >
        <form class="wel-agent on wel-own" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input ref={(el) => { cmdEl = el; queueMicrotask(() => el.focus()); }} class="wel-input" spellcheck={false} placeholder="command, e.g. aider --model sonnet" aria-label="Command or address" />
          <input ref={nameEl} class="wel-input" placeholder="name (optional)" aria-label="Name" />
          <button type="submit" class="wel-btn sm primary">Add</button>
          <button type="button" class="wel-btn sm quiet" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      </Show>
    </>
  );
}

function AgentsStep() {
  const node = () => setupStatus()?.node;
  return (
    <>
      <h2>Which agents do you use?</h2>
      <p class="wel-lede">Switched on, an agent is in the <b>+</b> menu. tri-code looked on your PATH; anything missing shows how to get it.</p>
      <Show when={node() === false}>
        <div class="wel-banner">
          <Icon name="triangle-alert" size={14} />
          <span class="wel-grow">Node isn't on PATH, so agents can't open windows yet. Everything else works.</span>
          <Show when={NODE_INSTALL[PLATFORM]}>
            <code>{NODE_INSTALL[PLATFORM]}</code>
            <button type="button" class="wel-btn sm" onClick={() => copyText(NODE_INSTALL[PLATFORM]!)}><Icon name="copy" size={12} /></button>
          </Show>
          <button type="button" class="wel-btn sm" onClick={() => void lookForAgents()}><Icon name="refresh-cw" size={12} />Check again</button>
        </div>
      </Show>
      <div class="wel-list">
        <For each={KNOWN.filter((k) => k.kind === "agent")}>{(k) => <AgentRow k={k} />}</For>
        <OwnRows />
      </div>
      <Show when={setupError()}><p class="wel-err">{setupError()}</p></Show>
      <Show when={lookupError()}><p class="wel-err">Couldn't look on PATH: {lookupError()}</p></Show>
      <h3>Also in the + menu</h3>
      <div class="wel-list">
        <For each={KNOWN.filter((k) => k.kind === "app")}>{(k) => <AgentRow k={k} />}</For>
      </div>
      <p class="wel-note wel-foot-note">Icons, hotkeys, scopes and sounds for each are in the commands window, <Caps id="agents" />.</p>
    </>
  );
}

/** The same switches for Settings › Agents, so whatever setup picked can be changed there. */
export function PlusMenuList() {
  return (
    <>
      <div class="wel-list">
        <For each={KNOWN}>{(k) => <AgentRow k={k} brief />}</For>
        <OwnRows />
      </div>
      <Show when={lookupError()}><p class="wel-err">Couldn't look on PATH: {lookupError()}</p></Show>
    </>
  );
}

// ---------- 3. Signals ----------

function SignalsStep() {
  const n = () => app.notify;
  const badge = () => n().alert === "badge";
  return (
    <>
      <h2>When an agent needs you</h2>
      <p class="wel-lede">Agents say when they're working, waiting on you, done or failed. It shows on the window, its tab and the project. Pick when it should also make a sound.</p>
      <div class="wel-preview" aria-hidden="true">
        <div class="wel-winbar"><Icon name="asterisk" size={13} /><b>claude</b><span class="wel-note wel-grow">· fix login redirect</span><span class="wel-sig blocked">needs you</span></div>
        <Show when={n().desktop && !badge()}>
          <div class="wel-toast"><Icon name="bell" size={14} /><span><b>claude needs you</b><small>my-app · “Run the migration?”</small></span></div>
        </Show>
      </div>
      <h3>Alert me</h3>
      <Seg<AlertMode>
        label="Alert me" big value={n().alert} set={(alert) => setNotify({ alert })}
        options={[
          { v: "away", name: "When I'm away", note: "Another project, workspace or app" },
          { v: "always", name: "Always", note: "Even for the window I'm in" },
          { v: "badge", name: "Badge only", note: "No sound, no popup" },
        ]}
      />
      <div classList={{ "wel-dim": badge() }}>
        <h3>Sounds</h3>
        <div class="wel-sounds">
          <For each={EVENTS}>
            {([ev, label]: [SoundEvent, string]) => (
              <>
                <span class={`wel-sig ${ev}`}>{label}</span>
                <SoundSelect class="wel-input" value={n()[ev]} label={`${label} sound`} onPick={(v) => { setNotify({ [ev]: v }); playSound(v); }} />
                <button type="button" class="wel-btn sm" aria-label={`Play ${label}`} disabled={n()[ev] === "off"} onClick={() => playSound(n()[ev])}><Icon name="play" size={12} /></button>
              </>
            )}
          </For>
        </div>
        <label class="wel-row wel-vol">
          <span class="wel-note">Volume</span>
          <input type="range" min="0" max="100" step="5" value={String(n().volume)} onInput={(e) => setNotify({ volume: +e.currentTarget.value })} onChange={() => playSound(n().blocked)} />
        </label>
        <label class="wel-check">
          <input type="checkbox" checked={n().desktop} onChange={(e) => setNotify({ desktop: e.currentTarget.checked })} />
          <span>Desktop notifications <span class="wel-note">· your OS may ask to allow them</span></span>
        </label>
      </div>
    </>
  );
}

// ---------- 4. Machines ----------

function MachinesStep() {
  return (
    <>
      <h2>Where do you work?</h2>
      <p class="wel-lede">Projects are grouped by machine. This one is ready. Add an ssh host and its agents run there, in sessions that survive network drops and restarts.</p>
      <div class="wel-list">
        <For each={app.environments}>
          {(h) => (
            <div class="wel-agent on">
              <div class="wel-agent-head">
                <span class="wel-ico"><Icon name={envIcon(h)} size={16} /></span>
                <span class="wel-grow">
                  <span class="wel-name">{envName(h)}</span>
                  <span class="wel-sub">{isLocalHost(h) ? "this computer" : `over ssh · ${h}`}</span>
                </span>
                <span class="wel-chip ok"><Icon name="check" size={11} />ready</span>
              </div>
            </div>
          )}
        </For>
        <button type="button" class="wel-add" onClick={() => openEnvDialog()}>
          <Icon name="server" size={14} />
          <span><b>Add an ssh host</b> · pick one from ~/.ssh/config or type user@host; it's tested before it's added</span>
        </button>
      </div>
      <p class="wel-note wel-foot-note">
        A host needs ssh that logs in with a key, without a password prompt, and ideally <code>shpool</code> (<code>tmux</code> works too, but drops agent signals). Skip this if you only work on this computer.
      </p>
      <h3>In a project</h3>
      <div class="wel-list">
      <div class="wel-agent" classList={{ on: linksOn() }}>
        <div class="wel-agent-head">
          <span class="wel-ico"><Icon name="folder-symlink" size={16} /></span>
          <span class="wel-grow">
            <span class="wel-name">Linked folders</span>
            <span class="wel-sub">Show other folders beside a project's own, in the editor's tree and Go to File: a shared library, logs, assets. A project on an ssh host can link one there or on this computer.</span>
          </span>
          <button type="button" class="wel-switch" role="switch" aria-checked={linksOn()} aria-label="Linked folders" onClick={() => setLinkedFolders(!linksOn())} />
        </div>
      </div>
      </div>
    </>
  );
}

// ---------- 5. First project ----------

function Summary() {
  const row = (k: string, v: JSX.Element, at: number) => (
    <div class="wel-sum-row"><span class="wel-sum-k">{k}</span><span class="wel-grow">{v}</span><button type="button" class="wel-link" onClick={() => go(at)}>Change</button></div>
  );
  const names = () => app.agents.map((a) => a.name || "unnamed");
  const windows = () => (["claude", "pi"] as const).filter((k) => setupStatus()?.[k].state === "installed");
  const alert = () => ({ away: "when I'm away", always: "always", badge: "badge only" })[app.notify.alert];
  const themeName = () => ({ system: "System", light: "Light", dark: "Dark" })[themeOf(app.settings)];
  return (
    <div class="wel-sum">
      {row("Theme & keys", <>{themeName()} · <KeyList keys={[modLabel()]} /></>, 0)}
      {row("+ menu", names().length ? <For each={names()}>{(n, i) => <>{i() ? ", " : ""}<code>{n}</code></>}</For> : <span class="wel-note">nothing yet</span>, 1)}
      {row("Open windows", windows().length ? <For each={windows()}>{(n, i) => <>{i() ? ", " : ""}<code>{n}</code></>}</For> : <span class="wel-note">no agent</span>, 1)}
      {row("Alerts", <>{alert()}{app.notify.desktop && app.notify.alert !== "badge" ? " · desktop notifications" : ""}</>, 2)}
      {row("Machines", app.environments.map(envName).join(", "), 3)}
    </div>
  );
}

function ProjectStep() {
  return (
    <>
      <h2>Open your first project</h2>
      <p class="wel-lede">A project is a folder. Its agents, windows and worktrees live under it in the sidebar.</p>
      <div class="wel-starts">
        <button type="button" class="wel-start" onClick={() => closeWelcome("open")}>
          <span class="wel-ico"><Icon name="folder-open" size={16} /></span>
          <b>Open a folder</b>
          <small>Pick one on {app.environments.length > 1 ? "any of your machines" : "this computer"}. Git repos are marked.</small>
          <span class="wel-start-foot"><Caps id="open-project" /></span>
        </button>
        <button type="button" class="wel-start" onClick={() => closeWelcome("clone")}>
          <span class="wel-ico"><Icon name="download" size={16} /></span>
          <b>Clone a repo</b>
          <small>Paste a git URL, or pick from your GitHub repos.</small>
          <span class="wel-start-foot">uses <code>gh</code> if you're signed in</span>
        </button>
        <button type="button" class="wel-start" onClick={() => closeWelcome("tour")}>
          <span class="wel-ico"><Icon name="compass" size={16} /></span>
          <b>Take the tour</b>
          <small>A sample project with recorded agents. Six stops, a couple of minutes. Nothing runs.</small>
          <span class="wel-start-foot"><span class="wel-rec">Recommended the first time</span></span>
        </button>
      </div>
      <h3>Your setup</h3>
      <Summary />
      <h3>Later, when you need them</h3>
      <div class="wel-later">
        <div><Icon name="shield" size={14} /><span><b>Sandboxes</b><small>Run a worktree's agents in Docker, with only the network you allow. Settings › Sandbox.</small></span></div>
        <div><Icon name="smartphone" size={14} /><span><b>Your phone</b><small>See your agents and answer them over Tailscale. Settings › Remote.</small></span></div>
        <div><Icon name="list-todo" size={14} /><span><b>Issues</b><small>Plane, GitHub or local issues beside your agents. <Caps id="issues" /></small></span></div>
        <div><Icon name="keyboard" size={14} /><span><b>Hotkeys</b><small>Every key can be changed. <Caps id="help" /></small></span></div>
      </div>
    </>
  );
}

const BODIES = [LookStep, AgentsStep, SignalsStep, MachinesStep, ProjectStep];

// ---------- the window ----------

export function Welcome() {
  const last = () => step() === STEPS.length - 1;
  // Enter continues, unless it belongs to what has focus (a field, a button, a menu).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || last()) return;
    if ((e.target as Element).closest("input, select, textarea, button, form")) return;
    e.preventDefault();
    next();
  };
  let main: HTMLDivElement | undefined;
  createEffect(on(step, () => main?.scrollTo(0, 0), { defer: true }));
  return (
    <Show when={open()}>
      <Modal class="wel-scrim" label="Set up tri-code" onClose={closeWelcome} dismiss={false}>
        <div class="wel" tabindex="-1" onKeyDown={onKey} ref={(el) => queueMicrotask(() => el.focus())}>
          <nav class="wel-rail" aria-label="Setup steps">
            <div class="wel-brand"><img src={logo} alt="" width="22" height="22" />Set up tri-code</div>
            <For each={STEPS}>
              {(s, i) => (
                <button type="button" class="wel-step" classList={{ done: passed().includes(i()) }} aria-current={step() === i() ? "step" : undefined} onClick={() => go(i())}>
                  <span class="wel-num">{passed().includes(i()) && step() !== i() ? <Icon name="check" size={11} /> : i() + 1}</span>
                  {s.title}
                </button>
              )}
            </For>
            <p class="wel-rail-foot">Nothing here is final: it's all in Settings, and <b>Set up tri-code</b> is in <Caps id="palette" />.</p>
          </nav>
          <div class="wel-main" ref={main}>
            <Dynamic component={BODIES[step()]} />
          </div>
          <div class="wel-foot">
            <span class="wel-hint"><KeyList keys={["Enter"]} /> continue · <KeyList keys={["Esc"]} /> skip setup</span>
            <Show when={step() > 0} fallback={<button type="button" class="wel-btn quiet" onClick={() => closeWelcome()}>Skip setup</button>}>
              <button type="button" class="wel-btn" onClick={() => go(step() - 1)}>Back</button>
            </Show>
            <Show when={!last()} fallback={<button type="button" class="wel-btn" onClick={() => closeWelcome()}>Done</button>}>
              <button type="button" class="wel-btn primary" onClick={next}>{step() === 0 ? "Get started" : "Continue"}</button>
            </Show>
          </div>
        </div>
      </Modal>
    </Show>
  );
}
