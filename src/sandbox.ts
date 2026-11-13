// Sandboxed Worktrees: a Worktree whose agent (claude, for now) runs in a Docker Sandbox (`sbx`),
// a microVM that sees only the checkout, the repo's .git (so git works in it) and the folders Settings ›
// Sandbox adds. A copy of a multi-repo folder works too: it mounts each nested repo's .git instead.
// Shells, setup and the other Commands stay outside it, so the user's own tools, dev servers and
// browser windows work as before. New worktree's Sandbox toggle is all the user does: the sandbox is
// made in the background (ensureSandbox), retrying a download that breaks off, then prepared (git as
// on the host, Node, bun, Rust, Go as the project needs); claude windows wait for it. Removing the
// Worktree removes it. Keys, network and the sandboxes are in Settings › Sandbox (SandboxSettings.tsx).
// Each host has its own sbx: an ssh Environment's projects are sandboxed by the sbx installed there,
// with its own sign-in, keys, network rules and templates, so every call here names the host.
// A preview feature, off until turned on in Settings › Preview (preview.ts). Off, it is hidden
// everywhere and Worktrees act as if they had no sandbox (sandboxOf); on again, they have it back.
// Chosen from design/sandbox.html. Rust: sbx.rs.

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { type Project, app, isLocalHost, projectById, setApp } from "./state";
import { sandboxPreview } from "./preview";

/** The key a host's sbx goes by: "local" for this machine, else its ssh destination. */
export const hostKey = (host?: string) => (!host || isLocalHost(host) ? "local" : host);
const hostArg = (host: string) => (hostKey(host) === "local" ? null : host);

/** `sbx <args>` on `host` (this machine or an ssh host); its stdout. A secret's value goes in `input`. */
export const sbx = (host: string, args: string[], input?: string) => invoke<string>("sbx_cli", { host: hostArg(host), args, input: input ?? null });

/** Settings › Sandbox's host: the one New worktree's "Set it up" was for, else this machine. */
export const [sandboxHost, setSandboxHost] = createSignal("local");

// ── names and mounts ────────────────────────────────────────────────

/** A sandbox name sbx accepts (2–63 letters, digits, hyphens; starts and ends with one of the first two). */
export function sandboxName(repoName: string, folder: string, taken: string[] = []): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `tri-${slug(repoName) || "repo"}-${slug(folder) || "wt"}`.slice(0, 58).replace(/-+$/, "");
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
}

/** What a new sandbox mounts besides its worktree: the repo's .git (a copy's: each nested repo's,
 *  `nested` relative to the folder), then Settings' folders with `{repo}` filled in. `:ro` stays on the end. */
export function mountsFor(repoPath: string, folders: string[] = [], nested?: string[]): string[] {
  const root = repoPath.replace(/[\\/]+$/, "");
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const gits = nested ? nested.map((r) => `${root}${sep}${r.replace(/[\\/]+/g, sep).replace(/^[\\/]+|[\\/]+$/g, "")}${sep}.git`) : [`${root}${sep}.git`];
  return [...gits, ...folders.map((f) => f.split("{repo}").join(root))];
}

/** Whether New worktree can sandbox this project: a git repo or a folder with repos nested in it (a
 *  copy, whose nested worktrees git works in), on this machine or an ssh host. */
export const canSandbox = (_repo: Project, kind: { git: boolean; repos?: string[] } | undefined) =>
  !!kind && (kind.git || !!kind.repos?.length);

export const sandboxByDefault = () => app.settings.sandbox?.byDefault !== false;
export const sandboxFolders = () => app.settings.sandbox?.folders ?? [];

// ── is sbx set up ───────────────────────────────────────────────────

/** How agents in a sandbox reach Anthropic: a Claude subscription token (`subscription`), an API key
 *  (`apikey`), or not at all yet. */
export type SignIn = "subscription" | "apikey" | null;

