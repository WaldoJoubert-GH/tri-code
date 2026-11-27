// The git window: one per project. The commit box and the staged / unstaged lists on the left,
// the selected file's diff on the right, and the branch's next steps (pull, push, PR, merge) in the
// header, each opening a drawer over the diff. The diff is unified or split (design/diff.html,
// variant A), and a double-click opens the file in the editor at that line.
// The `→ base` chip picks the branch's destination; file rows discard / delete (with Undo), stash,
// stop tracking or ignore; stashes list under Changes; a pull stopped on a conflict shows a
// Continue / Abort banner (design/git-sync.html).
// A folder that is not itself a repo gets an accordion of its nested repos and an active repo;
// the active repo owns the commit box, commits, PR and push (design/diff.html, folder of repos).

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { type Project, type Tab, diffModeOf, isRemote, setProjectDiffMode } from "../../shared/state/state";
import {
  type Change, type CtxId, type Drawer, type RepoStatus, type Sel, type Stash, closeStash, commit, copyFinding, discard, draftCommit, draftPr, fetchRemotes,
  finishOp, gitOf, ignore, isStaged, isUnstaged, linkedIssue, loadBranches, loadPr, markOf, merge, openDrawer, openPr, pull, push, refresh,
  repoRoot, review, select, selectCommit, selectRepo, selectStash, setBase, setField, setOpt, setPushTarget, stage, stashOp, stashPush, stepOf,
  toggleCtx, unpushed, unstage, untrack, upstreamOf,
} from "./git";
import { copyText } from "../../shared/ui/clipboard";
import { openFile } from "../editor";
import { openUrlInProject } from "../browser";
import { removeWorktree } from "../worktrees";
import { type DiffMode, diffStats, firstChange, parseUnified } from "../../shared/text/diff";
import DiffView, { type Drill, diffKeys, stepHunk } from "../../shared/text/DiffView";
import { flash } from "../../shared/ui/ui";
import { withKey } from "../../shared/keys/keymap";
import { HoldKey, KeyText } from "../../shared/keys/Keys";
import "./git.css";
import { ctrlName } from "../../shared/keys/modkey";
import { isEnter } from "../../shared/ui/enterkey";
import { Icon } from "../../shared/ui/lucide";

// Icons and buttons follow design/git-panel.html (variant A, "Quiet"): Lucide icons throughout,
// borderless icon buttons for row and section actions, labels kept on the main actions.

const BranchIcon = () => <Icon name="git-branch" size={12} class="g-bi" />;

/** The status letter shown for a file in one list. */
const letter = (c: Change, inStaged: boolean) => (inStaged ? c.x : c.x === "?" ? "U" : c.y);

/** A row's `+n −n`, from the status batch's numstat; nothing for an untracked or binary file. */
function RowStat(props: { n?: [number, number] }): JSX.Element {
  return (
    <Show when={props.n && props.n[0] + props.n[1] > 0}>
      <span class="g-rstat"><i class="p">+{props.n![0]}</i><i class="m">−{props.n![1]}</i></span>
    </Show>
  );
}

