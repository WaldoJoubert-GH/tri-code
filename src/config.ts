// Configuration export and import (Settings › Backup): what moves to another machine, as one
// JSON file. Pure, so config.test.ts can run it; Backup.tsx does the dialogs, disk and caches.
//
// Left out on purpose: PIN Locks (a hash that travels weakens the gate), Remote Control pairing
// (phone.json holds secrets), browser data (cookies, passwords), Worktrees and the Sample Project
// (their folders are this machine's), window layouts and runtime state (recent, pinned, tour).

import type { Agent, Fav, Persisted, Profile, Project, SoundEvent } from "./state";
import { migrate } from "./state";

export const CONFIG_FORMAT = "tri-code-config";
export const CONFIG_VERSION = 1;

export type Section = "preferences" | "commands" | "profiles" | "environments" | "projects";
export const SECTIONS: { id: Section; name: string }[] = [
  { id: "preferences", name: "Preferences" },
  { id: "commands", name: "Commands" },
  { id: "profiles", name: "Browser Profiles" },
  { id: "environments", name: "Environments" },
  { id: "projects", name: "Projects" },
];

const EVENTS: SoundEvent[] = ["blocked", "done", "error"];

/** A project as exported: its place and its appearance, no windows. */
export type ProjectConfig = Pick<Project, "id" | "name" | "host" | "path" | "accent" | "bg" | "dim" | "favs"> &
  Partial<Pick<Project, "icon" | "notify" | "profile" | "diffMode" | "setup" | "branchPrefix">>;

export type ConfigFile = {
  format: typeof CONFIG_FORMAT;
  version: number;
  app: string;
  exportedAt: string;
  sections: {
    preferences?: Pick<Persisted, "settings" | "notify" | "gap">;
    commands?: Agent[];
    profiles?: Profile[];
    environments?: Pick<Persisted, "environments" | "envStyles" | "envSsh">;
    projects?: ProjectConfig[];
  };
  /** Data URLs by asset key (assetKeys). */
  assets: Record<string, string>;
};

/** Where an asset is stored: the bg.rs command family and its key there. */
export type AssetRef = { kind: "bg" | "icon" | "sound"; key: string };
/** The file's key for an asset. */
export const assetName = (a: AssetRef) => `${a.kind}/${a.key}`;

/** Projects that travel: not Worktrees, not the Sample Project. */
export const exportable = (s: Pick<Persisted, "projects">) => s.projects.filter((p) => !p.parent && !p.sample);

/** The uploaded files a project has, by the key bg.rs stores them under. */
export function assetsOf(p: Pick<Project, "id" | "bg" | "icon" | "notify">): AssetRef[] {
  const out: AssetRef[] = [];
  if (p.bg === "image") out.push({ kind: "bg", key: p.id });
  if (p.icon?.kind === "image") out.push({ kind: "icon", key: p.id });
  for (const ev of EVENTS) if (p.notify?.[ev] === "custom") out.push({ kind: "sound", key: `${p.id}-${ev}` });
  return out;
}

/** The assets an export of `sections` needs loaded from disk. */
export const assetKeys = (s: Persisted, sections: Section[]): AssetRef[] =>
  sections.includes("projects") ? exportable(s).flatMap(assetsOf) : [];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function projectConfig(p: Project): ProjectConfig {
  const { id, name, host, path, accent, bg, dim, favs, icon, notify, profile, diffMode, setup, branchPrefix } = p;
  return clone({ id, name, host, path, accent, bg, dim, favs, icon, notify, profile, diffMode, setup, branchPrefix });
}

/** The file for `sections` of `s`. `assets` holds what assetKeys asked for (missing ones are skipped). */
export function buildExport(s: Persisted, sections: Section[], assets: Record<string, string>, app: string, now = new Date()): ConfigFile {
  const has = (x: Section) => sections.includes(x);
  const projects = has("projects") ? exportable(s) : [];
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    app,
    exportedAt: now.toISOString(),
    sections: {
      ...(has("preferences") ? { preferences: clone({ settings: s.settings, notify: s.notify, gap: s.gap }) } : {}),
      ...(has("commands") ? { commands: clone(s.agents) } : {}),
      ...(has("profiles") ? { profiles: clone(s.profiles) } : {}),
      ...(has("environments") ? { environments: clone({ environments: s.environments, envStyles: s.envStyles, envSsh: s.envSsh }) } : {}),
      ...(has("projects") ? { projects: projects.map(projectConfig) } : {}),
    },
    assets: Object.fromEntries(projects.flatMap(assetsOf).map(assetName).filter((k) => assets[k]).map((k) => [k, assets[k]])),
  };
}