/** `missing`: no sbx. `unreachable`: the ssh host didn't answer. `stopped`: its daemon isn't running.
 *  `signedOut`: needs `sbx login`. `signIn` and `github` once ready: what agents in a sandbox can use
 *  without signing in there. */
export type SbxState = { state: "checking" | "missing" | "unreachable" | "stopped" | "signedOut" | "ready"; version?: string; error?: string; signIn?: SignIn; github?: boolean };
const [sbxStates, setSbxStates] = createStore<Record<string, SbxState>>({});
/** The last read state of `host`'s sbx (this machine's when left out). */
export const sbxState = (host?: string): SbxState => sbxStates[hostKey(host)] ?? { state: "checking" };
export const sbxReady = (host?: string) => sbxState(host).state === "ready";

const signInNeeded = (e: string) => /log ?in|sign ?in|not authenticated|unauthori[sz]ed/i.test(e);

/** Read `host`'s sbx state again: is it there, is its daemon running, is it signed in. */
export async function refreshSbx(host = "local"): Promise<SbxState> {
  const key = hostKey(host);
  const done = (s: SbxState) => (setSbxStates(key, s), s);
  let where: string | null;
  try {
    where = await invoke<string | null>("sbx_where", { host: hostArg(host) });
  } catch (e) {
    return done({ state: key === "local" ? "missing" : "unreachable", error: String(e) });
  }
  if (!where) return done({ state: "missing" });
  let version: string | undefined;
  try {
    const v = JSON.parse(lastJson(await sbx(host, ["version", "--json"])));
    version = v?.client?.version;
    if (v?.server?.state !== "running") return done({ state: "stopped", version });
  } catch (e) {
    return done({ state: "stopped", version, error: String(e) });
  }
  try {
    await sbx(host, ["ls", "--json"]);
  } catch (e) {
    return done({ state: signInNeeded(String(e)) ? "signedOut" : "stopped", version, error: String(e) });
  }
  const raw = await sbx(host, ["secret", "ls", "--json"]).catch(() => "");
  return done({ state: "ready", version, signIn: readSignIn(raw), github: raw ? parseSecrets(raw).some((s) => s.service === "github") : false });
}

