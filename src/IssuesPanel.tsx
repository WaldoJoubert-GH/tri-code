// The issues window: a view of the project's `.dev/` folder (Plane, GitHub,
// Local and Sentry issues),
// the same files pi-todos and dev-hub read and write. Plain HTML, not a
// terminal, so plain keys drive it while the window is focused.

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { type Project, type Tab, focusTab, setTabTimeline, space, tabName } from "./state";
import { agentTarget } from "./agents";
import {
  ACTIVE_GROUPS, DEFAULT_PROGRESS_LABEL, LEVEL_COLORS, PRIORITY_COLORS, SOURCES, SOURCE_NAMES, type DevState,
  type GithubIssue, type NewIssue, type PlaneIssue, type PlaneLabel, type PlaneState, type SortOrder, type Source, type SourceFilter,
  type StatusFilter, type TrackedIssue, type UnifiedIssue,
  accumulatedMs, addDraftImage, ago, assigneesOf, avatarColor, changingTo, clearDraft, clock, commentsOf, createIssue, dev,
  draftOf, ensureComments, fgFor, filtersOf, formatDay, formatHm, formatHms, getDraft, guessRepo, initials, isActive,
  issueKey, issueLabels, labelOf, labelsFor, loadDev, membersFor, pendingIssue, postComment, priorityRank, removeDraftImage,
  runningEntry, saveSources, searchIssues, setDraftText, setIssueDates, setIssueState, setPendingIssue, shownIssues, slugOf, sourcesOf,
  statesFor, statusStopsOf, stateOf, syncDev, syncNow, toggleLabel, toggleTimer, updateIssue,
} from "./issues";
import { openUrlInProject } from "./browsers";
import { sendText } from "./terms";
import { Icon } from "./lucide";
import { flash } from "./ui";
import { type Grip, type Span, daysLate, dragged, isoOf, rangeOf, spanOf, todayDay } from "./timeline";

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
  const [status, setStatus] = createSignal<StatusFilter>("open");
  const [sort, setSort] = createSignal<SortOrder>("newest");
  const [q, setQ] = createSignal("");
  /** The open filter menu, if any: Source or Status. */
  const [fmenu, setFmenu] = createSignal<"source" | "status" | null>(null);
  /** The search dropdown: under the list's search box, or under the detail's crumb with its own field. */
  const [jump, setJump] = createSignal<"list" | "detail" | null>(null);
  /** The detail's jump field; the list's query is `q`. */
  const [jq, setJq] = createSignal("");
  /** The highlighted match in the search dropdown. */
  const [hit, setHit] = createSignal(0);
  const [creating, setCreating] = createSignal(false);
  /** The issue the Edit modal is open on. */
  const [editingIssue, setEditingIssue] = createSignal<TrackedIssue | null>(null);
  /** The Sources form is open over a connected panel (the ⚙ button). */
  const [editing, setEditing] = createSignal(false);
  const [drop, setDrop] = createSignal<number | null>(null);
  const [ldrop, setLdrop] = createSignal<number | null>(null);
  const [light, setLight] = createSignal<{ c: number; i: number } | null>(null);
  const [over, setOver] = createSignal(false);
  const [zoom, setZoom] = createSignal<Zoom>("week");
  /** The list shows as the Timeline: kept on the window, so it reopens the way it was left. */
  const timeline = () => !!props.tab.timeline;
  const setTimeline = (on: boolean) => setTabTimeline(home().id, props.tab.id, on);
  let tl: TimelineApi | undefined;

  let rootEl!: HTMLDivElement;
  let searchEl: HTMLInputElement | undefined;
  let fileEl: HTMLInputElement | undefined;
  /** The first time this panel gets focus, sync once. */
  let syncedOnce = false;

  /** The project this window is in: a Worktree's panel shows its repo's issues (`project`) but types into its own agents. */
  const home = () => props.home ?? props.project;
  const state = (): DevState | undefined => dev[props.project.id];
  const rows = createMemo(() => shownIssues(state(), { src: src(), status: status(), sort: sort(), q: q() }));
  /** The search dropdown's matches, for whichever field it hangs off. */
  const matches = createMemo(() => searchIssues(state(), view() === "detail" ? jq() : q()));
  const selected = createMemo(() => (state()?.issues ?? []).find((i) => issueKey(i) === sel()));
  const selectedTracked = (): TrackedIssue | undefined => {
    const i = selected();
    return i && i.source !== "sentry" ? i : undefined;
  };
  /** The selected issue's States and Labels, for the two dropdowns. */
  const dropStates = () => { const i = selectedTracked(); return i ? statesFor(state(), i.source) : []; };
  const dropLabels = () => { const i = selectedTracked(); return i ? labelsFor(state(), i.source) : []; };
  const sources = () => sourcesOf(state()?.config);
  const statusLabel = () => statusStopsOf(state()).find((s) => s.value === status())?.label ?? "Open";
  const anchor = () => (drop() !== null ? rootEl.querySelector(view() === "detail" ? ".pillbtn" : ".irow.sel .pill, .tlrow.sel .pill") : null);
  const labelAnchor = () => (ldrop() !== null ? rootEl.querySelector(".lblbtn") : null);

  // Keep the list cursor on a visible row; a drilled-in issue stays open.
  createEffect(() => {
    const list = rows();
    if (view() !== "detail" && !list.some((i) => issueKey(i) === sel())) setSel(list[0] ? issueKey(list[0]) : null);
  });

  // A sync in pi-todos or dev-hub should show up: re-read `.dev/` when focused.
  createEffect(on(() => props.focused, (f) => {
    if (!f) { setDrop(null); setLdrop(null); setFmenu(null); setJump(null); }
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
    setJump(null);
    setFmenu(null);
    const issue = (state()?.issues ?? []).find((i) => issueKey(i) === issueId);
    if (issue) ensureComments(props.project, issue).catch(() => {});
  }

  function openJumpDetail() {
    setJq("");
    setHit(0);
    setJump("detail");
  }

  /** Arrows move the highlight, Enter opens it, Escape closes the dropdown, then clears the search. */
  function jumpKey(e: KeyboardEvent) {
    const list = matches();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!jump()) setJump(view() === "detail" ? "detail" : "list");
      setHit(Math.max(0, Math.min(list.length - 1, hit() + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = list[hit()] ?? list[0];
      if (pick) { setJump(null); openDetailById(issueKey(pick)); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (jump()) setJump(null);
      else if (view() === "list" && q()) { setQ(""); if (searchEl) searchEl.value = ""; }
      else if (view() === "list") searchEl?.blur();
    }
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

  function toggleSort() {
    const next: SortOrder = sort() === "newest" ? "oldest" : "newest";
    setSort(next);
    flash(`sorted by created date, ${next} first`);
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
    // the New Issue modal and the search dropdown take their own keys
    if (!d?.connected || editing() || creating() || editingIssue() || jump()) return false;
    const k = e.key;

    if (fmenu()) {
      if (k === "Escape" || k === "f" || k === "s") setFmenu(null);
      return true;
    }
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
    else if (detail && k === "e") openEdit();
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
    } else if (k === "/") {
      if (detail) openJumpDetail();
      else { setView("list"); searchEl?.focus(); }
    }
    else if (!detail && k === "f") setFmenu("source");
    else if (!detail && k === "s") setFmenu("status");
    else if (!detail && k === "o") toggleSort();
    else if (!detail && k === "v") setTimeline(!timeline());
    else if (!detail && timeline() && k === "t") tl?.today();
    else if (!detail && timeline() && (k === "-" || k === "=")) setZoom(zoomBy(zoom(), k === "-" ? 1 : -1));
    else if (k === "r") syncNow(props.project);
    else if (k === "n") { setView("list"); setCreating(true); }
    else if (detail && k === "o" && selected()) openExternal(selected()!);
    else if (k === "d") openStates();
    else if (k === "a" && selected()) sendToAgent(selected()!);
    else if (k === "s" && detail && selectedTracked()) void toggleTimer(props.project, selectedTracked()!);
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

  function openEdit() {
    const issue = selectedTracked();
    if (!issue) return void flash("Sentry issues are edited in Sentry");
    setDrop(null);
    setLdrop(null);
    setEditingIssue(issue);
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

  const sourceCount = (key: SourceFilter) => (state()?.issues ?? []).filter((i) => key === "all" || i.source === key).length;

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
        {/* toolbar: one search (a dropdown over the issues), two filters, sort, sync, New */}
        <div class="itools">
          <div class="seg" role="group" aria-label="Layout">
            <button aria-pressed={!timeline()} title="List (v)" onClick={() => setTimeline(false)}><Icon name="list" size={13} /></button>
            <button aria-pressed={timeline()} title="Timeline (v)" onClick={() => setTimeline(true)}><Icon name="chart-gantt" size={13} /></button>
          </div>
          <div class="sbox">
            <Icon name="search" size={13} />
            <input
              class="isearch" ref={searchEl} placeholder="Search issues…" spellcheck={false} autocomplete="off" aria-label="Search issues"
              value={q()}
              onFocus={() => { setHit(0); setJump("list"); }}
              onInput={(e) => { setQ(e.currentTarget.value); setHit(0); setJump("list"); }}
              onKeyDown={jumpKey}
            />
          </div>
          <button class="fbtn" data-menu="source" aria-haspopup="listbox" title="Filter by source (f)" onClick={() => setFmenu(fmenu() === "source" ? null : "source")}>
            <Icon name="database" size={13} />
            <span>{src() === "all" ? "All" : SOURCE_NAMES[src() as UnifiedIssue["source"]]}</span>
            <Icon name="chevron-down" size={12} />
          </button>
          <button class="fbtn" data-menu="status" aria-haspopup="listbox" title="Filter by status (s)" onClick={() => setFmenu(fmenu() === "status" ? null : "status")}>
            <Icon name="list-filter" size={13} />
            <span>{statusLabel()}</span>
            <Icon name="chevron-down" size={12} />
          </button>
          <button class="ib" title={`Created date: ${sort() === "newest" ? "newest" : "oldest"} first (o)`} onClick={toggleSort}>
            <Icon name={sort() === "newest" ? "arrow-down-wide-narrow" : "arrow-up-wide-narrow"} />
          </button>
          <button class="ib" classList={{ spin: state()?.syncing }} title="Sync now (r)" onClick={() => syncNow(props.project)}>
            <Icon name="refresh-cw" />
          </button>
          <button class="nbtn" title="New Issue (n)" onClick={() => { setView("list"); setCreating(true); }}>
            <Icon name="plus" size={13} />New
          </button>
          <button class="ib" title="Issue sources: Plane, GitHub, Local" onClick={() => { setDrop(null); setLdrop(null); setEditing(true); }}>
            <Icon name="settings" />
          </button>
        </div>

        <div class="imain">
          <Show when={timeline()}>
            <Timeline
              rows={rows()}
              state={state()}
              project={props.project}
              sel={sel()}
              zoom={zoom()}
              onZoom={setZoom}
              onSelect={setSel}
              onOpen={openDetailById}
              onPill={(key) => { setSel(key); openStates(); }}
              api={(a) => (tl = a)}
            />
          </Show>
          <div class="ilist" classList={{ off: timeline() }}>
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
                {q() ? `Nothing matches “${q()}”` : "Nothing matches these filters."}
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
                  onJump={openJumpDetail}
                  onPrev={() => step(-1)}
                  onNext={() => step(1)}
                  onState={openStates}
                  onLabels={openLabels}
                  onEdit={openEdit}
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
          <Show when={view() === "detail"} fallback={<Show when={timeline()} fallback={<>
            <span><kbd>j</kbd><kbd>k</kbd> move</span>
            <span><kbd>Enter</kbd> open</span>
            <span><kbd>/</kbd> search</span>
            <span><kbd>s</kbd> status</span>
            <span><kbd>f</kbd> source</span>
            <span><kbd>o</kbd> sort</span>
            <span><kbd>n</kbd> new</span>
            <span><kbd>r</kbd> sync</span>
            <span><kbd>v</kbd> timeline</span>
          </>}>
            <span><kbd>j</kbd><kbd>k</kbd> move</span>
            <span><kbd>Enter</kbd> open</span>
            <span>drag a Plane bar to set its dates</span>
            <span><kbd>t</kbd> today</span>
            <span><kbd>-</kbd><kbd>=</kbd> zoom</span>
            <span><kbd>v</kbd> list</span>
          </Show>}>
            <span><kbd>Esc</kbd> back</span>
            <span><kbd>j</kbd><kbd>k</kbd> next / prev</span>
            <span><kbd>/</kbd> jump to issue</span>
            <span><kbd>o</kbd> open in {SOURCE_NAMES[selected()?.source ?? "plane"]}</span>
            <span><kbd>e</kbd> edit</span>
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
          {/* Source and Status: filters, under their buttons */}
          <Show when={fmenu() === "source"}>
            <Dropdown anchor={() => rootEl.querySelector("[data-menu='source']")} onClose={() => setFmenu(null)}>
              <div class="ttl">Source</div>
              <For each={filtersOf(state())}>
                {(key) => (
                  <button class={src() === key ? "hi" : ""} role="option" aria-selected={src() === key} onClick={() => { setSrc(key); setFmenu(null); }}>
                    <span>{key === "all" ? "All" : SOURCE_NAMES[key]}</span>
                    <span class="cur">{sourceCount(key)}{src() === key ? <Icon name="check" size={13} /> : ""}</span>
                  </button>
                )}
              </For>
            </Dropdown>
          </Show>
          <Show when={fmenu() === "status"}>
            <Dropdown anchor={() => rootEl.querySelector("[data-menu='status']")} onClose={() => setFmenu(null)}>
              <div class="ttl">Status</div>
              <For each={statusStopsOf(state())}>
                {(stop) => (
                  <button class={status() === stop.value ? "hi" : ""} role="option" aria-selected={status() === stop.value} onClick={() => { setStatus(stop.value); setFmenu(null); }}>
                    <span>{stop.label}</span>
                    <span class="cur">
                      {shownIssues(state(), { src: "all", status: stop.value, sort: "newest", q: "" }).length}
                      {status() === stop.value ? <Icon name="check" size={13} /> : ""}
                    </span>
                  </button>
                )}
              </For>
            </Dropdown>
          </Show>

          {/* the search dropdown: under the list's search box, or under the detail's crumb */}
          <Show when={jump()}>
            {(mode) => (
              <Dropdown anchor={() => rootEl.querySelector(mode() === "detail" ? ".crumbbtn" : ".sbox")} onClose={() => setJump(null)}>
                <Show when={mode() === "detail"}>
                  <div class="jfield">
                    <Icon name="search" size={13} />
                    <input
                      ref={(el) => requestAnimationFrame(() => el.focus())}
                      placeholder="Jump to issue…"
                      spellcheck={false}
                      autocomplete="off"
                      value={jq()}
                      onInput={(e) => { setJq(e.currentTarget.value); setHit(0); }}
                      onKeyDown={jumpKey}
                    />
                  </div>
                </Show>
                <div class="jlist" role="listbox">
                  <For each={matches()} fallback={<div class="jempty">No issue matches “{mode() === "detail" ? jq() : q()}”</div>}>
                    {(i, k) => (
                      <button
                        class={`jitem${k() === hit() ? " hi" : ""}`}
                        role="option"
                        aria-selected={k() === hit()}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setJump(null); openDetailById(issueKey(i)); }}
                      >
                        <span class="sid">{slugOf(state(), i)}</span>
                        <span class="jt">{i.title}</span>
                        <Show when={i.source !== "sentry"}><Pill state={stateOf(state(), i as TrackedIssue)} /></Show>
                      </button>
                    )}
                  </For>
                </div>
                <div class="jfoot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
              </Dropdown>
            )}
          </Show>

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
                        <span class="cur">{on() ? <Icon name="check" size={13} /> : ""}</span>
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
                        <Show when={lightImages().length > 1}><button title="Previous image (←)" onClick={() => lightStep(-1)}><Icon name="chevron-left" size={14} /></button></Show>
                        <span>
                          {img().img.name} · {img().author} {ago(img().at)}
                          {lightImages().length > 1 ? ` · ${lightImages().findIndex((x) => x.c === img().c && x.i === img().i) + 1} / ${lightImages().length}` : ""}
                        </span>
                        <Show when={lightImages().length > 1}><button title="Next image (→)" onClick={() => lightStep(1)}><Icon name="chevron-right" size={14} /></button></Show>
                        <span><kbd>Esc</kbd> close</span>
                      </div>
                    </div>
                  )}
                </Show>
              );
            })()}
          </Show>
        </div>

        {/* New Issue: a modal over the panel */}
        <Show when={creating()}>
          <IssueModal
            project={props.project}
            state={state()}
            sources={sources()}
            onClose={() => setCreating(false)}
            onDone={(issue) => { setCreating(false); openDetailById(issueKey(issue)); }}
          />
        </Show>
        <Show when={editingIssue()}>
          {(issue) => (
            <IssueModal
              project={props.project}
              state={state()}
              sources={[issue().source]}
              editing={issue()}
              onClose={() => setEditingIssue(null)}
              onDone={() => setEditingIssue(null)}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

// ── New Issue / Edit modal ──────────────────────────────────────────

/** Title, description, tags and assignees for a new issue, or for `editing` (whose Source is fixed).
 *  Tags are Plane or GitHub labels; local issues have neither tags nor assignees, so those fields
 *  say so instead of offering nothing. */
function IssueModal(props: {
  project: Project;
  state: DevState | undefined;
  sources: Source[];
  editing?: TrackedIssue;
  onClose: () => void;
  onDone: (issue: TrackedIssue) => void;
}): JSX.Element {
  const start = untrack(() => (props.editing ? draftOf(props.state, props.editing) : undefined));
  const [dest, setDest] = createSignal<Source>(untrack(() => props.editing?.source ?? props.sources[0] ?? "local"));
  const [title, setTitle] = createSignal(start?.title ?? "");
  const [desc, setDesc] = createSignal(start?.description ?? "");
  const [tags, setTags] = createSignal<string[]>(start?.labels ?? []);
  const [people, setPeople] = createSignal<string[]>(start?.assignees ?? []);
  const [busy, setBusy] = createSignal(false);
  let titleEl: HTMLInputElement | undefined;

  onMount(() => requestAnimationFrame(() => titleEl?.focus()));

  const labelPool = () => labelsFor(props.state, dest());
  const memberPool = () => membersFor(props.state, dest());
  const toggleIn = (list: () => string[], set: (v: string[]) => void, id: string) =>
    set(list().includes(id) ? list().filter((x) => x !== id) : [...list(), id]);

  /** A different Source has different labels and people, so the picks start over. */
  function choose(s: Source) {
    if (s === dest()) return;
    setDest(s);
    setTags([]);
    setPeople([]);
  }

  async function submit() {
    if (!title().trim() || busy()) return;
    setBusy(true);
    const draft: NewIssue = { title: title(), description: desc(), labels: tags(), assignees: people() };
    if (props.editing) {
      const ok = await updateIssue(props.project, props.editing, draft);
      setBusy(false);
      if (ok) props.onDone(props.editing);
      return;
    }
    const issue = await createIssue(props.project, draft, dest());
    setBusy(false);
    if (issue) props.onDone(issue);
  }

  return (
    <div class="mback" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <form
        class="modal"
        role="dialog"
        aria-label={props.editing ? `Edit ${slugOf(props.state, props.editing)}` : "New issue"}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onClose(); }
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
        }}
      >
        <div class="mhead">
          <span>{props.editing ? `Edit ${slugOf(props.state, props.editing)}` : "New issue"}</span>
          <span class="grow" />
          <button type="button" class="ib" title="Close (Esc)" onClick={props.onClose}><Icon name="x" /></button>
        </div>
        <div class="mbody">
          <Show when={!props.editing && props.sources.length > 1}>
            <div class="fld">
              <span>Source</span>
              <div class="seg" role="group" aria-label="Source">
                <For each={props.sources}>
                  {(s) => <button type="button" aria-pressed={dest() === s} onClick={() => choose(s)}>{SOURCE_NAMES[s]}</button>}
                </For>
              </div>
            </div>
          </Show>
          <label class="fld">
            <span>Title</span>
            <input class="finput" ref={titleEl} placeholder="What needs doing?" spellcheck={false} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          </label>
          <label class="fld">
            <span>Description</span>
            <textarea class="finput" rows={4} placeholder="Context, steps to reproduce, what done looks like…" value={desc()} onInput={(e) => setDesc(e.currentTarget.value)} />
          </label>
          <div class="fld">
            <span>Tags</span>
            <Show when={dest() !== "local"} fallback={<div class="fnote">Local issues have no tags.</div>}>
              <Show when={labelPool().length} fallback={<div class="fnote">No labels in {SOURCE_NAMES[dest()]} yet.</div>}>
                <div class="chips">
                  <For each={labelPool()}>
                    {(l) => (
                      <button type="button" class="tchip" aria-pressed={tags().includes(l.id)} onClick={() => toggleIn(tags, setTags, l.id)}>
                        <LabelChip label={l} />
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
          <div class="fld">
            <span>Assignees</span>
            <Show when={dest() !== "local"} fallback={<div class="fnote">Local issues have no assignees.</div>}>
              <Show when={memberPool().length} fallback={<div class="fnote">No members to assign yet. It stays unassigned.</div>}>
                <div class="chips">
                  <For each={memberPool()}>
                    {(m) => (
                      <button type="button" class="pchip" aria-pressed={people().includes(m.id)} onClick={() => toggleIn(people, setPeople, m.id)}>
                        <span class="av sm" style={{ "--avc": avatarColor(m.name) }}>{initials(m.name)}</span>{m.name}
                      </button>
                    )}
                  </For>
                </div>
                <div class="fnote">None selected means unassigned.</div>
              </Show>
            </Show>
          </div>
        </div>
        <div class="mfoot">
          <span class="grow"><kbd>Ctrl</kbd><kbd>Enter</kbd> {props.editing ? "save" : "create"} · <kbd>Esc</kbd> cancel</span>
          <button type="button" class="btn" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="btn primary" disabled={!title().trim() || busy()}>{props.editing ? "Save" : "Create issue"}</button>
        </div>
      </form>
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
  const people = () => assigneesOf(props.state, i);
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
      <span class="rmeta">
        {/* assignees: avatars, or a dim icon when nobody is on it; local issues have no one to assign */}
        <Show when={i.source !== "local"}>
          <Show when={people().length} fallback={<span class="unasg" title="Unassigned"><Icon name="user-round" size={13} /></span>}>
            <span class="avs" title={people().map((m) => m.name).join(", ")}>
              <For each={people().slice(0, 3)}>{(m) => <span class="av sm" style={{ "--avc": avatarColor(m.name) }}>{initials(m.name)}</span>}</For>
            </span>
          </Show>
        </Show>
        <Show when={props.runningStart !== undefined}
          fallback={<span class={`idate${late() ? " late" : ""}`} title={late() ? "past its Target Date" : "Target Date"}>{target ? formatDay(target) : ""}</span>}>
          <span class="irun" title="Running Entry"><i class="rec" />{formatHms(clock() - (props.runningStart ?? 0))}</span>
        </Show>
      </span>
    </div>
  );
}

// ── timeline ────────────────────────────────────────────────────────

type Zoom = "day" | "week" | "month";
const ZOOMS: Zoom[] = ["day", "week", "month"];
/** Pixels per day at each zoom. */
const PPD: Record<Zoom, number> = { day: 28, week: 14, month: 5 };
const zoomBy = (z: Zoom, n: number): Zoom => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + n))];
type TimelineApi = { today: () => void };

