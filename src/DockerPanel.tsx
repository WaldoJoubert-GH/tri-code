// The Docker Window (design/docker.html, variant A): a project's containers and their ports over
// one log pane. Picking a stack follows its compose logs, picking a container its own. Streams live
// as long as the panel is mounted; switching project ends them and coming back picks them up.

import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { type Project, type Tab, isRemote } from "./state";
import { type Stop, containerAction, followEvents, followLogs, forwardPort, forwardedPorts, listContainers, portKey } from "./docker";
import {
  type Container, type Level, type LogLine, type Port, type Stack, clockOf, containerOfPrefix, failureOf, groupStacks, isAlive, isUp, localAddr, matchesFind, needsLook, opensPage,
  parseEvent, parseLogLine, phaseText, phaseTone, portUrl, rowName, stoppedCleanly, withLevel,
} from "./dockerdata";
import { openUrlInProject } from "./browsers";
import { copyText } from "./clipboard";
import { Icon } from "./lucide";
import { ask, flash } from "./ui";
import "./docker.css";

const TAIL = 500;
const BUFFER = 5000;
const SLOW_POLL = 30_000;
const RETRY = 10_000;
const COLORS = ["--p-ocean", "--p-moss", "--p-plum", "--p-marigold", "--p-terracotta", "--p-slate"];

type Sel = { kind: "stack" | "container"; name: string };
/** A log line with the container it came from, when known. */
type Row = LogLine & { source?: string };

/** What a window remembers while its panel is unmounted. */
type View = {
  scope: "mine" | "all";
  showStopped: boolean;
  /** The container search. `query` is the log search. */
  find: string;
  sel: Sel | null;
  shut: string[];
  muted: string[];
  warnOnly: boolean;
  query: string;
  times: boolean;
  wrap: boolean;
  top: number;
};
const views = new Map<string, View>();
const viewOf = (id: string): View => {
  let v = views.get(id);
  if (!v) views.set(id, (v = { scope: "mine", showStopped: true, find: "", sel: null, shut: [], muted: [], warnOnly: false, query: "", times: true, wrap: false, top: 240 }));
  return v;
};

const sameSel = (a: Sel | null, b: Sel | null) => a?.kind === b?.kind && a?.name === b?.name;

