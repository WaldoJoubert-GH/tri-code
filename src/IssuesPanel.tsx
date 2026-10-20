// The issues window: a view of the project's `.dev/` folder (Plane + Sentry),
// the same files pi-todos and dev-hub read and write. Plain HTML, not a
// terminal, so plain keys drive it while the window is focused.

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { type Project, type Tab, focusTab, space, tabName } from "./state";
import { agentTarget } from "./agents";
import {
  ACTIVE_GROUPS, LEVEL_COLORS, PRIORITY_COLORS, type DevState, type PlaneIssue,
  type PlaneLabel, type PlaneState, type UnifiedIssue, accumulatedMs, addDraftImage, ago, avatarColor,
  clearDraft, clock, commentsOf, connectPlane, createIssue, dev, ensureComments, fgFor, formatDay, formatHm,
  formatHms, getDraft, initials, isActive, issueKey, labelOf, loadDev, pendingIssue, postComment, priorityRank,
  removeDraftImage, runningEntry, setDraftText, setIssueState, setPendingIssue, shownIssues, slugOf, stateOf,
  syncDev, syncNow, toggleLabel, toggleTimer,
} from "./issues";
import { openUrlInProject } from "./browsers";
import { sendText } from "./terms";
import { flash } from "./ui";

// ── small presentational pieces ─────────────────────────────────────

function Priority(props: { p?: string }): JSX.Element {
  const p = () => props.p ?? "none";
  const color = () => PRIORITY_COLORS[p()] ?? PRIORITY_COLORS.none;
  if (p() === "urgent") return <span class="pri urgent" style={{ "--pc": color() }} title="urgent">!</span>;
  const on = () => Math.max(0, 4 - priorityRank(p()));
  return (
    <span class={`pri ${p()}`} style={{ "--pc": color() }} title={p()}>
      <For each={[1, 2, 3]}>{(k) => <b class={k <= on() ? "on" : ""} />}</For>
    </span>
  );
}

function Pill(props: { state?: PlaneState; ghost?: string; onClick?: (e: MouseEvent) => void }): JSX.Element {
  return (
    <Show when={props.state} fallback={<span class="pill ghost">{props.ghost ?? "no state"}</span>}>
      {(s) => <span class="pill" style={{ background: s().color, color: fgFor(s().color) }} onClick={props.onClick}>{s().name}</span>}
    </Show>
  );
}

function LabelChip(props: { label?: PlaneLabel }): JSX.Element {
  return <span class="lb" style={{ "--lc": props.label?.color ?? "#888" }}><i />{props.label?.name ?? "?"}</span>;
}