/** The JSON in sbx's output: over ssh a login shell may print a banner before it. */
export function lastJson(out: string): string {
  const t = out.trim();
  if (!t || t.startsWith("{") || t.startsWith("[")) return t;
  const i = t.search(/^[[{]/m);
  return i >= 0 ? t.slice(i) : t;
}

// ── claude signed in, in every sandbox ──────────────────────────────
// sbx does this itself: its claude kit declares Anthropic's OAuth. A /login in any sandbox's claude is
// caught by the proxy, which keeps the real tokens on this machine (sbx's `anthropic` secret) and
// refreshes them; every sandbox made after that gets stand-in tokens in ~/.claude/.credentials.json,
// swapped for the real ones on the way out. An Anthropic API key (`sbx secret set anthropic`) works
// the same way. Either is bound when a sandbox is made, so sandboxes from before keep asking.

/** What `sbx secret ls --json` says claude in a sandbox can use: the `anthropic` secret, OAuth from a
 *  /login or a pasted API key. */
export function readSignIn(raw: string): SignIn {
  if (!raw) return null;
  try {
    const a = parseSecrets(raw).find((s) => s.service === "anthropic");
    if (!a) return null;
    return /oauth/i.test(a.type) ? "subscription" : "apikey";
  } catch {
    return null;
  }
}

/** The sandbox the sign-in happens in: no folder of the host mounted. */
export const SIGNIN_BOX = "tri-signin";

/** Make `host`'s sign-in sandbox if it isn't there; the terminal then runs claude in it for /login. */
export async function signInBox(host: string): Promise<void> {
  if ((await listBoxes(host)).some((b) => b.name === SIGNIN_BOX)) return;
  await createBox(host, SIGNIN_BOX, ["create", "--no-progress", "--name", SIGNIN_BOX, "claude"]);
}

/** Sign claude out of every sandbox of `host`: its sbx forgets the OAuth tokens and any API key. */
export const signOutClaude = (host: string) => sbx(host, ["secret", "rm", "anthropic", "--force"]);

/** Let agents use gh and push with the host's gh login, fetched by sbx there when it's needed. */
export const connectGithub = (host: string) => sbx(host, ["secret", "set", "github", "--force", "--command", "gh auth token"]);

// ── sandboxes ───────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const first = (o: Record<string, unknown>, ...keys: string[]) => keys.map((k) => str(o[k])).find(Boolean) ?? "";
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

/** One sandbox from `sbx ls --json`. */
export type Box = { name: string; status: string; agent: string; workspace: string; ports: string };

export function parseBoxes(json: string): Box[] {
  const v = JSON.parse(lastJson(json) || "[]");
  return list(Array.isArray(v) ? v : v?.sandboxes).map((o) => {
    const ws = Array.isArray(o.workspaces) ? str(o.workspaces[0]) || str((o.workspaces[0] as Record<string, unknown>)?.path) : "";
    const ports = Array.isArray(o.ports) ? o.ports.map((p) => (typeof p === "object" && p ? first(p as Record<string, unknown>, "host_port", "hostPort", "published") || JSON.stringify(p) : str(p))).join(", ") : str(o.ports);
    return { name: first(o, "name", "Name", "sandbox"), status: first(o, "status", "Status", "state"), agent: first(o, "agent", "Agent"), workspace: first(o, "workspace", "Workspace") || ws, ports };
  }).filter((b) => b.name);
}

export const listBoxes = async (host: string) => parseBoxes(await sbx(host, ["ls", "--json"]));

const samePath = (a: string, b: string) => {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return !!a && !!b && n(a) === n(b);
};

/** Which of `worktrees` (id, path) a tri-code sandbox belongs to: the one whose folder is its workspace. */
export function sandboxesFor(worktrees: { id: string; path: string }[], boxes: Box[]): { id: string; sandbox: string }[] {
  return worktrees.flatMap((w) => {
    const b = boxes.find((x) => x.name.startsWith("tri-") && x.name !== SIGNIN_BOX && samePath(x.workspace, w.path));
    return b ? [{ id: w.id, sandbox: b.name }] : [];
  });
}

/** At launch, before terminals start: give back their sandbox to Worktrees that lost it (a state.json
 *  saved by a build that didn't keep it), so their agents don't start outside it. Waits at most 4 s.
 *  This machine's only: sandboxes on ssh hosts came after Worktrees kept theirs. */
export async function adoptSandboxes(): Promise<void> {
  if (!sandboxPreview()) return;
  const loose = app.projects.filter((p) => p.parent && !p.sandbox && isLocalHost(p.host));
  if (!loose.length || !(await invoke<string | null>("sbx_where", { host: null }).catch(() => null))) return;
  const raw = await Promise.race([sbx("local", ["ls", "--json"]), sleep(4000).then(() => "")]).catch(() => "");
  if (!raw) return;
  for (const { id, sandbox } of sandboxesFor(loose, parseBoxes(raw))) setApp("projects", (p) => p.id === id, "sandbox", sandbox);
}

// ── which terminals run in the sandbox ──────────────────────────────

/** Agent CLIs: what a Sandboxed Worktree runs in its sandbox. Anything else runs on the host.
 *  Claude only for now: it is the one signed in for sandboxes (Agent sign-in). */
const AGENTS = ["claude"];

/** Whether a terminal's command starts an agent: its program, without a path or a Windows suffix. */
export function isAgentCommand(cmd: string): boolean {
  const prog = cmd.trim().split(/\s+/)[0] ?? "";
  const name = prog.split(/[\\/]/).pop()!.replace(/\.(cmd|exe|ps1|bat)$/i, "").toLowerCase();
  return !cmd.includes("\n") && AGENTS.includes(name);
}

/** A Worktree's sandbox while the Sandboxed Worktrees preview is on; with it off, none anywhere:
 *  not shown, and its agents run on the host. `sandbox` stays saved, so turning it on again brings
 *  the sandbox back. */
export const sandboxOf = (p: Project) => (sandboxPreview() ? p.sandbox : undefined);

/** Whether a terminal of `p` running `cmd` runs in its sandbox. */
export const runsInSandbox = (p: Project, cmd: string) => !!sandboxOf(p) && isAgentCommand(cmd);

// ── making and preparing a sandbox, in the background ───────────────

/** A free name, on the repo's host, for the sandbox of a new Worktree at `dir`. */
export async function newSandboxName(repo: Project, dir: string): Promise<string> {
  const taken = await listBoxes(repo.host).then((b) => b.map((x) => x.name), () => []);
  return sandboxName(repo.name, dir.split(/[\\/]/).pop() ?? "", taken);
}

/** The step a sandbox is on while it is made, for the windows waiting on it. Runtime only. */
const steps = new Map<string, Set<(msg: string) => void>>();
export function onSandboxStep(name: string, fn: (msg: string) => void): () => void {
  const set = steps.get(name) ?? new Set();
  set.add(fn);
  steps.set(name, set);
  return () => set.delete(fn);
}
const step = (name: string, msg: string) => steps.get(name)?.forEach((fn) => fn(msg));

/** What breaks a create off part way, which another try carries on from: a dropped download (the
 *  layers already fetched are kept), or the daemon restarting under it. */
const retryable = (e: string) => /pull|forcibly closed|connection|reset by peer|EOF|timeout|i\/o|pipe|daemon/i.test(e);
const TRIES = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `sbx <args>` (a create), tried again while it breaks off part way. */
async function createBox(host: string, name: string, args: string[]): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await sbx(host, args);
      return;
    } catch (e) {
      const err = String(e);
      if (/already exists/i.test(err)) return;
      if (i >= TRIES || !retryable(err)) throw e;
      step(name, `download interrupted; carrying on (${i}/${TRIES - 1})…`);
      await sleep(2000);
    }
  }
}

