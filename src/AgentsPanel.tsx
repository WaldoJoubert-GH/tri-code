// The Commands Window: every command as an editable row (icon, name, command or URL, scope, sounds,
// hotkey), plus a last row that adds one as you type. Changes apply as you type; the + menu and
// hotkeys follow, in list order. A command can be several lines (typed into a login shell), offered
// everywhere, on one Environment or in one project; the rows this project doesn't get stay listed,
// dimmed. A URL makes the row a web app (the chip before it flips to a globe); the project's
// Favourites are offered under the add row. One window per project, but the list is global.
// Chosen from design/commands.html (variant A), after design/agents.html and design/webapps.html.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import {
  type Agent, type Fav, type Project, type Scope, type SoundEvent, addAgent, app, envName, isWebApp, moveAgent, profileById,
  removeAgent, restoreAgent, updateAgent,
} from "./state";
import { profilesInUse } from "./profiles";
import {
  duplicateAgent, hotkeyKeys, hotkeyProblem, launchAgent, looksLikeUrl, nameProblem, newAgent, reaches, recording, replaceNote,
  sameScope, scopeIcon, scopeLabel, setRecording, urlProblem,
} from "./agents";
import { normalizeUrl } from "./browsers";
import { EVENTS, SOUNDS, playFor, playSound, soundFor } from "./signals";
import { Icon, toggleIconPicker } from "./lucide";
import { flash, showToast } from "./ui";
import { modDown, modLabel } from "./modkey";
import "./agents.css";

const MODIFIERS = new Set(["Alt", "Shift", "Control", "Meta", "AltGraph"]);

/** Click, then press a modifier chord. Backspace clears, Escape (or clicking away) cancels. */
function HotkeyField(props: { agent: Agent }) {
  const on = () => recording() === props.agent.id;
  const onKey = (e: KeyboardEvent) => {
    if (!on()) return;
    if (e.key === "Tab") return setRecording(null);
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(null);
    if (e.key === "Backspace" || e.key === "Delete") {
      updateAgent(props.agent.id, { hotkey: undefined });
      return setRecording(null);
    }
    if (MODIFIERS.has(e.key)) return;
    if (!modDown(e)) return flash(`hotkeys start with ${modLabel()}, so plain keys and Ctrl chords still reach the terminal`);
    updateAgent(props.agent.id, { hotkey: { code: e.code, ...(e.shiftKey ? { shift: true } : {}), ...(e.ctrlKey ? { ctrl: true } : {}) } });
    setRecording(null);
  };
  return (
    <button
      class="ag-hk"
      classList={{ rec: on(), bad: !!hotkeyProblem(props.agent) }}
      title={on() ? `Press ${modLabel()} + a key · Backspace clears · Esc cancels` : "Click, then press a chord"}
      onClick={() => setRecording(on() ? null : props.agent.id)}
      onKeyDown={onKey}
      onBlur={() => on() && setRecording(null)}
    >
      <Show when={!on()} fallback={<span>press {modLabel()} + a key…</span>}>
        <Show when={props.agent.hotkey} fallback={<span>no hotkey</span>}>
          {(h) => <For each={hotkeyKeys(h())}>{(k) => <kbd>{k}</kbd>}</For>}
        </Show>
      </Show>
    </button>
  );
}

/** The command (one line or several) or URL cell. Typing an address into a one-line command (or
 *  the other way round) flips the row's kind; the chip flips it by hand. A web app also picks its
 *  address bar. A script is folded to its first line until focused. */