export default function GitPanel(props: { project: Project; tab: Tab; focused: boolean }): JSX.Element {
  const p = () => props.project;
  const g = () => gitOf(p().id);
  const s = () => g().status;
  const [menu, setMenu] = createSignal(false);
  const [repoMenu, setRepoMenu] = createSignal(false);
  /** The destination picker under `→ base`, and its filter. */
  const [destMenu, setDestMenu] = createSignal(false);
  const [destQ, setDestQ] = createSignal("");
  const [destAt, setDestAt] = createSignal({ x: 0, y: 0 });
  /** A row's menu (right-click or ⋯), placed in the window. */
  const [ctx, setCtx] = createSignal<{ c: Change; staged: boolean; x: number; y: number } | null>(null);
  /** The Stash… form under the Changes header. */
  const [stashForm, setStashForm] = createSignal<{ x: number; y: number } | null>(null);
  const [stashMsg, setStashMsg] = createSignal("");
  const [stashU, setStashU] = createSignal(true);
  /** The row asking "Discard…?" / "Drop…?": `w:path`, `s:path`, `*` (all changes) or `drop:sha`. */
  const [confirm, setConfirm] = createSignal<string | null>(null);
  let winEl: HTMLDivElement | undefined;
  /** A point in the window for a popover, from a viewport point; kept inside the window. */
  const at = (clientX: number, clientY: number, w = 260) => {
    const r = winEl!.getBoundingClientRect();
    return { x: Math.max(4, Math.min(clientX - r.left, r.width - w - 4)), y: clientY - r.top };
  };
  /** A folder of repos: one git window with an accordion and an active repo. */
  const multiRepo = () => (g().repos?.length ?? 0) > 1;
  const nestedRepo = () => !!g().repo;
  /** A repo's short name: its folder, or its path when another repo has the same folder name. */
  const nameOf = (repo: string) => {
    if (!repo) return p().name;
    const base = repo.split("/").pop()!;
    return (g().repos ?? []).some((r) => r.repo !== repo && r.repo.split("/").pop() === base) ? repo : base;
  };
  const repoName = () => nameOf(g().repo);
  /** The diff pane's width: split falls back to unified in a narrow window. */
  const [paneW, setPaneW] = createSignal(0);
  let rightEl: HTMLDivElement | undefined;
  let diffEl: HTMLDivElement | undefined;

  const wantedMode = (): DiffMode => diffModeOf(p());
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
    if (!sel) return;
    if (deleted()) return flash("deleted: there is no working copy to open");
    openFile(p(), abs(sel), { from: props.tab.id, at: { line, mode: how.diff ? "diff" : "source" } });
  };
  const openAt = (m: "source" | "diff") => {
    const line = first();
    if (line) drill(line, 0, { diff: m === "diff" });
  };
  const nav = (d: 1 | -1) => diffEl && stepHunk(diffEl, d);
  // Alt+D (keymap "diff"): the selected file's diff in the editor, at its first change.
  onMount(() => {
    diffKeys.set(props.tab.id, () => {
      if (!g().sel || g().commit || !first()) return false;
      if (deleted()) {
        flash("deleted: there is no working copy to open");
        return true;
      }
      openAt("diff");
      return true;
    });
    onCleanup(() => diffKeys.delete(props.tab.id));
  });
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
    if (!el.closest(".g-dest, .g-destmenu")) setDestMenu(false);
    if (!el.closest(".g-ctx")) setCtx(null);
    if (!el.closest(".g-stashform, .g-stashbtn")) setStashForm(null);
    if (!el.closest(".g-confirm, .g-ask")) setConfirm(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !(ctx() || stashForm() || destMenu() || confirm())) return;
    setCtx(null); setStashForm(null); setDestMenu(false); setConfirm(null);
    e.stopPropagation();
  };
  // A new status (refresh, another repo) closes what pointed at the old one.
  createEffect(on(() => g().status, () => { setCtx(null); setConfirm(null); }, { defer: true }));
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  const stagedList = () => (s()?.files ?? []).filter(isStaged);
  const unstagedList = () => (s()?.files ?? []).filter(isUnstaged);
  const ready = () => !!g().msg.trim() && stagedList().length > 0 && !g().working;
  const up = () => unpushed(s());
  const step = () => stepOf(g());
  const onBase = () => !!s() && s()!.branch === s()!.base;

  const onMsgKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      void commit(p(), e.shiftKey ? "push" : null);
    }
  };

  const chip = (id: CtxId, label: string, detail: string, title: string) => (
    <button class="g-chip" classList={{ on: g().ctx[id] }} title={title} onClick={() => toggleCtx(p(), id)}>
      <Icon name={g().ctx[id] ? "check" : "plus"} size={11} />{label} <span class="k">{detail}</span>
    </button>
  );
  const Chips = () => (
    <div class="g-chips">
      <span class="lbl" title="What ✦ reads. Click to switch one off."><Icon name="sparkles" size={12} />reads</span>
      {chip("diff", "diff", stagedList().length ? `${stagedList().length} staged` : "branch", "The staged diff (commit) or the branch diff (PR, review)")}
      <Show when={linkedIssue(p())}>{(i) => chip("issue", i().slug, i().title.slice(0, 24), `${i().slug}: ${i().title}`)}</Show>
      {chip("style", "commit style", `last ${s()?.commits.length ?? 0}`, "Recent commit subjects, to match their style")}
      <Show when={g().terms}>{chip("terms", "CONTEXT.md", "terms", "The project's glossary")}</Show>
    </div>
  );

  const Thinking = (pr: { what: string }) => <span class="g-thinking">{pr.what}</span>;

  const conflicted = (c: Change) => markOf(c) === "C";
  const untrackedC = (c: Change) => c.x === "?";
  const short = (path: string) => path.replace(/\/$/, "").split("/").pop() ?? path;
  const keyOf = (c: Change, staged: boolean) => `${staged ? "s" : "w"}:${c.path}`;
  /** Delete for a new file (untracked, or added from the Staged list), Discard for the rest. */
  const deletes = (c: Change, staged: boolean) => untrackedC(c) || (staged && c.x === "A");

  const Confirm = (cp: { q: JSX.Element; yes: string; onYes: () => void }) => (
    <div class="g-confirm" role="alertdialog">
      <span class="q">{cp.q}</span>
      <span class="grow" />
      <button class="g-btn sm" onClick={() => setConfirm(null)}>Keep</button>
      <button class="g-btn sm danger" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => { setConfirm(null); cp.onYes(); }}>{cp.yes}</button>
    </div>
  );

  const FileRow = (fp: { c: Change; inStaged: boolean }) => {
    const sel = () => g().sel?.path === fp.c.path && g().sel?.staged === fp.inStaged && g().sel?.repo === g().repo && !g().stash;
    const i = fp.c.path.lastIndexOf("/");
    const del = () => deletes(fp.c, fp.inStaged);
    const openMenu = (x: number, y: number) => {
      select(p(), { repo: g().repo, path: fp.c.path, staged: fp.inStaged });
      setCtx({ c: fp.c, staged: fp.inStaged, ...at(x, y, 250) });
    };
    return (
      <Show when={confirm() !== keyOf(fp.c, fp.inStaged)} fallback={
        <Confirm
          q={<>{del() ? "Delete" : fp.inStaged ? "Discard all changes to" : "Discard changes to"} <b>{short(fp.c.path)}</b>?</>}
          yes={del() ? "Delete" : "Discard"}
          onYes={() => void discard(p(), [fp.c], fp.inStaged)}
        />
      }>
        <div
          class="g-frow"
          classList={{ sel: sel(), conf: conflicted(fp.c) }}
          title={fp.c.path}
          onClick={() => select(p(), { repo: g().repo, path: fp.c.path, staged: fp.inStaged })}
          onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY); }}
          onDblClick={() => {
            if (fp.c.x === "D" || fp.c.y === "D") return flash("deleted: there is no working copy to open");
            openFile(p(), abs({ repo: g().repo, path: fp.c.path, staged: fp.inStaged }), { from: props.tab.id });
          }}
        >
          <input
            type="checkbox"
            checked={fp.inStaged}
            title={conflicted(fp.c) ? "Mark resolved (stage)" : fp.inStaged ? "Unstage" : "Stage"}
            onClick={(e) => {
              e.stopPropagation();
              void (fp.inStaged ? unstage(p(), [fp.c.path]) : stage(p(), [fp.c.path]));
            }}
          />
          <span class={`g-st s-${conflicted(fp.c) ? "C" : letter(fp.c, fp.inStaged)}`}>{conflicted(fp.c) ? "C" : letter(fp.c, fp.inStaged)}</span>
          <button type="button" class="g-fp rowmain" aria-current={sel() || undefined}><span class="d">{i >= 0 ? fp.c.path.slice(0, i + 1) : ""}</span>{fp.c.path.slice(i + 1)}</button>
          <RowStat n={fp.inStaged ? fp.c.index : fp.c.work} />
          <span class="g-racts" onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
            <Show when={conflicted(fp.c)} fallback={
              <button class="bad g-ask" title={del() ? "Delete file…" : "Discard changes…"} aria-label={del() ? "Delete file" : "Discard changes"} onClick={() => setConfirm(keyOf(fp.c, fp.inStaged))}>
                <Icon name={del() ? "trash-2" : "undo-2"} />
              </button>
            }>
              <button class="txt" title="Mark resolved (git add)" onClick={() => stage(p(), [fp.c.path])}><Icon name="check" size={12} />resolved</button>
            </Show>
            <button title="More" aria-label="More" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.right - 250, r.bottom + 2); }}><Icon name="ellipsis" /></button>
          </span>
        </div>
      </Show>
    );
  };

  /** A row's menu: stage, stash, discard / delete, stop tracking, ignore. */
  const RowMenu = () => (
    <Show when={ctx()}>
      {(m) => {
        const c = () => m().c;
        const close = () => setCtx(null);
        const run = (f: () => unknown) => () => { close(); void f(); };
        return (
          <div class="g-menu g-ctx" role="menu" style={{ left: `${m().x}px`, top: `${m().y}px` }}>
            <button role="menuitem" disabled={c().x === "D" || c().y === "D"}
              onClick={run(() => openFile(p(), abs({ repo: g().repo, path: c().path, staged: m().staged }), { from: props.tab.id }))}><Icon name="square-pen" />Open in editor</button>
            <button role="menuitem" onClick={run(() => { copyText(c().path); flash("copied the path"); })}><Icon name="copy" />Copy path</button>
            <hr />
            <button role="menuitem" onClick={run(() => (m().staged ? unstage(p(), [c().path]) : stage(p(), [c().path])))}>
              <Icon name={conflicted(c()) ? "check" : m().staged ? "minus" : "plus"} />
              {conflicted(c()) ? "Mark resolved" : m().staged ? "Unstage" : "Stage"}
            </button>
            <button role="menuitem" disabled={conflicted(c()) || c().path.endsWith("/")}
              onClick={run(() => stashPush(p(), { message: short(c().path), untracked: untrackedC(c()), files: [c().path] }))}><Icon name="archive" />Stash this file</button>
            <hr />
            <Show when={untrackedC(c())}>
              <button role="menuitem" onClick={run(() => ignore(p(), c().path))}><Icon name="file-x" />Add to .gitignore</button>
            </Show>
            <Show when={!untrackedC(c()) && c().x !== "A" && c().x !== "D"}>
              <button role="menuitem" onClick={run(() => untrack(p(), c().path))}><Icon name="eye-off" />Stop tracking (keep on disk)</button>
            </Show>
            <button role="menuitem" class="bad g-ask" disabled={conflicted(c())}
              onClick={() => { const k = keyOf(c(), m().staged); close(); setConfirm(k); }}>
              <Icon name={deletes(c(), m().staged) ? "trash-2" : "undo-2"} />
              {deletes(c(), m().staged) ? "Delete file…" : "Discard changes…"}
            </button>
          </div>
        );
      }}
    </Show>
  );

  const StashForm = () => (
    <Show when={stashForm()}>
      {(f) => {
        const n = () => (s()?.files ?? []).filter((c) => !conflicted(c) && (stashU() || !untrackedC(c))).length;
        const go = async () => {
          if (!n()) return;
          if (await stashPush(p(), { message: stashMsg(), untracked: stashU() })) { setStashForm(null); setStashMsg(""); }
        };
        return (
          <div class="g-menu g-stashform" style={{ left: `${f().x}px`, top: `${f().y}px` }}>
            <div class="g-group">Stash changes</div>
            <input class="g-in" placeholder={`WIP on ${s()?.branch ?? "HEAD"}`} value={stashMsg()} ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => setStashMsg(e.currentTarget.value)} onKeyDown={(e) => { if (isEnter(e)) void go(); }} />
            <label class="g-hint g-check-l"><input type="checkbox" checked={stashU()} onChange={(e) => setStashU(e.currentTarget.checked)} /> include untracked files</label>
            <div class="g-row">
              <span class="g-hint">Staged and unstaged both go in.</span>
              <span class="grow" />
              <button class="g-btn sm" onClick={() => setStashForm(null)}>Cancel</button>
              <button class="g-btn sm primary" disabled={!n() || !!g().working} onClick={() => void go()}>
                <Icon name="archive" size={13} />{g().working === "stash" ? "Stashing…" : `Stash ${n()}`}
              </button>
            </div>
          </div>
        );
      }}
    </Show>
  );

  const StashRow = (sp: { st: Stash }) => (
    <Show when={confirm() !== `drop:${sp.st.sha}`} fallback={
      <Confirm q={<>Drop <b>{sp.st.ref}</b>? It can't be undone.</>} yes="Drop" onYes={() => void stashOp(p(), sp.st, "drop")} />
    }>
      <div class="g-srow pad" classList={{ sel: g().stash?.key === sp.st.sha }} title={`${sp.st.subject}\n${sp.st.when}`} onClick={() => void selectStash(p(), sp.st)}>
        <span class="ix">{sp.st.ref.replace(/^stash/, "")}</span>
        <button type="button" class="s rowmain" aria-current={g().stash?.key === sp.st.sha || undefined}>{sp.st.subject}</button>
        <span class="w">{sp.st.when}</span>
        <span class="g-racts" onClick={(e) => e.stopPropagation()}>
          <button class="txt" title="git stash apply: keep the stash" disabled={!!g().working} onClick={() => stashOp(p(), sp.st, "apply")}>Apply</button>
          <button class="txt" title="git stash pop: apply, then drop it" disabled={!!g().working} onClick={() => stashOp(p(), sp.st, "pop")}>Pop</button>
          <button class="bad g-ask" title="Drop…" aria-label="Drop stash" onClick={() => setConfirm(`drop:${sp.st.sha}`)}><Icon name="trash-2" /></button>
        </span>
      </div>
    </Show>
  );

  const Lists = (lp: { sub?: boolean }) => (
    <>
      <div class="g-sec" classList={{ sub: lp.sub }}><Icon name="circle-check-big" size={12} />Staged <span class="n">{stagedList().length}</span>
        <Show when={stagedList().length}>
          <button title="Unstage all" aria-label="Unstage all" onClick={() => unstage(p(), stagedList().map((c) => c.path))}><Icon name="minus" /></button>
        </Show>
      </div>
      <For each={stagedList()}>{(c) => <FileRow c={c} inStaged={true} />}</For>
      <div class="g-sec" classList={{ sub: lp.sub }}><Icon name="file-diff" size={12} />Changes <span class="n">{unstagedList().length}</span>
        <Show when={unstagedList().length}>
          <span class="acts">
            <button class="g-stashbtn" title="Stash the changes…" aria-label="Stash the changes" onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setStashForm(stashForm() ? null : at(r.right - 290, r.bottom + 4, 290));
            }}><Icon name="archive" /></button>
            <button class="bad g-ask" title="Discard all changes…" aria-label="Discard all changes" onClick={() => setConfirm("*")}><Icon name="undo-2" /></button>
            <button title="Stage all" aria-label="Stage all" onClick={() => stage(p(), unstagedList().map((c) => c.path))}><Icon name="plus" /></button>
          </span>
        </Show>
      </div>
      <Show when={confirm() === "*"}>
        {(() => {
          const live = () => unstagedList().filter((c) => !conflicted(c));
          const n = () => live().filter((c) => !untrackedC(c)).length;
          const u = () => live().filter(untrackedC).length;
          return (
            <Confirm
              q={<>{n() ? <>Discard <b>{n()}</b> changed</> : ""}{n() && u() ? ", " : ""}{u() ? <>delete <b>{u()}</b> untracked</> : ""}?</>}
              yes="Discard all"
              onYes={() => void discard(p(), live(), false)}
            />
          );
        })()}
      </Show>
      <For each={unstagedList()}>{(c) => <FileRow c={c} inStaged={false} />}</For>
      <Show when={s() && !s()!.files.length && !g().loading}><div class="g-hint pad">Working tree clean.</div></Show>
      <Show when={g().stashes?.length}>
        <div class="g-sec" classList={{ sub: lp.sub }}><Icon name="archive" size={12} />Stashes <span class="n">{g().stashes!.length}</span></div>
        <For each={g().stashes}>{(st) => <StashRow st={st} />}</For>
      </Show>
      <div class="g-sec" classList={{ sub: lp.sub }}><Icon name="history" size={12} />Commits</div>
      <For each={s()?.commits ?? []}>
        {(c) => (
          <button
            type="button"
            class="g-commit pad"
            classList={{ sel: g().commit?.key === c.sha }}
            aria-current={g().commit?.key === c.sha || undefined}
            title={`${c.sha}\n${c.when}`}
            onClick={() => selectCommit(p(), c.sha)}
          >
            <span class="sha">{c.sha.slice(0, 7)}</span><span class="s">{c.subject}</span>
            <span class="w" classList={{ local: !c.pushed }} title={c.pushed ? undefined : "Not pushed"}>
              <Show when={!c.pushed}><Icon name="cloud-off" size={11} /></Show>{c.pushed ? c.when : "local"}
            </span>
          </button>
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
        <button type="button" class="g-repohead" classList={{ on: active() }} aria-expanded={active()} title={`${rp.r.repo || p().name}${rs()?.branch ? ` · ${rs()!.branch}` : ""}`} onClick={() => selectRepo(p(), rp.r.repo)}>
          <span class="cv"><Icon name={active() ? "chevron-down" : "chevron-right"} size={12} /></span>
          <b>{rp.r.repo || p().name}</b>
          <span class="br">{rs()?.branch ?? "—"}</span>
          <Show when={rs()?.ahead}><span class="ab">↑{rs()!.ahead}</span></Show>
          <span class="ct" classList={{ bad: !!rp.r.error }}>{rp.r.error ? "error" : n() ? `${n()} changed` : "clean"}</span>
        </button>
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

  const FlowStep = (fp: { id: Drawer; icon: string; label: string; count?: number; done: boolean; now: boolean; warn?: boolean; disabled?: string }) => (
    <button
      class="g-fs"
      classList={{ done: fp.done && !fp.now, now: fp.now, warn: fp.now && fp.warn, open: g().drawer === fp.id }}
      disabled={!!fp.disabled}
      title={fp.disabled ?? ""}
      onClick={() => openDrawer(p(), g().drawer === fp.id ? null : fp.id)}
    >
      <Icon name={fp.done && !fp.now ? "check" : fp.icon} size={13} /><span class="lbl">{fp.label}</span>
      <Show when={fp.count}><span class="g-count">{fp.count}</span></Show>
    </button>
  );

  const CheckList = () => (
    <div class="g-checks">
      <For each={g().pr?.checks ?? []} fallback={<div class="g-hint">No checks on this PR.</div>}>
        {(c) => (
          <div class="g-check">
            <span class={`ic ${c.state}`}>
              <Show when={c.state !== "pending"}>
                <Icon name={c.state === "pass" ? "circle-check" : c.state === "fail" ? "circle-x" : "circle-minus"} />
              </Show>
            </span>
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
          <Show when={g().busy === "review"} fallback={<button class="g-btn ai sm" onClick={() => review(p())}><Icon name="sparkles" size={13} />Review PR</button>}>
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
              <span class="g-hint g-revhead"><Icon name="sparkles" size={12} />review · <b classList={{ warn: open() > 0, ok: open() === 0 }}>{open() ? `${open()} to fix before merge` : "nothing blocking"}</b></span>
              <span class="grow" />
              <Show when={g().busy !== "review"} fallback={<Thinking what="reviewing…" />}>
                <button class="g-btn sm" onClick={() => review(p())}><Icon name="rotate-cw" size={13} />Again</button>
              </Show>
            </div>
            <For each={list()}>
              {(f, i) => (
                <div class="g-finding">
                  <span class={`sev ${f.sev}`}><Icon name={f.sev === "fix" ? "circle-alert" : f.sev === "ok" ? "circle-check" : "info"} /></span>
                  <div>
                    <Show when={f.loc}><div class="loc">{f.loc}</div></Show>
                    <p>{f.text}</p>
                  </div>
                  <Show when={f.sev !== "ok"} fallback={<span />}>
                    <button class="g-btn sm" title="Copy the note to the clipboard" onClick={() => copyFinding(p(), i())}><Icon name="copy" size={13} />Copy</button>
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
            <button class="g-btn sm" onClick={() => openUrlInProject(p().id, pr().url, props.tab.id)}><Icon name="external-link" size={13} />Open</button>
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
                <button class="g-icon" title="Close the commit" aria-label="Close the commit" onClick={() => selectCommit(p(), c.sha)}><Icon name="x" /></button>
              </div>
              <h3>{d().message.split("\n")[0]}</h3>
              <Show when={d().message.split("\n").slice(1).join("\n").trim()}>
                <pre class="g-cbody">{d().message.split("\n").slice(1).join("\n").trim()}</pre>
              </Show>
              <Show when={d().stat}><pre class="g-cstat">{d().stat}</pre></Show>
            </div>
            <div class="g-changes-head">Changes</div>
            <DiffView text={d().diff} mode={mode()} onMode={setMode} />
          </>
        )}
      </Show>
    </Show>
  );

  const DestMenu = () => (
    <Show when={destMenu() && s()}>
      {(() => {
        const names = () => {
          const q = destQ().trim().toLowerCase();
          const list = (g().branches ?? []).filter((b) => b !== s()!.branch && b.toLowerCase().includes(q));
          // The default first, then the rest as git lists them.
          return [...list.filter((b) => b === s()!.defaultBase), ...list.filter((b) => b !== s()!.defaultBase)];
        };
        const pick = (b: string) => { setDestMenu(false); void setBase(p(), b); };
        return (
          <div class="g-menu g-destmenu" role="menu" style={{ left: `${destAt().x}px`, top: `${destAt().y}px` }}>
            <input class="g-in g-destq" placeholder="Find a branch" value={destQ()} spellcheck={false} ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => setDestQ(e.currentTarget.value)}
              onKeyDown={(e) => { if (isEnter(e) && names()[0]) pick(names()[0]); }} />
            <div class="g-group">{s()!.branch} merges into</div>
            <div class="g-destlist">
              <Show when={g().branches} fallback={<div class="g-hint pad">Reading branches…</div>}>
                <For each={names()} fallback={<div class="g-hint pad">No match.</div>}>
                  {(b) => (
                    <button role="menuitemradio" aria-checked={b === s()!.base} classList={{ on: b === s()!.base }} onClick={() => pick(b)}>
                      <span class="ck"><Show when={b === s()!.base}><Icon name="check" size={12} /></Show></span><span class="nm">{b}</span>
                      <Show when={b === s()!.defaultBase}><span class="keycaps g-hint">default</span></Show>
                    </button>
                  )}
                </For>
              </Show>
            </div>
            <div class="g-foot">
              The PR base, and what ✦ Draft PR and ✦ Review compare against. Kept for this branch
              {g().pr?.state === "OPEN" ? `; PR #${g().pr!.number} is retargeted too` : ""}.
            </div>
          </div>
        );
      })()}
    </Show>
  );

  /** A pull stopped on a conflict: fix, stage, then Continue (or Abort). */
  const OpBanner = () => (
    <Show when={s()?.op}>
      {(op) => {
        const left = () => (s()?.files ?? []).filter(conflicted).length;
        const name = () => (op() === "merge" ? "Merge" : "Rebase");
        return (
          <div class="g-banner" role="status">
            <Icon name="triangle-alert" class="g-bad" />
            <b>{name()} stopped</b>
            <span>{left() ? `${left()} conflict${left() === 1 ? "" : "s"}: fix the file, then mark it resolved` : "conflicts resolved: continue when ready"}</span>
            <span class="grow" />
            <button class="g-btn sm" disabled={!!g().working} onClick={() => finishOp(p(), "abort")}><Icon name="circle-x" size={13} />Abort {op()}</button>
            <button class="g-btn sm primary" disabled={!!g().working || left() > 0} onClick={() => finishOp(p(), "continue")}>
              <Icon name="play" size={13} />{g().working === "rebase" ? "Working…" : "Continue"}
            </button>
          </div>
        );
      }}
    </Show>
  );

  const StashView = () => (
    <Show when={g().stash}>
      {(st) => {
        const entry = () => g().stashes?.find((x) => x.sha === st().key);
        return (
          <>
            <div class="g-cmsg">
              <div class="g-crow">
                <span class="sha stash">{entry()?.ref ?? st().ref}</span>
                <span class="g-hint">{entry()?.when}</span>
                <span class="grow" />
                <Show when={entry()}>
                  {(e) => (
                    <Show when={confirm() !== `drop:${e().sha}`} fallback={
                      <Confirm q={<>Drop <b>{e().ref}</b>?</>} yes="Drop" onYes={() => void stashOp(p(), e(), "drop")} />
                    }>
                      <button class="g-btn sm" disabled={!!g().working} title="git stash apply: keep the stash" onClick={() => stashOp(p(), e(), "apply")}><Icon name="clipboard-paste" size={13} />Apply</button>
                      <button class="g-btn sm primary" disabled={!!g().working} title="git stash pop: apply, then drop it" onClick={() => stashOp(p(), e(), "pop")}><Icon name="archive-restore" size={13} />Pop</button>
                      <button class="g-btn sm ghostdanger g-ask" onClick={() => setConfirm(`drop:${e().sha}`)}><Icon name="trash-2" size={13} />Drop</button>
                    </Show>
                  )}
                </Show>
                <button class="g-icon" title="Close the stash" aria-label="Close the stash" onClick={() => closeStash(p())}><Icon name="x" /></button>
              </div>
              <h3>{st().subject}</h3>
            </div>
            <div class="g-changes-head">Changes</div>
            <Show when={!st().error} fallback={<div class="g-note bad">{st().error}</div>}>
              <Show when={st().text !== undefined} fallback={<div class="g-note">Loading stash…</div>}>
                <DiffView text={st().text!} mode={mode()} onMode={setMode} />
              </Show>
            </Show>
          </>
        );
      }}
    </Show>
  );
  const DrawerView = () => {
    const d = () => g().drawer;
    const title = () => (d() === "pull" ? "Pull" : d() === "push" ? "Push" : d() === "pr" ? "Open pull request" : `Merge #${g().pr?.number ?? ""}`);
    const target = () => `${g().pushRemote}/${g().pushBranch.trim()}`;
    /** Pushing somewhere other than the upstream (or a branch with none). */
    const elsewhere = () => target() !== (s()?.upstream ?? "");
    const ffBlocked = () => g().pullMode === "ff" && (s()?.ahead ?? 0) > 0;
    const dirty = () => (s()?.files.length ?? 0) > 0;
    return (
      <Show when={d()}>
        <div class="g-drawer">
          <div class="g-dh">
            <Icon name={d() === "pull" ? "arrow-down-to-line" : d() === "push" ? "arrow-up-from-line" : d() === "pr" ? "git-pull-request-arrow" : "git-merge"} />
            {title()}
            <button class="x" title="Close" aria-label="Close" onClick={() => openDrawer(p(), null)}><Icon name="x" /></button>
          </div>
          <div class="g-db">
            <Show when={d() === "pull"}>
              <div class="g-hint">from <b class="g-mono">{s()?.upstream}</b> into <b class="g-mono">{s()?.branch}</b></div>
              <div class="g-group">Incoming {s()?.behind ?? 0}</div>
              <Show when={g().incoming} fallback={<div class="g-hint">Reading the remote…</div>}>
                <Show when={!g().incomingError} fallback={<div class="g-hint bad">{g().incomingError}</div>}>
                  <For each={g().incoming} fallback={<div class="g-hint">Nothing new{g().working === "fetch" ? " yet: fetching…" : "."}</div>}>
                    {(c) => (
                      <div class="g-commit in" title={`${c.sha}\n${c.author} · ${c.when}`}>
                        <span class="sha">{c.sha.slice(0, 7)}</span><span class="s">{c.subject}</span><span class="w">{c.author}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
              <Show when={up()}>
                <div class="g-group">Yours, not pushed {up()}</div>
                <For each={(s()?.commits ?? []).filter((c) => !c.pushed)}>
                  {(c) => <div class="g-commit"><span class="sha">{c.sha.slice(0, 7)}</span><span class="s">{c.subject}</span></div>}
                </For>
              </Show>
              <div class="g-row">
                <span class="g-hint">How</span>
                <span class="g-seg">
                  <For each={[["rebase", "rebase"], ["merge", "merge"], ["ff", "fast-forward only"]] as const}>
                    {([k, label]) => <button aria-pressed={g().pullMode === k} onClick={() => setOpt(p(), "pullMode", k)}>{label}</button>}
                  </For>
                </span>
              </div>
              <div class="g-hint">
                {g().pullMode === "rebase" ? "Your local commits are replayed on top of the incoming ones; history stays straight."
                  : g().pullMode === "merge" ? "Adds a merge commit when both sides have new commits."
                  : "Only moves forward; refuses if you have local commits."}
              </div>
              <Show when={ffBlocked()}>
                <div class="g-note warn">You have {s()!.ahead} local commit{s()!.ahead === 1 ? "" : "s"}, so this can't fast-forward. Pick rebase or merge.</div>
              </Show>
              <Show when={dirty()}>
                <div class="g-note" classList={{ warn: !g().autostash }}>
                  <label class="g-check-l">
                    <input type="checkbox" checked={g().autostash} onChange={(e) => setOpt(p(), "autostash", e.currentTarget.checked)} />
                    Stash my {s()!.files.length} changed file{s()!.files.length === 1 ? "" : "s"} first, and put them back after
                  </label>
                  <Show when={!g().autostash}><div class="g-hint warn">Without this, git refuses if an incoming commit touches one of them.</div></Show>
                </div>
              </Show>
            </Show>
            <Show when={d() === "push"}>
              <div class="g-field">
                <span class="l">to</span>
                <span class="g-target">
                  <select value={g().pushRemote} onChange={(e) => setPushTarget(p(), "pushRemote", e.currentTarget.value)}>
                    <For each={g().remotes?.length ? g().remotes : [g().pushRemote]}>{(r) => <option value={r}>{r}</option>}</For>
                  </select>
                  <span class="g-hint">/</span>
                  <input value={g().pushBranch} spellcheck={false} onInput={(e) => setPushTarget(p(), "pushBranch", e.currentTarget.value)} />
                </span>
                <span />
                <span class="g-row">
                  <label class="g-hint g-check-l">
                    <input type="checkbox" checked={g().track} onChange={(e) => setOpt(p(), "track", e.currentTarget.checked)} /> track it (set upstream)
                  </label>
                  <Show when={!s()?.upstream || elsewhere()}>
                    <span class="g-hint warn">{s()?.upstream ? `not the upstream (${s()!.upstream})` : "new on the remote"}</span>
                  </Show>
                </span>
              </div>
              <For each={(s()?.commits ?? []).filter((c) => !c.pushed)} fallback={<div class="g-hint">Nothing to push.</div>}>
                {(c) => <div class="g-commit"><span class="sha">{c.sha.slice(0, 7)}</span><span class="s">{c.subject}</span></div>}
              </For>
              <Show when={s()?.behind && !elsewhere()}>
                <div class="g-note warn">
                  {s()!.behind} commit{s()!.behind === 1 ? " is" : "s are"} on {s()!.upstream} but not here yet; the push will be refused.
                  <button class="g-btn sm" style={{ "margin-left": "6px" }} onClick={() => openDrawer(p(), "pull")}><Icon name="arrow-down-to-line" size={13} />Pull first</button>
                </div>
              </Show>
            </Show>
            <Show when={d() === "pr"}>
              <Show when={!g().pr || g().pr!.state !== "OPEN"} fallback={<><div class="g-hint">This branch already has an open PR.</div><PrCard /></>}>
                <div class="g-row">
                  <span class="g-branch"><BranchIcon /> {s()?.branch}</span>→<span class="g-branch base">{s()?.base}</span>
                  <span class="grow" />
                  <Show when={g().busy === "pr"} fallback={<button class="g-btn ai sm" onClick={() => draftPr(p())}><Icon name="sparkles" size={13} />Draft PR</button>}>
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
            <Show when={d() === "pull"}>
              <button class="g-btn sm" disabled={!!g().working} title="git fetch --all --prune" onClick={() => fetchRemotes(p())}>
                <Icon name="refresh-cw" size={13} class={g().working === "fetch" ? "spin" : ""} />{g().working === "fetch" ? "Fetching…" : "Fetch"}
              </button>
              <span class="grow" />
              <button class="g-btn primary" disabled={!!g().working || !s()?.behind || ffBlocked()} onClick={() => pull(p())}>
                <Icon name={s()?.behind ? "arrow-down-to-line" : "check"} />
                {g().working === "pull" ? "Pulling…" : s()?.behind ? "Pull" : "Up to date"}
                <Show when={s()?.behind && g().working !== "pull"}><span class="g-count">{s()!.behind}</span></Show>
              </button>
            </Show>
            <Show when={d() === "push"}>
              <span class="grow" />
              <button
                class="g-btn primary"
                disabled={!!g().working || !g().pushBranch.trim() || (!up() && !!s()?.upstream && !elsewhere())}
                onClick={async () => {
                  const t = { remote: g().pushRemote, branch: g().pushBranch, track: g().track };
                  // The default target is the plain push (to the upstream, or origin tracked).
                  const u = upstreamOf(s());
                  const same = u ? u.remote === t.remote && u.branch === t.branch.trim() : t.remote === "origin" && t.branch.trim() === s()?.branch && t.track;
                  if (await push(p(), same ? undefined : t)) openDrawer(p(), null);
                }}
              >
                <Icon name="arrow-up-from-line" />
                {g().working === "push" ? "Pushing…" : "Push"}
                <Show when={up() && g().working !== "push"}><span class="g-count">{up()}</span></Show>
              </button>
            </Show>
            <Show when={d() === "pr" && (!g().pr || g().pr!.state !== "OPEN")}>
              <label class="g-hint g-check-l">
                <input type="checkbox" checked={g().prDraft} onChange={(e) => setOpt(p(), "prDraft", e.currentTarget.checked)} /> draft
              </label>
              <span class="grow" />
              <Show when={up() > 0}><span class="g-hint warn">push first</span></Show>
              <button class="g-btn primary" disabled={!g().prTitle.trim() || up() > 0 || !!g().working} onClick={() => openPr(p())}>
                <Icon name="git-pull-request-arrow" />{g().working === "pr" ? "Opening…" : "Open PR"}
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
                      <Icon name="git-merge" />{g().working === "merge" ? "Merging…" : failing() ? `Merge #${g().pr!.number} anyway` : `Merge #${g().pr!.number}`}
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
    <div class="gitwin" ref={(el) => (winEl = el)} onKeyDown={onKey}>
      <div class="g-head" classList={{ "g-head-open": repoMenu() }}>
        <Show when={multiRepo()}>
          <button class="g-repo" title="Active repo: click to switch" aria-haspopup="menu" aria-expanded={repoMenu()} onClick={() => setRepoMenu(!repoMenu())}>
            <b>{repoName()}</b><span class="k">{g().repos!.length} repos</span><span class="cv"><Icon name="chevron-down" size={12} /></span>
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
          <span class="g-arrow"><Icon name="arrow-right" size={12} /></span>
          <button
            class="g-dest"
            classList={{ open: destMenu() }}
            disabled={!s()!.branch}
            title={`Destination: what ${s()!.branch ?? "this branch"} merges into (the PR base). Click to change.`}
            aria-haspopup="menu"
            aria-expanded={destMenu()}
            onClick={(e) => {
              const open = !destMenu();
              const r = e.currentTarget.getBoundingClientRect();
              setDestAt(at(r.left, r.bottom + 4, 290));
              setDestMenu(open);
              setDestQ("");
              if (open) void loadBranches(p());
            }}
          >
            {s()!.base}<span class="cv"><Icon name="chevron-down" size={12} /></span>
          </button>
          <span class="g-ahead">
            {s()!.behind ? <span class="in" title={`${s()!.behind} on ${s()!.upstream} not here yet`}><Icon name="arrow-down" size={12} />{s()!.behind}</span> : ""}
            {s()!.files.length ? `${s()!.files.length} changed` : ""}
          </span>
        </Show>
        <span class="grow" />
        <Show when={s()}>
          <div class="g-flow">
            <FlowStep
              id="pull"
              icon="arrow-down-to-line"
              label="Pull"
              count={s()!.behind}
              done={!!s()!.upstream && !s()!.behind}
              now={s()!.behind > 0}
              warn
              disabled={!s()!.upstream ? "No upstream yet: push the branch first" : undefined}
            />
            <span class="sepa"><Icon name="chevron-right" size={12} /></span>
            <FlowStep id="push" icon="arrow-up-from-line" label="Push" count={up()} done={!up() && !!s()!.upstream} now={step() === "push" && !s()!.behind} />
            <span class="sepa"><Icon name="chevron-right" size={12} /></span>
            <FlowStep
              id={g().pr?.state === "OPEN" ? "merge" : "pr"}
              icon="git-pull-request-arrow"
              label={g().pr?.state === "OPEN" ? `#${g().pr!.number}` : "PR"}
              done={g().pr?.state === "OPEN" || g().pr?.state === "MERGED"}
              now={step() === "pr" && !onBase()}
              disabled={onBase() && !g().pr ? `You are on ${s()!.base}; work on a branch to open a PR` : undefined}
            />
            <span class="sepa"><Icon name="chevron-right" size={12} /></span>
            <FlowStep
              id="merge"
              icon={g().pr?.checks.some((c) => c.state === "pending") ? "loader-circle" : "git-merge"}
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
            classList={{ primary: g().pr?.state === "MERGED", ghost: g().pr?.state !== "MERGED" }}
            title={`Close this worktree's windows, delete ${p().path} and its branch`}
            onClick={() => void removeWorktree(p())}
          >
            <Icon name="folder-x" size={13} /><span class="lbl">Remove worktree</span>
          </button>
        </Show>
        <button class="g-icon" title="Refresh" aria-label="Refresh" classList={{ spin: g().loading }} onClick={() => refresh(p())}><Icon name="refresh-cw" /></button>
      </div>

      <OpBanner />
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
                placeholder={`Message${nestedRepo() ? ` for ${repoName()}` : ""} (${ctrlName}+Enter commits, ${ctrlName}+Shift+Enter also pushes)`}
                value={g().msg}
                onInput={(e) => setField(p(), "msg", e.currentTarget.value)}
                onKeyDown={onMsgKey}
              />
              <div class="g-row">
                <Show when={g().busy === "commit"} fallback={
                  <button class="g-btn ai sm" disabled={!stagedList().length} title="Write the message from the staged diff" onClick={() => draftCommit(p())}><Icon name="sparkles" size={13} />Draft</button>
                }>
                  <Thinking what="drafting…" />
                </Show>
                <span class="grow" />
                <span class="g-split">
                  <button class="g-btn primary" disabled={!ready()} onClick={() => commit(p())}>
                    <Icon name="git-commit-horizontal" />
                    {g().working === "commit" ? "Committing…" : "Commit"}
                    <Show when={stagedList().length && g().working !== "commit"}><span class="g-count">{stagedList().length}</span></Show>
                  </button>
                  <button class="g-btn primary more" disabled={!ready()} aria-haspopup="menu" aria-label="More commit options" onClick={() => setMenu(!menu())}><Icon name="chevron-down" /></button>
                  <Show when={menu()}>
                    <div class="g-menu" role="menu">
                      <button role="menuitem" onClick={() => { setMenu(false); void commit(p(), "push"); }}><Icon name="arrow-up-from-line" />Commit &amp; push<KeyText text="Mod+Shift+↵" /></button>
                      <button role="menuitem" disabled={onBase()} onClick={() => { setMenu(false); void commit(p(), "pr"); }}><Icon name="git-pull-request-arrow" />Commit, push &amp; open PR…</button>
                      <button role="menuitem" onClick={() => { setMenu(false); void commit(p()); }}><Icon name="git-commit-horizontal" />Commit<KeyText text="Mod+↵" /></button>
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
            <Show when={!g().stash} fallback={<StashView />}>
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
                  <Show when={g().sel && hunks().length}>
                    <span class="g-stat"><i class="p">+{stat().added}</i> <i class="m">−{stat().removed}</i></span>
                  </Show>
                  <span class="grow" />
                  <Show when={g().sel}>
                    <span class="g-side" classList={{ staged: g().sel!.staged }}>
                      <Icon name={g().sel!.staged ? "circle-check-big" : "circle-dashed"} size={12} />{g().sel!.staged ? "staged" : "not staged"}
                    </span>
                  </Show>
                  <span class="g-hunks">
                    <button class="g-icon" title="Previous hunk (P)" aria-label="Previous hunk" disabled={!hunks().length} onClick={() => nav(-1)}><Icon name="chevron-up" /></button>
                    <button class="g-icon" title="Next hunk (N)" aria-label="Next hunk" disabled={!hunks().length} onClick={() => nav(1)}><Icon name="chevron-down" /></button>
                  </span>
                  <span class="g-seg" role="group" aria-label="Diff orientation">
                    <button aria-pressed={mode() === "unified"} title="A stacked diff" onClick={() => setMode("unified")}><Icon name="rows-2" size={13} /><span class="lbl">Unified</span></button>
                    <button
                      aria-pressed={mode() === "split"}
                      title={wantedMode() === "split" && !splitFits() ? "Split needs about 660px: this pane shows unified" : "Side by side"}
                      onClick={() => setMode("split")}
                    ><Icon name="columns-2" size={13} /><span class="lbl">Split</span></button>
                  </span>
                  <button class="g-btn sm" disabled={!g().sel || !first() || deleted()} title={deleted() ? "A deleted file has no working copy to open" : "Open the file at its first change"} onClick={() => openAt("source")}><Icon name="square-pen" size={13} />Editor</button>
                  <button class="g-btn sm" disabled={!g().sel || !first() || deleted()} title={deleted() ? "A deleted file has no working copy to open" : withKey("Open the editor in its diff view", "diff")} onClick={() => openAt("diff")}><Icon name="file-diff" size={13} />Diff<HoldKey id="diff" when={!!(props.focused && g().sel && first() && !deleted())} /></button>
                </div>
                <Show when={!g().repoError} fallback={<div class="g-note bad">{g().repoError}</div>}>
                  <DiffView
                    text={g().sel ? g().diff?.text : ""}
                    error={g().diff?.error}
                    mode={mode()}
                    onMode={setMode}
                    onDrill={drill}
                    ref={(el) => (diffEl = el)}
                  />
                </Show>
              </>
            }>
              {(c) => <CommitView sha={c().key} />}
            </Show>
            </Show>
            <DrawerView />
          </div>
        </div>
      </Show>
      <DestMenu />
      <RowMenu />
      <StashForm />
    </div>
  );
}