// ── a template per repo ─────────────────────────────────────────────
// The first sandbox of a repo that had tools installed is saved (sbx template save) as the repo's
// template, and the repo's next sandboxes start from it with those tools in place. A template keeps
// the VM's files; sbx still binds the sign-in and the folders when each sandbox is made.

/** The repo's template tag, in the image store of the host's sbx. */
export const templateOf = (repoName: string) => `tri-template/${(repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo")}:latest`;

/** A template from `sbx template ls --json`: its tag as `repository:tag` without the registry, and size. */
export type Template = { tag: string; size: number };

export function parseTemplates(json: string): Template[] {
  const v = JSON.parse(lastJson(json) || "[]");
  return list(Array.isArray(v) ? v : v?.templates).map((o) => ({
    tag: `${first(o, "repository", "name").replace(/^docker\.io\//, "")}:${first(o, "tag") || "latest"}`,
    size: Number(o.size) || 0,
  })).filter((t) => t.tag.startsWith("tri-template/"));
}

export const listTemplates = async (host: string) => parseTemplates(await sbx(host, ["template", "ls", "--json"]));
export const removeTemplate = (host: string, tag: string) => sbx(host, ["template", "rm", "--force", tag]);

/** Save sandbox `name` as the repo's template. sbx saves a stopped sandbox; the next exec starts it. */
async function saveTemplate(host: string, name: string, tag: string): Promise<void> {
  await sbx(host, ["stop", name]);
  await sbx(host, ["template", "save", name, tag]);
}

/** The script that readies a sandbox, run in its workspace each time it is first needed in a session:
 *  quick when there's nothing left to do. git as on this machine; Python's environment in the VM
 *  (the worktree's .venv is this machine's); Node 22, bun, Rust and Go when the project has their
 *  files, at its top or one folder down (a copy's nested repos). Every step is on Balanced's allow
 *  list. Written without bash's brace expansions, which a template literal would take for its own. */
