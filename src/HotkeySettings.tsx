// Settings › Hotkeys: the Hotkey Modifier, then every Keymap action and every agent with the keys
// it has now. Click a key to change it, + to add another; a key another action or agent has
// offers Swap (or Move here, when adding). Changed rows show a dot and ↺; Reset all puts every
// action back. Agents keep their one hotkey on the agent (also edited in the agents window).

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { type Chord, type Hotkey, app, setSettings, updateAgent } from "./state";
import { metaName, modLabel } from "./modkey";
import {
  ACTIONS, actionById, changed, chordKeys, chordProblem, chordText, keysOf, owner, recorded, sameChord, setKeys,
} from "./keymap";
import { recording, setRecording } from "./agents";
import { flash } from "./ui";

const MODIFIERS = new Set(["Alt", "Shift", "Control", "Meta", "AltGraph", "OS"]);
const GROUPS = ["Focus", "Arrange", "Project", "Windows and links", "Signals", "Agents", "Text"];

/** A row: a Keymap action, or an agent (one hotkey, kept on the agent). */
type Row = { kind: "action" | "agent"; id: string; desc: string; keys: Chord[]; text?: boolean; changed: boolean };
/** Who has a chord: an action's key, or an agent's hotkey. */
type Holder = { kind: "action"; id: string; index: number } | { kind: "agent"; id: string };
type Clash = { row: Row; i: number; chord?: Chord; other?: Holder; blocked?: string };

const [clash, setClash] = createSignal<Clash | null>(null);

const agentName = (id: string) => app.agents.find((a) => a.id === id)?.name || "an agent";
const holderName = (h: Holder) => (h.kind === "action" ? actionById(h.id)!.desc : `${agentName(h.id)} (agent)`);

function rows(): Row[] {
  return [
    ...ACTIONS.map((a): Row => ({ kind: "action", id: a.id, desc: a.desc, keys: keysOf(a.id), text: a.text, changed: changed(a.id) })),
    ...app.agents.map((a): Row => ({ kind: "agent", id: a.id, desc: a.name || "untitled", keys: a.hotkey ? [a.hotkey] : [], changed: false })),
  ];
}
const groupOf = (r: Row) => (r.kind === "agent" ? "Agents" : actionById(r.id)!.group);

/** Who else has `c`, other than `row`. */
function holder(c: Chord, row: Row): Holder | undefined {
  const a = owner(c, row.kind === "action" ? row.id : undefined);
  if (a) return { kind: "action", ...a };
  const g = app.agents.find((x) => x.hotkey && sameChord(x.hotkey, c) && !(row.kind === "agent" && x.id === row.id));
  return g && { kind: "agent", id: g.id };
}

function store(row: Row, keys: Chord[]) {
  if (row.kind === "action") setKeys(row.id, keys);
  else updateAgent(row.id, { hotkey: keys[0] as Hotkey | undefined });
}

function setHolder(h: Holder, c: Chord | undefined) {
  if (h.kind === "agent") return updateAgent(h.id, { hotkey: c as Hotkey | undefined });
  const keys = [...keysOf(h.id)];
  if (c) keys[h.index] = c;
  else keys.splice(h.index, 1);
  setKeys(h.id, keys);
}

const keysText = (keys: Chord[]) => (keys.length ? keys.map(chordText).join(", ") : "no hotkey");

/** Put `c` in slot `i` of `row` (undefined removes the slot), or raise a clash to settle first. */
function assign(row: Row, i: number, c: Chord | undefined) {
  const keys = [...row.keys];
  if (!c) {
    keys.splice(i, 1);
    store(row, keys);
    return flash(`${row.desc}: ${keysText(keys)}`);
  }
  const problem = chordProblem(c);
  if (problem) return setClash({ row, i, blocked: problem });
  const mine = keys.findIndex((x) => sameChord(x, c));
  if (mine >= 0 && mine !== i) return flash(`${row.desc} already has ${chordText(c)}`);
  const other = holder(c, row);
  if (other) return setClash({ row, i, chord: c, other });
  keys[i] = c;
  store(row, keys);
  flash(`${row.desc}: ${keysText(keys)}`);
}

