// The issues window: a view of the project's `.dev/` folder (Plane, GitHub,
// Local and Sentry issues),
// the same files pi-todos and dev-hub read and write. Plain HTML, not a
// terminal, so plain keys drive it while the window is focused.

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { type Project, type Tab, focusTab, space, tabName } from "./state";
import { agentTarget } from "./agents";
import {
  ACTIVE_GROUPS, DEFAULT_PROGRESS_LABEL, LEVEL_COLORS, PRIORITY_COLORS, SOURCES, SOURCE_NAMES, type DevState,
  type GithubIssue, type LocalIssue, type PlaneIssue, type PlaneLabel, type PlaneState, type Source, type SourceFilter, type TrackedIssue, type UnifiedIssue,
  accumulatedMs, addDraftImage, ago, avatarColor, changingTo, clearDraft, clock, commentsOf, createIssue, dev,
  ensureComments, fgFor, filtersOf, formatDay, formatHm, formatHms, getDraft, guessRepo, initials, isActive,
  issueKey, issueLabels, labelOf, labelsFor, loadDev, pendingIssue, postComment, priorityRank, removeDraftImage,
  runningEntry, saveSources, setDraftText, setIssueState, setPendingIssue, shownIssues, slugOf, sourcesOf,
  stateOf, statesFor, syncDev, syncNow, toggleLabel, toggleTimer,
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

/** A State Pill. With `busy`, it shows the State being changed to, with a spinner, until the change lands. */
function Pill(props: { state?: PlaneState; busy?: PlaneState; ghost?: string; onClick?: (e: MouseEvent) => void }): JSX.Element {
  return (
    <Show when={props.busy ?? props.state} fallback={<span class="pill ghost">{props.ghost ?? "no state"}</span>}>
      {(s) => (
        <span
          class="pill"
          classList={{ busy: !!props.busy }}
          aria-busy={!!props.busy}
          title={props.busy ? `changing to ${props.busy.name}…` : undefined}
          style={{ background: s().color, color: fgFor(s().color) }}
          onClick={props.onClick}
        >
          <Show when={props.busy}><i class="pspin" /></Show>
          {s().name}
        </span>
      )}
    </Show>
  );
}

function LabelChip(props: { label?: PlaneLabel }): JSX.Element {
  return <span class="lb" style={{ "--lc": props.label?.color ?? "#888" }}><i />{props.label?.name ?? "?"}</span>;
}

/** An absolutely-positioned popup anchored under (or above) another element. A press
 *  anywhere outside it (other than on its anchor, which reopens it) closes it. */
function Dropdown(props: { anchor: () => Element | null | undefined; onClose: () => void; children: JSX.Element }): JSX.Element {
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
    const outside = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (el.contains(t) || props.anchor()?.contains(t))) return;
      props.onClose();
    };
    root?.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", outside, true);
    onCleanup(() => {
      root?.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside, true);
    });
  });
  createEffect(() => place());
  return <div class="idrop" ref={el}>{props.children}</div>;
}

// ── the panel ───────────────────────────────────────────────────────

