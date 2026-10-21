// The agents window: every agent as an editable row (icon, name, command or URL, hotkey), plus a
// last row that adds one as you type. Changes apply as you type; the + menu and hotkeys follow.
// A URL makes the row a web app (the chip before it flips to a globe); the project's Favourites
// are offered under the add row. One window per project, but the list is global. Chosen from
// design/agents.html (variant B) and design/webapps.html (variant A).

import { For, Show, createSignal } from "solid-js";
import { type Agent, type Fav, type Project, addAgent, app, isWebApp, moveAgent, removeAgent, restoreAgent, updateAgent } from "./state";
import { hotkeyKeys, hotkeyProblem, launchAgent, looksLikeUrl, nameProblem, newAgent, recording, setRecording, urlProblem } from "./agents";
import { normalizeUrl } from "./browsers";
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

/** The command or URL cell. Typing an address into a command (or the other way round) flips
 *  the row's kind; the chip flips it by hand. A web app also picks its address bar. */
function TargetField(props: { agent: Agent }) {
  const web = () => isWebApp(props.agent);
  const setKind = (toWeb: boolean, value: string) =>
    updateAgent(props.agent.id, toWeb ? { url: value, command: "" } : { command: value, url: undefined, bar: undefined });
  const onInput = (value: string) => {
    const prev = web() ? props.agent.url ?? "" : props.agent.command;
    const isUrl = looksLikeUrl(value);
    if (isUrl !== looksLikeUrl(prev) && isUrl !== web()) setKind(isUrl, value);
    else updateAgent(props.agent.id, web() ? { url: value } : { command: value });
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
      <input
        class="ag-in mono"
        classList={{ bad: !!urlProblem(props.agent) }}
        value={web() ? props.agent.url ?? "" : props.agent.command}
        placeholder={web() ? "https://… or localhost:5173" : "(login shell)"}
        spellcheck={false}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      <Show when={web()}>
        <span class="ag-seg" title="Address bar: full, or app (title bar only)">
          <button classList={{ on: props.agent.bar !== "app" }} onClick={() => updateAgent(props.agent.id, { bar: undefined })}>full</button>
          <button classList={{ on: props.agent.bar === "app" }} onClick={() => updateAgent(props.agent.id, { bar: "app" })}>app</button>
        </span>
      </Show>
    </span>
  );
}

export default function AgentsPanel(props: { project: Project }) {
  const [dragged, setDragged] = createSignal<string | null>(null);
  const [over, setOver] = createSignal<string | null>(null);
  let listEl!: HTMLDivElement;

  /** Move the caret into a row's name. Synchronous (the row renders with the store update), so
   *  fast typing in the add row carries on in the new name instead of making another agent. */
  const focusName = (id: string) => {
    const el = listEl.querySelector<HTMLInputElement>(`input[data-name="${id}"]`);
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  };

  function remove(a: Agent) {
    const index = app.agents.findIndex((x) => x.id === a.id);
    const copy = { ...a };
    removeAgent(a.id);
    showToast({ msg: `Deleted ${a.name || "agent"} · open windows keep running.`, undo: () => restoreAgent(copy, index) });
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

  return (
    <div class="agentswin">
      <div class="ag-list" ref={listEl}>
        <div class="ag-row ag-th">
          <span /><span>Icon</span><span>Name</span><span>Command or URL</span><span>Hotkey</span><span />
        </div>
        <For each={app.agents}>
          {(a) => (
            <div
              class="ag-item"
              classList={{ over: over() === a.id && dragged() !== a.id }}
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
            >
              <div class="ag-row">
                <span
                  class="ag-grip"
                  draggable={true}
                  title="Drag to reorder the + menu"
                  onDragStart={(e) => {
                    setDragged(a.id);
                    e.dataTransfer!.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
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
                  classList={{ bad: !!nameProblem(a) }}
                  data-name={a.id}
                  value={a.name}
                  placeholder="name"
                  spellcheck={false}
                  onInput={(e) => updateAgent(a.id, { name: e.currentTarget.value })}
                />
                <TargetField agent={a} />
                <HotkeyField agent={a} />
                <span class="ag-ops">
                  <button title={`Open ${a.name || "one"}`} onClick={() => launchAgent(props.project, a)}>
                    <Icon name="play" size={13} />
                  </button>
                  <button title="Delete" onClick={() => remove(a)}>
                    <Icon name="trash-2" size={13} />
                  </button>
                </span>
              </div>
              <Show when={nameProblem(a) || urlProblem(a) || hotkeyProblem(a)}>
                {(msg) => <div class="ag-msg">{msg()}{hotkeyProblem(a) && !nameProblem(a) && !urlProblem(a) ? " · the hotkey is ignored" : ""}</div>}
              </Show>
            </div>
          )}
        </For>
        <div
          class="ag-row ag-new"
          onDragOver={(e) => dragged() && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const d = dragged();
            if (d) moveAgent(d, null);
          }}
        >
          <span />
          <span class="ag-icon ghost"><Icon name="plus" size={14} /></span>
          <input class="ag-in" placeholder="add an agent or web app…" spellcheck={false} onInput={(e) => addFrom(e.currentTarget)} />
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
        <p class="ag-note">
          Commands run in the project folder on the project's host (over ssh for remote projects); an empty command is your
          login shell. A URL (<code>localhost:5173</code>, <code>https://…</code>) makes a web app that opens a browser window
          instead; “app” hides its address bar. Editing a command or URL changes new windows only. Hotkeys start with {modLabel()}, so
          plain keys and Ctrl chords keep reaching the terminal. The list is shared by every project.
        </p>
      </div>
    </div>
  );
}