/** Swap: the other holder gets this slot's old key. Move: it loses the key. */
function settle(swap: boolean) {
  const c = clash();
  setClash(null);
  if (!c?.chord || !c.other) return;
  const old = c.row.keys[c.i];
  setHolder(c.other, swap ? old : undefined);
  const keys = [...c.row.keys];
  keys[c.i] = c.chord;
  store(c.row, keys);
  flash(swap ? `swapped with “${holderName(c.other)}”` : `moved from “${holderName(c.other)}”`);
}

const slotId = (row: Row, i: number) => `hk:${row.kind}:${row.id}:${i}`;

/** One key of a row, or the slot being recorded. Click, then press a key; the modifier is implied. */
function KeySlot(props: { row: Row; i: number; add?: boolean }) {
  const on = () => recording() === slotId(props.row, props.i);
  const chord = () => props.row.keys[props.i];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") return setRecording(null);
    e.preventDefault();
    e.stopPropagation();
    if (MODIFIERS.has(e.key)) return;
    setRecording(null);
    if (e.key === "Escape") return;
    if (e.key === "Backspace" || e.key === "Delete") return chord() && assign(props.row, props.i, undefined);
    assign(props.row, props.i, recorded(e, !!props.row.text));
  };
  // The window takes the key, so one pressed before the slot has focus still counts.
  createEffect(() => {
    if (!on()) return;
    window.addEventListener("keydown", onKey, { capture: true });
    onCleanup(() => window.removeEventListener("keydown", onKey, { capture: true }));
  });
  const start = () => {
    setClash(null);
    setRecording(on() ? null : slotId(props.row, props.i));
  };
  return (
    <Show
      when={on()}
      fallback={
        <Show
          when={chord()}
          fallback={
            props.add
              ? <button type="button" class="hk-add" title="Add another key" onClick={start}>+</button>
              : <button type="button" class="hk none" title="Click to add a hotkey" onClick={start}><span>no hotkey</span></button>
          }
        >
          {(c) => <button type="button" class="hk" title="Click to change" onClick={start}><For each={chordKeys(c())}>{(k) => <kbd>{k}</kbd>}</For></button>}
        </Show>
      }
    >
      <button
        type="button"
        class="hk rec"
        title="Press a key · Backspace removes · Esc cancels"
        ref={(el) => requestAnimationFrame(() => el.focus())}
        onBlur={() => on() && setRecording(null)}
        onClick={() => setRecording(null)}
      >
        <Show when={!props.row.text} fallback={<span>press Ctrl or Cmd + a key…</span>}>
          <kbd>{modLabel()}</kbd><span>+ press a key…</span>
        </Show>
      </button>
    </Show>
  );
}

function ClashNote(props: { c: Clash }) {
  const old = () => props.c.row.keys[props.c.i];
  return (
    <div class="hk-clash">
      <Show
        when={!props.c.blocked}
        fallback={<><span class="grow">{props.c.blocked}</span><button type="button" onClick={() => setClash(null)}>OK</button></>}
      >
        <span class="grow">
          <b>{chordText(props.c.chord!)}</b> is already “{holderName(props.c.other!)}”.{" "}
          {old() ? <>Swap them, so that one gets <b>{chordText(old()!)}</b>?</> : "Move it here, so that one loses it?"}
        </span>
        <button type="button" class="primary" onClick={() => settle(!!old())}>{old() ? "Swap" : "Move here"}</button>
        <button type="button" onClick={() => setClash(null)}>Cancel</button>
      </Show>
    </div>
  );
}

function KeyRow(props: { row: Row }) {
  const r = () => props.row;
  const def = () => (r().kind === "action" ? actionById(r().id)!.def : []);
  const isClash = () => clash()?.row.kind === r().kind && clash()?.row.id === r().id;
  // Agents have one hotkey, so only actions get a +.
  const canAdd = () => r().kind === "action" && r().keys.length > 0;
  return (
    <>
      <dt>
        <For each={r().keys}>{(_, i) => <KeySlot row={r()} i={i()} />}</For>
        <Show when={!r().keys.length}><KeySlot row={r()} i={0} /></Show>
        <Show when={canAdd()}><KeySlot row={r()} i={r().keys.length} add /></Show>
      </dt>
      <dd>
        <span class="txt">{r().desc}<Show when={r().kind === "agent"}> <small>agent</small></Show></span>
        <Show when={r().changed}>
          <i class="hk-changed" title="Changed" />
          <button type="button" class="hk-reset" title={`Back to ${keysText(def())}`} onClick={() => { setClash(null); setKeys(r().id, def()); }}>↺</button>
        </Show>
      </dd>
      <Show when={isClash() && clash()}>{(c) => <ClashNote c={c()} />}</Show>
    </>
  );
}