function TargetField(props: { agent: Agent }) {
  const [open, setOpen] = createSignal(false);
  const web = () => isWebApp(props.agent);
  const lines = () => props.agent.command.split("\n").length;
  const setKind = (toWeb: boolean, value: string) =>
    updateAgent(props.agent.id, toWeb ? { url: value, command: "" } : { command: value, url: undefined, bar: undefined });
  const onInput = (value: string) => {
    const prev = web() ? props.agent.url ?? "" : props.agent.command;
    const isUrl = !value.includes("\n") && looksLikeUrl(value);
    if (isUrl !== looksLikeUrl(prev) && isUrl !== web()) setKind(isUrl, value);
    else updateAgent(props.agent.id, web() ? { url: value } : { command: value });
  };
  /** Grow to fit every line while focused. */
  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  return (
    <span class="ag-target">
      <button
        class="ag-kind"
        classList={{ web: web() }}
        title={`${web() ? "Web app: opens a browser window" : "Runs in a terminal"} · click to switch`}
        onClick={() => setKind(!web(), web() ? props.agent.url ?? "" : props.agent.command)}
      >
        <Icon name={web() ? "globe" : "square-terminal"} size={13} />
      </button>
      <Show
        when={!web()}
        fallback={
          <input
            class="ag-in mono"
            classList={{ bad: !!urlProblem(props.agent) }}
            value={props.agent.url ?? ""}
            placeholder="https://… or localhost:5173"
            spellcheck={false}
            onInput={(e) => onInput(e.currentTarget.value)}
          />
        }
      >
        <textarea
          class="ag-code"
          classList={{ folded: !open() }}
          rows={1}
          value={props.agent.command}
          placeholder="(login shell)"
          spellcheck={false}
          title="Enter adds a line; the lines are typed into the shell one after another"
          onFocus={(e) => {
            setOpen(true);
            fit(e.currentTarget);
          }}
          onBlur={(e) => {
            setOpen(false);
            e.currentTarget.style.height = "";
          }}
          onInput={(e) => {
            onInput(e.currentTarget.value);
            if (!isWebApp(props.agent)) fit(e.currentTarget);
          }}
        />
        <Show when={!open() && lines() > 1}>
          <span class="ag-more">+{lines() - 1} line{lines() > 2 ? "s" : ""}</span>
        </Show>
      </Show>
      <Show when={web()}>
        <span class="ag-seg" title="Address bar: full, or app (title bar only)">
          <button classList={{ on: props.agent.bar !== "app" }} onClick={() => updateAgent(props.agent.id, { bar: undefined })}>full</button>
          <button classList={{ on: props.agent.bar === "app" }} onClick={() => updateAgent(props.agent.id, { bar: "app" })}>app</button>
        </span>
        <Show when={profilesInUse()}>
          <select
            class="ag-profile"
            title="Browser profile: whose cookies and sign-ins its windows use"
            value={profileById(props.agent.profile)?.id ?? ""}
            onChange={(e) => updateAgent(props.agent.id, { profile: e.currentTarget.value || undefined })}
          >
            <option value="">project's profile</option>
            <For each={app.profiles}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
        </Show>
      </Show>
    </span>
  );
}

/** The scope or sound popover: which command, and the button it hangs under. */
type Pop = { kind: "scope" | "sound"; id: string; anchor: HTMLElement };

const soundName = (id: string) => (id === "off" ? "off" : id === "custom" ? "uploaded" : SOUNDS[id]?.name ?? id);
const projectsOn = (host: string) => app.projects.filter((p) => !p.parent && !p.sample && p.host === host).length;
const scopeProjects = () => app.projects.filter((p) => !p.parent && !p.sample);

function ScopePicker(props: { agent: Agent; onPick: (s: Scope | undefined) => void }) {
  const opt = (s: Scope | undefined, label: string, icon: string, note: string) => (
    <button classList={{ on: sameScope(s, props.agent.scope) }} onClick={() => props.onPick(s)}>
      <Icon name={icon} size={13} />
      <span class="nm">{label}</span>
      <small>{note}</small>
    </button>
  );
  const n = (k: number) => `${k} project${k === 1 ? "" : "s"}`;
  return (
    <>
      {opt(undefined, "Everywhere", scopeIcon(undefined), n(scopeProjects().length))}
      <h4>Environment</h4>
      <For each={app.environments}>{(h) => opt({ env: h }, envName(h), scopeIcon({ env: h }), n(projectsOn(h)))}</For>
      <h4>Project</h4>
      <For each={scopeProjects()}>{(p) => opt({ project: p.id }, p.name, "folder", envName(p.host))}</For>
    </>
  );
}