export const PREPARE = String.raw`set -e
say() { printf '%s\n' "$*"; }
trap 'say "failed at line $LINENO"' ERR
persist() { grep -qxF "$1" /etc/sandbox-persistent.sh 2>/dev/null || echo "$1" >> /etc/sandbox-persistent.sh; }
gitg() { git -C "$HOME" config --global "$@"; }
if [ -n "$TRI_GIT_NAME" ]; then gitg user.name "$TRI_GIT_NAME"; fi
if [ -n "$TRI_GIT_EMAIL" ]; then gitg user.email "$TRI_GIT_EMAIL"; fi
if [ -n "$TRI_GIT_AUTOCRLF" ]; then gitg core.autocrlf "$TRI_GIT_AUTOCRLF"; fi
gitg gc.worktreePruneExpire never
if command -v jq >/dev/null 2>&1 && [ -f "$HOME/.claude.json" ] && [ -n "$WORKSPACE_DIR" ]; then
  t=$(mktemp); jq --arg d "$WORKSPACE_DIR" '.projects[$d].hasTrustDialogAccepted = true' "$HOME/.claude.json" > "$t" && mv "$t" "$HOME/.claude.json"
fi
persist 'export UV_PROJECT_ENVIRONMENT="$HOME/.venvs/project"'
persist 'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"'
. /etc/sandbox-persistent.sh
has() { command -v "$1" >/dev/null 2>&1; }
any() { for f in "$@"; do [ -f "$f" ] && return 0; done; return 1; }
node_ok() { has node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if any package.json */package.json && ! node_ok; then
  say "installing Node.js 22"
  case "$(uname -m)" in aarch64|arm64) a=arm64;; *) a=x64;; esac
  f=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-$a.tar.gz" | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$f" | sudo tar -xz -C /usr/local --strip-components=1
fi
if any bun.lock bun.lockb */bun.lock */bun.lockb && ! has bun; then
  say "installing bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
if any Cargo.toml src-tauri/Cargo.toml */Cargo.toml */src-tauri/Cargo.toml && ! has cargo; then
  say "installing Rust"
  curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal >/dev/null
fi
if any go.mod */go.mod && ! has go; then
  say "installing Go"
  sudo apt-get install -y -qq golang-go >/dev/null
fi
`;

type Identity = { name: string | null; email: string | null; autocrlf: string | null };

/** Prepare a sandbox; true when it installed something. */
async function prepareBox(name: string, wt: Project): Promise<boolean> {
  // A copy's folder isn't a repo: its first nested one has the repo's own config, if any.
  const dir = wt.copy?.repos[0] ? `${wt.path.replace(/[\\/]+$/, "")}/${wt.copy.repos[0]}` : wt.path;
  const id = await invoke<Identity>("sandbox_git_identity", { host: hostArg(wt.host), dir }).catch((): Identity => ({ name: null, email: null, autocrlf: null }));
  const env = { TRI_GIT_NAME: id.name, TRI_GIT_EMAIL: id.email, TRI_GIT_AUTOCRLF: id.autocrlf };
  const flags = Object.entries(env).flatMap(([k, v]) => (v ? ["-e", `${k}=${v}`] : []));
  const out = await sbx(wt.host, ["exec", ...flags, name, "bash", "-c", PREPARE]);
  const said = out.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of said) step(name, line);
  return said.some((l) => l.startsWith("installing"));
}

/** Each sandbox's readying in this session, so every agent window of a Worktree waits on the same one.
 *  By host and name: two hosts can each have a sandbox of the same name. */
const readying = new Map<string, Promise<void>>();
const readyKey = (wt: Project) => `${hostKey(wt.host)}\n${wt.sandbox}`;