export default function IssuesPanel(props: { project: Project; home?: Project; tab: Tab; focused: boolean }): JSX.Element {
  const [view, setView] = createSignal<"list" | "detail">("list");
  const [sel, setSel] = createSignal<string | null>(null);
  const [src, setSrc] = createSignal<SourceFilter>("all");
  const [done, setDone] = createSignal(false);
  const [q, setQ] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  /** Where a New Issue goes when the project has more than one Source. */
  const [dest, setDest] = createSignal<Source | null>(null);
  /** The Sources form is open over a connected panel (the ⚙ button). */
  const [editing, setEditing] = createSignal(false);
  const [drop, setDrop] = createSignal<number | null>(null);
  const [ldrop, setLdrop] = createSignal<number | null>(null);
  const [light, setLight] = createSignal<{ c: number; i: number } | null>(null);
  const [over, setOver] = createSignal(false);

  let rootEl!: HTMLDivElement;
  let searchEl: HTMLInputElement | undefined;
  let fileEl: HTMLInputElement | undefined;
  /** The first time this panel gets focus, sync once. */
  let syncedOnce = false;

  /** The project this window is in: a Worktree's panel shows its repo's issues (`project`) but types into its own agents. */
  const home = () => props.home ?? props.project;
  const state = (): DevState | undefined => dev[props.project.id];
  const rows = createMemo(() => shownIssues(state(), { src: src(), done: done(), q: q() }));
  const selected = createMemo(() => (state()?.issues ?? []).find((i) => issueKey(i) === sel()));
  const selectedTracked = (): TrackedIssue | undefined => {
    const i = selected();
    return i && i.source !== "sentry" ? i : undefined;
  };
  /** The selected issue's States and Labels, for the two dropdowns. */
  const dropStates = () => { const i = selectedTracked(); return i ? statesFor(state(), i.source) : []; };
  const dropLabels = () => { const i = selectedTracked(); return i ? labelsFor(state(), i.source) : []; };
  const sources = () => sourcesOf(state()?.config);
  const target = (): Source | undefined => { const d = dest(); const all = sources(); return d && all.includes(d) ? d : all[0]; };
  const anchor = () => (drop() !== null ? rootEl.querySelector(view() === "detail" ? ".pillbtn" : ".irow.sel .pill") : null);
  const labelAnchor = () => (ldrop() !== null ? rootEl.querySelector(".lblbtn") : null);

  // Keep the list cursor on a visible row; a drilled-in issue stays open.
  createEffect(() => {
    const list = rows();
    if (view() !== "detail" && !list.some((i) => issueKey(i) === sel())) setSel(list[0] ? issueKey(list[0]) : null);
  });

  // A sync in pi-todos or dev-hub should show up: re-read `.dev/` when focused.
  createEffect(on(() => props.focused, (f) => {
    if (!f) { setDrop(null); setLdrop(null); }
    if (!f || untrack(() => state()?.loading)) return;
    loadDev(props.project).then(() => {
      if (!syncedOnce && state()?.connected && !editing()) {
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
    if (issue) ensureComments(props.project, issue).catch(() => {});
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
    if (view() === "detail") ensureComments(props.project, issue).catch(() => {});
  }

  function toggleDone() {
    setDone(!done());
    flash(done() ? "showing done and cancelled" : "showing active only");
  }

  async function changeState(stateId: string) {
    const issue = selectedTracked();
    setDrop(null);
    if (!issue || stateOf(state(), issue)?.id === stateId) return;
    const next = statesFor(state(), issue.source).find((s) => s.id === stateId);
    await setIssueState(props.project, issue, stateId);
    if (next && !ACTIVE_GROUPS.has(next.group) && runningEntry(props.project.id)?.issue_id === issueKey(issue)) {
      await toggleTimer(props.project, issue);
    }
  }

  function sendToAgent(issue: UnifiedIssue) {
    const p = home();
    const target = agentTarget(p, space(p).focus);
    if (!target) return void flash("open an agent window first (the + menu)");
    sendText(target.id, `${slugOf(state(), issue)}: ${issue.title}${issue.link ? ` ${issue.link}` : ""}`);
    focusTab(p.id, target.id);
    flash(`typed ${slugOf(state(), issue)} into ${tabName(target)}, not sent`);
  }

  function openExternal(issue: UnifiedIssue) {
    if (!issue.link) return void flash(`${slugOf(state(), issue)} is a Local issue: it lives only in .dev/local-issues.json`);
    openUrlInProject(home().id, issue.link, props.tab.id);
  }

  function copySlug(issue: UnifiedIssue) {
    navigator.clipboard?.writeText(slugOf(state(), issue)).catch(() => {});
    flash(`copied ${slugOf(state(), issue)}`);
  }

  function lightImages() {
    const issue = selectedTracked();
    const list = issue ? commentsOf(props.project.id, issueKey(issue)) ?? [] : [];
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
    if (!d?.connected || editing()) return false;
    const k = e.key;

    if (drop() !== null) {
      const states = dropStates();
      if (k === "ArrowDown" || k === "j") setDrop(((drop() ?? 0) + 1) % states.length);
      else if (k === "ArrowUp" || k === "k") setDrop(((drop() ?? 0) + states.length - 1) % states.length);
      else if (k === "Enter") { const s = states[drop()!]; if (s) void changeState(s.id); }
      else if (k === "Escape" || k === "d") setDrop(null);
      return true;
    }
    if (ldrop() !== null) {
      const issue = selectedTracked();
      const labels = dropLabels();
      if (k === "ArrowDown" || k === "j") setLdrop(((ldrop() ?? 0) + 1) % labels.length);
      else if (k === "ArrowUp" || k === "k") setLdrop(((ldrop() ?? 0) + labels.length - 1) % labels.length);
      else if ((k === "Enter" || k === " ") && issue && labels[ldrop()!]) void toggleLabel(props.project, issue, labels[ldrop()!].id);
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
    else if (detail && k === "l") openLabels();
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
      const stops = filtersOf(d);
      setSrc((s) => stops[(stops.indexOf(s) + 1) % stops.length]);
      const now = src();
      flash(`source: ${now === "all" ? "all" : SOURCE_NAMES[now]}`);
    } else if (!detail && k === "c") toggleDone();
    else if (k === "r") syncNow(props.project);
    else if (k === "n") { setView("list"); setCreating(true); }
    else if (k === "o" && selected()) openExternal(selected()!);
    else if (k === "d") openStates();
    else if (k === "a" && selected()) sendToAgent(selected()!);
    else if (k === "s" && selectedTracked()) void toggleTimer(props.project, selectedTracked()!);
    else if (k === "y" && selected()) copySlug(selected()!);
    else return false;
    return true;
  }

  function openStates() {
    const issue = selectedTracked();
    if (!issue) return void flash("Sentry issues have no state to change");
    if (changingTo(props.project.id, issue)) return void flash(`${slugOf(state(), issue)} is still changing state`);
    setDrop(Math.max(0, dropStates().findIndex((s) => s.id === stateOf(state(), issue)?.id)));
  }

  function openLabels() {
    const issue = selectedTracked();
    if (!issue || issue.source === "local") return void flash("labels are for Plane and GitHub issues");
    if (!dropLabels().length) return void flash(`no labels in ${SOURCE_NAMES[issue.source]} yet`);
    setLdrop(0);
  }

  function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    addImages(input.files);
    input.value = "";
  }

  function addImages(files: FileList | null | undefined) {
    const issue = selected();
    if (!issue || !files) return;
    if (issue.source !== "plane") return void flash(`${SOURCE_NAMES[issue.source]} comments are text only`);
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return void flash("only images can be attached");
    for (const f of images) {
      const reader = new FileReader();
      reader.onload = () => addDraftImage(props.project.id, issueKey(issue), { name: f.name || "pasted-image.png", src: String(reader.result) });
      reader.readAsDataURL(f);
    }
  }

  async function post() {
    const issue = selectedTracked();
    if (!issue || issue.source === "local") return;
    const key = issueKey(issue);
    const draft = getDraft(props.project.id, key);
    if (issue.source === "github" && !draft.text.trim()) return void flash("GitHub comments are text only through gh");
    if (!draft.text.trim() && !draft.images.length) return;
    await postComment(props.project, issue, draft.text, draft.images);
    clearDraft(props.project.id, key);
  }

  return (
    <div class="iss" classList={{ detail: view() === "detail" }} ref={rootEl}>
      <Show
        when={state()?.connected && !editing()}
        fallback={
          <Show when={state()?.loaded} fallback={<div class="isetup"><p>Loading .dev/…</p></div>}>
            <Setup project={props.project} state={state} onClose={state()?.connected ? () => setEditing(false) : undefined} />
          </Show>
        }
      >
        {/* toolbar */}
        <div class="itools">
          <div class="seg" role="group" aria-label="Source">
            <For each={filtersOf(state())}>
              {(key) => {
                const label = key === "all" ? "All" : SOURCE_NAMES[key];
                return <button data-src={key} aria-pressed={src() === key} title={`${label} (f)`} onClick={() => setSrc(key)}>{label}</button>;
              }}
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
          <button class="ib" classList={{ spin: state()?.syncing }} title="Sync now (r)" onClick={() => syncNow(props.project)}>⟳</button>
          <button class="ib" title="New Issue (n)" onClick={() => { setView("list"); setCreating(true); }}>+</button>
          <button class="ib" title="Issue sources: Plane, GitHub, Local" onClick={() => { setDrop(null); setLdrop(null); setEditing(true); }}>⚙</button>
        </div>

        <div class="imain">
          <div class="ilist">
            <Show when={creating() ? target() : undefined}>
              {(to) => {
                const where = () => to() === "plane" ? state()?.config.plane?.project_identifier ?? "Plane" : to() === "github" ? state()?.config.github?.repo ?? "GitHub" : "Local";
                const cycle = () => { const all = sources(); setDest(all[(all.indexOf(to()) + 1) % all.length]); };
                return (
                  <div class="inew">
                    <Priority p="none" />
                    <input
                      placeholder={`New Issue title · Enter to create in ${where()}${sources().length > 1 ? ", Tab changes where" : ""}, Esc to cancel`}
                      spellcheck={false}
                      autofocus
                      onKeyDown={async (e) => {
                        const input = e.currentTarget;
                        if (e.key === "Tab" && sources().length > 1) {
                          e.preventDefault();
                          cycle();
                        } else if (e.key === "Enter" && input.value.trim()) {
                          const issue = await createIssue(props.project, input.value.trim(), to());
                          setCreating(false);
                          if (issue) openDetailById(issueKey(issue));
                        } else if (e.key === "Escape" || e.key === "Enter") {
                          setCreating(false);
                        }
                      }}
                    />
                    <Show when={sources().length > 1}>
                      <button class="idest" title="Where the New Issue goes (Tab)" onMouseDown={(e) => e.preventDefault()} onClick={cycle}>→ {SOURCE_NAMES[to()]}</button>
                    </Show>
                  </div>
                );
              }}
            </Show>
            <For each={rows()}>{(issue) => <Row
              issue={issue}
              state={state()}
              projectId={props.project.id}
              selected={sel() === issueKey(issue)}
              commentCount={commentsOf(props.project.id, issueKey(issue))?.length ?? 0}
              runningStart={(() => {
                const e = runningEntry(props.project.id);
                return e?.issue_id === issueKey(issue) ? Date.parse(e.started_at) : undefined;
              })()}
              onOpen={() => openDetailById(issueKey(issue))}
              onPill={() => { setSel(issueKey(issue)); openStates(); }}
            />}</For>
            <Show when={rows().length === 0}>
              <div class="iempty">
                {q() ? `Nothing matches “${q()}”` : `No ${done() ? "" : "open "}issues${src() === "all" ? "" : ` from ${SOURCE_NAMES[src() as UnifiedIssue["source"]]}`}.`}
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
                  onState={openStates}
                  onLabels={openLabels}
                  onOpen={() => openExternal(issue())}
                  onCopy={() => copySlug(issue())}
                  onSend={() => sendToAgent(issue())}
                  onTimer={() => { const i = selectedTracked(); if (i) void toggleTimer(props.project, i); }}
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
            <span><kbd>o</kbd> open in {SOURCE_NAMES[selected()?.source ?? "plane"]}</span>
            <span><kbd>d</kbd> state</span>
            <span><kbd>l</kbd> labels</span>
            <span><kbd>c</kbd> comment</span>
            <span><kbd>a</kbd> send to agent</span>
            <span><kbd>s</kbd> timer</span>
          </Show>
          <span class="src" title="The panel only renders this file (and local-issues.json); pi-todos and dev-hub read the same one">
            {props.project.host !== "local" ? `${props.project.host}:` : ""}.dev/issues.json
          </span>
        </div>

        <div class="islot">
          <Show when={drop() !== null ? selectedTracked() : undefined}>
            {(issue) => (
              <Dropdown anchor={anchor} onClose={() => setDrop(null)}>
                <div class="ttl">{slugOf(state(), issue())} state</div>
                <For each={["backlog", "unstarted", "started", "completed", "cancelled"]}>
                  {(group) => (
                    <Show when={dropStates().some((s) => s.group === group)}>
                      <h5>{group}</h5>
                      <For each={dropStates().filter((s) => s.group === group)}>
                        {(s) => (
                          <button
                            data-state={s.id}
                            class={dropStates().indexOf(s) === drop() ? "hi" : ""}
                            role="option"
                            onClick={() => changeState(s.id)}
                          >
                            <Pill state={s} />
                            <Show when={s.id === stateOf(state(), issue())?.id}><span class="cur">current</span></Show>
                          </button>
                        )}
                      </For>
                    </Show>
                  )}
                </For>
              </Dropdown>
            )}
          </Show>
          <Show when={ldrop() !== null ? selectedTracked() : undefined}>
            {(issue) => (
              <Dropdown anchor={labelAnchor} onClose={() => setLdrop(null)}>
                <div class="ttl">{slugOf(state(), issue())} labels</div>
                <For each={dropLabels()}>
                  {(l, k) => {
                    const on = () => issueLabels(state(), issue()).includes(l.id);
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
  projectId: string;
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
  const target = i.source === "plane" ? i.target_date : undefined;
  const late = () => !!target && !closed() && target < new Date().toISOString().slice(0, 10);
  const labels = () => issueLabels(props.state, i).map((id) => labelOf(props.state, i.source, id)).filter((l): l is PlaneLabel => !!l);
  return (
    <div class={`irow plane${props.selected ? " sel" : ""}${closed() ? " closed" : ""}`} onClick={props.onOpen}>
      <Priority p={i.source === "plane" ? i.priority : undefined} />
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
      <Pill state={stateOf(props.state, i)} busy={changingTo(props.projectId, i)} onClick={(e) => { e.stopPropagation(); props.onPill(); }} />
      {props.runningStart !== undefined
        ? <span class="irun" title="Running Entry"><i class="rec" />{formatHms(clock() - props.runningStart)}</span>
        : <span class={`idate${late() ? " late" : ""}`} title={late() ? "past its Target Date" : "Target Date"}>{target ? formatDay(target) : ""}</span>}
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
  const tracked = (): TrackedIssue | undefined => (i().source !== "sentry" ? (i() as TrackedIssue) : undefined);
  /** Plane and GitHub issues have comments; Local and Sentry ones don't. */
  const commented = () => i().source === "plane" || i().source === "github";
  const issueId = () => issueKey(i());
  const draft = () => getDraft(props.project.id, issueId());
  const comments = () => (commented() ? commentsOf(props.project.id, issueId()) ?? [] : []);
  const running = () => runningEntry(props.project.id)?.issue_id === issueKey(i());

  return (
    <>
      <div class="dhead">
        <button class="iback" title="Back to the list (Esc)" onClick={props.onBack}>‹ Issues</button>
        <span class="crumb">/ <b>{slugOf(props.state, i())}</b>{SOURCE_NAMES[i().source]}</span>
        <span class="pos">{props.position}</span>
        <button class="ib" title="Previous issue (k)" onClick={props.onPrev}>↑</button>
        <button class="ib" title="Next issue (j)" onClick={props.onNext}>↓</button>
      </div>
      <div class="dbody">
        <div class="dmain">
          <h3>{i().title}</h3>
          <Show when={tracked()} fallback={
            <div class="ichips">
              <span><span class="lvl" style={{ "--pc": LEVEL_COLORS[(i() as { level?: string }).level ?? "error"] }} />{(i() as { level?: string }).level}</span>
              <span class="pill ghost">{(i() as { sentry_status?: string }).sentry_status}</span>
            </div>
          }>
            {(p) => (
              <>
                <div class="ichips">
                  <button class="pillbtn" title="Change state (d)" aria-haspopup="listbox" onClick={props.onState}>
                    <Pill state={stateOf(props.state, p())} busy={changingTo(props.project.id, p())} />
                    <span class="caret">▾</span>
                  </button>
                  <Show when={p().source === "plane"}>
                    <span><Priority p={(p() as PlaneIssue).priority} />{(p() as PlaneIssue).priority}</span>
                  </Show>
                </div>
                <Show when={p().source !== "local"}>
                  <div class="dlabels">
                    <For each={issueLabels(props.state, p()).map((id) => labelOf(props.state, p().source, id))}>
                      {(l) => <Show when={l}>{(x) => <LabelChip label={x()} />}</Show>}
                    </For>
                    <button class="lblbtn" title="Edit labels (l)" aria-haspopup="listbox" onClick={props.onLabels}>
                      {issueLabels(props.state, p()).length ? "+ Label" : "+ Add label"}
                    </button>
                  </div>
                </Show>
              </>
            )}
          </Show>
          <p>
            {tracked()?.description
              ? tracked()!.description
              : <span class="c-m">{tracked() ? "No description." : "Stack trace and breadcrumbs are in .dev/sentry; o opens the full issue."}</span>}
          </p>
        </div>
        <div class="dside">
          <Show when={tracked()} fallback={
            <dl>
              <dt>Culprit</dt><dd>{(i() as { culprit?: string }).culprit ?? "—"}</dd>
              <dt>Events</dt><dd>{(i() as { count?: number }).count ?? 0}</dd>
              <dt>Last seen</dt><dd>{ago(i().updated_at)}</dd>
            </dl>
          }>
            {(p) => (
              <dl>
                <Show when={p().source === "plane"}>
                  <dt>Start</dt><dd>{formatDay((p() as PlaneIssue).start_date)}</dd>
                  <dt>Target</dt><dd>{formatDay((p() as PlaneIssue).target_date)}</dd>
                </Show>
                <Show when={p().source === "github"}>
                  <dt>Author</dt><dd>{(p() as GithubIssue).author || "—"}</dd>
                  <dt>Updated</dt><dd>{ago(p().updated_at)}</dd>
                </Show>
                <Show when={p().source === "local"}>
                  <dt>Created</dt><dd>{ago((p() as LocalIssue).created_at)}</dd>
                </Show>
                <dt>Time</dt><dd>{accumulatedMs(props.project.id, issueId()) ? formatHm(accumulatedMs(props.project.id, issueId())) : "—"}{running() ? " · running" : ""}</dd>
              </dl>
            )}
          </Show>
          <div class="iacts">
            <Show when={i().link}>
              <button onClick={props.onOpen}><kbd>o</kbd>Open in {SOURCE_NAMES[i().source]}</button>
            </Show>
            <button onClick={props.onSend}><kbd>a</kbd>Send to agent</button>
            <Show when={tracked()}>
              <button class={running() ? "on" : ""} onClick={props.onTimer}><kbd>s</kbd>{running() ? "Stop timer" : "Start timer"}</button>
            </Show>
            <button onClick={props.onCopy}><kbd>y</kbd>Copy {slugOf(props.state, i())}</button>
          </div>
        </div>
        <Show when={commented()}>
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
                <Show when={i().source === "plane"} fallback={<span class="grow">posts to GitHub through gh · <kbd>Ctrl</kbd><kbd>Enter</kbd> posts</span>}>
                  <button class="ib" title="Attach images" onClick={props.onAttach}>⊕</button>
                  <input class="cfile" type="file" accept="image/*" multiple hidden ref={props.fileRef} onChange={props.onFile} />
                  <span class="grow">images upload to Plane · <kbd>Ctrl</kbd><kbd>Enter</kbd> posts</span>
                </Show>
                <button class="post" disabled={!draft().text.trim() && !draft().images.length} onClick={props.onPost}>Comment</button>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </>
  );
}

// ── Sources form (no Source set up yet, or ⚙) ───────────────────────

const BLURBS: Record<Source, string> = {
  plane: "A Plane project: States, labels, comments with images.",
  github: "This repo's GitHub Issues, through gh on the project's host.",
  local: "Issues kept only in .dev/local-issues.json. No account, no sync.",
};

function Setup(props: { project: Project; state: () => DevState | undefined; onClose?: () => void }): JSX.Element {
  const cfg = () => props.state()?.config ?? {};
  const [on, setOn] = createSignal<Source[]>(sourcesOf(untrack(cfg)));
  const [ws, setWs] = createSignal(untrack(cfg).plane?.workspace_slug ?? "");
  const [pid, setPid] = createSignal(untrack(cfg).plane?.project_id ?? "");
  const [tok, setTok] = createSignal("");
  const [repo, setRepo] = createSignal(untrack(cfg).github?.repo ?? "");
  const [repoNote, setRepoNote] = createSignal("");
  const [plabel, setPlabel] = createSignal(untrack(cfg).github?.progress_label ?? DEFAULT_PROGRESS_LABEL);
  const [prefix, setPrefix] = createSignal(untrack(cfg).local?.prefix ?? "");
  const remote = () => props.project.host !== "local";
  const hostToken = () => !!props.state()?.hostToken;
  const has = (s: Source) => on().includes(s);

  const toggle = (s: Source) => {
    setOn((list) => SOURCES.filter((x) => (x === s ? !list.includes(s) : list.includes(x))));
    if (s === "github" && has("github") && !repo()) {
      setRepoNote("asking gh…");
      guessRepo(props.project)
        .then((r) => { if (!repo()) setRepo(r); setRepoNote(r ? "from gh in this folder" : ""); })
        .catch((e) => setRepoNote(`gh sees no repo here (${e}); type owner/name`));
    }
  };

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    if (!on().length) return void flash("tick at least one source");
    if (has("plane") && (!ws().trim() || !pid().trim())) return void flash("Plane needs a workspace slug and a project ID");
    if (has("plane") && !hostToken() && !tok().trim()) return void flash("paste a Plane Personal Access Token");
    if (has("github") && !/^[\w.-]+\/[\w.-]+$/.test(repo().trim())) return void flash("GitHub needs the repo as owner/name");
    if (has("local") && /[^\w.-]/.test(prefix().trim())) return void flash("a Local prefix is letters, digits, . _ or -");
    void saveSources(props.project, {
      sources: on(),
      plane: has("plane") ? { workspace_slug: ws().trim(), project_id: pid().trim(), token: tok().trim() || undefined } : undefined,
      github: has("github") ? { repo: repo().trim(), progress_label: plabel().trim() } : undefined,
      local: has("local") ? { prefix: prefix().trim() } : undefined,
    }).then(() => props.onClose?.());
  };

  return (
    <div class="isetup">
      <form autocomplete="off" class="isrc" onSubmit={submit}>
        <b>Issue sources for {props.project.name}</b>
        <p>
          Tick any. The panel lists them together, with pulled Sentry issues beside them. Everything lands in this
          project's <code>.dev/</code>{remote() ? <> on <code>{props.project.host}</code></> : ""}, so pi-todos and dev-hub see the same thing.
        </p>
        <For each={SOURCES}>
          {(s) => (
            <fieldset classList={{ on: has(s) }}>
              <label class="ihead">
                <input type="checkbox" checked={has(s)} onChange={() => toggle(s)} />
                <b>{SOURCE_NAMES[s]}</b>
                <span>{BLURBS[s]}</span>
              </label>
              <Show when={has(s) && s === "plane"}>
                <label>Workspace slug<input name="ws" spellcheck={false} value={ws()} onInput={(e) => setWs(e.currentTarget.value)} /></label>
                <label>Project ID<input name="pid" placeholder="dc6c5b3b-7f09-4ebf-…" spellcheck={false} value={pid()} onInput={(e) => setPid(e.currentTarget.value)} /></label>
                <Show when={hostToken()} fallback={
                  <label>Personal Access Token<input name="tok" type="password" placeholder="plane_api_…" value={tok()} onInput={(e) => setTok(e.currentTarget.value)} /></label>
                }>
                  <p class="ok">✓ Plane token found in <code>~/.pi/agent/secrets/plane.json</code>{remote() ? ` on ${props.project.host}` : ""}</p>
                </Show>
              </Show>
              <Show when={has(s) && s === "github"}>
                <label>Repository<input name="repo" placeholder="owner/name" spellcheck={false} value={repo()} onInput={(e) => setRepo(e.currentTarget.value)} /></label>
                <Show when={repoNote()}><p>{repoNote()}</p></Show>
                <label>"In Progress" label<input name="plabel" spellcheck={false} value={plabel()} onInput={(e) => setPlabel(e.currentTarget.value)} /></label>
                <p>GitHub has only open and closed. An open issue with this label is In Progress; it's created in the repo the first time it's needed. gh uses {remote() ? `${props.project.host}'s` : "your"} login, so tri-code stores no GitHub token. Issues show as <code>#231</code>.</p>
              </Show>
              <Show when={has(s) && s === "local"}>
                <label>Prefix<input name="prefix" placeholder="none" spellcheck={false} value={prefix()} onInput={(e) => setPrefix(e.currentTarget.value)} /></label>
                <p>New issues read as <code>{prefix().trim() ? `${prefix().trim()}-1` : "1"}</code>. Leave it empty for plain numbers.</p>
              </Show>
            </fieldset>
          )}
        </For>
        <div class="srow">
          <button class="go">Save</button>
          <Show when={props.onClose}><button type="button" class="cancel" onClick={() => props.onClose?.()}>Cancel</button></Show>
        </div>
        <div class="files">
          writes {props.project.path}/.dev/config.json
          {has("plane") && !hostToken() ? <><br />writes ~/.pi/agent/secrets/plane.json</> : ""}
          {remote() ? " (over ssh)" : ""}
          {has("local") ? <><br />Local issues go in .dev/local-issues.json</> : ""}
          {has("plane") || has("github") ? <><br />then syncs every 5 min into .dev/issues.json</> : ""}
        </div>
      </form>
    </div>
  );
}
