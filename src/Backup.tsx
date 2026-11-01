// Settings › Backup: export this machine's configuration to a file and import one, with a preview
// of what an import changes. The merge itself is config.ts.

import { For, Show, createSignal } from "solid-js";
import { produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { type ConfigFile, type ImportPlan, type Section, SECTIONS, applyImport, assetKeys, assetName, buildExport, parseConfig, planImport } from "./config";
import { app, newId, setApp } from "./state";
import { setBgImage } from "./Appearance";
import { loadIcons } from "./icons";
import { reloadSounds } from "./signals";
import { appVersion } from "./updater";
import { flash } from "./ui";

const LOAD = { bg: "bg_load", icon: "icon_load", sound: "sound_load" } as const;
const SAVE = { bg: "bg_save", icon: "icon_save", sound: "sound_save" } as const;
const arg = (kind: keyof typeof LOAD, key: string) => (kind === "sound" ? { key } : { projectId: key });

const FILTERS = [{ name: "tri-code configuration", extensions: ["json"] }];

const [picks, setPicks] = createSignal<Section[]>(SECTIONS.map((s) => s.id));
const [pending, setPending] = createSignal<{ file: ConfigFile; plan: ImportPlan; picks: Section[] } | null>(null);
const [error, setError] = createSignal("");
const [busy, setBusy] = createSignal(false);

const toggle = (list: Section[], id: Section) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** Pick a file name and write the picked sections, with each exported project's uploaded files. */
export async function exportConfig(sections = picks()) {
  setError("");
  const path = await save({ title: "Export configuration", defaultPath: "tri-code-config.json", filters: FILTERS });
  if (!path) return;
  setBusy(true);
  try {
    const assets: Record<string, string> = {};
    await Promise.all(assetKeys(app, sections).map(async (a) => {
      const url = await invoke<string | null>(LOAD[a.kind], arg(a.kind, a.key)).catch(() => null);
      if (url) assets[assetName(a)] = url;
    }));
    const file = buildExport(app, sections, assets, appVersion);
    await invoke("config_write", { path, json: JSON.stringify(file, null, 2) });
    flash("configuration exported");
  } catch (e) {
    setError(`Export failed: ${e}`);
  } finally {
    setBusy(false);
  }
}

/** Pick a file and show what importing it would do. Nothing changes until Import is pressed. */
export async function chooseImport() {
  setError("");
  const path = await open({ title: "Import configuration", multiple: false, directory: false, filters: FILTERS });
  if (typeof path !== "string") return;
  try {
    const file = parseConfig(await invoke<string>("config_read", { path }));
    const plan = planImport(app, file);
    setPending({ file, plan, picks: plan.sections.map((s) => s.id) });
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}

async function runImport() {
  const p = pending();
  if (!p) return;
  setBusy(true);
  try {
    let writes: ReturnType<typeof applyImport> = [];
    setApp(produce((s) => { writes = applyImport(s, p.file, p.picks, newId); }));
    for (const w of writes) await invoke(SAVE[w.kind], { ...arg(w.kind, w.key), dataUrl: w.dataUrl });
    for (const w of writes) {
      if (w.kind === "bg") await setBgImage(w.key, w.dataUrl);
      if (w.kind === "sound") reloadSounds(w.key.slice(0, w.key.lastIndexOf("-")));
    }
    loadIcons();
    setPending(null);
    flash("configuration imported");
  } catch (e) {
    setError(`Import failed: ${e}`);
  } finally {
    setBusy(false);
  }
}

function ImportPreview() {
  return (
    <Show when={pending()}>
      {(p) => (
        <div class="bk-preview">
          <p class="bk-from">From tri-code {p().file.app}, exported {new Date(p().file.exportedAt).toLocaleString()}</p>
          <For each={p().plan.sections}>
            {(s) => (
              <label class="bk-check">
                <input
                  type="checkbox"
                  checked={p().picks.includes(s.id)}
                  onChange={() => setPending({ ...p(), picks: toggle(p().picks, s.id) })}
                />
                <span><b>{s.name}</b> <span class="bk-dim">{s.summary}</span></span>
              </label>
            )}
          </For>
          <For each={p().plan.notes}>{(n) => <p class="note">{n}</p>}</For>
          <p class="note">Nothing is deleted: matching entries are replaced and the rest are added.</p>
          <div class="bk-actions">
            <button type="button" class="rc-btn" disabled={busy() || !p().picks.length} onClick={runImport}>Import</button>
            <button type="button" class="rc-btn ghost" disabled={busy()} onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}
    </Show>
  );
}

export function BackupPage() {
  return (
    <>
      <h4>Export</h4>
      <For each={SECTIONS}>
        {(s) => (
          <label class="bk-check">
            <input type="checkbox" checked={picks().includes(s.id)} onChange={() => setPicks(toggle(picks(), s.id))} />
            {s.name}
          </label>
        )}
      </For>
      <div class="bk-actions">
        <button type="button" class="rc-btn" disabled={busy() || !picks().length} onClick={() => exportConfig()}>Export…</button>
      </div>
      <p class="note">
        One JSON file with your preferences, hotkeys, commands, browser profiles, environments and projects, with their uploaded
        backgrounds, icons and sounds. Window layouts, Worktrees, PIN locks, phone pairing and browser cookies stay on this machine.
      </p>
      <h4>Import</h4>
      <Show when={!pending()}>
        <div class="bk-actions">
          <button type="button" class="rc-btn" disabled={busy()} onClick={chooseImport}>Import…</button>
        </div>
      </Show>
      <ImportPreview />
      <Show when={error()}><p class="rc-err">{error()}</p></Show>
    </>
  );
}