export default function DockerPanel(props: { project: Project; tab: Tab; focused: boolean }): JSX.Element {
  const p = () => props.project;
  const [v, setV] = createStore(viewOf(props.tab.id));
  const [containers, setContainers] = createSignal<Container[]>([]);
  const [roots, setRoots] = createSignal<string[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [live, setLive] = createSignal(false);
  const [following, setFollowing] = createSignal(true);
  const [unseen, setUnseen] = createSignal(0);
  const [forwarded, setForwarded] = createSignal<Record<string, number>>({});
  /** Start or stop under way, by `c:<container>` or `s:<stack>`. */
  const [busy, setBusy] = createSignal<Record<string, "start" | "stop">>({});

  let alive = true;
  let linesEl: HTMLDivElement | undefined;
  let rowsEl: HTMLDivElement | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let stopEvents: Stop | undefined;
  let stopLogs: Stop | undefined;
  let streaming = false;
  let lastList = "";

  const stacks = createMemo(() => groupStacks(containers(), roots()));
  const shownStacks = createMemo(() => stacks().filter((s) => v.scope === "all" || s.mine));
  const shown = (s: Stack) => s.containers.filter((c) => v.showStopped || !stoppedCleanly(c));
  // The search only narrows the rows. What's selected, its logs and a stack's counts and buttons
  // all stay as they are, so typing doesn't switch streams and Stop still means the whole stack.
  const listed = (s: Stack) => shown(s).filter((c) => matchesFind(c, v.find));
  const listedStacks = createMemo(() => shownStacks().filter((s) => listed(s).length));
  const stackId = (s: Stack) => s.name ?? "";
  const isShut = (s: Stack) => !v.find.trim() && v.shut.includes(stackId(s));
  const selStack = () => (v.sel?.kind === "stack" ? stacks().find((s) => s.name === v.sel!.name) : undefined);
  const selContainer = () => (v.sel?.kind === "container" ? containers().find((c) => c.name === v.sel!.name) : undefined);
  const isSel = (kind: Sel["kind"], name: string | undefined) => v.sel?.kind === kind && v.sel.name === name;
  const othersCount = () => stacks().filter((s) => !s.mine).reduce((n, s) => n + s.containers.filter((c) => !stoppedCleanly(c)).length, 0);

  /** Everything that can stay selected, search or no search. */
  const flat = (): Sel[] =>
    shownStacks().flatMap((s) => [
      ...(s.name ? [{ kind: "stack", name: s.name } as Sel] : []),
      ...(v.shut.includes(stackId(s)) ? [] : shown(s).map((c) => ({ kind: "container", name: c.name }) as Sel)),
    ]);
  /** The rows on screen in order, for j and k. */
  const listedRows = (): Sel[] =>
    listedStacks().flatMap((s) => [
      ...(s.name ? [{ kind: "stack", name: s.name } as Sel] : []),
      ...(isShut(s) ? [] : listed(s).map((c) => ({ kind: "container", name: c.name }) as Sel)),
    ]);

  // What's selected can go away: another scope, a stopped container hidden, a stack brought down.
  createEffect(() => {
    if (!loaded()) return;
    const list = flat();
    const inFold = () => {
      const c = v.sel?.kind === "container" ? containers().find((x) => x.name === v.sel!.name) : undefined;
      return !!c && shownStacks().some((s) => s.containers.includes(c)) && (v.showStopped || !stoppedCleanly(c));
    };
    if (v.sel && (list.some((x) => sameSel(x, v.sel)) || inFold())) return;
    setV("sel", list[0] ?? null);
  });

  // ── the list ───────────────────────────────────────────────────────

  async function refresh() {
    clearTimeout(refreshTimer);
    let wait = SLOW_POLL;
    try {
      const r = await listContainers(p().host, p().path);
      if (!alive) return;
      batch(() => {
        setRoots(r.roots);
        // New objects would redraw every row, so only when something changed.
        const text = JSON.stringify(r.list);
        if (text !== lastList) {
          lastList = text;
          setContainers(r.list);
        }
        setFailure(null);
        setLoaded(true);
      });
      startEvents();
      resumeLogs();
    } catch (e) {
      if (!alive) return;
      batch(() => {
        setFailure(String(e));
        setLoaded(true);
      });
      wait = RETRY;
    }
    if (alive) refreshTimer = setTimeout(refresh, wait);
  }

  function soon(ms = 250) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, ms);
  }

  function startEvents() {
    if (stopEvents) return;
    setLive(true);
    stopEvents = followEvents(p().host, (lines) => {
      let any = false;
      for (const l of lines) {
        const e = parseEvent(l);
        if (!e) continue;
        any = true;
        if (e.action === "start") addMark(e.name, "started");
        else if (e.action === "die") addMark(e.name, e.code === undefined ? "exited" : `exited (${e.code})`);
      }
      if (any) soon();
    }, () => {
      stopEvents = undefined;
      setLive(false);
      soon(5000);
    });
  }

  // ── the log pane ───────────────────────────────────────────────────

  let rows: Row[] = [];
  let lastStamp: string | undefined;
  /** Lines at or before this came from an earlier stream of the same logs. */
  let dropUntil: string | undefined;
  const lastLevel = new Map<string, Level>();

  const colorOf = (name: string | undefined) => {
    const i = containers().findIndex((c) => c.name === name);
    return `var(${COLORS[(i < 0 ? 5 : i) % COLORS.length]})`;
  };
  const composeMode = () => v.sel?.kind === "stack";

  function isVisible(r: Row): boolean {
    if (composeMode() && r.source) {
      if (v.muted.includes(r.source)) return false;
      const c = containers().find((x) => x.name === r.source);
      if (c && stoppedCleanly(c) && !v.showStopped) return false;
    }
    if (r.mark) return !v.warnOnly && !v.query;
    if (v.warnOnly && r.level === "info") return false;
    return !v.query || r.text.toLowerCase().includes(v.query.toLowerCase());
  }

  function highlighted(into: HTMLElement, text: string) {
    const q = v.query.toLowerCase();
    if (!q) {
      into.textContent = text;
      return;
    }
    const low = text.toLowerCase();
    let at = 0;
    for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, at)) {
      into.append(text.slice(at, i));
      const m = document.createElement("mark");
      m.textContent = text.slice(i, i + q.length);
      into.append(m);
      at = i + q.length;
    }
    into.append(text.slice(at));
  }

  function rowEl(r: Row): HTMLElement {
    const el = document.createElement("div");
    const label = composeMode() ? containers().find((c) => c.name === r.source) : undefined;
    const name = label ? rowName(label) : r.prefix;
    if (r.mark) {
      el.className = "dk-ln dk-mark";
      const s = document.createElement("span");
      s.textContent = `${composeMode() && name ? `${name} ` : ""}${r.text} · ${clockOf(r.stamp)}`;
      el.append(s);
      return el;
    }
    el.className = `dk-ln${r.level === "info" ? "" : ` ${r.level === "bad" ? "dk-bad" : "dk-warn"}`}`;
    const t = document.createElement("time");
    t.textContent = clockOf(r.stamp);
    el.append(t);
    if (composeMode()) {
      const s = document.createElement("span");
      s.className = "dk-svc";
      s.textContent = name ?? "";
      s.title = name ?? "";
      s.style.color = colorOf(r.source);
      el.append(s);
    }
    const m = document.createElement("span");
    m.className = "dk-m";
    highlighted(m, r.text);
    el.append(m);
    return el;
  }

  function renderRows() {
    const el = linesEl;
    if (!el) return;
    const list = rows.filter(isVisible);
    const frag = document.createDocumentFragment();
    for (const r of list) frag.append(rowEl(r));
    el.replaceChildren(frag);
    if (!list.length) {
      const none = document.createElement("div");
      none.className = "dk-nolines";
      none.textContent = v.warnOnly || v.query ? "No lines match." : streaming ? "No output yet." : "No logs.";
      el.append(none);
    }
    if (following()) el.scrollTop = el.scrollHeight;
  }

  function appendRows(added: Row[]) {
    rows.push(...added);
    if (rows.length > BUFFER) rows = rows.slice(-BUFFER);
    const el = linesEl;
    if (!el) return;
    const fresh = added.filter(isVisible);
    if (!fresh.length) return;
    el.querySelector(".dk-nolines")?.remove();
    const frag = document.createDocumentFragment();
    for (const r of fresh) frag.append(rowEl(r));
    el.append(frag);
    while (el.childElementCount > BUFFER) el.firstElementChild!.remove();
    if (following()) el.scrollTop = el.scrollHeight;
    else setUnseen((n) => n + fresh.length);
  }

  function onLines(raw: string[]) {
    const compose = composeMode();
    const added: Row[] = [];
    for (const text of raw) {
      const parsed = parseLogLine(text, compose);
      if (dropUntil && parsed.stamp && parsed.stamp <= dropUntil) continue;
      const source = compose ? containerOfPrefix(parsed.prefix, containers())?.name : v.sel?.name;
      const key = source ?? parsed.prefix ?? "";
      const row: Row = { ...withLevel(parsed, lastLevel.get(key)), source };
      lastLevel.set(key, row.level);
      if (row.stamp) lastStamp = row.stamp;
      added.push(row);
    }
    if (added.length) appendRows(added);
  }

  function addMark(container: string, text: string) {
    const belongs = v.sel?.kind === "stack" ? containers().some((c) => c.name === container && c.stack === v.sel!.name) : v.sel?.name === container;
    if (belongs) appendRows([{ text, level: "info", mark: true, source: container, stamp: new Date().toISOString() }]);
  }

  function startLogs(since?: string) {
    stopLogs?.();
    const sel = v.sel;
    if (!sel) return;
    streaming = true;
    dropUntil = since;
    const target = sel.kind === "stack" ? { stack: sel.name } : { container: sel.name };
    stopLogs = followLogs(p().host, target, since ? 0 : TAIL, since, onLines, (code) => {
      streaming = false;
      stopLogs = undefined;
      // docker logs ends when its container stops, which is nothing to report.
      if (code > 0) appendRows([{ text: `logs ended (exit ${code})`, level: "info", mark: true, stamp: new Date().toISOString() }]);
      if (!rows.length) renderRows();
    });
  }

  /** docker logs ends with its container: once that's back up, carry on from the last line. */
  function resumeLogs() {
    if (streaming || !v.sel) return;
    const anyAlive = v.sel.kind === "stack" ? !!selStack()?.containers.some(isAlive) : !!selContainer() && isAlive(selContainer()!);
    if (anyAlive) startLogs(lastStamp);
  }

  // A new selection is a new log. It waits for the list, which names the lines' containers.
  createEffect(on(() => (loaded() && v.sel ? `${v.sel.kind}:${v.sel.name}` : ""), (key) => {
    rows = [];
    lastStamp = undefined;
    lastLevel.clear();
    batch(() => {
      setFollowing(true);
      setUnseen(0);
    });
    stopLogs?.();
    stopLogs = undefined;
    streaming = false;
    if (key) startLogs();
    renderRows();
  }));
  // Filters only choose among the lines already here.
  createEffect(on(() => [v.warnOnly, v.query, v.muted.length, v.showStopped], () => renderRows(), { defer: true }));

  function jumpToEnd() {
    if (linesEl) linesEl.scrollTop = linesEl.scrollHeight;
    batch(() => {
      setFollowing(true);
      setUnseen(0);
    });
  }
  const toggleFollow = () => (following() ? setFollowing(false) : jumpToEnd());
  function onScroll() {
    const el = linesEl!;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (atEnd !== following()) {
      batch(() => {
        setFollowing(atEnd);
        if (atEnd) setUnseen(0);
      });
    }
  }

  // ── actions ────────────────────────────────────────────────────────

  const select = (s: Sel) => setV("sel", s);
  const toggleIn = (key: "shut" | "muted", value: string) => setV(key, (l) => (l.includes(value) ? l.filter((x) => x !== value) : [...l, value]));

  function move(by: number) {
    const list = listedRows();
    const i = list.findIndex((x) => sameSel(x, v.sel));
    const next = list[Math.max(0, Math.min(list.length - 1, i + by))];
    if (!next) return;
    select(next);
    queueMicrotask(() => rowsEl?.querySelector(".dk-on")?.scrollIntoView({ block: "nearest" }));
  }

  const busyFor = (c: Container) => busy()[`c:${c.name}`] ?? (c.stack ? busy()[`s:${c.stack}`] : undefined);

  /** Stopping what belongs to another project asks first; this project's is one click, and Start undoes it. */
  async function act(action: "start" | "stop", target: { stack: string } | { container: string }, mine: boolean) {
    const name = "stack" in target ? target.stack : target.container;
    const key = "stack" in target ? `s:${name}` : `c:${name}`;
    if (busy()[key]) return;
    if (action === "stop" && !mine && !(await ask(`Stop ${name}? It isn't part of ${p().name}.`))) return;
    setBusy((b) => ({ ...b, [key]: action }));
    try {
      await containerAction(p().host, action, target);
    } catch (e) {
      flash(`couldn't ${action} ${name}: ${e}`);
    }
    if (alive) await refresh();
    setBusy(({ [key]: _, ...rest }) => rest);
  }

  async function clickPort(port: Port) {
    const remote = isRemote(p());
    if (remote && port.proto !== "tcp") {
      const at = p().host.split("@").pop();
      copyText(`${at}:${port.host}`);
      flash(`copied ${at}:${port.host}`);
      return;
    }
    let addr = localAddr(port);
    let local = port.host!;
    if (remote) {
      flash(`forwarding ${port.host} from ${p().host}…`);
      try {
        local = await forwardPort(props.tab.id, p().host, port);
      } catch (e) {
        flash(`couldn't forward ${port.host}: ${e}`);
        return;
      }
      addr = "localhost";
      setForwarded((f) => ({ ...f, [portKey(port)]: local }));
    }
    if (opensPage(port)) {
      openUrlInProject(p().id, portUrl(port, addr, local), props.tab.id);
    } else {
      copyText(`${addr}:${local}`);
      flash(`copied ${addr}:${local}`);
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  const onKey = (e: KeyboardEvent) => {
    if (!props.focused || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest("input:not([type=checkbox]), textarea, select");
    if (e.key === "Escape" && typing) {
      setV(target!.closest(".dk-ph") ? "find" : "query", "");
      (target as HTMLInputElement).blur();
      e.preventDefault();
      return;
    }
    if (typing) return;
    const act: Record<string, () => void> = {
      j: () => move(1),
      k: () => move(-1),
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      "/": () => document.querySelector<HTMLInputElement>(`[data-docker="${props.tab.id}"] .dk-lh .dk-search input`)?.focus(),
      s: () => document.querySelector<HTMLInputElement>(`[data-docker="${props.tab.id}"] .dk-ph .dk-search input`)?.focus(),
      f: toggleFollow,
      t: () => setV("times", (x) => !x),
      w: () => setV("wrap", (x) => !x),
      e: () => setV("warnOnly", (x) => !x),
    };
    if (act[e.key]) {
      act[e.key]();
      e.preventDefault();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", onKey);
    void forwardedPorts(props.tab.id).then((f) => alive && setForwarded(f));
    void refresh();
  });
  onCleanup(() => {
    alive = false;
    window.removeEventListener("keydown", onKey);
    clearTimeout(refreshTimer);
    stopEvents?.();
    stopLogs?.();
  });

  function startDrag(e: PointerEvent) {
    e.preventDefault();
    const bar = e.currentTarget as HTMLElement;
    const body = bar.parentElement!;
    bar.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const top = body.getBoundingClientRect().top;
      setV("top", Math.max(80, Math.min(body.clientHeight - 130, m.clientY - top)));
    };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  }

  // ── view ───────────────────────────────────────────────────────────

  const Status = () => {
    const list = () => shownStacks().flatMap((s) => shown(s));
    const look = () => list().filter(needsLook).length;
    return (
      <div class="dk-status">
        <span>{list().filter(isUp).length} up</span>
        <Show when={look()}><span class="dk-warntext">{look()} {look() === 1 ? "needs" : "need"} a look</span></Show>
      </div>
    );
  };

  const PortChips = (cp: { c: Container }) => (
    <Show when={cp.c.ports.length} fallback={<span class="dk-none">no ports</span>}>
      <div class="dk-ports">
        <For each={cp.c.ports}>
          {(port) => (
            <Show when={port.host} fallback={
              <span class="dk-port dk-int" title="Exposed inside the Docker network, not published to the host">{port.cont}{port.proto === "tcp" ? "" : `/${port.proto}`}</span>
            }>
              {(_) => {
                const fw = () => forwarded()[portKey(port)];
                const shownPort = () => fw() ?? port.host!;
                const action = () => (opensPage(port) ? "open in a browser window" : "copy the address");
                const tip = () => `${port.bind}:${port.host} → ${port.cont}/${port.proto}. Click to ${isRemote(p()) && !fw() && port.proto === "tcp" ? "forward over ssh and " : ""}${action()}`;
                return (
                  <button class="dk-port" classList={{ "dk-tcp": !opensPage(port), "dk-fwd": !!fw() }} title={tip()} onClick={(e) => { e.stopPropagation(); void clickPort(port); }}>
                    <Show when={fw()}><Icon name="cable" size={11} /></Show>
                    {shownPort()}
                    <Show when={shownPort() !== port.cont}><span class="dk-to">→ {port.cont}</span></Show>
                    <Show when={port.proto !== "tcp"}><span class="dk-to">/{port.proto}</span></Show>
                  </button>
                );
              }}
            </Show>
          )}
        </For>
      </div>
    </Show>
  );

  const StateCell = (cp: { c: Container }) => (
    <Show when={busyFor(cp.c)} fallback={<span class={`dk-st dk-${phaseTone(cp.c)}`}><i /><span>{phaseText(cp.c)}</span></span>}>
      {(a) => <span class="dk-st dk-warn"><i /><span>{a() === "stop" ? "stopping…" : "starting…"}</span></span>}
    </Show>
  );

  const ActionButton = (ap: { action: "start" | "stop"; name: string; disabled: boolean; onClick: () => void }) => (
    <button
      class="dk-act"
      classList={{ "dk-act-stop": ap.action === "stop" }}
      disabled={ap.disabled}
      aria-label={`${ap.action === "stop" ? "Stop" : "Start"} ${ap.name}`}
      title={`${ap.action === "stop" ? "Stop" : "Start"} ${ap.name}`}
      onClick={(e) => { e.stopPropagation(); ap.onClick(); }}
    >
      <Icon name={ap.action === "stop" ? "square" : "play"} size={12} />
    </button>
  );

  const Table = () => (
    <table class="dk-tb">
      <thead><tr><th>Container</th><th>State</th><th>Ports</th><th class="dk-col-img">Image</th><th class="dk-col-up">Up</th><th class="dk-col-act"><span class="dk-hidden">Start or stop</span></th></tr></thead>
      <For each={listedStacks()}>
        {(s) => {
          const shut = () => isShut(s);
          const up = () => s.containers.filter(isUp).length;
          const total = () => shown(s).length;
          const stackBusy = () => !!s.name && !!busy()[`s:${s.name}`];
          return (
            <tbody>
              <tr class="dk-stack" classList={{ "dk-on": !!s.name && isSel("stack", s.name) }} onClick={() => s.name && select({ kind: "stack", name: s.name })}>
                <td colspan="6">
                  <div class="dk-sh" classList={{ "dk-shut": shut() }}>
                    <button class="dk-chev" aria-label={`${shut() ? "Unfold" : "Fold"} ${s.name ?? "other containers"}`} onClick={(e) => { e.stopPropagation(); toggleIn("shut", stackId(s)); }}><Icon name="chevron-down" size={14} /></button>
                    <Icon name={s.name ? "layers" : "box"} size={13} />
                    <span>{s.name ?? "Not in a stack"}</span>
                    <span class="dk-meta">{s.name ? `${up()}/${total()} up` : s.containers.length}</span>
                    <Show when={s.name}>
                      <span class="dk-grow" />
                      <span class="dk-meta">compose logs</span>
                      <Show when={shown(s).some((c) => !isAlive(c))}><ActionButton action="start" name={s.name!} disabled={stackBusy()} onClick={() => void act("start", { stack: s.name! }, s.mine)} /></Show>
                      <Show when={s.containers.some(isAlive)}><ActionButton action="stop" name={s.name!} disabled={stackBusy()} onClick={() => void act("stop", { stack: s.name! }, s.mine)} /></Show>
                    </Show>
                  </div>
                </td>
              </tr>
              <Show when={!shut()}>
                <For each={listed(s)}>
                  {(c) => (
                    <tr classList={{ "dk-on": isSel("container", c.name), "dk-off": stoppedCleanly(c) }} onClick={() => select({ kind: "container", name: c.name })}>
                      <td class="dk-nm" title={c.name}>{rowName(c)}</td>
                      <td><StateCell c={c} /></td>
                      <td class="dk-pc"><PortChips c={c} /></td>
                      <td class="dk-img dk-col-img" title={c.image}>{c.image}</td>
                      <td class="dk-up dk-col-up">{c.up}</td>
                      <td class="dk-col-act">
                        <ActionButton action={isAlive(c) ? "stop" : "start"} name={rowName(c)} disabled={!!busyFor(c)} onClick={() => void act(isAlive(c) ? "stop" : "start", { container: c.name }, s.mine)} />
                      </td>
                    </tr>
                  )}
                </For>
              </Show>
            </tbody>
          );
        }}
      </For>
    </table>
  );

  const LogPane = () => (
    <div class="dk-log">
      <div class="dk-lh">
        <div class="dk-scope">
          <Show when={selStack()} fallback={
            <>
              <Icon name="box" size={13} />
              <span class="dk-scope-n" title={v.sel?.name}>{v.sel?.name}</span>
              <Show when={selContainer()}>{(c) => <StateCell c={c()} />}</Show>
            </>
          }>
            <Icon name="layers" size={13} />
            <span class="dk-scope-n">{v.sel?.name}</span>
            <span class="dk-tag">compose logs</span>
          </Show>
        </div>
        <div class="dk-tools">
          <label class="dk-search">
            <Icon name="search" size={12} />
            <input placeholder="Search logs" aria-label="Search logs" value={v.query} onInput={(e) => setV("query", e.currentTarget.value)} />
          </label>
          <div class="dk-seg" role="group" aria-label="Level">
            <button aria-pressed={!v.warnOnly} onClick={() => setV("warnOnly", false)}>All</button>
            <button aria-pressed={v.warnOnly} title="Warnings and errors (e)" onClick={() => setV("warnOnly", true)}>Warn+</button>
          </div>
          <button class="dk-ib" aria-pressed={v.times} aria-label="Timestamps" title="Timestamps (t)" onClick={() => setV("times", (x) => !x)}><Icon name="clock" size={13} /></button>
          <button class="dk-ib" aria-pressed={v.wrap} aria-label="Wrap lines" title="Wrap lines (w)" onClick={() => setV("wrap", (x) => !x)}><Icon name="wrap-text" size={13} /></button>
          <button class="dk-follow" classList={{ "dk-following": following() }} aria-pressed={following()} title="Follow new lines (f)" onClick={toggleFollow}><Icon name="arrow-down" size={12} />Follow</button>
        </div>
      </div>
      <Show when={selStack()}>
        {(s) => (
          <div class="dk-chips">
            <For each={shown(s())}>
              {(c) => (
                <button class="dk-chip" classList={{ "dk-mute": v.muted.includes(c.name) }} aria-pressed={!v.muted.includes(c.name)} title={`Show or hide ${rowName(c)}`} onClick={() => toggleIn("muted", c.name)}>
                  <i style={{ background: v.muted.includes(c.name) ? undefined : colorOf(c.name) }} />{rowName(c)}
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
      <div class="dk-lines" classList={{ "dk-no-times": !v.times, "dk-wrapped": v.wrap }} ref={(el) => { linesEl = el; queueMicrotask(renderRows); }} onScroll={onScroll} />
      <Show when={!following() && unseen()}>
        <button class="dk-new" onClick={jumpToEnd}><Icon name="arrow-down" size={12} />{unseen()} new line{unseen() === 1 ? "" : "s"}</button>
      </Show>
    </div>
  );

  const FailurePage = (fp: { err: string }) => {
    const where = () => (isRemote(p()) ? p().host : "this machine");
    const kind = () => failureOf(fp.err);
    return (
      <div class="dk-msg">
        <div>
          <Show when={kind() === "missing"}>
            <h3><Icon name="triangle-alert" size={16} />No docker on {where()}</h3>
            <p>tri-code runs the Docker CLI on the project's host, and couldn't find it there.</p>
          </Show>
          <Show when={kind() === "down"}>
            <h3 class="dk-badtext"><Icon name="triangle-alert" size={16} />Docker isn't running on {where()}</h3>
            <pre>{fp.err}</pre>
          </Show>
          <Show when={kind() === "other"}>
            <h3 class="dk-badtext"><Icon name="triangle-alert" size={16} />Couldn't ask docker on {where()}</h3>
            <pre>{fp.err}</pre>
          </Show>
          <p>Checking again every {RETRY / 1000} seconds.</p>
          <button class="dk-btn" onClick={() => void refresh()}>Check now</button>
        </div>
      </div>
    );
  };

  const NothingPage = () => (
    <div class="dk-msg">
      <div>
        <h3><Icon name="container" size={16} />Nothing running for {p().name}</h3>
        <p>Start it from this folder and it shows up here by itself:</p>
        <pre>docker compose up -d</pre>
        <Show when={othersCount()}>
          <button class="dk-btn" onClick={() => setV("scope", "all")}>Show {othersCount()} {othersCount() === 1 ? "container" : "containers"} from elsewhere on this host</button>
        </Show>
      </div>
    </div>
  );

  return (
    <div class="dk" data-docker={props.tab.id}>
      <div class="dk-ph">
        <div class="dk-seg" role="group" aria-label="Which containers">
          <button aria-pressed={v.scope === "mine"} onClick={() => setV("scope", "mine")}>This project</button>
          <button aria-pressed={v.scope === "all"} onClick={() => setV("scope", "all")}>All on host</button>
        </div>
        <label class="dk-check"><input type="checkbox" checked={v.showStopped} onChange={(e) => setV("showStopped", e.currentTarget.checked)} />Show stopped</label>
        <label class="dk-search" title="Name, stack, image, state or port (s)">
          <Icon name="search" size={12} />
          <input placeholder="Search containers" aria-label="Search containers" value={v.find} onInput={(e) => setV("find", e.currentTarget.value)} />
        </label>
        <span class="dk-grow" />
        <Show when={loaded() && !failure()}>
          <span class="dk-live" title={live() ? "Following docker events" : `Checking every ${SLOW_POLL / 1000} seconds`}><i classList={{ "dk-idle": !live() }} />{live() ? "live" : "polling"}</span>
        </Show>
      </div>
      <Show when={loaded()} fallback={<div class="dk-msg"><p>Asking docker…</p></div>}>
        <Show when={!failure()} fallback={<FailurePage err={failure()!} />}>
          <Show when={shownStacks().length} fallback={<NothingPage />}>
            <div class="dk-body">
              <div class="dk-list" ref={rowsEl} style={{ "max-height": `min(${v.top}px, calc(100% - 130px))` }}>
                <Show when={listedStacks().length} fallback={<div class="dk-nomatch">No containers match “{v.find.trim()}”.</div>}><Table /></Show>
              </div>
              <div class="dk-split" role="separator" aria-orientation="horizontal" onPointerDown={startDrag} />
              <Show when={v.sel} fallback={<div class="dk-msg"><p>Pick a stack or a container to see its logs.</p></div>}><LogPane /></Show>
            </div>
            <Status />
          </Show>
        </Show>
      </Show>
    </div>
  );
}