/** Make sure a Sandboxed Worktree's sandbox exists and is prepared: made again if it was removed. The
 *  first one downloads sbx's image, which takes minutes. A failure is forgotten, so the next window
 *  (or Enter in a waiting one) tries again. On an ssh host the shells' agent launchers are written
 *  there too. */
export function ensureSandbox(wt: Project): Promise<void> {
  const name = wt.sandbox;
  if (!name) return Promise.resolve();
  const key = readyKey(wt);
  let p = readying.get(key);
  if (!p) {
    p = (async () => {
      const host = wt.host;
      const repo = projectById(wt.parent ?? "") ?? wt;
      if (hostKey(host) !== "local") {
        await invoke("sbx_remote_shims", { host }).catch((e) => step(name, `couldn't write the claude launcher on ${host}: ${String(e).trim()}`));
      }
      const there = (await listBoxes(host)).some((b) => b.name === name);
      const tag = templateOf(repo.name);
      const tpl = await listTemplates(host).then((t) => t.some((x) => x.tag === tag), () => false);
      if (!there) {
        const mounts = [wt.path, ...mountsFor(repo.path, sandboxFolders(), wt.copy?.repos)];
        step(name, tpl ? `making the sandbox from ${repo.name}'s template…` : `making the sandbox${hostKey(host) === "local" ? "" : ` on ${host}`} (the first one downloads about 1 GB)…`);
        await createBox(host, name, ["create", "--no-progress", ...(tpl ? ["--pull", "never", "-t", tag] : []), "--name", name, "claude", ...mounts]);
      }
      step(name, "preparing the sandbox…");
      const installed = await prepareBox(name, wt);
      if (installed && !tpl) {
        step(name, `saving this setup for ${repo.name}'s next worktrees…`);
        await saveTemplate(host, name, tag).catch((e) => step(name, `couldn't save the template: ${String(e).trim()}`));
      }
    })();
    readying.set(key, p);
    p.catch(() => readying.delete(key));
  }
  return p;
}

/** What every agent window of a Sandboxed Worktree waits on before it starts: the sandbox made and
 *  prepared (once a session), then running. A stopped one (after a restart, or stopped from the
 *  Docker Window) is started here, a removed one made again, so the agent always finds it there. */
export async function readySandbox(wt: Project): Promise<void> {
  const name = wt.sandbox;
  if (!name) return;
  await ensureSandbox(wt);
  const box = (await listBoxes(wt.host)).find((b) => b.name === name);
  if (!box) {
    readying.delete(readyKey(wt));
    return ensureSandbox(wt);
  }
  if (!isRunning(box.status)) {
    step(name, "starting the sandbox…");
    await startSandbox(wt.host, name);
  }
}

/** Make a new Worktree's `.git` pointer relative, so git reads it in the sandbox too (sbx.rs). */
export const relativeGitdir = (host: string, dir: string) => invoke<void>("sandbox_gitdir_relative", { host: hostArg(host), dir });

/** Remove a sandbox and everything installed in it; its worktree's files are the host's and stay. */
export const removeSandbox = (host: string, name: string) => sbx(host, ["rm", "--force", name]);
export const stopSandbox = (host: string, name: string) => sbx(host, ["stop", name]);
/** sbx has no start: running anything in a stopped sandbox starts it. */
export const startSandbox = (host: string, name: string) => sbx(host, ["exec", name, "true"]);
export const isRunning = (status: string) => /run/i.test(status);

// ── keys ────────────────────────────────────────────────────────────

