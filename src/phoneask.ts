// Remote Control: what a phone asks of tri-code beyond watching terminals. phone.rs passes each
// question on (`phone-ask`) and the answer back (`phone_reply`), so the phone uses the same git,
// file and window code as the desktop, ssh projects included. Every question names a project,
// which must be in an unlocked Environment; files must be under the project's folders.
// Chosen from design/remote-view.html (variant B): open new windows, and view Git and Editor.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Agent, type Project, addTab, isWebApp, projectById, sendTo, tabName } from "./state";
import { normalizeUrl } from "./urls";
import { envLocked } from "./envlock";
import { offeredIn } from "./scope";
import { type Change, type GitStatus, type RepoStatus, repoRoot } from "./git";
import type { FsList, FsText } from "./files";
import { hostAt, rootsOf, within } from "./links";
import { iconSvg } from "./lucide";
import { flash } from "./ui";

/** A plain shell, offered first even when the commands list has none. */
const SHELL: Agent = { id: "", name: "shell", command: "", icon: "square-terminal" };

/** What the phone's + offers in `p`: a shell first, then the project's commands and web apps. */
export function phoneCommands(p: Project): { id: string; name: string; web: boolean; icon: string }[] {
  const offered = offeredIn(p);
  const shell = offered.find((a) => !isWebApp(a) && !a.command.trim()) ?? SHELL;
  return [shell, ...offered.filter((a) => a !== shell)].map((a) => ({
    id: a.id, name: a.name || "shell", web: isWebApp(a), icon: iconSvg(a.icon || (isWebApp(a) ? "globe" : "square-terminal")),
  }));
}

type Ask =
  | { what: "open"; project: string; command: string; ws: number }
  | { what: "git"; project: string }
  | { what: "diff"; project: string; repo: string; path: string; staged: boolean; untracked: boolean; orig?: string }
  | { what: "editor"; project: string; tab: string }
  | { what: "list"; project: string; path: string }
  | { what: "read"; project: string; path: string };

function projectOf(id: string): Project {
  const p = projectById(id);
  if (!p || p.sample || envLocked(p.host)) throw new Error("That project isn't there any more");
  return p;
}

/** A path relative to a repo, as git reports it: no way out of the repo. */
function relative(s: string): string {
  const parts = s.split(/[\\/]/);
  if (/^([a-z]:|[\\/])/i.test(s) || parts.includes("..")) throw new Error("Not a path in this project");
  return s;
}

/** A file or folder the phone may read: under one of the project's folders (its own, Linked Folders). */
function under(p: Project, path: string): { host: string; path: string } {
  if (path.split(/[\\/]/).includes("..") || !rootsOf(p).some((r) => within(r.path, path))) throw new Error("Not a path in this project");
  return { host: hostAt(p, path), path };
}

const changeOf = (c: Change) => ({ path: c.path, x: c.x, y: c.y, orig: c.orig, index: c.index, work: c.work });

async function answer(q: Ask): Promise<unknown> {
  const p = projectOf(q.project);
  switch (q.what) {
    case "open": {
      const a = q.command ? offeredIn(p).find((x) => x.id === q.command) : SHELL;
      if (!a) throw new Error("That command isn't offered in this project any more");
      const id = isWebApp(a) ? addTab(p.id, "browser", { agent: a, url: normalizeUrl(a.url ?? "") }) : addTab(p.id, "term", a.id ? { agent: a } : {});
      const ws = Math.round(q.ws) - 1;
      if (ws >= 0 && ws < p.spaces.length) sendTo(p.id, id, ws);
      flash(`${p.name}: your phone opened ${a.name || "a shell"}`);
      return { tab: id };
    }
    case "git": {
      const args = { host: p.host, path: p.path };
      const one = (repo: string, s: GitStatus) => ({ repo, branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, op: s.op, files: s.files.map(changeOf) });
      try {
        return { repos: [one("", await invoke<GitStatus>("git_status", args))] };
      } catch (e) {
        const repos = await invoke<RepoStatus[]>("folder_status", args).catch(() => null);
        if (!repos?.length) throw new Error(`Not a git repo: ${e}`, { cause: e });
        return { repos: repos.map((r) => (r.status ? one(r.repo, r.status) : { repo: r.repo, error: r.error ?? "couldn't read it", files: [] })) };
      }
    }
    case "diff": {
      const repo = q.repo ? relative(q.repo) : "";
      return {
        text: await invoke<string>("git_diff", {
          host: p.host, path: repoRoot(p, repo), file: relative(q.path), staged: !!q.staged, untracked: !q.staged && !!q.untracked,
          orig: q.staged && q.orig ? relative(q.orig) : null,
        }),
      };
    }
    case "editor": {
      const t = p.tabs.find((x) => x.id === q.tab && x.kind === "editor");
      if (!t) throw new Error("That editor window is gone");
      return { name: tabName(t), root: p.path, current: t.path ?? null, files: t.files ?? [] };
    }
    case "list": {
      const at = under(p, q.path || p.path);
      const list = await invoke<FsList>("list_files", at);
      return { path: list.path, root: p.path, entries: list.entries.toSorted((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)) };
    }
    case "read": {
      const f = await invoke<FsText>("read_file", under(p, q.path));
      return { path: f.path, size: f.size, binary: f.binary, truncated: f.truncated, text: f.text };
    }
  }
}

/** Mount once (in App, through startPhoneSync): answer the phones' questions. */
export function answerPhones() {
  return listen<{ id: number; q: Ask }>("phone-ask", async ({ payload }) => {
    let data: unknown;
    try {
      data = (await answer(payload.q)) ?? null;
    } catch (e) {
      data = { error: e instanceof Error ? e.message : String(e) };
    }
    invoke("phone_reply", { id: payload.id, json: JSON.stringify(data) }).catch((e) => console.warn("phone_reply failed:", e));
  });
}