/** A sound per signal: the project's (unset), off, or a built-in, with ▶ to try each. */
function SoundPicker(props: { agent: Agent; project: Project }) {
  const own = (ev: SoundEvent) => props.agent.sounds?.[ev];
  const set = (ev: SoundEvent, value: string) => {
    const sounds = { ...props.agent.sounds };
    if (value) sounds[ev] = value;
    else delete sounds[ev];
    updateAgent(props.agent.id, { sounds: Object.keys(sounds).length ? sounds : undefined });
    if (value && value !== "off") playSound(value);
  };
  const play = (ev: SoundEvent) => {
    const id = own(ev);
    if (id) playSound(id);
    else void playFor(props.project, ev);
  };
  return (
    <>
      <h4>Sounds for {props.agent.name || "this command"}</h4>
      <For each={EVENTS}>
        {([ev, label]) => (
          <div class="snd">
            <label>{label}</label>
            <select classList={{ own: !!own(ev) }} value={own(ev) ?? ""} onChange={(e) => set(ev, e.currentTarget.value)}>
              <option value="">{props.project.name}'s ({soundName(soundFor(props.project, ev))})</option>
              <option value="off">Off</option>
              <For each={Object.entries(SOUNDS)}>{([id, s]) => <option value={id}>{s.name}</option>}</For>
            </select>
            <button title="Play" onClick={() => play(ev)}><Icon name="play" size={12} /></button>
          </div>
        )}
      </For>
      <div class="foot">
        <span>Plays at the signals' volume, and not during Do not disturb</span>
        <Show
          when={props.agent.sounds}
          fallback={<button onClick={() => updateAgent(props.agent.id, { sounds: { blocked: "off", done: "off", error: "off" } })}>Mute all</button>}
        >
          <button onClick={() => updateAgent(props.agent.id, { sounds: undefined })}>Use {props.project.name}'s</button>
        </Show>
      </div>
    </>
  );
}

