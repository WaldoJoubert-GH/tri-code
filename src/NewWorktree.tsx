// The New Worktree dialog (Alt+W): a branch name, or an In Progress issue to name it after,
// and the agent to open in the new checkout. Creating it runs `git worktree add` on the
// project's host (or, for a folder that isn't a repo, copies it) and switches to the Worktree.

import { For, Show, createSignal } from "solid-js";
import { app, projectById, worktreesOf } from "./state";
import { closeNewWorktree, createWorktree, issueBranch, kinds, newWorktreeFor, toBranch, worktreeDir } from "./worktrees";
import { dev, inProgress, slugOf } from "./issues";
import { gitOf } from "./git";
import { Icon } from "./lucide";

export function NewWorktreeDialog() {
  return (
    <Show when={projectById(newWorktreeFor() ?? "")} keyed>
      {(repo) => {
        const [name, setName] = createSignal("");
        const [issue, setIssue] = createSignal<string | undefined>();
        // The first agent with a command (claude, usually); "" opens nothing.
        const [agent, setAgent] = createSignal(app.agents.find((a) => a.command.trim())?.id ?? "");
        const [busy, setBusy] = createSignal(false);
        const [error, setError] = createSignal("");
        const branch = () => toBranch(name());
        const base = () => gitOf(repo.id).status?.base ?? "main";
        const issues = () => inProgress(repo.id);
        const taken = () => worktreesOf(repo.id).some((w) => w.branch === branch());
        /** The repos inside a folder that isn't one, which a copy adds back as worktrees; null for a repo. */
        const nested = () => {
          const k = kinds[repo.id];
          return k && !k.git ? k.repos : null;
        };

        const create = async () => {
          if (!branch() || busy()) return;
          setBusy(true);
          setError("");
          try {
            await createWorktree(repo, branch(), { base: base(), issue: issue(), agent: app.agents.find((a) => a.id === agent()) });
            closeNewWorktree();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        };

        return (
          <div class="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && closeNewWorktree()}>
            <div class="wt-dlg" role="dialog" aria-label="New worktree">
              <header>
                <span><Icon name="git-branch-plus" size={14} /> New worktree · {repo.name}</span>
                <button type="button" title="Close (Esc)" aria-label="Close" onClick={closeNewWorktree}>×</button>
              </header>
              <div class="body">
                <input
                  value={name()}
                  placeholder="branch name"
                  spellcheck={false}
                  autocomplete="off"
                  ref={(el) => requestAnimationFrame(() => el.focus())}
                  onInput={(e) => { setName(e.currentTarget.value); setIssue(undefined); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void create();
                    else if (e.key === "Escape") closeNewWorktree();
                    e.stopPropagation();
                  }}
                />
                <Show when={issues().length}>
                  <div class="mt">or name it after an In Progress issue</div>
                  <div class="issues">
                    <For each={issues()}>
                      {(i) => {
                        const slug = slugOf(dev[repo.id], i);
                        return (
                          <button
                            type="button"
                            class="chip"
                            classList={{ on: issue() === slug }}
                            title={i.title}
                            onClick={() => { setName(issueBranch(slug, i.title)); setIssue(slug); }}
                          >
                            <b>{slug}</b> {i.title}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
                <label class="row">
                  Open
                  <select value={agent()} onChange={(e) => setAgent(e.currentTarget.value)}>
                    <For each={app.agents}>{(a) => <option value={a.id}>{a.name || "untitled"}</option>}</For>
                    <option value="">nothing</option>
                  </select>
                  in it
                </label>
                <div class="where">
                  <Show when={kinds[repo.id]} fallback={<span>checking {repo.path}…</span>}>
                    <Show
                      when={nested()}
                      fallback={<span>git worktree add -b {branch() || "<branch>"} {worktreeDir(repo, branch() || "<branch>")} {base()}</span>}
                    >
                      {(repos) => (
                        <>
                          <span>not a git repo: copy {repo.path} → {worktreeDir(repo, branch() || "<branch>")}</span>
                          <Show when={repos().length}>
                            <span>{repos().join(", ")}: git worktree add -b {branch() || "<branch>"}</span>
                          </Show>
                          <span>skips node_modules, target, .venv and other build folders: install again in the copy</span>
                        </>
                      )}
                    </Show>
                  </Show>
                </div>
                <Show when={taken()}><div class="note">{branch()} already has a worktree; Create switches to it.</div></Show>
                <Show when={error()}><div class="note bad">{error()}</div></Show>
              </div>
              <footer>
                <button type="button" onClick={closeNewWorktree}>Cancel</button>
                <button type="button" class="primary" disabled={!branch() || busy()} onClick={() => void create()}>
                  {busy() ? "Creating…" : "Create"}
                </button>
              </footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
