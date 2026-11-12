// Sampling a host for the Monitor Window, and ending a process there. Commands are in
// src-tauri/src/monitor.rs, the data's shape and the pure parts in monitordata.ts.

import { Channel, invoke } from "@tauri-apps/api/core";
import { type Project, addTab, focusTab } from "./state";
import type { Snapshot } from "./monitordata";

/** Open or focus the project's Monitor Window. */
export function openMonitorPanel(project: Project): string {
  const existing = project.tabs.find((t) => t.kind === "monitor");
  const id = existing?.id ?? addTab(project.id, "monitor");
  focusTab(project.id, id);
  return id;
}

/** Sample `host` every `every` seconds until the returned function is called. `onEnd` hears why
 *  sampling stopped by itself (ssh dropped, no /proc). */
export function sample(id: string, host: string, dirs: string[], every: number, onSample: (s: Snapshot) => void, onEnd: (why: string) => void): () => void {
  const samples = new Channel<Snapshot>();
  const exit = new Channel<string>();
  let stopped = false;
  samples.onmessage = (s) => { if (!stopped) onSample(s); };
  exit.onmessage = (e) => { if (!stopped) onEnd(e); };
  invoke("monitor_start", { id, host, dirs, every, onSample: samples, onExit: exit }).catch((e) => { if (!stopped) onEnd(String(e)); });
  return () => {
    if (stopped) return;
    stopped = true;
    void invoke("monitor_stop", { id });
  };
}

/** End `pid` and everything it started, if it is still the process born at `born`. */
export async function endProcess(host: string, pid: number, born: number): Promise<void> {
  await invoke("monitor_end", { host, pid, born });
}
