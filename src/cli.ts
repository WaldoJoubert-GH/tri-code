// The `tri` command (cli.rs): `tri .` and `tri <folder>` open that folder as a project, or focus
// it when it already is one; `tri <file>[:line]` opens the file in the Editor Window of the project
// that holds it (the deepest one, so a Worktree wins over its repo), else of a new project at the
// file's repo or folder. Paths are always on this machine. Settings › Command line installs `tri`.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Project, app, isLocalHost, setApp } from "./state";
import { openFolder } from "./OpenProject";
import { openFile } from "./files";
import { flash } from "./ui";
import { editorPath, ownerOf, samePath } from "./clipaths";

export type Target = { path: string; dir: boolean; root: string | null; line: number | null; col: number | null };

/** The project at exactly `dir`, focused, or a new one there. */
function project(dir: string): Project | undefined {
  const at = app.projects.find((p) => isLocalHost(p.host) && !p.sample && samePath(p.path, dir));
  if (at) {
    setApp("activeProject", at.id);
    return at;
  }
  const id = openFolder("local", dir);
  return app.projects.find((p) => p.id === id);
}

function open(t: Target) {
  if (t.dir) {
    project(t.path);
    return;
  }
  const p = ownerOf(app.projects, t.path) ?? project(t.root ?? t.path.replace(/[\\/][^\\/]*$/, ""));
  if (!p) return;
  setApp("activeProject", p.id);
  openFile(p, editorPath(p, t.path), t.line ? { at: { line: t.line } } : {});
}

async function drain() {
  try {
    const targets = await invoke<Target[]>("cli_take");
    for (const t of targets) open(t);
  } catch (e) {
    console.warn("tri: opening from the command line failed:", e);
  }
}

/** Mount once, after the state has loaded (App): opens what `tri` asked for, now and on each later call. */
export function startCli() {
  void listen("cli-open", () => void drain());
  void drain();
}

// ---- Settings › Command line ----

export type CliSetup = { state: "missing" | "installed" | "stale"; script: string; onPath: boolean };

const [setup, setSetup] = createSignal<CliSetup | null>(null);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal("");
export { setup as cliSetup, busy as cliBusy, error as cliError };

export async function refreshCli() {
  try {
    setSetup(await invoke<CliSetup>("cli_status"));
  } catch (e) {
    setError(String(e));
  }
}

async function act(cmd: "cli_install" | "cli_remove", done: string) {
  setBusy(true);
  setError("");
  try {
    await invoke(cmd);
    flash(done);
  } catch (e) {
    setError(String(e));
  } finally {
    setBusy(false);
    await refreshCli();
  }
}

export const installCli = () => act("cli_install", "tri is installed · open a new terminal and run tri .");
export const removeCli = () => act("cli_remove", "tri is removed");