const DAY_MS = 86_400_000;
const dateAt = (day: number) => new Date(day * DAY_MS);
const shortDay = (day: number) => dateAt(day).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** The issue list as a Gantt chart: the rows on the left, a bar per issue on the right (design/issues-gantt.html, variant A). */
function Timeline(props: {
  rows: UnifiedIssue[];
  state: DevState | undefined;
  project: Project;
  sel: string | null;
  zoom: Zoom;
  onZoom: (z: Zoom) => void;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  onPill: (key: string) => void;
  api: (a: TimelineApi) => void;
}): JSX.Element {
  let scrollEl!: HTMLDivElement;
  const today = todayDay();
  const ppd = () => PPD[props.zoom];
  const spans = createMemo(() => new Map(props.rows.map((i) => [issueKey(i), spanOf(props.state, i, today)])));
  const range = createMemo(() => rangeOf([...spans().values()], today));
  const x = (day: number) => (day - range().from) * ppd();
  /** A bar being dragged, and the bars whose new dates are on their way to Plane. */
  const [drag, setDrag] = createSignal<{ key: string; grip: Grip; x0: number; span: Span; dd: number } | null>(null);
  const [sending, setSending] = createSignal<Record<string, { start: number; end: number }>>({});
  const shown = (key: string): { start: number; end: number; startSet: boolean; endSet: boolean } | null => {
    const s = spans().get(key);
    if (!s) return null;
    const d = drag();
    if (d?.key === key && d.dd) return { ...dragged(d.span, d.grip, d.dd), startSet: true, endSet: true };
    const p = sending()[key];
    return p ? { ...p, startSet: true, endSet: true } : s;
  };

  const months = createMemo(() => {
    const { from, days } = range();
    const out: { label: string; width: number }[] = [];
    let start = 0;
    for (let n = 1; n <= days; n++) {
      if (n === days || dateAt(from + n).getUTCDate() === 1) {
        out.push({ label: dateAt(from + start).toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" }), width: (n - start) * ppd() });
        start = n;
      }
    }
    return out;
  });
  /** The second header row: days at Day zoom, else weeks. */
  const units = createMemo(() => {
    const { from, days } = range();
    const out: { label: string; width: number; now: boolean; weekend?: boolean }[] = [];
    if (props.zoom === "day") {
      for (let n = from; n < from + days; n++) {
        const wd = dateAt(n).getUTCDay();
        out.push({ label: String(dateAt(n).getUTCDate()), width: ppd(), now: n === today, weekend: wd === 0 || wd === 6 });
      }
    } else {
      for (let n = from; n < from + days; n += 7) {
        out.push({ label: props.zoom === "week" ? shortDay(n) : String(dateAt(n).getUTCDate()), width: 7 * ppd(), now: today >= n && today < n + 7 });
      }
    }
    return out;
  });

  const leftWidth = () => scrollEl?.querySelector<HTMLElement>(".tlcorner")?.offsetWidth ?? 0;
  const scrollToDay = (day: number, smooth: boolean) =>
    scrollEl.scrollTo({ left: Math.max(0, x(day) - (scrollEl.clientWidth - leftWidth()) * 0.35), behavior: smooth ? "smooth" : "auto" });
  props.api({ today: () => scrollToDay(today, true) });
  onMount(() => scrollToDay(today, false));

  // Zooming keeps the day in the middle where it was.
  createEffect(on(() => props.zoom, (_, prev) => {
    if (!prev) return;
    const mid = (scrollEl.scrollLeft + (scrollEl.clientWidth - leftWidth()) / 2) / PPD[prev];
    scrollEl.scrollLeft = mid * ppd() - (scrollEl.clientWidth - leftWidth()) / 2;
  }, { defer: true }));

  // Keep the selected row in view (vertically; the bar's day is left where it is).
  createEffect(on(() => props.sel, (key) => {
    const row = key ? scrollEl.querySelector<HTMLElement>(`.tlrow[data-key="${CSS.escape(key)}"]`) : null;
    if (!row) return;
    const head = scrollEl.querySelector<HTMLElement>(".tlhead")?.offsetHeight ?? 0;
    if (row.offsetTop - head < scrollEl.scrollTop) scrollEl.scrollTop = row.offsetTop - head;
    else if (row.offsetTop + row.offsetHeight > scrollEl.scrollTop + scrollEl.clientHeight) scrollEl.scrollTop = row.offsetTop + row.offsetHeight - scrollEl.clientHeight;
  }, { defer: true }));

  function grab(e: PointerEvent, issue: UnifiedIssue) {
    if (e.button !== 0) return;
    const key = issueKey(issue);
    props.onSelect(key);
    const span = spans().get(key);
    if (!span) return;
    if (issue.source !== "plane") return void flash(`${slugOf(props.state, issue)}: ${SOURCE_NAMES[issue.source]} issues have no dates to set`);
    if (sending()[key]) return;
    e.preventDefault();
    const grip = ((e.target as HTMLElement).dataset.grip as Grip | undefined) ?? "move";
    setDrag({ key, grip, x0: e.clientX, span, dd: 0 });
    document.body.classList.add(grip === "move" ? "tl-moving" : "tl-sizing");
    const move = (ev: PointerEvent) => setDrag((d) => (d ? { ...d, dd: Math.round((ev.clientX - d.x0) / ppd()) } : d));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("tl-moving", "tl-sizing");
      const d = drag();
      setDrag(null);
      if (!d?.dd) return;
      const next = dragged(d.span, d.grip, d.dd);
      setSending((s) => ({ ...s, [key]: next }));
      void setIssueDates(props.project, issue as PlaneIssue, isoOf(next.start), isoOf(next.end))
        .finally(() => setSending((s) => { const { [key]: _, ...rest } = s; return rest; }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function barTitle(issue: UnifiedIssue, s: { start: number; end: number; startSet: boolean; endSet: boolean }): string {
    const dates = `${slugOf(props.state, issue)} · ${shortDay(s.start)} → ${shortDay(s.end)} · ${s.end - s.start + 1}d`;
    if (issue.source !== "plane") return `${dates}\nopened → ${isActive(props.state, issue) ? "today" : "closed"}; ${SOURCE_NAMES[issue.source]} issues have no dates to set`;
    const missing = [!s.startSet && "Start Date", !s.endSet && "Target Date"].filter(Boolean).join(" or ");
    return missing ? `${dates}\nno ${missing}: drag to set one` : dates;
  }

  return (
    <div class="itl" ref={scrollEl} style={{ "--ppd": ppd() }}>
      <div class="tlin" style={{ width: `calc(var(--tlw) + ${range().days * ppd()}px)` }}>
        <div class="tlhead">
          <div class="tlcorner">
            <span>{props.rows.length} issues</span>
            <div class="seg" role="group" aria-label="Zoom">
              <For each={ZOOMS}>{(z) => <button aria-pressed={props.zoom === z} title={`${z[0].toUpperCase()}${z.slice(1)} (- / =)`} onClick={() => props.onZoom(z)}>{z[0].toUpperCase()}</button>}</For>
            </div>
          </div>
          <div class="tlscale" style={{ width: `${range().days * ppd()}px` }}>
            <div class="tlmonths"><For each={months()}>{(m) => <span style={{ width: `${m.width}px` }}><b>{m.label}</b></span>}</For></div>
            <div class="tlunits" classList={{ days: props.zoom === "day" }}>
              <For each={units()}>{(u) => <span classList={{ now: u.now, we: !!u.weekend }} style={{ width: `${u.width}px` }}>{u.label}</span>}</For>
            </div>
          </div>
        </div>
        <For each={props.rows}>{(issue) => {
          const key = issueKey(issue);
          const s = () => shown(key);
          const closed = () => !isActive(props.state, issue);
          const late = () => daysLate(props.state, issue, today);
          const color = () => (issue.source === "sentry" ? undefined : stateOf(props.state, issue)?.color) ?? "#888888";
          /** The title goes inside a bar wide enough for a few letters; the left column always has it. */
          const inside = () => { const b = s(); return !!b && (b.end - b.start + 1) * ppd() >= 48; };
          return (
            <div class="tlrow" classList={{ sel: props.sel === key }} data-key={key} onClick={() => props.onSelect(key)} onDblClick={() => props.onOpen(key)}>
              <div class="tlleft">
                <Show when={issue.source === "sentry"} fallback={<Priority p={issue.source === "plane" ? issue.priority : undefined} />}>
                  <span class="lvl" style={{ "--pc": LEVEL_COLORS[(issue as { level?: string }).level ?? "error"] ?? LEVEL_COLORS.error }} />
                </Show>
                <span class="sid">{slugOf(props.state, issue)}</span>
                <span class="tt" classList={{ closed: closed() }}>{issue.title}</span>
                <Show when={issue.source !== "sentry"}>
                  <Pill state={stateOf(props.state, issue as TrackedIssue)} busy={changingTo(props.project.id, issue as TrackedIssue)}
                    onClick={(e) => { e.stopPropagation(); props.onPill(key); }} />
                </Show>
              </div>
              <div class="tltrack">
                <Show when={s()}>
                  {(b) => <>
                    <div
                      class="tlbar"
                      classList={{ fs: !b().startSet, fe: !b().endSet, locked: issue.source !== "plane", closed: closed(), busy: !!sending()[key] }}
                      style={{ left: `${x(b().start)}px`, width: `${(b().end - b().start + 1) * ppd()}px`, "--sc": color(), "--fc": fgFor(color()) }}
                      title={barTitle(issue, b())}
                      onPointerDown={(e) => grab(e, issue)}
                    >
                      <i class="grip" data-grip="start" />
                      <span>{inside() ? issue.title : ""}</span>
                      <i class="grip" data-grip="end" />
                    </div>
                    {/* overdue: a hatched tail from the Target Date to today, so a long-late bar still shows near today */}
                    <Show when={late() && !drag()}>
                      <span class="tlover" style={{ left: `${x(b().end + 1)}px`, width: `${(today - b().end) * ppd()}px` }} />
                      <span class="tlnote late" style={{ left: `${x(Math.max(b().end, today) + 1) + 6}px` }}>{late()}d late</span>
                    </Show>
                  </>}
                </Show>
              </div>
            </div>
          );
        }}</For>
        <div class="tltoday" style={{ left: `calc(var(--tlw) + ${x(today) + ppd() / 2}px)` }} />
        <Show when={props.rows.length === 0}><div class="iempty">Nothing matches these filters.</div></Show>
      </div>
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
  onJump: () => void;
  onPrev: () => void;
  onNext: () => void;
  onState: () => void;
  onLabels: () => void;
  onEdit: () => void;
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
        <button class="iback" title="Back to the list (Esc)" onClick={props.onBack}><Icon name="chevron-left" size={14} />Issues</button>
        <button class="crumbbtn" title="Jump to another issue (/)" aria-haspopup="listbox" onClick={props.onJump}>
          <b>{slugOf(props.state, i())}</b><span>{SOURCE_NAMES[i().source]}</span><Icon name="chevron-down" size={12} />
        </button>
        <span class="pos">{props.position}</span>
        <button class="ib" title="Previous issue (k)" onClick={props.onPrev}><Icon name="chevron-up" size={14} /></button>
        <button class="ib" title="Next issue (j)" onClick={props.onNext}><Icon name="chevron-down" size={14} /></button>
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
                    <Icon name="chevron-down" size={11} />
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
                      <Icon name="tag" size={11} />{issueLabels(props.state, p()).length ? "Label" : "Add label"}
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
                <Show when={p().created_at}>
                  <dt>Created</dt><dd>{formatDay(p().created_at!.slice(0, 10))}</dd>
                </Show>
                <Show when={p().source === "plane"}>
                  <dt>Start</dt><dd>{formatDay((p() as PlaneIssue).start_date)}</dd>
                  <dt>Target</dt><dd>{formatDay((p() as PlaneIssue).target_date)}</dd>
                </Show>
                <Show when={p().source === "github"}>
                  <dt>Author</dt><dd>{(p() as GithubIssue).author || "—"}</dd>
                  <dt>Updated</dt><dd>{ago(p().updated_at)}</dd>
                </Show>
                <Show when={p().source !== "local"}>
                  <dt>Assignees</dt>
                  <dd class="who">
                    <Show when={assigneesOf(props.state, p()).length} fallback={<span class="c-m">Unassigned</span>}>
                      <For each={assigneesOf(props.state, p())}>
                        {(m) => <span class="asg"><span class="av sm" style={{ "--avc": avatarColor(m.name) }}>{initials(m.name)}</span>{m.name}</span>}
                      </For>
                    </Show>
                  </dd>
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
              <button onClick={props.onEdit}><kbd>e</kbd>Edit issue</button>
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
                        <button title={`Remove ${img.name}`} aria-label={`Remove ${img.name}`} onClick={() => removeDraftImage(props.project.id, issueId(), k())}><Icon name="x" size={10} /></button>
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <div class="cbar">
                <Show when={i().source === "plane"} fallback={<span class="grow">posts to GitHub through gh · <kbd>Ctrl</kbd><kbd>Enter</kbd> posts</span>}>
                  <button class="ib" title="Attach images" onClick={props.onAttach}><Icon name="image-plus" size={15} /></button>
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