/** The services `sbx secret set` knows (its help), with what each is for. */
export const SERVICES: { id: string; label: string }[] = [
  { id: "anthropic", label: "Anthropic" }, { id: "github", label: "GitHub" }, { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google" }, { id: "openrouter", label: "OpenRouter" }, { id: "mistral", label: "Mistral" },
  { id: "groq", label: "Groq" }, { id: "xai", label: "xAI" }, { id: "copilot", label: "Copilot" },
  { id: "cursor", label: "Cursor" }, { id: "devin", label: "Devin" }, { id: "droid", label: "Droid" }, { id: "nebius", label: "Nebius" },
];
export const serviceLabel = (id: string) => SERVICES.find((s) => s.id === id)?.label ?? id;

/** A stored key from `sbx secret ls --json`: its service, scope, kind (`service`, `oauth`, ...) and how
 *  sbx shows it (masked). */
export type Secret = { service: string; scope: string; type: string; shown: string };

export function parseSecrets(json: string): Secret[] {
  const v = JSON.parse(lastJson(json) || "{}");
  return list(v?.secrets ?? v).map((o) => ({
    service: first(o, "service", "Service", "name"),
    scope: first(o, "sandbox", "scope", "Scope") || "global",
    type: first(o, "type", "kind", "mode"),
    shown: first(o, "secret", "value", "masked", "source", "command", "ref"),
  })).filter((s) => s.service);
}

export const listSecrets = async (host: string) => parseSecrets(await sbx(host, ["secret", "ls", "--json"]));

/** How a key is given: pasted, the output of a command run when needed, or a 1Password / AWS reference. */
export type KeyHow = "value" | "command" | "ref";

/** Store a key for every sandbox of `host`. A pasted value goes on stdin, never on the command line
 *  (over ssh too). A command runs on that host when the key is needed. */
export function setSecret(host: string, service: string, how: KeyHow, text: string) {
  if (how === "value") return sbx(host, ["secret", "set", service, "--force"], text);
  return sbx(host, ["secret", "set", service, "--force", how === "command" ? "--command" : "--ref", text]);
}
export const removeSecret = (host: string, service: string) => sbx(host, ["secret", "rm", service, "--force"]);

// ── network ─────────────────────────────────────────────────────────

/** A network rule from `sbx policy ls --json`. `own` is one added here or by an approval, not a preset. */
export type Rule = { id: string; name: string; decision: "allow" | "deny"; resources: string[]; own: boolean; scope: string };

export function parseRules(json: string): Rule[] {
  const v = JSON.parse(lastJson(json) || "{}");
  return list(v?.rules ?? v).filter((o) => str(o.resource_type || "network") === "network").map((o) => {
    const via = str((o.provenance as Record<string, unknown> | undefined)?.created_via);
    return {
      id: first(o, "id", "rule_id"),
      name: first(o, "name", "id"),
      decision: str(o.decision) === "deny" ? "deny" : "allow",
      resources: Array.isArray(o.resources) ? o.resources.map(str).filter(Boolean) : [],
      own: !!via && via !== "default" && str(o.origin || "local") === "local",
      scope: first(o, "scope") || "global",
    } satisfies Rule;
  });
}

/** A host the proxy blocked, from `sbx policy log --json`. */
export type Blocked = { host: string; count: number; sandbox: string };

export function parseBlocked(json: string): Blocked[] {
  const v = JSON.parse(lastJson(json) || "{}");
  return list(v?.blocked).map((o) => ({
    host: first(o, "host", "resource", "destination", "target", "domain").replace(/:443$/, ""),
    count: Number(o.count ?? o.requests ?? o.request_count ?? 1) || 1,
    sandbox: first(o, "sandbox", "sandbox_name", "name"),
  })).filter((b) => b.host);
}

export const listRules = async (host: string) => parseRules(await sbx(host, ["policy", "ls", "--type", "network", "--json"]));
export const listBlocked = async (host: string) => parseBlocked(await sbx(host, ["policy", "log", "--type", "network", "--json"]));
/** Let `host`'s sandboxes reach `dest` (a domain, a wildcard or host:port). */
export const allowHost = (host: string, dest: string) => sbx(host, ["policy", "allow", "network", dest.trim()]);
export const removeRule = (host: string, id: string) => sbx(host, ["policy", "rm", "network", "--id", id, "--force"]);