/** An absolutely-positioned popup anchored under (or above) another element. */
function Dropdown(props: { anchor: () => Element | null | undefined; children: JSX.Element }): JSX.Element {
  let el!: HTMLDivElement;
  const place = () => {
    const anchor = props.anchor();
    const root = el?.closest<HTMLElement>(".iss");
    if (!anchor || !root || !el) return;
    const rr = root.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const dw = el.offsetWidth, dh = el.offsetHeight;
    let top = ar.bottom - rr.top + 4;
    if (top + dh > rr.height - 4) top = ar.top - rr.top - dh - 4;
    top = Math.max(4, Math.min(top, rr.height - dh - 4));
    const left = Math.max(4, Math.min(ar.left - rr.left - 6, rr.width - dw - 4));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  onMount(() => {
    place();
    const root = el.closest<HTMLElement>(".iss");
    root?.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    onCleanup(() => {
      root?.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    });
  });
  createEffect(() => place());
  return <div class="idrop" ref={el}>{props.children}</div>;
}

// ── the panel ───────────────────────────────────────────────────────

export default function IssuesPanel(props: { project: Project; home?: Project; tab: Tab; focused: boolean }): JSX.Element {
  const [view, setView] = createSignal<"list" | "detail">("list");
  const [sel, setSel] = createSignal<string | null>(null);
  const [src, setSrc] = createSignal<"all" | "plane" | "sentry">("all");
  const [done, setDone] = createSignal(false);
  const [q, setQ] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [drop, setDrop] = createSignal<number | null>(null);
  const [ldrop, setLdrop] = createSignal<number | null>(null);
  const [light, setLight] = createSignal<{ c: number; i: number } | null>(null);
  const [over, setOver] = createSignal(false);

  let rootEl!: HTMLDivElement;
  let searchEl: HTMLInputElement | undefined;
  let fileEl: HTMLInputElement | undefined;
  /** The first time this panel gets focus, pull Plane once. */
  let syncedOnce = false;

  /** The project this window is in: a Worktree's panel shows its repo's issues (`project`) but types into its own agents. */
  const home = () => props.home ?? props.project;
  const state = (): DevState | undefined => dev[props.project.id];
  const rows = createMemo(() => shownIssues(state(), { src: src(), done: done(), q: q() }));
  const selected = createMemo(() => (state()?.issues ?? []).find((i) => issueKey(i) === sel()));
  const selectedPlane = (): PlaneIssue | undefined => {
    const i = selected();
    return i?.source === "plane" ? i : undefined;
  };
  const anchor = () => (drop() !== null ? rootEl.querySelector(view() === "detail" ? ".pillbtn" : ".irow.sel .pill") : null);
  const labelAnchor = () => (ldrop() !== null ? rootEl.querySelector(".lblbtn") : null);

  // Keep the list cursor on a visible row; a drilled-in issue stays open.
  createEffect(() => {
    const list = rows();
    if (view() !== "detail" && !list.some((i) => issueKey(i) === sel())) setSel(list[0] ? issueKey(list[0]) : null);
  });

  // A sync in pi-todos or dev-hub should show up: re-read `.dev/` when focused.
  createEffect(on(() => props.focused, (f) => {
    if (!f || untrack(() => state()?.loading)) return;
    loadDev(props.project).then(() => {
      if (!syncedOnce && state()?.connected) {
        syncedOnce = true;
        syncDev(props.project, true);
      }
    });
  }, { defer: false }));

  // Open an issue asked for by the toolbar chips or the sidebar.
  createEffect(() => {
    const p = pendingIssue();
    if (!p || p.projectId !== home().id) return;
    setPendingIssue(null);
    openDetailById(p.issueId);
  });

  onMount(() => {
    const id = window.setInterval(() => syncNow(props.project), 5 * 60e3);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      clearInterval(id);
      window.removeEventListener("keydown", onKey);
    });
  });

  function openDetailById(issueId: string) {
    setSrc((s) => (s === "sentry" ? "all" : s));
    setSel(issueId);
    setView("detail");
    setDrop(null);
    setLdrop(null);
    setLight(null);
    const issue = (state()?.issues ?? []).find((i) => issueKey(i) === issueId);
    if (issue?.source === "plane") ensureComments(props.project, issue.id).catch(() => {});
  }

  function step(n: number) {
    const list = rows();
    const at = list.findIndex((i) => issueKey(i) === sel());
    const issue = list[at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + n))];
    if (!issue) return;
    if (issueKey(issue) === sel()) return void flash(n > 0 ? "last issue" : "first issue");
    setSel(issueKey(issue));
    setLight(null);
    setLdrop(null);
    if (view() === "detail" && issue.source === "plane") ensureComments(props.project, issue.id).catch(() => {});
  }

  function toggleDone() {
    setDone(!done());
    flash(done() ? "showing done and cancelled" : "showing active only");
  }

  async function changeState(stateId: string) {
    const issue = selectedPlane();
    setDrop(null);
    if (!issue || issue.state_id === stateId) return;
    const next = state()?.states.find((s) => s.id === stateId);
    await setIssueState(props.project, issue, stateId);
    if (next && !ACTIVE_GROUPS.has(next.group) && runningEntry(props.project.id)?.issue_id === issue.id) {
      await toggleTimer(props.project, issue);
    }
  }

  function sendToAgent(issue: UnifiedIssue) {
    const p = home();
    const target = agentTarget(p, space(p).focus);
    if (!target) return void flash("open an agent window first (the + menu)");
    sendText(target.id, `${slugOf(state(), issue)}: ${issue.title} ${issue.link}`);
    focusTab(p.id, target.id);
    flash(`typed ${slugOf(state(), issue)} into ${tabName(target)}, not sent`);
  }

  function openExternal(issue: UnifiedIssue) {
    openUrlInProject(home().id, issue.link, props.tab.id);
  }

  function copySlug(issue: UnifiedIssue) {
    navigator.clipboard?.writeText(slugOf(state(), issue)).catch(() => {});
    flash(`copied ${slugOf(state(), issue)}`);
  }

  function lightImages() {
    const issue = selectedPlane();
    const list = issue ? commentsOf(props.project.id, issue.id) ?? [] : [];
    return list.flatMap((cmt, c) => cmt.images.map((img, i) => ({ c, i, img, author: cmt.author, at: cmt.created_at })));
  }

  function lightStep(n: number) {
    const all = lightImages();
    if (!all.length) return;
    const k = all.findIndex((x) => x.c === light()?.c && x.i === light()?.i);
    const idx = k < 0 ? 0 : (k + n + all.length) % all.length;
    setLight({ c: all[idx].c, i: all[idx].i });
  }

  function onKey(e: KeyboardEvent) {
    if (!props.focused || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea, select")) return;
    if (handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function handleKey(e: KeyboardEvent): boolean {
    const d = state();
    if (!d?.connected) return false;
    const k = e.key;

    if (drop() !== null) {
      if (k === "ArrowDown" || k === "j") setDrop(((drop() ?? 0) + 1) % d.states.length);
      else if (k === "ArrowUp" || k === "k") setDrop(((drop() ?? 0) + d.states.length - 1) % d.states.length);
      else if (k === "Enter") { const s = d.states[drop()!]; if (s) void changeState(s.id); }
      else if (k === "Escape" || k === "d") setDrop(null);
      return true;
    }
    if (ldrop() !== null) {
      const issue = selectedPlane();
      if (k === "ArrowDown" || k === "j") setLdrop(((ldrop() ?? 0) + 1) % d.labels.length);
      else if (k === "ArrowUp" || k === "k") setLdrop(((ldrop() ?? 0) + d.labels.length - 1) % d.labels.length);
      else if ((k === "Enter" || k === " ") && issue) void toggleLabel(props.project, issue, d.labels[ldrop()!].id);
      else if (k === "Escape" || k === "l") setLdrop(null);
      return true;
    }
    if (light()) {
      if (k === "Escape") setLight(null);
      else if (k === "ArrowRight" || k === "l" || k === "j") lightStep(1);
      else if (k === "ArrowLeft" || k === "h" || k === "k") lightStep(-1);
      return true;
    }

    const detail = view() === "detail";
    if (detail && k === "c") rootEl.querySelector<HTMLTextAreaElement>(".ccompose textarea")?.focus();
    else if (detail && k === "l") { if (selectedPlane()) setLdrop(0); else flash("labels are for Plane issues"); }
    else if (k === "ArrowDown" || k === "j") step(1);
    else if (k === "ArrowUp" || k === "k") step(-1);
    else if (k === "Enter" || (!detail && k === "ArrowRight")) {
      const issue = selected();
      if (!issue) return false;
      if (detail) openExternal(issue);
      else openDetailById(issueKey(issue));
    } else if (detail && (k === "Escape" || k === "Backspace" || k === "ArrowLeft" || k === "h")) {
      setView("list");
      setLight(null);
    } else if (k === "Escape") {
      if (!q()) return false;
      setQ("");
      if (searchEl) searchEl.value = "";
    } else if (k === "/") { setView("list"); searchEl?.focus(); }
    else if (!detail && k === "f") {
      setSrc((s) => (s === "all" ? "plane" : s === "plane" ? "sentry" : "all"));
      flash(`source: ${src()}`);
    } else if (!detail && k === "c") toggleDone();
    else if (k === "r") syncNow(props.project);
    else if (k === "n") { setView("list"); setCreating(true); }
    else if (k === "o" && selected()) openExternal(selected()!);
    else if (k === "d") {
      const issue = selectedPlane();
      if (!issue) flash("Sentry issues have no Plane state");
      else setDrop(d.states.findIndex((s) => s.id === issue.state_id));
    } else if (k === "a" && selected()) sendToAgent(selected()!);
    else if (k === "s" && selectedPlane()) void toggleTimer(props.project, selectedPlane()!);
    else if (k === "y" && selected()) copySlug(selected()!);
    else return false;
    return true;
  }

  function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    addImages(input.files);
    input.value = "";
  }

  function addImages(files: FileList | null | undefined) {
    const issue = selected();
    if (!issue || !files) return;
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return void flash("only images can be attached");
    for (const f of images) {
      const reader = new FileReader();
      reader.onload = () => addDraftImage(props.project.id, issueKey(issue), { name: f.name || "pasted-image.png", src: String(reader.result) });
      reader.readAsDataURL(f);
    }
  }

  async function post() {
    const issue = selectedPlane();
    if (!issue) return;
    const draft = getDraft(props.project.id, issue.id);
    if (!draft.text.trim() && !draft.images.length) return;
    await postComment(props.project, issue, draft.text, draft.images);
    clearDraft(props.project.id, issue.id);
  }

  return (
    <div class="iss" classList={{ detail: view() === "detail" }} ref={rootEl}>
      <Show
        when={state()?.connected}
        fallback={
          <Show when={state()?.loaded} fallback={<div class="isetup"><p>Loading .dev/…</p></div>}>
            <Setup project={props.project} state={state} />
          </Show>
        }
      >
        {/* toolbar */}
        <div class="itools">
          <div class="seg" role="group" aria-label="Source">
            <For each={[["all", "All"], ["plane", "Plane"], ["sentry", "Sentry"]] as const}>
              {([key, label]) => (
                <button data-src={key} aria-pressed={src() === key} title={`${label} (f)`} onClick={() => setSrc(key)}>{label}</button>
              )}
            </For>
          </div>
          <input
            class="isearch" ref={searchEl} placeholder="/ filter" spellcheck={false} aria-label="Filter issues"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { if (searchEl?.value) { setQ(""); searchEl.value = ""; } else searchEl?.blur(); }
              else if (e.key === "Enter" || e.key === "ArrowDown") searchEl?.blur();
            }}
          />
          <button class="ib" aria-pressed={done()} title="Show done and cancelled (c)" onClick={toggleDone}>✓</button>
          <button class="ib" classList={{ spin: state()?.syncing }} title="Sync with Plane now (r)" onClick={() => syncNow(props.project)}>⟳</button>
          <button class="ib" title="New Issue (n)" onClick={() => { setView("list"); setCreating(true); }}>+</button>
        </div>

        <div class="imain">
          <div class="ilist">
            <Show when={creating()}>
              <div class="inew">
                <Priority p="none" />
                <input
                  placeholder={`New Issue title · Enter to create in ${state()?.config.plane?.project_identifier ?? "Plane"}, Esc to cancel`}
                  spellcheck={false}
                  autofocus
                  onKeyDown={async (e) => {
                    const input = e.currentTarget;
                    if (e.key === "Enter" && input.value.trim()) {
                      const issue = await createIssue(props.project, input.value.trim());
                      setCreating(false);
                      if (issue) openDetailById(issue.id);
                    } else if (e.key === "Escape" || e.key === "Enter") {
                      setCreating(false);
                    }
                  }}
                />
              </div>
            </Show>
            <For each={rows()}>{(issue) => <Row
              issue={issue}
              state={state()}
              selected={sel() === issueKey(issue)}
              commentCount={commentsOf(props.project.id, issueKey(issue))?.length ?? 0}
              runningStart={(() => {
                const e = runningEntry(props.project.id);
                return e?.issue_id === issueKey(issue) ? Date.parse(e.started_at) : undefined;
              })()}
              onOpen={() => openDetailById(issueKey(issue))}
              onPill={() => { const d = state(); if (d && issue.source === "plane") setDrop(d.states.findIndex((s) => s.id === issue.state_id)); }}
            />}</For>
            <Show when={rows().length === 0}>
              <div class="iempty">
                {q() ? `Nothing matches “${q()}”` : `No ${done() ? "" : "open "}issues${src() === "all" ? "" : ` from ${src()}`}.`}
                <br /><kbd>n</kbd> creates one
              </div>
            </Show>
          </div>
          <div class="idetail">
            <Show when={view() === "detail" ? selected() : undefined}>
              {(issue) => (
                <Detail
                  issue={issue()}
                  state={state()}
                  project={props.project}
                  position={(() => { const k = rows().findIndex((x) => issueKey(x) === issueKey(issue())); return k >= 0 ? `${k + 1} / ${rows().length}` : "not in this filter"; })()}
                  onBack={() => { setView("list"); setLight(null); }}
                  onPrev={() => step(-1)}
                  onNext={() => step(1)}
                  onState={() => { const d = state(); const i = selectedPlane(); if (d && i) setDrop(d.states.findIndex((s) => s.id === i.state_id)); }}
                  onLabels={() => { if (selectedPlane()) setLdrop(0); else flash("labels are for Plane issues"); }}
                  onOpen={() => openExternal(issue())}
                  onCopy={() => copySlug(issue())}
                  onSend={() => sendToAgent(issue())}
                  onTimer={() => { const i = selectedPlane(); if (i) void toggleTimer(props.project, i); }}
                  onImage={(c, i) => setLight({ c, i })}
                  onAttach={() => fileEl?.click()}
                  onFile={onFile}
                  fileRef={(el) => (fileEl = el)}
                  onPost={post}
                  over={over()}
                  setOver={setOver}
                  addImages={addImages}
                />
              )}
            </Show>
          </div>
        </div>

        <div class="ihint">
          <Show when={view() === "detail"} fallback={<>
            <span><kbd>j</kbd><kbd>k</kbd> move</span>
            <span><kbd>Enter</kbd> open</span>
            <span><kbd>/</kbd> filter</span>
            <span><kbd>n</kbd> new</span>
            <span><kbd>f</kbd> source</span>
            <span><kbd>r</kbd> sync</span>
          </>}>
            <span><kbd>Esc</kbd> back</span>
            <span><kbd>j</kbd><kbd>k</kbd> next / prev</span>
            <span><kbd>o</kbd> open in {selected()?.source === "plane" ? "Plane" : "Sentry"}</span>
            <span><kbd>d</kbd> state</span>
            <span><kbd>l</kbd> labels</span>
            <span><kbd>c</kbd> comment</span>
            <span><kbd>a</kbd> send to agent</span>
            <span><kbd>s</kbd> timer</span>
          </Show>
          <span class="src" title="The panel only renders this file; pi-todos and dev-hub read the same one">
            {props.project.host !== "local" ? `${props.project.host}:` : ""}.dev/issues.json
          </span>
        </div>

        <div class="islot">
          <Show when={drop() !== null ? selectedPlane() : undefined}>
            {(issue) => (
              <Dropdown anchor={anchor}>
                <div class="ttl">{slugOf(state(), issue())} state</div>
                <For each={["backlog", "unstarted", "started", "completed", "cancelled"]}>
                  {(group) => (
                    <Show when={(state()?.states ?? []).some((s) => s.group === group)}>
                      <h5>{group}</h5>
                      <For each={(state()?.states ?? []).filter((s) => s.group === group)}>
                        {(s) => (
                          <button
                            data-state={s.id}
                            class={(state()?.states ?? []).indexOf(s) === drop() ? "hi" : ""}
                            role="option"
                            onClick={() => changeState(s.id)}
                          >
                            <Pill state={s} />
                            <Show when={s.id === issue().state_id}><span class="cur">current</span></Show>
                          </button>
                        )}
                      </For>
                    </Show>
                  )}
                </For>
              </Dropdown>
            )}
          </Show>
          <Show when={ldrop() !== null ? selectedPlane() : undefined}>
            {(issue) => (
              <Dropdown anchor={labelAnchor}>
                <div class="ttl">{slugOf(state(), issue())} labels</div>
                <For each={state()?.labels ?? []}>
                  {(l, k) => {
                    const on = () => (issue().labels ?? []).includes(l.id);
                    return (
                      <button
                        data-label={l.id}
                        class={k() === ldrop() ? "hi" : ""}
                        role="option"
                        aria-selected={on()}
                        onClick={() => void toggleLabel(props.project, issue(), l.id)}
                      >
                        <LabelChip label={l} />
                        <span class="cur">{on() ? "✓" : ""}</span>
                      </button>
                    );
                  }}
                </For>
                <div class="lfoot">Enter toggles · Esc closes</div>
              </Dropdown>
            )}
          </Show>
          <Show when={light()}>
            {(() => {
              const im = () => lightImages().find((x) => x.c === light()?.c && x.i === light()?.i);
              return (
                <Show when={im()}>
                  {(img) => (
                    <div class="ilight" role="dialog" aria-label={img().img.name} onClick={(e) => { if (e.target === e.currentTarget) setLight(null); }}>
                      <div class="lwrap"><img src={img().img.src} alt={img().img.name} /></div>
                      <div class="cap">
                        <Show when={lightImages().length > 1}><button title="Previous image (←)" onClick={() => lightStep(-1)}>‹</button></Show>
                        <span>
                          {img().img.name} · {img().author} {ago(img().at)}
                          {lightImages().length > 1 ? ` · ${lightImages().findIndex((x) => x.c === img().c && x.i === img().i) + 1} / ${lightImages().length}` : ""}
                        </span>
                        <Show when={lightImages().length > 1}><button title="Next image (→)" onClick={() => lightStep(1)}>›</button></Show>
                        <span><kbd>Esc</kbd> close</span>
                      </div>
                    </div>
                  )}
                </Show>
              );
            })()}
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ── list row ────────────────────────────────────────────────────────

function Row(props: {
  issue: UnifiedIssue;
  state: DevState | undefined;
  selected: boolean;
  commentCount: number;
  runningStart?: number;
  onOpen: () => void;
  onPill: () => void;
}): JSX.Element {
  const i = props.issue;
  const closed = () => !isActive(props.state, i);
  if (i.source === "sentry") {
    return (
      <div class={`irow${props.selected ? " sel" : ""}${closed() ? " closed" : ""}`} onClick={props.onOpen}>
        <span class="lvl" style={{ "--pc": LEVEL_COLORS[i.level ?? "error"] ?? LEVEL_COLORS.error }} title={i.level} />
        <span class="sid">{slugOf(props.state, i)}</span>
        <span class="t">{i.title}</span>
        <span class="pill ghost">{i.sentry_status}</span>
        <span class="idate">{i.count ?? 0}×</span>
      </div>
    );
  }
  const late = () => !!i.target_date && !closed() && i.target_date < new Date().toISOString().slice(0, 10);
  const labels = () => (i.labels ?? []).map((id) => labelOf(props.state, id)).filter((l): l is PlaneLabel => !!l);
  return (
    <div class={`irow plane${props.selected ? " sel" : ""}${closed() ? " closed" : ""}`} onClick={props.onOpen}>
      <Priority p={i.priority} />
      <span class="sid">{slugOf(props.state, i)}</span>
      <span class="t">
        <span class="tt">{i.title}</span>
        <For each={labels().slice(0, 2)}>{(l) => <LabelChip label={l} />}</For>
        <Show when={labels().length > 2}>
          <span class="lbmore" title={labels().slice(2).map((l) => l.name).join(", ")}>+{labels().length - 2}</span>
        </Show>
        <Show when={props.commentCount > 0}>
          <span class="cc" title={`${props.commentCount} comment${props.commentCount === 1 ? "" : "s"}`}>{props.commentCount}</span>
        </Show>
      </span>
      <Pill state={stateOf(props.state, i)} onClick={(e) => { e.stopPropagation(); props.onPill(); }} />
      {props.runningStart !== undefined
        ? <span class="irun" title="Running Entry"><i class="rec" />{formatHms(clock() - props.runningStart)}</span>
        : <span class={`idate${late() ? " late" : ""}`} title={late() ? "past its Target Date" : "Target Date"}>{i.target_date ? formatDay(i.target_date) : ""}</span>}
    </div>
  );
}

// ── detail view ─────────────────────────────────────────────────────

function Detail(props: {
  issue: UnifiedIssue;
  state: DevState | undefined;
  project: Project;
  position: string;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
  onState: () => void;
  onLabels: () => void;
  onOpen: () => void;
  onCopy: () => void;
  onSend: () => void;
  onTimer: () => void;
  onImage: (c: number, i: number) => void;
  onAttach: () => void;
  onFile: (e: Event) => void;
  fileRef: (el: HTMLInputElement) => void;
  onPost: () => void;
  over: boolean;
  setOver: (v: boolean) => void;
  addImages: (files: FileList | null | undefined) => void;
}): JSX.Element {
  const i = () => props.issue;
  const plane = (): PlaneIssue | undefined => (i().source === "plane" ? (i() as PlaneIssue) : undefined);
  const issueId = () => issueKey(i());
  const draft = () => getDraft(props.project.id, issueId());
  const comments = () => (plane() ? commentsOf(props.project.id, plane()!.id) ?? [] : []);
  const running = () => runningEntry(props.project.id)?.issue_id === issueKey(i());

  return (
    <>
      <div class="dhead">
        <button class="iback" title="Back to the list (Esc)" onClick={props.onBack}>‹ Issues</button>
        <span class="crumb">/ <b>{slugOf(props.state, i())}</b>{i().source === "plane" ? "Plane" : "Sentry"}</span>
        <span class="pos">{props.position}</span>
        <button class="ib" title="Previous issue (k)" onClick={props.onPrev}>↑</button>
        <button class="ib" title="Next issue (j)" onClick={props.onNext}>↓</button>
      </div>
      <div class="dbody">
        <div class="dmain">
          <h3>{i().title}</h3>
          <Show when={plane()} fallback={
            <div class="ichips">
              <span><span class="lvl" style={{ "--pc": LEVEL_COLORS[(i() as { level?: string }).level ?? "error"] }} />{(i() as { level?: string }).level}</span>
              <span class="pill ghost">{(i() as { sentry_status?: string }).sentry_status}</span>
            </div>
          }>
            {(p) => (
              <>
                <div class="ichips">
                  <button class="pillbtn" title="Change state (d)" aria-haspopup="listbox" onClick={props.onState}>
                    <Pill state={stateOf(props.state, p())} />
                    <span class="caret">▾</span>
                  </button>
                  <span><Priority p={p().priority} />{p().priority}</span>
                </div>
                <div class="dlabels">
                  <For each={(p().labels ?? []).map((id) => labelOf(props.state, id))}>
                    {(l) => <Show when={l}>{(x) => <LabelChip label={x()} />}</Show>}
                  </For>
                  <button class="lblbtn" title="Edit labels (l)" aria-haspopup="listbox" onClick={props.onLabels}>
                    {(p().labels ?? []).length ? "+ Label" : "+ Add label"}
                  </button>
                </div>
              </>
            )}
          </Show>
          <p>
            {plane()?.description
              ? plane()!.description
              : <span class="c-m">{i().source === "plane" ? "No description." : "Stack trace and breadcrumbs are in .dev/sentry; o opens the full issue."}</span>}
          </p>
        </div>
        <div class="dside">
          <Show when={plane()} fallback={
            <dl>
              <dt>Culprit</dt><dd>{(i() as { culprit?: string }).culprit ?? "—"}</dd>
              <dt>Events</dt><dd>{(i() as { count?: number }).count ?? 0}</dd>
              <dt>Last seen</dt><dd>{ago(i().updated_at)}</dd>
            </dl>
          }>
            {(p) => (
              <dl>
                <dt>Start</dt><dd>{formatDay(p().start_date)}</dd>
                <dt>Target</dt><dd>{formatDay(p().target_date)}</dd>
                <dt>Time</dt><dd>{accumulatedMs(props.project.id, p().id) ? formatHm(accumulatedMs(props.project.id, p().id)) : "—"}{running() ? " · running" : ""}</dd>
              </dl>
            )}
          </Show>
          <div class="iacts">
            <button onClick={props.onOpen}><kbd>o</kbd>Open in {i().source === "plane" ? "Plane" : "Sentry"}</button>
            <button onClick={props.onSend}><kbd>a</kbd>Send to agent</button>
            <Show when={plane()}>
              <button class={running() ? "on" : ""} onClick={props.onTimer}><kbd>s</kbd>{running() ? "Stop timer" : "Start timer"}</button>
            </Show>
            <button onClick={props.onCopy}><kbd>y</kbd>Copy {slugOf(props.state, i())}</button>
          </div>
        </div>
        <Show when={plane()}>
          <div class="dcomments">
            <h4>Comments{comments().length ? ` · ${comments().length}` : ""}</h4>
            <Show when={comments().length} fallback={<div class="cnone">No comments yet.</div>}>
              <For each={comments()}>
                {(cmt, ci) => (
                  <div class="cmt">
                    <span class="av" style={{ "--avc": avatarColor(cmt.author) }}>{initials(cmt.author)}</span>
                    <div>
                      <div class="cmeta"><b>{cmt.author}</b><span>{ago(cmt.created_at)}</span></div>
                      <Show when={cmt.text}><div class="ctext">{cmt.text}</div></Show>
                      <Show when={cmt.images.length}>
                        <div class="cimgs">
                          <For each={cmt.images}>
                            {(img, ii) => (
                              <button title={`${img.name} · click to enlarge`} onClick={() => props.onImage(ci(), ii())}>
                                <img src={img.src} alt={img.name} />
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </Show>
            <div
              class="ccompose"
              classList={{ over: props.over }}
              onPaste={(e) => {
                const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
                if (files.length) { e.preventDefault(); props.addImages(files as unknown as FileList); }
              }}
              onDragOver={(e) => { e.preventDefault(); props.setOver(true); }}
              onDragLeave={() => props.setOver(false)}
              onDrop={(e) => { e.preventDefault(); props.setOver(false); props.addImages(e.dataTransfer?.files); }}
            >
              <textarea
                placeholder="Add a comment… paste or drop images here"
                spellcheck
                value={draft().text}
                onInput={(e) => setDraftText(props.project.id, issueId(), e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); props.onPost(); } else if (e.key === "Escape") e.currentTarget.blur(); }}
              />
              <Show when={draft().images.length}>
                <div class="cattach">
                  <For each={draft().images}>
                    {(img, k) => (
                      <span>
                        <img src={img.src} alt={img.name} title={img.name} />
                        <button title={`Remove ${img.name}`} aria-label={`Remove ${img.name}`} onClick={() => removeDraftImage(props.project.id, issueId(), k())}>×</button>
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <div class="cbar">
                <button class="ib" title="Attach images" onClick={props.onAttach}>⊕</button>
                <input class="cfile" type="file" accept="image/*" multiple hidden ref={props.fileRef} onChange={props.onFile} />
                <span class="grow">images upload to Plane · <kbd>Ctrl</kbd><kbd>Enter</kbd> posts</span>
                <button class="post" disabled={!draft().text.trim() && !draft().images.length} onClick={props.onPost}>Comment</button>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </>
  );
}

// ── setup form (no `.dev/config.json` plane section yet) ────────────

function Setup(props: { project: Project; state: () => DevState | undefined }): JSX.Element {
  const [ws, setWs] = createSignal(props.state()?.config.plane?.workspace_slug ?? "");
  const [pid, setPid] = createSignal(props.state()?.config.plane?.project_id ?? "");
  const [tok, setTok] = createSignal("");
  const remote = () => props.project.host !== "local";
  const hostToken = () => !!props.state()?.hostToken;

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    if (!ws().trim() || !pid().trim()) return void flash("workspace slug and project ID are both needed");
    if (!hostToken() && !tok().trim()) return void flash("paste a Plane Personal Access Token");
    void connectPlane(props.project, { workspace_slug: ws().trim(), project_id: pid().trim(), token: tok().trim() || undefined });
  };

  return (
    <div class="isetup">
      <form autocomplete="off" onSubmit={submit}>
        <b>Connect Plane to {props.project.name}</b>
        <p>
          tri-code keeps no Plane data of its own. It reads and writes this project's <code>.dev/</code>
          {remote() ? <> on <code>{props.project.host}</code></> : ""}: the same files pi-todos and dev-hub use, so all three always agree.
        </p>
        <label>Workspace slug<input name="ws" spellcheck={false} value={ws()} onInput={(e) => setWs(e.currentTarget.value)} /></label>
        <label>Project ID<input name="pid" placeholder="dc6c5b3b-7f09-4ebf-…" spellcheck={false} value={pid()} onInput={(e) => setPid(e.currentTarget.value)} /></label>
        <Show when={hostToken()} fallback={
          <label>Personal Access Token<input name="tok" type="password" placeholder="plane_api_…" value={tok()} onInput={(e) => setTok(e.currentTarget.value)} /></label>
        }>
          <p class="ok">✓ Plane token found in <code>~/.pi/agent/secrets/plane.json</code>{remote() ? ` on ${props.project.host}` : ""}</p>
        </Show>
        <button class="go">Connect</button>
        <div class="files">
          writes {props.project.path}/.dev/config.json{hostToken() ? "" : <><br />writes ~/.pi/agent/secrets/plane.json</>}{remote() ? " (over ssh)" : ""}
          <br />then syncs every 5 min into .dev/issues.json, plane-states.json, plane-labels.json
        </div>
      </form>
    </div>
  );
}