/** The row's bell: faint while it follows the project, rung once it has sounds of its own, crossed when all are off. */
function SoundButton(props: { agent: Agent; project: Project; onOpen: (el: HTMLElement) => void }) {
  const mine = () => props.agent.sounds;
  const allOff = () => EVENTS.every(([ev]) => (mine()?.[ev] ?? soundFor(props.project, ev)) === "off");
  const title = () =>
    EVENTS.map(([ev, label]) => `${label}: ${soundName(mine()?.[ev] ?? soundFor(props.project, ev))}${mine()?.[ev] ? "" : ` (${props.project.name}'s)`}`).join("\n")
    + "\nClick to change";
  return (
    <button
      class="ag-sound"
      classList={{ own: !!mine() && !allOff(), mute: allOff() }}
      title={title()}
      onClick={(e) => props.onOpen(e.currentTarget)}
    >
      <Icon name={allOff() ? "bell-off" : mine() ? "bell-ring" : "bell"} size={13} />
    </button>
  );
}

export default function AgentsPanel(props: { project: Project }) {
  const [dragged, setDragged] = createSignal<string | null>(null);
  const [over, setOver] = createSignal<string | null>(null);
  const [pop, setPop] = createSignal<Pop | null>(null);
  const [fresh, setFresh] = createSignal<string | null>(null);
  const [q, setQ] = createSignal("");
  let listEl!: HTMLDivElement;
  let searchEl!: HTMLInputElement;
  let popEl: HTMLDivElement | undefined;

  /** Move the caret into a row's name. Synchronous (the row renders with the store update), so
   *  fast typing in the add row carries on in the new name instead of making another command. */
  const focusName = (id: string, select = false) => {
    const el = listEl.querySelector<HTMLInputElement>(`input[data-name="${id}"]`);
    el?.focus();
    if (select) el?.select();
    else el?.setSelectionRange(el.value.length, el.value.length);
  };

  const toggle = (kind: Pop["kind"], id: string, anchor: HTMLElement) =>
    setPop((p) => (p?.kind === kind && p.id === id ? null : { kind, id, anchor }));
  const popAgent = () => app.agents.find((a) => a.id === pop()?.id);
  /** Under its button, or above it when there's no room below. */
  const place = (el: HTMLDivElement) => {
    popEl = el;
    requestAnimationFrame(() => {
      const p = pop();
      if (!p) return;
      const r = p.anchor.getBoundingClientRect();
      const below = r.bottom + 4 + el.offsetHeight <= innerHeight - 8;
      el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - el.offsetHeight - 4)}px`;
    });
  };
  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (pop() && !popEl?.contains(t) && !pop()!.anchor.contains(t)) setPop(null);
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && pop()) {
      e.stopPropagation();
      setPop(null);
    }
  };
  onMount(() => {
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onEsc);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDown);
    document.removeEventListener("keydown", onEsc);
  });

  function remove(a: Agent) {
    const index = app.agents.findIndex((x) => x.id === a.id);
    const copy = { ...a };
    removeAgent(a.id);
    showToast({ msg: `Deleted ${a.name || "command"} · open windows keep running.`, undo: () => restoreAgent(copy, index) });
  }

  function duplicate(a: Agent) {
    const id = duplicateAgent(a);
    setFresh(id);
    setTimeout(() => fresh() === id && setFresh(null), 900);
    focusName(id, true);
    flash(`duplicated ${a.name || "command"}${a.hotkey ? " · the copy has no hotkey" : ""}`);
  }

  /** ↑ / ↓ on a focused grip moves the row; Alt+arrows stay the window hotkeys. */
  function nudge(a: Agent, dir: -1 | 1, grip: HTMLElement) {
    const i = app.agents.findIndex((x) => x.id === a.id);
    const j = i + dir;
    if (j < 0 || j >= app.agents.length) return;
    moveAgent(a.id, dir < 0 ? app.agents[j].id : app.agents[j + 1]?.id ?? null);
    grip.focus();
  }

  /** The project's Favourites that are not a web app yet, offered under the add row. */
  const suggestions = () => {
    const key = (url: string) => normalizeUrl(url).replace(/\/$/, "");
    const urls = new Set(app.agents.filter(isWebApp).map((a) => key(a.url ?? "")));
    return props.project.favs.filter((f) => !urls.has(key(f.url)));
  };
  function addFav(f: Fav) {
    addAgent({ ...newAgent(), name: f.name, url: f.url, icon: "globe" });
    flash(`added ${f.name} · give it an icon and a hotkey`);
  }

  function addFrom(input: HTMLInputElement) {
    if (!input.value.trim()) return;
    const a = { ...newAgent(), name: input.value };
    input.value = "";
    addAgent(a);
    focusName(a.id);
  }

  const message = (a: Agent) => nameProblem(a) || urlProblem(a) || hotkeyProblem(a);

  /** Every word of the filter is in the name, the command or URL, the scope or the hotkey. */
  const shown = () => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return app.agents;
    return app.agents.filter((a) => {
      const text = [a.name, a.command, a.url ?? "", scopeLabel(a.scope), a.hotkey ? hotkeyKeys(a.hotkey).join("+") : ""].join(" ").toLowerCase();
      return words.every((w) => text.includes(w));
    });
  };
  const clearFilter = () => {
    setQ("");
    searchEl.value = "";
  };

  return (
    <div
      class="agentswin"
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.key !== "/" || e.ctrlKey || e.altKey || e.metaKey || recording() || t.matches("input, textarea, select")) return;
        e.preventDefault();
        searchEl.focus();
      }}
    >
      <div class="ag-list" ref={listEl}>
        <div class="ag-tools">
          <Icon name="search" size={13} />
          <input
            class="ag-search"
            ref={searchEl}
            placeholder="/ filter"
            spellcheck={false}
            aria-label="Filter commands"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (searchEl.value) clearFilter();
                else searchEl.blur();
              } else if (e.key === "Enter" || e.key === "ArrowDown") {
                listEl.querySelector<HTMLInputElement>("input[data-name]")?.focus();
              }
            }}
          />
          <Show when={q()}>
            <span class="ag-count">{shown().length} of {app.agents.length}</span>
            <button class="ag-clear" title="Clear the filter (Esc)" onClick={() => { clearFilter(); searchEl.focus(); }}>
              <Icon name="x" size={12} />
            </button>
          </Show>
        </div>
        <div class="ag-row ag-th">
          <span /><span>Icon</span><span>Name</span><span>Command or URL</span><span>Scope</span><span class="ag-th-icon" title="Signal sounds"><Icon name="bell" size={12} /></span><span>Hotkey</span><span title="Whether agents may open it as a window">Agent</span><span />
        </div>
        <For each={shown()}>
          {(a) => (
            <div
              class="ag-item"
              classList={{ over: over() === a.id && dragged() !== a.id, off: !reaches(a, props.project), dragging: dragged() === a.id, fresh: fresh() === a.id }}
              title={reaches(a, props.project) ? undefined : `Not in ${props.project.name}'s + menu`}
              onDragOver={(e) => {
                if (!dragged()) return;
                e.preventDefault();
                setOver(a.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const d = dragged();
                if (d) moveAgent(d, a.id);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyD") {
                  e.preventDefault();
                  duplicate(a);
                }
              }}
            >
              <div class="ag-row">
                <span
                  class="ag-grip"
                  draggable={true}
                  tabindex={0}
                  title="Drag to reorder the + menu · or focus and press ↑ / ↓"
                  onDragStart={(e) => {
                    setDragged(a.id);
                    e.dataTransfer!.effectAllowed = "move";
                    e.dataTransfer!.setData("text/plain", a.name);
                    e.dataTransfer!.setDragImage(e.currentTarget.closest(".ag-item")!, 20, 16);
                  }}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                    e.preventDefault();
                    nudge(a, e.key === "ArrowUp" ? -1 : 1, e.currentTarget);
                  }}
                >
                  <Icon name="grip-vertical" size={13} />
                </span>
                <button
                  class="ag-icon"
                  title={`Icon: ${a.icon}`}
                  onClick={(e) => toggleIconPicker(e.currentTarget, a.icon, (icon) => updateAgent(a.id, { icon }))}
                >
                  <Icon name={a.icon} size={15} />
                </button>
                <input
                  class="ag-in"
                  classList={{ bad: !!nameProblem(a) && !!a.name }}
                  data-name={a.id}
                  value={a.name}
                  placeholder="name"
                  spellcheck={false}
                  onInput={(e) => updateAgent(a.id, { name: e.currentTarget.value })}
                />
                <TargetField agent={a} />
                <button
                  class={`ag-scope ${!a.scope ? "g" : "env" in a.scope ? "e" : "p"}`}
                  title="Which projects offer it · click to change"
                  onClick={(e) => toggle("scope", a.id, e.currentTarget)}
                >
                  <Icon name={scopeIcon(a.scope)} size={12} />
                  <span>{scopeLabel(a.scope)}</span>
                </button>
                <Show when={!isWebApp(a)} fallback={<span />}>
                  <SoundButton agent={a} project={props.project} onOpen={(el) => toggle("sound", a.id, el)} />
                </Show>
                <HotkeyField agent={a} />
                <Show when={!isWebApp(a)} fallback={<span />}>
                  <button
                    class="ag-agent"
                    classList={{ on: !!a.agentRun }}
                    title={a.agentRun ? `Agents may open this in a window of their project · click to stop` : "Agents may not open this · click to allow"}
                    onClick={() => updateAgent(a.id, { agentRun: !a.agentRun })}
                  >
                    <Icon name="bot" size={12} />
                    <span>{a.agentRun ? "agent" : "off"}</span>
                  </button>
                </Show>
                <span class="ag-ops">
                  <button title={`Open ${a.name || "one"} in ${props.project.name}`} onClick={() => launchAgent(props.project, a)}>
                    <Icon name="play" size={13} />
                  </button>
                  <button title="Duplicate (Ctrl+D)" onClick={() => duplicate(a)}>
                    <Icon name="copy" size={13} />
                  </button>
                  <button title="Delete" onClick={() => remove(a)}>
                    <Icon name="trash-2" size={13} />
                  </button>
                </span>
              </div>
              <Show
                when={message(a)}
                fallback={<Show when={replaceNote(a, props.project)}>{(note) => <div class="ag-msg note">{note()}</div>}</Show>}
              >
                {(msg) => <div class="ag-msg">{msg()}{hotkeyProblem(a) && !nameProblem(a) && !urlProblem(a) ? " · the hotkey is ignored" : ""}</div>}
              </Show>
            </div>
          )}
        </For>
        <Show when={q() && !shown().length}>
          <div class="ag-none">No command matches “{q()}”</div>
        </Show>
        <div
          class="ag-row ag-new"
          classList={{ over: over() === "end" }}
          onDragOver={(e) => {
            if (!dragged()) return;
            e.preventDefault();
            setOver("end");
          }}
          onDrop={(e) => {
            e.preventDefault();
            const d = dragged();
            if (d) moveAgent(d, null);
          }}
        >
          <span />
          <span class="ag-icon ghost"><Icon name="plus" size={14} /></span>
          <input class="ag-in" placeholder="add a command or web app…" spellcheck={false} onInput={(e) => addFrom(e.currentTarget)} />
        </div>
        <Show when={suggestions().length}>
          <div class="ag-favs">
            <span>From {props.project.name}'s favourites</span>
            <For each={suggestions()}>
              {(f) => (
                <button title={`Add ${f.url} as a web app`} onClick={() => addFav(f)}>
                  <Icon name="plus" size={12} />
                  {f.name || f.url}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={pop()} keyed>
        {(p) => (
          <Show when={popAgent()}>
            {(a) => (
              <Portal>
                <div class={`ag-pop ${p.kind === "scope" ? "scopepick" : "soundpick"}`} ref={place}>
                  <Show when={p.kind === "scope"} fallback={<SoundPicker agent={a()} project={props.project} />}>
                    <ScopePicker
                      agent={a()}
                      onPick={(s) => {
                        updateAgent(a().id, { scope: s });
                        setPop(null);
                      }}
                    />
                  </Show>
                </div>
              </Portal>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}
