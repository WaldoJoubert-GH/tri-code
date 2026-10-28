// The New Worktree dialog (Alt+W): a branch name, an existing branch (local, or only on a remote),
// or an In Progress issue to name it after, a setup script to run once in the new checkout (kept per
// repo) and the Commands to open there. Creating it runs `git worktree add` on the project's host (or,
// for a folder that isn't a repo, copies it) and switches to the Worktree.
// Chosen from design/worktree-commands.html (variant D).

import { For, Show, createSignal } from "solid-js";
import { app, projectById, setBranchPrefix, setWorktreeSetup, worktreeAgent, worktreesOf } from "./state";
import { branches, cleanPrefix, closeNewWorktree, createWorktree, fetching, issueBranch, kinds, listed, newWorktreeFor, setupFor, toBranch, worktreeDir } from "./worktrees";
import { SETUP_VARS } from "./setup";
import { dev, inProgress, slugOf } from "./issues";
import { gitOf } from "./git";
import { Icon } from "./lucide";

export function NewWorktreeDialog() {
  return (
    <Show when={projectById(newWorktreeFor() ?? "")} keyed>
      {(repo) => {
        const [name, setName] = createSignal("");
        const [issue, setIssue] = createSignal<string | undefined>();
        const [setup, setSetup] = createSignal(repo.setup ?? "");
        let setupEl!: HTMLTextAreaElement;
        /** Put `{name}` where the cursor is in the setup box (at the end if it hasn't been focused). */
        const insertVar = (name: string) => {
          const v = setup(), at = setupEl.selectionStart ?? v.length, to = setupEl.selectionEnd ?? at;
          const text = `{${name}}`;
          setSetup(v.slice(0, at) + text + v.slice(to));
          setupEl.focus();
          setupEl.setSelectionRange(at + text.length, at + text.length);
        };
        // Settings › Git picks the one that starts on; "" starts with none.
        const [open, setOpen] = createSignal<string[]>(worktreeAgent() ? [worktreeAgent()] : []);
        const toggleOpen = (id: string) => setOpen((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
        /** The picked Commands, in the + menu's order. */
        const opening = () => app.agents.filter((a) => open().includes(a.id));
        const [busy, setBusy] = createSignal(false);
        const [error, setError] = createSignal("");
        /** An existing branch picked below: its name is used as it is, not through toBranch. */
        const [picked, setPicked] = createSignal<string | undefined>();
        const [prefix, setPrefix] = createSignal(repo.branchPrefix ?? "");
        /** A new branch starts with the prefix; an existing one is used as it is. */
        const branch = () => picked() ?? (toBranch(name()) ? cleanPrefix(prefix()) + toBranch(name()) : "");
        /** The prefix the folder leaves out: the typed one, or the saved one for an existing branch. */
        const dirPrefix = () => (picked() ? repo.branchPrefix : prefix());
        const keys = (e: KeyboardEvent) => {
          if (e.key === "Enter") void create();
          else if (e.key === "Escape") closeNewWorktree();
          e.stopPropagation();
        };
        /** The branches that could be checked out: not the ones a checkout already has, matching what is typed. */
        const existing = () => {
          const out = new Set((listed[repo.id] ?? []).map((w) => w.branch));
          const q = name().trim().toLowerCase();
          return (branches[repo.id] ?? []).filter((b) => !out.has(b.name) && b.name.toLowerCase().includes(q)).slice(0, 12);
        };
        /** The picked or typed branch, if it already exists. */
        const found = () => (branches[repo.id] ?? []).find((b) => b.name === branch());
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
            setWorktreeSetup(repo.id, setup());
            // Saved first: the new folder is named without it.
            if (!picked()) setBranchPrefix(repo.id, cleanPrefix(prefix()));
            await createWorktree(repo, branch(), { base: base(), issue: issue(), setup: setup(), open: opening() });
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
                <div class="joined">
                  <input
                    class="pre"
                    value={prefix()}
                    placeholder="prefix/"
                    spellcheck={false}
                    autocomplete="off"
                    disabled={!!picked()}
                    style={{ width: `${Math.min(18, Math.max(7, prefix().length + 2))}ch` }}
                    title={picked() ? "An existing branch is used as it is" : `Every new branch in ${repo.name} starts with this; saved when you press Create`}
                    aria-label="Branch prefix"
                    onInput={(e) => setPrefix(e.currentTarget.value)}
                    onKeyDown={keys}
                  />
                  <input
                    class="nm"
                    value={name()}
                    placeholder="branch name"
                    spellcheck={false}
                    autocomplete="off"
                    aria-label="Branch name"
                    ref={(el) => requestAnimationFrame(() => el.focus())}
                    onInput={(e) => { setName(e.currentTarget.value); setIssue(undefined); setPicked(undefined); }}
                    onKeyDown={keys}
                  />
                </div>
                <Show when={!nested() && (existing().length || fetching() === repo.id)}>
                  <div class="mt">or check out an existing branch<Show when={fetching() === repo.id}> · fetching…</Show></div>
                  <div class="issues">
                    <For each={existing()}>
                      {(b) => (
                        <button
                          type="button"
                          class="chip"
                          classList={{ on: picked() === b.name }}
                          title={b.remote ? `only on ${b.remote}: makes a local ${b.name} tracking ${b.remote}/${b.name}` : b.name}
                          onClick={() => { setName(b.name); setPicked(b.name); setIssue(undefined); }}
                        >
                          <b>{b.name}</b>{b.remote ? ` ${b.remote}` : ""}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
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
                            onClick={() => { setName(issueBranch(slug, i.title)); setIssue(slug); setPicked(undefined); }}
                          >
                            <b>{slug}</b> {i.title}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
                <div class="mt">Setup <span class="r">runs once, in its own window; closes when done</span></div>
                <textarea
                  class="setup"
                  ref={setupEl}
                  value={setup()}
                  placeholder={"bun install\ncp {repo}/.env .env"}
                  spellcheck={false}
                  rows={3}
                  onInput={(e) => setSetup(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void create();
                    else if (e.key === "Escape") closeNewWorktree();
                    e.stopPropagation();
                  }}
                />
                <div class="vars">
                  <For each={SETUP_VARS}>
                    {(v) => (
                      <button type="button" class="chip" title={`${v.hint}: insert at the cursor`} onClick={() => insertVar(v.name)}>
                        <b>{`{${v.name}}`}</b> {v.hint}
                      </button>
                    )}
                  </For>
                </div>
                <div class="mt">and open</div>
                <div class="issues">
                  <For each={app.agents}>
                    {(a) => (
                      <button
                        type="button"
                        class="chip"
                        classList={{ on: open().includes(a.id) }}
                        aria-pressed={open().includes(a.id)}
                        title={a.url ?? (a.command || "login shell")}
                        onClick={() => toggleOpen(a.id)}
                      >
                        <b>{a.name || "untitled"}</b>
                      </button>
                    )}
                  </For>
                </div>
                <div class="where">
                  <Show when={kinds[repo.id]} fallback={<span>checking {repo.path}…</span>}>
                    <Show
                      when={nested()}
                      fallback={
                        <span>
                          {(() => {
                            const b = branch() || "<branch>";
                            const dir = worktreeDir(repo, b, dirPrefix());
                            const f = found();
                            if (!f) return `git worktree add -b ${b} ${dir} ${base()}`;
                            return f.remote ? `git worktree add --track -b ${b} ${dir} ${f.remote}/${b}` : `git worktree add ${dir} ${b}`;
                          })()}
                        </span>
                      }
                    >
                      {(repos) => (
                        <>
                          <span>not a git repo: copy {repo.path} → {worktreeDir(repo, branch() || "<branch>", dirPrefix())}</span>
                          <Show when={repos().length}>
                            <span>{repos().join(", ")}: git worktree add -b {branch() || "<branch>"}</span>
                          </Show>
                          <span>skips node_modules, target, .venv and other build folders: install again in the copy</span>
                        </>
                      )}
                    </Show>
                  </Show>
                  <Show when={setup().trim()}>
                    <span class="then">then runs setup: {setupFor(repo, branch() || "<branch>", setup(), dirPrefix()).join(" && ")}</span>
                  </Show>
                  <span class="then">{opening().length ? `then opens: ${opening().map((a) => a.name || "untitled").join(", ")}` : "then opens nothing"}</span>
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
