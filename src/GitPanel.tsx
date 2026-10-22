// The git window: one per project. The commit box and the staged / unstaged lists on the left,
// the selected file's diff on the right, and the branch's next steps (push, PR, merge) in the
// header, each opening a drawer over the diff. The diff is unified or split (design/diff.html,
// variant A), and a double-click opens the file in the editor at that line.
// A folder that is not itself a repo gets an accordion of its nested repos and an active repo;
// the active repo owns the commit box, commits, PR and push (design/diff.html, folder of repos).

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { type Project, type Tab, isRemote, setProjectDiffMode } from "./state";
import {
  type Change, type CtxId, type Drawer, type RepoStatus, type Sel, commit, copyFinding, draftCommit, draftPr, gitOf, isStaged, isUnstaged, linkedIssue,
  loadPr, merge, openDrawer, openPr, push, refresh, repoRoot, review, select, selectCommit, selectRepo, setField, setOpt, stage, stepOf,
  toggleCtx, unpushed, unstage,
} from "./git";
import { openFile } from "./files";
import { openUrlInProject } from "./browsers";
import { removeWorktree } from "./worktrees";
import { type DiffMode, diffStats, firstChange, parseUnified } from "./diff";
import DiffView, { type Drill } from "./DiffView";
import "./git.css";

function BranchIcon(): JSX.Element {
  return (
    <svg class="g-bi" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.7" /><circle cx="4" cy="12.5" r="1.7" /><circle cx="12" cy="5" r="1.7" />
      <path d="M4 5.2v5.6M12 6.7c0 3-8 2-8 4.1" />
    </svg>
  );
}

/** The status letter shown for a file in one list. */
const letter = (c: Change, inStaged: boolean) => (inStaged ? c.x : c.x === "?" ? "U" : c.y);