/** Read a file's text, or throw a message to show. */
export function parseConfig(text: string): ConfigFile {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON.");
  }
  if (raw?.format !== CONFIG_FORMAT) throw new Error("That file isn't a tri-code configuration.");
  if (typeof raw.version !== "number" || raw.version > CONFIG_VERSION) {
    throw new Error(`That file is from a newer tri-code (${raw.app ?? "unknown"}). Update to import it.`);
  }
  return { ...raw, sections: raw.sections ?? {}, assets: raw.assets ?? {} };
}

/** What importing a section would do, for the preview. */
export type SectionPlan = { id: Section; name: string; summary: string };
export type ImportPlan = { sections: SectionPlan[]; notes: string[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function byIdSummary<T extends { id: string }>(cur: T[], inc: T[], one: string) {
  const replace = inc.filter((x) => cur.some((c) => c.id === x.id)).length;
  return `${plural(inc.length, one)}: ${inc.length - replace} new, ${replace} replacing the same id`;
}

const sameProject = (a: { host: string; path: string }, b: { host: string; path: string }) =>
  (a.host || "local") === (b.host || "local") && a.path === b.path;

export function planImport(s: Persisted, f: ConfigFile): ImportPlan {
  const sec = f.sections;
  const out: SectionPlan[] = [];
  const notes: string[] = [];
  const add = (id: Section, summary: string) => out.push({ id, name: SECTIONS.find((x) => x.id === id)!.name, summary });
  if (sec.preferences) {
    const keys = Object.keys(sec.preferences.settings ?? {}).length;
    add("preferences", `hotkeys, colours, signals and ${plural(keys, "other setting")}`);
  }
  if (sec.commands) add("commands", byIdSummary(s.agents, sec.commands, "command"));
  if (sec.profiles) add("profiles", `${byIdSummary(s.profiles, sec.profiles, "profile")}; cookies and passwords stay behind`);
  if (sec.environments) {
    const fresh = sec.environments.environments.filter((h) => !s.environments.includes(h));
    add("environments", `${plural(sec.environments.environments.length, "environment")}: ${fresh.length} new`);
    const keys = Object.entries(sec.environments.envSsh ?? {}).filter(([, v]) => v.identityFile).map(([h]) => h);
    if (keys.length) notes.push(`Key files for ${keys.join(", ")} are paths on the old machine; check they exist here.`);
    notes.push("PIN locks aren't exported; set them again in the sidebar.");
  }
  if (sec.projects) {
    const known = sec.projects.filter((p) => exportable(s).some((q) => sameProject(p, q))).length;
    add("projects", `${plural(sec.projects.length, "project")}: ${sec.projects.length - known} new, ${known} already open (appearance updated)`);
    notes.push("Projects open with an empty canvas. Folders on this machine are not created or checked.");
  }
  return { sections: out, notes };
}

/** An asset to write after the import, with the id it now belongs to. */
export type AssetWrite = AssetRef & { dataUrl: string };

function mergeById<T extends { id: string }>(cur: T[], inc: T[]): T[] {
  const out = cur.map((c) => inc.find((x) => x.id === c.id) ?? c);
  for (const x of inc) if (!cur.some((c) => c.id === x.id)) out.push(x);
  return out;
}

/** One level deeper than a spread, so the file's hotkeys override yours one action at a time. */
function mergeSettings(cur: Record<string, any>, inc: Record<string, any>) {
  const out: Record<string, any> = { ...cur };
  for (const [k, v] of Object.entries(inc)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur[k] && typeof cur[k] === "object" ? { ...cur[k], ...v } : v;
  }
  return out;
}

/**
 * Merge the `picks` of `f` into `s` (a store draft or a plain object) in place. Nothing is deleted:
 * ids that match are replaced, projects at the same host and path keep their windows and get the
 * file's appearance, anything else is added. Returns the assets to write, under their new keys.
 */
export function applyImport(s: Persisted, f: ConfigFile, picks: Section[], newId: () => string): AssetWrite[] {
  const sec = f.sections;
  const on = (x: Section) => picks.includes(x) && !!sec[x];
  // Fill in fields the file's tri-code didn't know about, the same way an old state.json is read.
  const m = migrate({
    projects: (sec.projects ?? []).map((p) => ({ ...p, tabs: [] })),
    agents: sec.commands ?? [],
    environments: sec.environments?.environments ?? [],
  });

  // Project ids in the file → ids here, for scopes and asset keys.
  const ids = new Map<string, string>();
  const writes: AssetWrite[] = [];
  if (on("projects")) {
    m.projects.forEach((p, i) => {
      const fileId = sec.projects![i].id;
      const here = exportable(s).find((q) => sameProject(q, p));
      const id = here?.id ?? newId();
      ids.set(fileId, id);
      const fields = { name: p.name, accent: p.accent, bg: p.bg, dim: p.dim, favs: p.favs as Fav[], icon: p.icon, notify: p.notify, profile: p.profile, diffMode: p.diffMode, setup: p.setup, branchPrefix: p.branchPrefix };
      // An uploaded file the export lacked falls back to the default.
      for (const a of assetsOf({ ...p, id: fileId })) {
        const dataUrl = f.assets[assetName(a)];
        const key = a.kind === "sound" ? `${id}${a.key.slice(fileId.length)}` : id;
        if (dataUrl) writes.push({ kind: a.kind, key, dataUrl });
        else if (a.kind === "bg") fields.bg = "none";
        else if (a.kind === "icon") fields.icon = undefined;
        else if (fields.notify) fields.notify = { ...fields.notify, [a.key.slice(fileId.length + 1)]: undefined };
      }
      if (here) {
        const target = s.projects.find((q) => q.id === id)!;
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) delete (target as any)[k];
          else (target as any)[k] = v;
        }
      } else {
        const fresh: Project = { ...p, ...fields, id, tabs: [], ws: 0 };
        for (const k of Object.keys(fresh) as (keyof Project)[]) if (fresh[k] === undefined) delete fresh[k];
        s.projects.push(fresh);
      }
      if (!s.environments.includes(p.host)) s.environments.push(p.host);
    });
  }

  if (on("preferences")) {
    const pr = sec.preferences!;
    s.settings = migrate({ settings: mergeSettings(s.settings, pr.settings ?? {}) }).settings;
    s.notify = { ...s.notify, ...pr.notify };
    if (typeof pr.gap === "number") s.gap = pr.gap;
  }

  if (on("commands")) {
    const known = new Set(s.projects.map((p) => p.id));
    const agents = m.agents.map((a) => {
      if (!a.scope || !("project" in a.scope)) return a;
      const id = ids.get(a.scope.project) ?? a.scope.project;
      // Scoped to a project that didn't come along: offer it everywhere rather than nowhere.
      if (!known.has(id)) {
        const { scope: _, ...rest } = a;
        return rest;
      }
      return { ...a, scope: { project: id } };
    });
    s.agents = mergeById(s.agents, agents);
  }

  if (on("profiles")) s.profiles = mergeById(s.profiles, clone(sec.profiles!));

  if (on("environments")) {
    const e = sec.environments!;
    for (const h of e.environments) if (!s.environments.includes(h)) s.environments.push(h);
    for (const [h, v] of Object.entries(e.envStyles ?? {})) s.envStyles[h] = { ...s.envStyles[h], ...v };
    for (const [h, v] of Object.entries(e.envSsh ?? {})) s.envSsh[h] = { ...s.envSsh[h], ...v };
  }
  // References the file made to profiles or commands that aren't here fall back to the default.
  const profiles = new Set(s.profiles.map((p) => p.id));
  for (const p of s.projects) if (p.profile && !profiles.has(p.profile)) delete p.profile;
  if (s.settings.profile && !profiles.has(s.settings.profile)) delete s.settings.profile;
  const wa = s.settings.worktreeAgent;
  if (wa && !s.agents.some((a) => a.id === wa)) delete s.settings.worktreeAgent;
  return writes;
}