export function HotkeysPage() {
  const [q, setQ] = createSignal("");
  const all = createMemo(rows);
  const hit = (r: Row) => {
    const s = q().trim().toLowerCase();
    return !s || `${r.desc} ${r.keys.map(chordText).join(" ")}`.toLowerCase().includes(s) || recording()?.startsWith(`hk:${r.kind}:${r.id}:`);
  };
  const shown = () => GROUPS.map((g) => [g, all().filter((r) => groupOf(r) === g && hit(r))] as const).filter(([, rs]) => rs.length);
  const count = () => shown().reduce((n, [, rs]) => n + rs.length, 0);
  const anyChanged = () => all().some((r) => r.changed);
  const resetAll = () => {
    setClash(null);
    setSettings({ hotkeys: undefined });
    flash("every hotkey is back to its default");
  };
  const mods = [
    { mod: "alt" as const, cap: metaName === "Cmd" ? "⌥" : "Alt", name: metaName === "Cmd" ? "Option (Alt)" : "Alt", help: `The default. ${metaName} and Ctrl chords reach the terminal and the OS.` },
    {
      mod: "meta" as const, cap: metaName === "Cmd" ? "⌘" : metaName, name: metaName,
      help: metaName === "Cmd"
        ? "Like a Mac app. Cmd+C and Cmd+X still copy and cut while text is selected; Option goes to the terminal."
        : `The ${metaName} key. Your desktop may keep some ${metaName} chords for itself; Alt goes to the terminal.`,
    },
  ];
  return (
    <div class="hk-page">
      <h4>Modifier</h4>
      <div class="hk-mods" role="radiogroup" aria-label="Hotkey modifier">
        <For each={mods}>
          {(m) => (
            <button
              type="button" role="radio" class="hk-mod" aria-checked={app.settings.modKey === m.mod}
              onClick={() => { setSettings({ modKey: m.mod }); flash(`hotkeys now start with ${modLabel()}`); }}
            >
              <span class="cap">{m.cap}</span><b>{m.name}</b><small>{m.help}</small>
            </button>
          )}
        </For>
      </div>
      <p class="note">Every window hotkey starts with this key, so plain keys and Ctrl chords keep reaching the terminal.</p>
      <div class="hk-search">
        <input
          value={q()} placeholder="Search hotkeys" spellcheck={false} autocomplete="off"
          ref={(el) => requestAnimationFrame(() => el.focus())}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <Show when={q().trim()}><span>{count()} of {all().length}</span></Show>
        <button type="button" class="hk-resetall" disabled={!anyChanged()} onClick={resetAll}>Reset all</button>
      </div>
      <p class="note">Click any key to change it, or + to add another. Shift and Ctrl are optional and {modLabel()} is implied. Backspace removes it, Esc cancels.</p>
      <For each={shown()} fallback={<div class="hk-empty">No hotkey matches “{q().trim()}”.</div>}>
        {([g, rs]) => (
          <>
            <h4>{g}</h4>
            <dl class="hk-list"><For each={rs}>{(r) => <KeyRow row={r} />}</For></dl>
          </>
        )}
      </For>
      <h4>Mouse</h4>
      <dl class="hk-list">
        <dt><kbd>Ctrl</kbd> + click link</dt><dd>Open it in this project's browser window</dd>
        <dt><kbd>Ctrl</kbd><kbd>Shift</kbd> + click link</dt><dd>Open it in the system browser</dd>
        <dt><kbd>Shift</kbd> + drag</dt><dd>Select text in claude, pi or any app that captures the mouse</dd>
      </dl>
    </div>
  );
}
