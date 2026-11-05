// Running docker for the Docker Window: the one-shot list, the log and event streams, and the ssh
// forwards behind port chips. Commands are in src-tauri/src/docker.rs, parsing in dockerdata.ts.

import { Channel, invoke } from "@tauri-apps/api/core";
import { type Project, addTab, focusTab } from "./state";
import { type Port, parseContainers, tunnelTarget } from "./dockerdata";

/** Open or focus the project's Docker Window. */
export function openDockerPanel(project: Project): string {
  const existing = project.tabs.find((t) => t.kind === "docker");
  const id = existing?.id ?? addTab(project.id, "docker");
  focusTab(project.id, id);
  return id;
}

export async function listContainers(host: string, path: string) {
  const r = await invoke<{ dirs: string[]; out: string }>("docker_ps", { host, path });
  return { roots: r.dirs, list: parseContainers(r.out) };
}

/** Start or stop a stack or a container. Resolves once docker has finished. */
export async function containerAction(host: string, action: "start" | "stop", target: { stack: string } | { container: string }): Promise<void> {
  await invoke("docker_action", { host, action, ...target });
}

/** What a stream's owner calls to end it. Safe before the stream has started, and twice. */
export type Stop = () => void;

function follow(command: string, args: Record<string, unknown>, onLines: (lines: string[]) => void, onExit: (code: number) => void): Stop {
  const lines = new Channel<string[]>();
  const exit = new Channel<number>();
  let stopped = false;
  lines.onmessage = (l) => { if (!stopped) onLines(l); };
  exit.onmessage = (c) => { if (!stopped) onExit(c); };
  const id = invoke<number>(command, { ...args, onLines: lines, onExit: exit }).catch((e) => {
    if (!stopped) {
      onLines([`${e}`]);
      onExit(-1);
    }
    return undefined;
  });
  return () => {
    if (stopped) return;
    stopped = true;
    void id.then((i) => i !== undefined && invoke("docker_stop", { id: i }));
  };
}

/** Follow a stack's compose logs or a container's own. `since` picks up where an ended stream left off. */
export function followLogs(host: string, target: { stack: string } | { container: string }, tail: number, since: string | undefined, onLines: (lines: string[]) => void, onExit: (code: number) => void): Stop {
  return follow("docker_logs", { host, ...target, tail, since }, onLines, onExit);
}

export function followEvents(host: string, onLines: (lines: string[]) => void, onExit: (code: number) => void): Stop {
  return follow("docker_events", { host }, onLines, onExit);
}

// Tunnels last as long as the window, not the mounted panel: switching project and back shouldn't
// break a page that's open on one.
type Forward = { id: number; port: number };
const forwards = new Map<string, Map<string, Promise<Forward>>>();

const portKey = (p: Port) => `${p.bind}:${p.host}/${p.proto}`;

/** The local port for a port on an ssh host, opening its tunnel the first time. */
export async function forwardPort(tabId: string, host: string, p: Port): Promise<number> {
  const map = forwards.get(tabId) ?? new Map<string, Promise<Forward>>();
  forwards.set(tabId, map);
  const key = portKey(p);
  let f = map.get(key);
  if (!f) {
    f = invoke<Forward>("docker_forward", { host, toHost: tunnelTarget(p), port: p.host });
    map.set(key, f);
    // A failed tunnel can be tried again.
    f.catch(() => map.delete(key));
  }
  return (await f).port;
}

/** The ports already forwarded for this window, published port key to local port. */
export async function forwardedPorts(tabId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [k, f] of forwards.get(tabId) ?? []) {
    const r = await f.catch(() => undefined);
    if (r) out[k] = r.port;
  }
  return out;
}
export { portKey };

/** The window has closed for good: end its tunnels. */
export function closeDockerWindow(tabId: string) {
  for (const f of forwards.get(tabId)?.values() ?? []) void f.then((r) => invoke("docker_unforward", { id: r.id })).catch(() => {});
  forwards.delete(tabId);
}
