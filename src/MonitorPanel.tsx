// The Monitor Window (design/monitor.html, variant A): the project's host's CPU, memory, network and
// disks over a live process list you can end things from. Sampling runs while the panel is mounted;
// switching project stops it and coming back starts it again.

import { Index, For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { type Project, type Tab, isRemote } from "./state";
import { endProcess, sample } from "./monitor";
import { type Proc, type Scope, type Snapshot, type SortKey, bytes, descendants, duration, firstAsc, graphPaths, perSec, pushed, rowsOf, tone } from "./monitordata";
import { copyText } from "./clipboard";
import { Icon } from "./lucide";
import { Key } from "./Keys";
import { flash } from "./ui";
import "./monitor.css";

const RETRY = 10_000;
const RATES = [1, 2, 5];

/** What a window remembers while its panel is unmounted. */
type View = { scope: Scope; find: string; tree: boolean; sort: SortKey; asc: boolean; every: number; paused: boolean; sel: number | null };
const views = new Map<string, View>();
const viewOf = (id: string): View => {
  let v = views.get(id);
  if (!v) views.set(id, (v = { scope: "all", find: "", tree: true, sort: "cpu", asc: false, every: 1, paused: false, sel: null }));
  return v;
};

const SORT_NAME: Record<SortKey, string> = { cpu: "CPU", mem: "memory", pid: "pid", name: "name", user: "user", up: "age" };

type Ask = { pid: number; born: number; name: string; kids: number; mine: boolean };

export default function MonitorPanel(props: { project: Project; tab: Tab; focused: boolean }): JSX.Element {
  const p = () => props.project;
  const [v, setV] = createStore(viewOf(props.tab.id));
  const [snap, setSnap] = createSignal<Snapshot | null>(null);
  const [at, setAt] = createSignal(Date.now() / 1000);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [hist, setHist] = createStore({ cpu: [] as number[], mem: [] as number[], rx: [] as number[], tx: [] as number[], pcpu: [] as number[], pmem: [] as number[] });
  const [ask, setAsk] = createSignal<Ask | null>(null);
  const [ending, setEnding] = createSignal<ReadonlySet<number>>(new Set());

  let alive = true;
  let stop: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollEl: HTMLDivElement | undefined;
  let rootEl: HTMLDivElement | undefined;

  // ── sampling ───────────────────────────────────────────────────────

  function onSample(s: Snapshot) {
    batch(() => {
      setSnap(s);
      setAt(Date.now() / 1000);
      setFailure(null);
      setHist("cpu", (h) => pushed(h, s.cpu));
      setHist("mem", (h) => pushed(h, s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0));
      setHist("rx", (h) => pushed(h, s.rx));
      setHist("tx", (h) => pushed(h, s.tx));
      const sel = s.procs.find((x) => x.pid === v.sel);
      if (sel) {
        setHist("pcpu", (h) => pushed(h, sel.cpu));
        setHist("pmem", (h) => pushed(h, sel.mem));
      }
      // What was ending and is gone now is done.
      if (ending().size) setEnding(new Set([...ending()].filter((pid) => s.procs.some((x) => x.pid === pid))));
    });
  }

  function start() {
    clearTimeout(retryTimer);
    stop?.();
    stop = undefined;
    if (v.paused || !alive) return;
    stop = sample(props.tab.id, p().host, [p().path], v.every, onSample, (why) => {
      stop = undefined;
      setFailure(why);
      if (alive) retryTimer = setTimeout(start, RETRY);
    });
  }

  createEffect(on(() => [p().host, p().path, v.every, v.paused], start));
  // A new selection starts its own history.
  createEffect(on(() => v.sel, () => setHist({ pcpu: [], pmem: [] }), { defer: true }));

  // ── the list ───────────────────────────────────────────────────────

  const rows = createMemo(() => {
    const s = snap();
    return s ? rowsOf(s.procs, { scope: v.scope, find: v.find, tree: v.tree, sort: v.sort, asc: v.asc }) : [];
  });
  const byPid = createMemo(() => new Map((snap()?.procs ?? []).map((x) => [x.pid, x])));
  const selected = () => (v.sel === null ? undefined : byPid().get(v.sel));

  // What's selected can go away (it ended, a search hid it): take the row that is now where it was.
  let lastIndex = 0;
  createEffect(() => {
    const list = rows();
    if (!list.length) return;
    const i = list.findIndex((r) => r.p.pid === v.sel);
    if (i >= 0) lastIndex = i;
    else setV("sel", list[Math.min(lastIndex, list.length - 1)].p.pid);
  });

  function select(pid: number) {
    setV("sel", pid);
    if (ask() && ask()!.pid !== pid) setAsk(null);
  }

  function move(by: number) {
    const list = rows();
    if (!list.length) return;
    const i = list.findIndex((r) => r.p.pid === v.sel);
    select(list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + by))].p.pid);
    queueMicrotask(() => scrollEl?.querySelector(".mn-on")?.scrollIntoView({ block: "nearest" }));
  }

  function setSort(k: SortKey) {
    if (v.sort === k) setV("asc", (a) => !a);
    else setV({ sort: k, asc: firstAsc(k) });
  }

  // ── ending a process ───────────────────────────────────────────────

  const guardText = (x: Proc) =>
    x.guard === "tri-code" ? "This is tri-code, or what keeps this window connected."
    : x.guard === "system" ? (isRemote(p()) ? "init: ending it takes the host down." : "The operating system's own.")
    : "";

  function askEnd(pid: number | null) {
    const x = pid === null ? undefined : byPid().get(pid);
    if (!x || x.guard || ending().has(x.pid)) return;
    setV("sel", x.pid);
    setAsk({ pid: x.pid, born: x.born, name: x.name, kids: descendants(snap()!.procs, x.pid).length, mine: x.mine });
  }

  async function confirmEnd() {
    const a = ask();
    if (!a) return;
    setAsk(null);
    const tree = [a.pid, ...descendants(snap()?.procs ?? [], a.pid).map((x) => x.pid)];
    setEnding((s) => new Set([...s, ...tree]));
    try {
      await endProcess(p().host, a.pid, a.born);
      flash(`ended ${a.name}${a.kids ? ` and ${a.kids} more` : ""}`);
    } catch (e) {
      flash(`couldn't end ${a.name}: ${e}`);
      setEnding((s) => new Set([...s].filter((pid) => !tree.includes(pid))));
    }
  }

  // ── keys ───────────────────────────────────────────────────────────

  const onKey = (e: KeyboardEvent) => {
    if (!props.focused || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest("input:not([type=checkbox]), textarea, select");
    if (e.key === "Escape") {
      if (typing) {
        setV("find", "");
        (target as HTMLInputElement).blur();
      } else if (ask()) setAsk(null);
      else return;
      e.preventDefault();
      return;
    }
    if (typing) {
      if (e.key === "Enter" || e.key === "ArrowDown") {
        (target as HTMLInputElement).blur();
        e.preventDefault();
      }
      return;
    }
    if (ask() && (e.key === "Enter" || e.key === "y")) {
      void confirmEnd();
      e.preventDefault();
      return;
    }
    const act: Record<string, () => void> = {
      j: () => move(1),
      k: () => move(-1),
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      PageDown: () => move(15),
      PageUp: () => move(-15),
      Home: () => move(-1e9),
      End: () => move(1e9),
      x: () => askEnd(v.sel),
      Delete: () => askEnd(v.sel),
      "/": () => rootEl?.querySelector<HTMLInputElement>(".mn-search input")?.focus(),
      t: () => setV("tree", (x) => !x),
      a: () => setV("scope", (s) => (s === "all" ? "mine" : "all")),
      c: () => setSort("cpu"),
      m: () => setSort("mem"),
      n: () => setSort("name"),
      p: () => setSort("pid"),
      " ": () => setV("paused", (x) => !x),
    };
    if (act[e.key]) {
      act[e.key]();
      e.preventDefault();
    }
  };

  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => {
    alive = false;
    window.removeEventListener("keydown", onKey);
    clearTimeout(retryTimer);
    stop?.();
  });

  // ── view ───────────────────────────────────────────────────────────

  const Graph = (gp: { vals: number[]; h: number; max: number; color: string; down?: boolean; grid?: boolean }) => {
    const d = () => graphPaths(gp.vals, gp.h, gp.max, gp.down);
    return (
      <svg class="mn-g" viewBox={`0 0 100 ${gp.h}`} preserveAspectRatio="none" style={{ height: `${gp.h}px` }} aria-hidden="true">
        <Show when={gp.grid}>
          <For each={[0.25, 0.5, 0.75]}>{(f) => <line class="mn-grid" x1="0" x2="100" y1={gp.h * f} y2={gp.h * f} />}</For>
        </Show>
        <path class="mn-a" d={d().area} fill={`color-mix(in srgb, ${gp.color} 22%, transparent)`} />
        <path class="mn-l" d={d().line} stroke={gp.color} />
      </svg>
    );
  };

  const Bar = (bp: { parts: { pct: number; color: string }[]; tall?: boolean }) => (
    <div class="mn-bar" classList={{ "mn-tall": bp.tall }}>
      <For each={bp.parts}>{(x) => <span style={{ width: `${Math.max(0, Math.min(100, x.pct))}%`, background: x.color }} />}</For>
    </div>
  );

  const Header = () => (
    <div class="mn-ph">
      <span class="mn-host" title={snap()?.hostName}>
        <i classList={{ "mn-bad": !!failure() }} />
        {isRemote(p()) ? p().host : "this machine"}
        <Show when={snap()?.os}><span class="mn-os">· {snap()!.os}</span></Show>
      </span>
      <Show when={snap()}>
        {(s) => (
          <>
            <span class="mn-fact">up <b>{duration(s().uptime)}</b></span>
            <Show when={s().load}>{(l) => <span class="mn-fact" title="Load average: 1, 5 and 15 minutes">load <b>{l()[0].toFixed(2)}</b> {l()[1].toFixed(2)} {l()[2].toFixed(2)}</span>}</Show>
            <span class="mn-fact"><b>{s().procs.length}</b> processes</span>
          </>
        )}
      </Show>
      <span class="mn-grow" />
      <div class="mn-seg" role="group" aria-label="Sample every">
        <For each={RATES}>{(r) => <button aria-pressed={v.every === r} onClick={() => setV("every", r)}>{r} s</button>}</For>
      </div>
      <button class="mn-ib" aria-pressed={v.paused} title="Pause sampling (space)" onClick={() => setV("paused", (x) => !x)}>
        <Icon name={v.paused ? "play" : "pause"} size={12} />{v.paused ? "Resume" : "Pause"}
      </button>
      <span class="mn-live" title={`Sampling every ${v.every} s`}><i classList={{ "mn-idle": v.paused || !!failure(), "mn-beat": !v.paused && !failure() }} />{v.paused ? "paused" : failure() ? "retrying" : "live"}</span>
    </div>
  );

  const Meters = (mp: { s: Snapshot }) => {
    const s = () => mp.s;
    const netMax = () => Math.max(64 * 1024, ...hist.rx, ...hist.tx);
    return (
      <div class="mn-meters">
        <div class="mn-box mn-cpu">
          <div class="mn-bh">CPU <span class="mn-big" style={{ color: tone(s().cpu) }}>{s().cpu.toFixed(0)}%</span><span class="mn-grow" />
            <span class="mn-note">{s().cores.length} {s().cores.length === 1 ? "core" : "cores"}{s().mhz ? ` · ${(s().mhz! / 1000).toFixed(1)} GHz` : ""}</span>
          </div>
          <Graph vals={hist.cpu} h={84} max={100} color="var(--accent)" grid />
          <div class="mn-cores">
            <Index each={s().cores}>
              {(c, i) => (
                <div class="mn-core" title={`core ${i}: ${c().toFixed(0)}%`}>
                  <span class="mn-c">c{i}</span><Bar parts={[{ pct: c(), color: tone(c()) }]} /><span class="mn-n">{c().toFixed(0)}%</span>
                </div>
              )}
            </Index>
          </div>
        </div>
        <div class="mn-box">
          <div class="mn-bh">Memory <span class="mn-big">{bytes(s().memUsed)}</span><span class="mn-note">of {bytes(s().memTotal)}</span><span class="mn-grow" />
            <span class="mn-note">{s().memTotal ? ((s().memUsed / s().memTotal) * 100).toFixed(0) : 0}%</span>
          </div>
          <Bar tall parts={[
            { pct: (s().memUsed / s().memTotal) * 100, color: "var(--p-ocean)" },
            { pct: (s().memCached / s().memTotal) * 100, color: "color-mix(in srgb, var(--p-ocean) 35%, transparent)" },
          ]} />
          <div class="mn-legend">
            <span><i style={{ background: "var(--p-ocean)" }} />used {bytes(s().memUsed)}</span>
            <Show when={s().memCached}><span><i style={{ background: "color-mix(in srgb, var(--p-ocean) 35%, transparent)" }} />cached {bytes(s().memCached)}</span></Show>
            <span><i style={{ background: "var(--hover)" }} />free {bytes(Math.max(0, s().memTotal - s().memUsed - s().memCached))}</span>
          </div>
          <Show when={s().swapTotal}>
            <div class="mn-row2"><span class="mn-k">swap</span><Bar parts={[{ pct: (s().swapUsed / s().swapTotal) * 100, color: "var(--p-plum)" }]} /><span class="mn-v">{bytes(s().swapUsed)} / {bytes(s().swapTotal)}</span></div>
          </Show>
          <div class="mn-gap"><Graph vals={hist.mem} h={24} max={100} color="var(--p-ocean)" /></div>
        </div>
        <div class="mn-box">
          <div class="mn-bh">Network</div>
          <div class="mn-net"><span class="mn-k" style={{ color: "var(--p-moss)" }}>↓ {perSec(s().rx)}</span><Graph vals={hist.rx} h={24} max={netMax()} color="var(--p-moss)" /></div>
          <div class="mn-net"><span class="mn-k" style={{ color: "var(--p-plum)" }}>↑ {perSec(s().tx)}</span><Graph vals={hist.tx} h={24} max={netMax()} color="var(--p-plum)" down /></div>
        </div>
        <div class="mn-box mn-disks">
          <div class="mn-bh">Disks</div>
          <For each={s().disks} fallback={<div class="mn-note">None to show.</div>}>
            {(d) => (
              <>
                <div class="mn-row2" title={d.mount}>
                  <span class="mn-k mn-mount">{d.mount}</span>
                  <Bar parts={[{ pct: d.total ? (d.used / d.total) * 100 : 0, color: d.used / d.total > 0.9 ? "var(--bad)" : d.used / d.total > 0.8 ? "var(--warn)" : "var(--p-slate)" }]} />
                  <span class="mn-v">{bytes(d.used)} / {bytes(d.total)}</span>
                </div>
                <Show when={d.read !== null && (d.read || d.write)}>
                  <div class="mn-row2 mn-io"><span /><span class="mn-v">r {perSec(d.read ?? 0)} · w {perSec(d.write ?? 0)}</span><span /></div>
                </Show>
              </>
            )}
          </For>
        </div>
      </div>
    );
  };

  const Th = (tp: { k: SortKey; label: string; class?: string }) => (
    <th class={tp.class} classList={{ "mn-sorted": v.sort === tp.k, "mn-asc": v.sort === tp.k && v.asc }} onClick={() => setSort(tp.k)}>{tp.label}</th>
  );

  const Table = () => (
    <table class="mn-tb">
      <colgroup>
        <col class="mn-col-name" /><col class="mn-col-pid" /><col class="mn-col-cpu" /><col class="mn-col-mem" /><col class="mn-col-user" /><col class="mn-col-up" /><col /><col class="mn-col-end" />
      </colgroup>
      <thead>
        <tr>
          <Th k="name" label="Process" /><Th k="pid" label="PID" class="mn-num" /><Th k="cpu" label="CPU" class="mn-num" /><Th k="mem" label="Memory" class="mn-num" />
          <Th k="user" label="User" class="mn-user" /><Th k="up" label="Up" class="mn-num" /><th class="mn-cmd">Command</th><th><span class="mn-hidden">End</span></th>
        </tr>
      </thead>
      <tbody>
        <Index each={rows()}>
          {(r) => {
            const x = () => r().p;
            return (
              <tr classList={{ "mn-on": x().pid === v.sel, "mn-ending": ending().has(x().pid) }} onClick={() => select(x().pid)} onDblClick={() => askEnd(x().pid)}>
                <td class="mn-nm" title={x().name}>
                  <span class="mn-tree">{r().prefix}</span>{x().name}
                  <Show when={x().mine}><span class="mn-tag mn-proj">project</span></Show>
                  <Show when={x().guard === "tri-code"}><span class="mn-tag">tri-code</span></Show>
                  <Show when={ending().has(x().pid)}><span class="mn-tag mn-warn">ending…</span></Show>
                </td>
                <td class="mn-num mn-pid">{x().pid}</td>
                <td class="mn-num" classList={{ "mn-hot": x().cpu >= 40 && x().cpu < 80, "mn-hotter": x().cpu >= 80 }}>
                  <span class="mn-cv"><Bar parts={[{ pct: x().cpu, color: tone(x().cpu) }]} />{x().cpu.toFixed(1)}</span>
                </td>
                <td class="mn-num">{bytes(x().mem)}</td>
                <td class="mn-user mn-dim" title={x().user}>{x().user}</td>
                <td class="mn-num mn-dim">{duration(at() - x().start)}</td>
                <td class="mn-cmd" title={x().cmd}>{x().cmd}</td>
                <td class="mn-end">
                  <button class="mn-endb" disabled={!!x().guard} title={x().guard ? guardText(x()) : `End ${x().name} (x)`} aria-label={`End ${x().name}`} onClick={(e) => { e.stopPropagation(); askEnd(x().pid); }}>
                    <Icon name="x" size={12} />
                  </button>
                </td>
              </tr>
            );
          }}
        </Index>
      </tbody>
    </table>
  );

  const Confirm = (cp: { a: Ask }) => {
    const windows = () => /windows/i.test(snap()?.os ?? "") && !isRemote(p());
    return (
      <div class="mn-confirm" role="alertdialog" aria-label={`End ${cp.a.name}?`}>
        <span>End <b>{cp.a.name}</b> <span class="mn-pid">{cp.a.pid}</span>
          <Show when={cp.a.kids}> and its <b>{cp.a.kids}</b> {cp.a.kids === 1 ? "child" : "children"}</Show>?
        </span>
        <span class="mn-how">{windows() ? "taskkill /T /F" : "TERM to the tree, then KILL what's left"}{cp.a.mine ? "" : " · not part of this project"}</span>
        <span class="mn-grow" />
        <button class="mn-btn" onClick={() => setAsk(null)}>Cancel <Key k="Esc" /></button>
        <button class="mn-btn mn-danger" onClick={() => void confirmEnd()}>End <Key k="↵" /></button>
      </div>
    );
  };

  const Detail = () => (
    <div class="mn-det">
      <Show when={selected()} fallback={<p class="mn-dim">Pick a process.</p>}>
        {(x) => {
          const kids = () => descendants(snap()?.procs ?? [], x().pid);
          const chain = () => {
            const out: Proc[] = [];
            const seen = new Set([x().pid]);
            for (let at = byPid().get(x().ppid); at && !seen.has(at.pid); at = byPid().get(at.ppid)) {
              seen.add(at.pid);
              out.unshift(at);
            }
            return out;
          };
          return (
            <>
              <h3>{x().name}<Show when={x().mine}><span class="mn-tag mn-proj">project</span></Show></h3>
              <div class="mn-pidl">pid {x().pid} · parent {x().ppid || "—"}{x().user ? ` · ${x().user}` : ""}</div>
              <div class="mn-cmdfull">{x().cmd}</div>
              <dl>
                <dt>Folder</dt><dd class="mn-mono">{x().cwd ?? "—"}</dd>
                <dt>Started</dt><dd>{new Date(x().start * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {duration(at() - x().start)} ago</dd>
                <dt>Children</dt><dd>{kids().length ? `${kids().length} (${[...new Set(kids().map((k) => k.name))].slice(0, 3).join(", ")})` : "none"}</dd>
              </dl>
              <div class="mn-sec">CPU <span>{x().cpu.toFixed(1)}%</span></div>
              <Graph vals={hist.pcpu} h={34} max={Math.max(100, ...hist.pcpu)} color={tone(x().cpu)} />
              <div class="mn-sec">Memory <span>{bytes(x().mem)}</span></div>
              <Graph vals={hist.pmem} h={34} max={Math.max(1, ...hist.pmem) * 1.3} color="var(--p-ocean)" />
              <div class="mn-sec">Started by</div>
              <div class="mn-chain">
                <For each={chain()}>{(c) => <><button onClick={() => select(c.pid)}>{c.name}</button> › </>}</For><b>{x().name}</b>
              </div>
              <div class="mn-acts">
                <button class="mn-btn mn-danger" disabled={!!x().guard || ending().has(x().pid)} onClick={() => askEnd(x().pid)}>
                  End{kids().length ? ` with ${kids().length} ${kids().length === 1 ? "child" : "children"}` : ""}
                </button>
                <button class="mn-btn" onClick={() => { copyText(x().cmd); flash("copied the command"); }}>Copy command</button>
              </div>
              <Show when={x().guard}><p class="mn-why">{guardText(x())}</p></Show>
            </>
          );
        }}
      </Show>
    </div>
  );

  const FailurePage = (fp: { err: string }) => (
    <div class="mn-msg">
      <div>
        <Show when={/no \/proc/.test(fp.err)} fallback={<><h3><Icon name="triangle-alert" size={16} />Couldn't sample {isRemote(p()) ? p().host : "this machine"}</h3><pre>{fp.err}</pre></>}>
          <h3><Icon name="triangle-alert" size={16} />{p().host} has no /proc</h3>
          <p>On an ssh host the Monitor reads <code>/proc</code>, which only Linux has. {fp.err.replace(/^no \/proc: /, "")}.</p>
        </Show>
        <p>Trying again every {RETRY / 1000} seconds.</p>
        <button class="mn-btn" onClick={start}>Try now</button>
      </div>
    </div>
  );

  return (
    <div class="mn" ref={rootEl}>
      <Header />
      <Show when={snap()} fallback={failure() ? <FailurePage err={failure()!} /> : <div class="mn-msg"><p class="mn-dim">{v.paused ? "Paused." : "Sampling…"}</p></div>}>
        {(s) => (
          <div class="mn-body">
            <Meters s={s()} />
            <div class="mn-procs">
              <div class="mn-plist">
                <div class="mn-pt">
                  <div class="mn-seg" role="group" aria-label="Which processes">
                    <button aria-pressed={v.scope === "all"} onClick={() => setV("scope", "all")}>All</button>
                    <button aria-pressed={v.scope === "mine"} title="Processes in the project's folder and what they started (a)" onClick={() => setV("scope", "mine")}>This project</button>
                  </div>
                  <label class="mn-search" title="Name, command, pid or user (/)">
                    <Icon name="search" size={12} />
                    <input placeholder="Filter processes" aria-label="Filter processes" value={v.find} onInput={(e) => setV("find", e.currentTarget.value)} />
                  </label>
                  <button class="mn-ib" aria-pressed={v.tree && !v.find.trim()} disabled={!!v.find.trim()} title="Tree (t)" onClick={() => setV("tree", (x) => !x)}><Icon name="list-tree" size={12} />Tree</button>
                  <span class="mn-grow" />
                  <Show when={failure()}><span class="mn-badtext" title={failure()!}>disconnected · retrying</span></Show>
                  <span class="mn-count">{rows().length} shown</span>
                </div>
                <div class="mn-scroll" ref={scrollEl}>
                  <Show when={rows().length} fallback={<div class="mn-none">{v.find.trim() ? `No processes match “${v.find.trim()}”.` : "Nothing runs in this project's folder."}</div>}>
                    <Table />
                  </Show>
                </div>
                <Show when={ask()}>{(a) => <Confirm a={a()} />}</Show>
              </div>
              <Detail />
            </div>
          </div>
        )}
      </Show>
      <div class="mn-status">
        <span>sorted by {SORT_NAME[v.sort]}{v.tree && !v.find.trim() ? " · tree" : ""}</span>
        <span class="mn-grow" />
        <span class="mn-keys">
          <span><Key k="j" /> <Key k="k" /> move</span><span><Key k="x" /> end</span><span><Key k="/" /> filter</span><span><Key k="t" /> tree</span>
          <span><Key k="a" /> scope</span><span><Key k="c" /> <Key k="m" /> <Key k="n" /> <Key k="p" /> sort</span><span><Key k="space" /> pause</span>
        </span>
      </div>
    </div>
  );
}