export default function GitPanel(props: { project: Project; tab: Tab; focused: boolean }): JSX.Element {
  const p = () => props.project;
  const g = () => gitOf(p().id);
  const s = () => g().status;
  const [menu, setMenu] = createSignal(false);
  const [repoMenu, setRepoMenu] = createSignal(false);
  /** A folder of repos: one git window with an accordion and an active repo. */
  const multiRepo = () => (g().repos?.length ?? 0) > 1;
  const nestedRepo = () => !!g().repo;
  const repoName = () => (g().repo ? g().repo.split("/").pop()! : p().name);
  /** The diff pane's width: split falls back to unified in a narrow window. */
  const [paneW, setPaneW] = createSignal(0);
  let rightEl: HTMLDivElement | undefined;
  let diffEl: HTMLDivElement | undefined;
  let hunkAt = 0;

  const wantedMode = (): DiffMode => p().diffMode ?? "split";
  const splitFits = () => paneW() === 0 || paneW() >= 660;
  const mode = (): DiffMode => (wantedMode() === "unified" || !splitFits() ? "unified" : "split");
  const setMode = (m: DiffMode) => setProjectDiffMode(p().id, m);
  const hunks = createMemo(() => (g().diff?.text ? parseUnified(g().diff!.text!) : []));
  const stat = createMemo(() => diffStats(hunks()));
  const first = () => firstChange(hunks());
  /** A deleted file has no working copy to open; its diff still shows. */
  const deleted = () => {
    const c = g().status?.files.find((f) => f.path === g().sel?.path);
    return !!c && (c.x === "D" || c.y === "D");
  };
  const abs = (sel: Sel) => `${repoRoot(p(), sel.repo)}/${sel.path}`;
  const drill: Drill = (line, _hunk, how) => {
    const sel = g().sel;
    if (!sel || deleted()) return;
    openFile(p(), abs(sel), { from: props.tab.id, at: { line, mode: how.diff ? "diff" : "source" } });
  };
  const openAt = (m: "source" | "diff") => {
    const line = first();
    if (line) drill(line, 0, { diff: m === "diff" });
  };
  const nav = (d: 1 | -1) => {
    const n = hunks().length;
    if (!n) return;
    hunkAt = Math.max(0, Math.min(n - 1, hunkAt + d));
    diffEl?.querySelector(`[data-hunk="${hunkAt}"]`)?.scrollIntoView({ block: "start" });
  };
  createEffect(on(() => g().diff?.key, () => { hunkAt = 0; }));
  onMount(() => {
    if (!rightEl) return;
    const ro = new ResizeObserver(([entry]) => setPaneW(entry.contentRect.width));
    ro.observe(rightEl);
    onCleanup(() => ro.disconnect());
  });

  onMount(() => void refresh(p()));
  // Coming back to the window picks up what the agents changed meanwhile.
  createEffect(on(() => props.focused, (f) => { if (f) void refresh(p()); }, { defer: true }));
  // Poll the PR while its checks run.
  createEffect(() => {
    const pr = g().pr;
    if (pr?.state !== "OPEN" || !pr.checks.some((c) => c.state === "pending")) return;
    const t = window.setTimeout(() => void loadPr(p()), 15_000);
    onCleanup(() => clearTimeout(t));
  });
  const onDown = (e: PointerEvent) => {
    const el = e.target as Element;
    if (!el.closest(".g-split")) setMenu(false);
    if (!el.closest(".g-repo, .g-repomenu")) setRepoMenu(false);
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  const stagedList = () => (s()?.files ?? []).filter(isStaged);
  const unstagedList = () => (s()?.files ?? []).filter(isUnstaged);
  const ready = () => !!g().msg.trim() && stagedList().length > 0 && !g().working;
  const up = () => unpushed(s());
  const step = () => stepOf(g());
  const onBase = () => !!s() && s()!.branch === s()!.base;

  const onMsgKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      void commit(p(), e.shiftKey ? "push" : null);
    }
  };

  const chip = (id: CtxId, label: string, detail: string, title: string) => (
    <button class="g-chip" classList={{ on: g().ctx[id] }} title={title} onClick={() => toggleCtx(p(), id)}>
      {label} <span class="k">{detail}</span>
    </button>
  );
  const Chips = () => (
    <div class="g-chips">
      <span class="lbl" title="What ✦ reads. Click to switch one off.">✦ reads</span>
      {chip("diff", "diff", stagedList().length ? `${stagedList().length} staged` : "branch", "The staged diff (commit) or the branch diff (PR, review)")}
      <Show when={linkedIssue(p())}>{(i) => chip("issue", i().slug, i().title.slice(0, 24), `${i().slug}: ${i().title}`)}</Show>
      {chip("style", "commit style", `last ${s()?.commits.length ?? 0}`, "Recent commit subjects, to match their style")}
      <Show when={g().terms}>{chip("terms", "CONTEXT.md", "terms", "The project's glossary")}</Show>
    </div>
  );

  const Thinking = (pr: { what: string }) => <span class="g-thinking">{pr.what}</span>;

  const FileRow = (fp: { c: Change; inStaged: boolean }) => {
    const sel = () => g().sel?.path === fp.c.path && g().sel?.staged === fp.inStaged && g().sel?.repo === g().repo;
    const i = fp.c.path.lastIndexOf("/");
    return (
      <div
        class="g-frow"
        classList={{ sel: sel() }}
        title={fp.c.path}
        onClick={() => select(p(), { repo: g().repo, path: fp.c.path, staged: fp.inStaged })}
        onDblClick={() => {
          if (fp.c.x === "D" || fp.c.y === "D") return;
          openFile(p(), abs({ repo: g().repo, path: fp.c.path, staged: fp.inStaged }), { from: props.tab.id });
        }}
      >
        <input
          type="checkbox"
          checked={fp.inStaged}
          title={fp.inStaged ? "Unstage" : "Stage"}
          onClick={(e) => {
            e.stopPropagation();
            void (fp.inStaged ? unstage(p(), [fp.c.path]) : stage(p(), [fp.c.path]));
          }}
        />
        <span class={`g-st s-${letter(fp.c, fp.inStaged)}`}>{letter(fp.c, fp.inStaged)}</span>
        <span class="g-fp"><span class="d">{i >= 0 ? fp.c.path.slice(0, i + 1) : ""}</span>{fp.c.path.slice(i + 1)}</span>
      </div>
    );
  };

  const Lists = (lp: { sub?: boolean }) => (
    <>
      <div class="g-sec" classList={{ sub: lp.sub }}>Staged <span class="n">{stagedList().length}</span>
        <button title="Unstage all" onClick={() => unstage(p(), stagedList().map((c) => c.path))}>− all</button>
      </div>
      <For each={stagedList()}>{(c) => <FileRow c={c} inStaged={true} />}</For>
      <div class="g-sec" classList={{ sub: lp.sub }}>Changes <span class="n">{unstagedList().length}</span>
        <button title="Stage all" onClick={() => stage(p(), unstagedList().map((c) => c.path))}>+ all</button>
      </div>
      <For each={unstagedList()}>{(c) => <FileRow c={c} inStaged={false} />}</For>
      <Show when={s() && !s()!.files.length && !g().loading}><div class="g-hint pad">Working tree clean.</div></Show>
      <div class="g-sec" classList={{ sub: lp.sub }}>Commits</div>
      <For each={s()?.commits ?? []}>
        {(c) => (
          <div
            class="g-commit pad"
            classList={{ sel: g().commit?.key === c.sha }}
            title={`${c.sha}\n${c.when}`}
            onClick={() => selectCommit(p(), c.sha)}
          >
            <span class="sha">{c.sha.slice(0, 7)}</span><span class="s">{c.subject}</span>
            <span class="w">{c.pushed ? c.when : "local"}</span>
          </div>
        )}
      </For>
    </>
  );

  const RepoSection = (rp: { r: RepoStatus }) => {
    const active = () => rp.r.repo === g().repo;
    const rs = () => rp.r.status;
    const n = () => rs()?.files.length ?? 0;
    return (
      <div class="g-reposec">
        <div class="g-repohead" classList={{ on: active() }} title={`${rp.r.repo || p().name}${rs()?.branch ? ` · ${rs()!.branch}` : ""}`} onClick={() => selectRepo(p(), rp.r.repo)}>
          <span class="cv">{active() ? "▾" : "▸"}</span>
          <b>{rp.r.repo || p().name}</b>
          <span class="br">{rs()?.branch ?? "—"}</span>
          <Show when={rs()?.ahead}><span class="ab">↑{rs()!.ahead}</span></Show>
          <span class="ct" classList={{ bad: !!rp.r.error }}>{rp.r.error ? "error" : n() ? `${n()} changed` : "clean"}</span>
        </div>
        <Show when={active()} fallback={
          <Show when={n()}>
            <div class="g-reppeek">
              <For each={rs()!.files.slice(0, 3)}>{(f) => <span>{f.path}</span>}</For>
              <Show when={n() > 3}><span>+{n() - 3}</span></Show>
            </div>
          </Show>
        }>
          <Show when={!g().repoError} fallback={<div class="g-note bad">{g().repoError}</div>}>
            <Lists sub />
          </Show>
        </Show>
      </div>
    );
  };

  const FlowStep = (fp: { id: Drawer; label: string; done: boolean; now: boolean; disabled?: string }) => (
    <button
      class="g-fs"
      classList={{ done: fp.done, now: fp.now, open: g().drawer === fp.id }}
      disabled={!!fp.disabled}
      title={fp.disabled ?? ""}
      onClick={() => openDrawer(p(), g().drawer === fp.id ? null : fp.id)}
    >
      {fp.done ? "✓ " : ""}{fp.label}
    </button>
  );

  const CheckList = () => (
    <div class="g-checks">
      <For each={g().pr?.checks ?? []} fallback={<div class="g-hint">No checks on this PR.</div>}>
        {(c) => (
          <div class="g-check">
            <span class={`ic ${c.state}`}>{c.state === "pass" ? "✓" : c.state === "fail" ? "✕" : c.state === "skip" ? "–" : ""}</span>
            {c.name}
            <span class="t">{c.state === "pending" ? "running" : c.state}</span>
          </div>
        )}
      </For>
    </div>
  );

  const Review = () => (
    <Show
      when={g().review}
      fallback={
        <div class="g-row">
          <span class="g-hint">A second pass over the whole branch before it lands.</span>
          <span class="grow" />
          <Show when={g().busy === "review"} fallback={<button class="g-btn ai sm" onClick={() => review(p())}>✦ Review PR</button>}>
            <Thinking what="reviewing…" />
          </Show>
        </div>
      }
    >
      {(list) => {
        const open = () => list().filter((f) => f.sev === "fix").length;
        return (
          <div class="g-review">
            <div class="g-row">
              <span class="g-hint">✦ review · <b classList={{ warn: open() > 0, ok: open() === 0 }}>{open() ? `${open()} to fix before merge` : "nothing blocking"}</b></span>
              <span class="grow" />
              <Show when={g().busy !== "review"} fallback={<Thinking what="reviewing…" />}>
                <button class="g-btn sm" onClick={() => review(p())}>Again</button>
              </Show>
            </div>
            <For each={list()}>
              {(f, i) => (
                <div class="g-finding">
                  <span class={`sev ${f.sev}`}>{f.sev === "fix" ? "!" : f.sev === "ok" ? "✓" : "i"}</span>
                  <div>
                    <Show when={f.loc}><div class="loc">{f.loc}</div></Show>
                    <p>{f.text}</p>
                  </div>
                  <Show when={f.sev !== "ok"} fallback={<span />}>
                    <button class="g-btn sm" title="Copy the note to the clipboard" onClick={() => copyFinding(p(), i())}>Copy</button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        );
      }}
    </Show>
  );

  const PrCard = () => (
    <Show when={g().pr}>
      {(pr) => (
        <div class="g-prcard">
          <h3>{pr().title} <span class="num">#{pr().number}</span></h3>
          <div class="g-row">
            <span class={`g-pill ${pr().state === "MERGED" ? "merged" : pr().isDraft ? "draft" : pr().state === "OPEN" ? "open" : "closed"}`}>
              {pr().state === "MERGED" ? "Merged" : pr().isDraft ? "Draft" : pr().state === "OPEN" ? "Open" : "Closed"}
            </span>
            <span class="g-hint">{s()?.branch} → {pr().baseRefName}</span>
            <span class="grow" />
            <button class="g-btn sm" onClick={() => openUrlInProject(p().id, pr().url, props.tab.id)}>Open ↗</button>
          </div>
          <Show when={pr().body}>
            <details><summary class="g-hint">Description</summary><div class="g-md">{pr().body}</div></details>
          </Show>
        </div>
      )}
    </Show>
  );

  const CommitView = (c: { sha: string }) => (
    <Show when={!g().commit?.error} fallback={<div class="g-note bad">{g().commit!.error}</div>}>
      <Show when={g().commit?.detail} fallback={<div class="g-note">Loading commit…</div>}>
        {(d) => (
          <>
            <div class="g-cmsg">
              <div class="g-crow">
                <span class="sha">{d().sha.slice(0, 7)}</span>
                <span class="g-hint">{d().author} · {d().when}</span>
                <span class="grow" />
                <button class="g-icon" title="Close the commit" onClick={() => selectCommit(p(), c.sha)}>×</button>
              </div>
              <h3>{d().message.split("\n")[0]}</h3>
              <Show when={d().message.split("\n").slice(1).join("\n").trim()}>
                <pre class="g-cbody">{d().message.split("\n").slice(1).join("\n").trim()}</pre>
              </Show>
              <Show when={d().stat}><pre class="g-cstat">{d().stat}</pre></Show>
            </div>
            <div class="g-changes-head">Changes</div>
            <DiffView text={d().diff} mode={mode()} />
          </>
        )}
      </Show>
    </Show>
  );

  const DrawerView = () => {
    const d = () => g().drawer;
    const title = () => (d() === "push" ? "Push" : d() === "pr" ? "Open pull request" : `Merge #${g().pr?.number ?? ""}`);
    return (
      <Show when={d()}>
        <div class="g-drawer">
          <div class="g-dh">{title()}<button class="x" title="Close" onClick={() => openDrawer(p(), null)}>×</button></div>
          <div class="g-db">
            <Show when={d() === "push"}>
              <div class="g-hint">{s()?.upstream ? `to ${s()!.upstream}` : `to origin/${s()?.branch ?? ""} (new on the remote)`}</div>
              <For each={(s()?.commits ?? []).filter((c) => !c.pushed)} fallback={<div class="g-hint">Nothing to push.</div>}>
                {(c) => <div class="g-commit"><span class="sha">{c.sha.slice(0, 7)}</span><span class="s">{c.subject}</span></div>}
              </For>
              <Show when={s()?.behind}><div class="g-hint warn">{s()!.behind} commit(s) on the remote are not here yet; the push may be refused.</div></Show>
            </Show>
            <Show when={d() === "pr"}>
              <Show when={!g().pr || g().pr!.state !== "OPEN"} fallback={<><div class="g-hint">This branch already has an open PR.</div><PrCard /></>}>
                <div class="g-row">
                  <span class="g-branch"><BranchIcon /> {s()?.branch}</span>→<span class="g-branch base">{s()?.base}</span>
                  <span class="grow" />
                  <Show when={g().busy === "pr"} fallback={<button class="g-btn ai sm" onClick={() => draftPr(p())}>✦ Draft PR</button>}>
                    <Thinking what="drafting…" />
                  </Show>
                </div>
                <input class="g-in" classList={{ ghost: g().prAi }} placeholder="Title" value={g().prTitle}
                  onInput={(e) => setField(p(), "prTitle", e.currentTarget.value)} />
                <textarea class="g-in g-body" classList={{ ghost: g().prAi }} placeholder="## Summary" value={g().prBody}
                  onInput={(e) => setField(p(), "prBody", e.currentTarget.value)} />
                <Chips />
              </Show>
            </Show>
            <Show when={d() === "merge"}>
              <Show when={g().pr} fallback={<div class="g-hint">{g().prError ?? "This branch has no pull request yet."}</div>}>
                <PrCard />
                <Show when={g().pr!.state === "OPEN"}>
                  <CheckList />
                  <Review />
                  <div class="g-row">
                    <span class="g-hint">Strategy</span>
                    <span class="g-seg">
                      <For each={["squash", "merge", "rebase"] as const}>
                        {(k) => <button aria-pressed={g().strategy === k} onClick={() => setOpt(p(), "strategy", k)}>{k}</button>}
                      </For>
                    </span>
                    <label class="g-hint g-check-l">
                      <input type="checkbox" checked={g().delBranch} onChange={(e) => setOpt(p(), "delBranch", e.currentTarget.checked)} /> delete branch
                    </label>
                  </div>
                </Show>
              </Show>
            </Show>
          </div>
          <div class="g-df">
            <Show when={d() === "push"}>
              <span class="grow" />
              <button class="g-btn primary" disabled={!!g().working || (!up() && !!s()?.upstream)} onClick={() => push(p())}>
                {g().working === "push" ? "Pushing…" : up() ? `Push ↑${up()}` : "Push"}
              </button>
            </Show>
            <Show when={d() === "pr" && (!g().pr || g().pr!.state !== "OPEN")}>
              <label class="g-hint g-check-l">
                <input type="checkbox" checked={g().prDraft} onChange={(e) => setOpt(p(), "prDraft", e.currentTarget.checked)} /> draft
              </label>
              <span class="grow" />
              <Show when={up() > 0}><span class="g-hint warn">push first</span></Show>
              <button class="g-btn primary" disabled={!g().prTitle.trim() || up() > 0 || !!g().working} onClick={() => openPr(p())}>
                {g().working === "pr" ? "Opening…" : "Open PR"}
              </button>
            </Show>
            <Show when={d() === "merge" && g().pr?.state === "OPEN"}>
              {(() => {
                const checks = () => g().pr?.checks ?? [];
                const pending = () => checks().some((c) => c.state === "pending");
                const failing = () => checks().some((c) => c.state === "fail");
                return (
                  <>
                    <span class="g-hint" classList={{ warn: pending(), bad: failing() }}>
                      {failing() ? "checks failing" : pending() ? "waiting for checks…" : ""}
                    </span>
                    <span class="grow" />
                    <button class="g-btn ok" disabled={pending() || !!g().working} onClick={() => merge(p())}>
                      {g().working === "merge" ? "Merging…" : failing() ? `Merge #${g().pr!.number} anyway` : `Merge #${g().pr!.number}`}
                    </button>
                  </>
                );
              })()}
            </Show>
          </div>
        </div>
      </Show>
    );
  };

  return (
    <div class="gitwin">
      <div class="g-head" classList={{ "g-head-open": repoMenu() }}>
        <Show when={multiRepo()}>
          <button class="g-repo" title="Active repo: click to switch" aria-haspopup="menu" aria-expanded={repoMenu()} onClick={() => setRepoMenu(!repoMenu())}>
            <b>{repoName()}</b><span class="k">{g().repos!.length} repos</span><span class="cv">▾</span>
          </button>
          <Show when={repoMenu()}>
            <div class="g-repomenu" role="menu">
              <For each={g().repos ?? []}>
                {(r) => (
                  <button
                    class="g-repoitem"
                    classList={{ on: r.repo === g().repo }}
                    role="menuitem"
                    onClick={() => { selectRepo(p(), r.repo); setRepoMenu(false); }}
                  >
                    <span class="nm">{r.repo || p().name}</span>
                    <span class="br">{r.status?.branch ?? "—"}</span>
                    <span class="ct" classList={{ bad: !!r.error }}>{r.error ? "error" : `${r.status?.files.length ?? 0} changed`}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
        <Show when={nestedRepo() && !multiRepo()}>
          <span class="g-branch repo" title={g().repo}>{repoName()}</span>
          <span class="g-arrow">·</span>
        </Show>
        <Show when={s()} fallback={<span class="g-hint" classList={{ bad: !!g().repoError }}>{g().repoError ?? (isRemote(p()) ? `${p().host}:${p().path}` : p().path)}</span>}>
          <span class="g-branch"><BranchIcon /> {s()!.branch ?? "detached HEAD"}</span>
          <span class="g-arrow">→</span>
          <span class="g-branch base">{s()!.base}</span>
          <span class="g-ahead">
            {s()!.behind ? `↓${s()!.behind} ` : ""}{s()!.files.length ? `${s()!.files.length} changed` : ""}
          </span>
        </Show>
        <span class="grow" />
        <Show when={s()}>
          <div class="g-flow">
            <FlowStep id="push" label={up() ? `Push ↑${up()}` : "Push"} done={!up() && !!s()!.upstream} now={step() === "push"} />
            <span class="sepa">›</span>
            <FlowStep
              id={g().pr?.state === "OPEN" ? "merge" : "pr"}
              label={g().pr?.state === "OPEN" ? `#${g().pr!.number}` : "PR"}
              done={g().pr?.state === "OPEN" || g().pr?.state === "MERGED"}
              now={step() === "pr" && !onBase()}
              disabled={onBase() && !g().pr ? `You are on ${s()!.base}; work on a branch to open a PR` : undefined}
            />
            <span class="sepa">›</span>
            <FlowStep
              id="merge"
              label={g().pr?.checks.some((c) => c.state === "pending") ? "Checks…" : "Merge"}
              done={g().pr?.state === "MERGED"}
              now={step() === "merge"}
              disabled={!g().pr ? "Open a PR first" : undefined}
            />
          </div>
        </Show>
        <Show when={p().parent}>
          <button
            class="g-btn sm"
            classList={{ primary: g().pr?.state === "MERGED" }}
            title={`Close this worktree's windows, delete ${p().path} and its branch`}
            onClick={() => void removeWorktree(p())}
          >
            Remove worktree
          </button>
        </Show>
        <button class="g-icon" title="Refresh" classList={{ spin: g().loading }} onClick={() => refresh(p())}>⟳</button>
      </div>

      <Show when={!g().error} fallback={<div class="g-note bad">{g().error}</div>}>
        <div class="g-main">
          <div class="g-left">
            <div class="g-cbox">
              <Show when={nestedRepo()}>
                <div class="g-cbox-repo">Commit to <b>{repoName()}</b><span class="k">{s()?.branch ?? g().repo}</span></div>
              </Show>
              <textarea
                class="g-in g-msg"
                classList={{ ghost: g().msgAi, tall: !!g().msg }}
                placeholder={`Message${nestedRepo() ? ` for ${repoName()}` : ""} (Ctrl+Enter commits, Ctrl+Shift+Enter also pushes)`}
                value={g().msg}
                onInput={(e) => setField(p(), "msg", e.currentTarget.value)}
                onKeyDown={onMsgKey}
              />
              <div class="g-row">
                <Show when={g().busy === "commit"} fallback={
                  <button class="g-btn ai sm" disabled={!stagedList().length} title="Write the message from the staged diff" onClick={() => draftCommit(p())}>✦ Draft</button>
                }>
                  <Thinking what="drafting…" />
                </Show>
                <span class="grow" />
                <span class="g-split">
                  <button class="g-btn primary" disabled={!ready()} onClick={() => commit(p())}>
                    {g().working === "commit" ? "Committing…" : `Commit${stagedList().length ? ` ${stagedList().length}` : ""}`}
                  </button>
                  <button class="g-btn primary more" disabled={!ready()} aria-haspopup="menu" onClick={() => setMenu(!menu())}>▾</button>
                  <Show when={menu()}>
                    <div class="g-menu" role="menu">
                      <button role="menuitem" onClick={() => { setMenu(false); void commit(p(), "push"); }}>Commit &amp; push<span class="k">Ctrl+Shift+↵</span></button>
                      <button role="menuitem" disabled={onBase()} onClick={() => { setMenu(false); void commit(p(), "pr"); }}>Commit, push &amp; open PR…</button>
                      <button role="menuitem" onClick={() => { setMenu(false); void commit(p()); }}>Commit<span class="k">Ctrl+↵</span></button>
                    </div>
                  </Show>
                </span>
              </div>
              <Chips />
            </div>
            <div class="g-lists">
              <Show when={multiRepo()} fallback={<Lists />}>
                <For each={g().repos ?? []}>{(r) => <RepoSection r={r} />}</For>
              </Show>
            </div>
          </div>
          <div class="g-right" ref={(el) => (rightEl = el)}>
            <Show when={g().commit} fallback={
              <>
                <div class="g-diffhead">
                  <Show when={nestedRepo()}><span class="g-repochip" title={g().repo}>{repoName()}</span></Show>
                  <b title={g().sel?.path}>{(() => {
                    const rel = g().sel?.path ?? "";
                    const cut = rel.lastIndexOf("/");
                    if (cut < 0) return <span class="f">{rel || "—"}</span>;
                    return <><span class="d">{rel.slice(0, cut + 1)}</span><span class="f">{rel.slice(cut + 1)}</span></>;
                  })()}</b>
                  <Show when={g().sel && g().diff?.text !== undefined}>
                    <span class="g-stat"><i class="p">+{stat().added}</i> <i class="m">−{stat().removed}</i></span>
                  </Show>
                  <span class="grow" />
                  <Show when={g().sel}><span>{g().sel!.staged ? "staged" : "not staged"}</span></Show>
                  <button class="g-icon" title="Previous hunk" disabled={!hunks().length} onClick={() => nav(-1)}>⌃</button>
                  <button class="g-icon" title="Next hunk" disabled={!hunks().length} onClick={() => nav(1)}>⌄</button>
                  <span class="g-seg" role="group" aria-label="Diff orientation">
                    <button aria-pressed={mode() === "unified"} title="A stacked diff" onClick={() => setMode("unified")}>☰ Unified</button>
                    <button
                      aria-pressed={mode() === "split"}
                      title={wantedMode() === "split" && !splitFits() ? "Split needs about 660px: this pane shows unified" : "Side by side"}
                      onClick={() => setMode("split")}
                    >▥ Split</button>
                  </span>
                  <button class="g-btn sm" disabled={!g().sel || !first() || deleted()} title={deleted() ? "A deleted file has no working copy to open" : "Open the file at its first change"} onClick={() => openAt("source")}>↗ Editor</button>
                  <button class="g-btn sm" disabled={!g().sel || !first() || deleted()} title={deleted() ? "A deleted file has no working copy to open" : "Open the editor in its diff view"} onClick={() => openAt("diff")}>Diff</button>
                </div>
                <Show when={!g().repoError} fallback={<div class="g-note bad">{g().repoError}</div>}>
                  <DiffView
                    text={g().sel ? g().diff?.text : ""}
                    error={g().diff?.error}
                    mode={mode()}
                    onDrill={drill}
                    ref={(el) => (diffEl = el)}
                  />
                </Show>
              </>
            }>
              {(c) => <CommitView sha={c().key} />}
            </Show>
            <DrawerView />
          </div>
        </div>
      </Show>
    </div>
  );
}

