// An agent asks for a Worktree (`create_worktree` in mcp/tri-code.mjs) and follows it there: tri-code
// makes the checkout with the repo's saved setup, and the agent's window moves to the new Worktree
// with its program still running. Then the agent's working directory has to follow. Claude changes
// its own with EnterWorktree, which needs a checkout git lists, so a Folder Copy is refused. pi can't,
// so tri-code starts it over in the new folder when its turn ends, on a fork of its conversation.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { app, isLocalHost, moveTab, piCanFollow, projectById, repoOf, setApp } from "./state";
import { followAfterTurn, rehomeSession } from "./terms";
import { agentBranch } from "./branchname";
import { type Branch, adoptWorktrees, createWorktree, kinds } from "./worktrees";
import { gitOf } from "./git";
import { flash } from "./ui";

async function follow(project: string, tab: string, name: string): Promise<{ path: string; branch: string; setup?: string; project: string; restart: boolean }> {
  const from = projectById(project);
  const caller = from?.tabs.find((t) => t.id === tab);
  if (!from || !caller) throw new Error("this window is no longer open");
  const repo = repoOf(from);
  await adoptWorktrees(repo);
  if (!kinds[repo.id]?.git) throw new Error("this folder isn't a git repo: make its worktree with New worktree in tri-code");
  const known = await invoke<Branch[]>("git_branches", { host: repo.host, path: repo.path });
  const branch = agentBranch(name, known.map((b) => b.name), repo.branchPrefix);
  if (!branch) throw new Error("that name has nothing a branch can use");

  const watching = app.activeProject === project;
  const made = await createWorktree(repo, branch, { base: gitOf(repo.id).status?.base ?? "main", setup: repo.setup, open: [], background: true });
  const to = projectById(made.project);
  if (!to) throw new Error("the worktree was made but tri-code lost it");
  // Already there (it asked for the Worktree it is in): nothing has to follow.
  const restart = to.id !== project && isLocalHost(to.host) && piCanFollow(caller);
  moveTab(project, to.id, tab);
  rehomeSession(tab, to);
  if (restart) followAfterTurn(tab);
  // The view follows only someone already looking at this project.
  if (watching) setApp("activeProject", to.id);
  else flash(`an agent moved to worktree ${branch}`);
  return { path: to.path, branch, setup: made.setup, project: to.id, restart };
}

/** Mount once, after the state has loaded (App): answers the endpoint's worktree requests. */
export function startAgentWorktrees() {
  void listen<{ req: string; project: string; tab: string; branch: string }>("agent-worktree", ({ payload: { req, project, tab, branch } }) => {
    follow(project, tab, branch).then(
      (r) => invoke("agent_worktree_made", { req, tab, project: r.project, made: { path: r.path, branch: r.branch, setup: r.setup ?? null, restart: r.restart } }),
      (e) => invoke("agent_open_failed", { req, error: e instanceof Error ? e.message : String(e) }),
    ).catch((e) => console.warn("agent worktree answer failed:", e));
  });
}
