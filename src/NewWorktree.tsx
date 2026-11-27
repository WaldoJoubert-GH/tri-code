// The New Worktree dialog (Alt+W): a branch name, an existing branch (local, or only on a remote),
// or an In Progress issue to name it after, a setup script to run once in the new checkout (kept per
// repo), the repo's ignored files to copy in (ticks kept per repo) and the Commands to open there.
// Creating it runs `git worktree add` on the project's host (or, for a folder that isn't a repo,
// copies it) and switches to the Worktree. What Create will do is listed step by step on the right.
// Chosen from design/worktree-commands.html (variant D); the ignored files and the column from
// design/worktree-gitignore.html (variant B).

import { For, Show, createEffect, createSignal, on } from "solid-js";
import { app, projectById, setBranchPrefix, setCopyIgnored, setWorktreeSetup, worktreeAgent, worktreesOf } from "./shared/state/state";
import { branches, cleanPrefix, closeNewWorktree, createWorktree, fetching, ignored, issueBranch, kinds, listed, newWorktreeFor, setupFor, toBranch, worktreeDir } from "./worktrees";
import { BIG, fileSize, filterIgnored, splitPath, startingTicks } from "./ignored";
import { SETUP_VARS } from "./setup";
import { dev, inProgress, slugOf } from "./modules/issues";
import { gitOf } from "./git";
import { Icon } from "./shared/ui/lucide";
import { Modal } from "./shared/ui/Modal";
import { sandboxPreview } from "./shared/preview";
import { canSandbox, hostKey, mountsFor, refreshSbx, sandboxByDefault, sandboxFolders, sbxReady, sbxState, setSandboxHost } from "./modules/sandbox";
import { openSettings } from "./shared/nav";
import { isEnter } from "./shared/ui/enterkey";

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
        // The ignored files to copy: ticked as last time once they are listed (ignored.ts).
        const [ticked, setTicked] = createSignal<Set<string>>(new Set());
        const [query, setQuery] = createSignal("");
        const [onlyTicked, setOnlyTicked] = createSignal(false);
        const files = () => ignored[repo.id];
        createEffect(on(files, (f) => f && setTicked(new Set(startingTicks(f, repo.copyIgnored)))));
        const shownFiles = () => filterIgnored(files() ?? [], query(), ticked(), onlyTicked());
        /** The ticked files, in the listed order. */
        const copying = () => (files() ?? []).filter((f) => ticked().has(f.path));
        const toggleFile = (path: string) => setTicked((t) => {
          const n = new Set(t);
          if (!n.delete(path)) n.add(path);
          return n;
        });
        /** All / none of the files shown, so a search then all ticks just those. */
        const allShown = () => shownFiles().length > 0 && shownFiles().every((f) => ticked().has(f.path));
        const tickShown = () => setTicked((t) => {
          const n = new Set(t), off = allShown();
          for (const f of shownFiles()) off ? n.delete(f.path) : n.add(f.path);
          return n;
        });
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
          if (isEnter(e)) void create();
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
        // The Sandbox toggle: a git repo, or a folder with repos in it, with sbx set up on its host
        // (this machine or the ssh host it is on; Settings › Sandbox).
        // Only while the Sandboxed Worktrees preview is on (Settings › Preview).
        const host = repo.host;
        const remoteHost = hostKey(host) !== "local";
        if (sandboxPreview()) void refreshSbx(host);
        const [boxed, setBoxed] = createSignal(sandboxByDefault());
        const sandboxable = () => sandboxPreview() && canSandbox(repo, kinds[repo.id]);
        /** sbx isn't usable (as opposed to still being checked). */
        const sbxDown = () => !["checking", "ready"].includes(sbxState(host).state);
        const sandboxed = () => sandboxable() && !sbxDown() && boxed();
        const setUpSandbox = () => { setSandboxHost(hostKey(host)); closeNewWorktree(); openSettings("sandbox"); };

        const create = async () => {
          if (!branch() || busy()) return;
          setBusy(true);
          setError("");
          try {
            // Asked for a sandbox: never make the worktree without one because the check hadn't finished.
            if (sandboxed() && !sbxReady(host) && (await refreshSbx(host)).state !== "ready") {
              setError(`Docker Sandboxes isn't ready${remoteHost ? ` on ${host}` : ""}, so nothing was made. Set it up in Settings › Sandbox, or turn Sandbox off.`);
              return;
            }
            setWorktreeSetup(repo.id, setup());
            // Saved first: the new folder is named without it.
            if (!picked()) setBranchPrefix(repo.id, cleanPrefix(prefix()));
            const f = files();
            const copy = f && !nested() ? copying().map((x) => x.path) : undefined;
            if (f && copy) setCopyIgnored(repo.id, copy, f.map((x) => x.path));
            await createWorktree(repo, branch(), { base: base(), issue: issue(), setup: setup(), copy, open: opening(), sandbox: sandboxed() });
            closeNewWorktree();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        };

        return (
          <Modal label="New worktree" onClose={closeNewWorktree}>
            <div class="wt-dlg wide">
              <header>
                <span><Icon name="git-branch-plus" size={14} /> New worktree · {repo.name}</span>
                <button type="button" title="Close (Esc)" aria-label="Close" onClick={closeNewWorktree}>×</button>
              </header>
              <div class="cols">
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
                    placeholder={"bun install"}
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
                  <Show when={kinds[repo.id]?.git}>
                    <div class="mt">
                      and copy
                      <span class="r">
                        <Show when={files()} fallback="listing ignored files…">
                          {(f) => (
                            <Show when={f().length} fallback={`no ignored .env, database or data files in ${repo.name}`}>
                              {ticked().size} of {f().length} ignored files ·{" "}
                              <button type="button" class="link" disabled={!shownFiles().length} onClick={tickShown}>{allShown() ? "none" : "all"}</button>
                            </Show>
                          )}
                        </Show>
                      </span>
                    </div>
                    <Show when={files()?.length}>
                      <div class="ign">
                        <Show when={files()!.length > 6}>
                          <div class="find">
                            <Icon name="search" size={12} />
                            <input
                              value={query()}
                              placeholder={`filter ${files()!.length} files`}
                              spellcheck={false}
                              autocomplete="off"
                              aria-label="Filter ignored files"
                              onInput={(e) => setQuery(e.currentTarget.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape" && query()) setQuery("");
                                else if (e.key === "Escape") closeNewWorktree();
                                e.stopPropagation();
                              }}
                            />
                            <button type="button" class="ticked" aria-pressed={onlyTicked()} title="Show only ticked files" onClick={() => setOnlyTicked(!onlyTicked())}>ticked</button>
                          </div>
                        </Show>
                        <div class="scroll">
                          <div class="issues">
                            <For each={shownFiles()} fallback={<span class="none">{onlyTicked() && !query() ? "Nothing ticked." : `Nothing matches “${query()}”.`}</span>}>
                              {(f) => (
                                <button
                                  type="button"
                                  class="chip"
                                  classList={{ on: ticked().has(f.path) }}
                                  aria-pressed={ticked().has(f.path)}
                                  title={`${f.path} · ${fileSize(f.size)}`}
                                  onClick={() => toggleFile(f.path)}
                                >
                                  <b><i>{splitPath(f.path).dir}</i>{splitPath(f.path).name}</b>
                                  <Show when={f.size > BIG}> <span class="big">{fileSize(f.size)}</span></Show>
                                </button>
                              )}
                            </For>
                          </div>
                        </div>
                      </div>
                    </Show>
                  </Show>
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
                  <Show when={sandboxable()}>
                    <button
                      type="button"
                      class="sbx-toggle"
                      role="switch"
                      aria-checked={sandboxed()}
                      disabled={sbxDown()}
                      onClick={() => setBoxed(!boxed())}
                    >
                      <span class="tx">
                        <b><Icon name="shield" size={13} /> Sandbox</b>
                        <Show
                          when={!sbxDown()}
                          fallback={
                            <span>
                              {sbxState(host).state === "unreachable" ? `Couldn't reach ${host} to check Docker Sandboxes.` : `Docker Sandboxes isn't set up on ${remoteHost ? host : "this machine"}.`}{" "}
                              <a onClick={(e) => { e.stopPropagation(); setUpSandbox(); }}>Set it up →</a>
                            </span>
                          }
                        >
                          <span>
                            {boxed()
                              ? `Its agents run in their own VM${remoteHost ? ` on ${host}` : ""} and see only this worktree; the rest runs ${remoteHost ? "there" : "here"}.`
                              : `Its agents run on ${remoteHost ? host : "this machine"}, with your access.`}
                          </span>
                          <Show when={boxed() && sbxReady(host) && !sbxState(host).signIn}>
                            <span>
                              claude isn't signed in for sandboxes yet.{" "}
                              <a onClick={(e) => { e.stopPropagation(); setUpSandbox(); }}>Sign in once →</a>
                            </span>
                          </Show>
                        </Show>
                      </span>
                      <span class={`sbx-sw ${sandboxed() ? "on" : ""}`} />
                    </button>
                  </Show>
                  <Show when={taken()}><div class="note">{branch()} already has a worktree; Create switches to it.</div></Show>
                  <Show when={error()}><div class="note bad">{error()}</div></Show>
                </div>
                <div class="side">
                  <div class="mt">Create will</div>
                  <ol class="steps">
                    <li class="on">
                      <b>{nested() ? "Copy the folder" : "Check out"}</b>
                      <Show when={kinds[repo.id]} fallback={<span>checking {repo.path}…</span>}>
                        <Show
                          when={nested()}
                          fallback={
                            <span class="cmd">
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
                              <span class="cmd">{repo.path} → {worktreeDir(repo, branch() || "<branch>", dirPrefix())}</span>
                              <Show when={repos().length}>
                                <span class="cmd">{repos().join(", ")}: git worktree add -b {branch() || "<branch>"}</span>
                              </Show>
                              <span>skips node_modules, target, .venv and other build folders: install again in the copy</span>
                            </>
                          )}
                        </Show>
                      </Show>
                    </li>
                    <Show when={kinds[repo.id]?.git && files()?.length}>
                      <li classList={{ on: copying().length > 0 }}>
                        <b>Copy from {repo.name}</b>
                        <Show when={copying().length} fallback={<span class="cmd">nothing ticked</span>}>
                          <ul>
                            <For each={copying().slice(0, 8)}>{(f) => <li>{f.path}</li>}</For>
                          </ul>
                          <Show when={copying().length > 8}><span>…and {copying().length - 8} more</span></Show>
                          <span>{copying().length} {copying().length === 1 ? "file" : "files"} · {fileSize(copying().reduce((n, f) => n + f.size, 0))}</span>
                        </Show>
                      </li>
                    </Show>
                    <Show when={sandboxed()}>
                      <li class="on">
                        <b>Make its sandbox, in the background</b>
                        <span class="cmd">sbx create claude {worktreeDir(repo, branch() || "<branch>", dirPrefix())} {mountsFor(repo.path, sandboxFolders(), nested() ?? undefined).join(" ")}</span>
                      </li>
                    </Show>
                    <li classList={{ on: !!setup().trim() }}>
                      <b>Run setup</b>
                      <span class="cmd">{setup().trim() ? setupFor(repo, branch() || "<branch>", setup(), dirPrefix()).join(" && ") : "nothing"}</span>
                    </li>
                    <li classList={{ on: opening().length > 0 }}>
                      <b>Open</b>
                      <span class="cmd">{opening().length ? opening().map((a) => a.name || "untitled").join(", ") : "nothing"}</span>
                    </li>
                  </ol>
                </div>
              </div>
              <footer>
                <button type="button" onClick={closeNewWorktree}>Cancel</button>
                <button type="button" class="primary" disabled={!branch() || busy()} onClick={() => void create()}>
                  {busy() ? "Creating…" : "Create"}
                </button>
              </footer>
            </div>
          </Modal>
        );
      }}
    </Show>
  );
}
