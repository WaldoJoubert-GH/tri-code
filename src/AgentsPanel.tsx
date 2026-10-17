// The agents window: every agent as an editable row (icon, name, command, hotkey), plus a
// last row that adds one as you type. Changes apply as you type; the + menu and hotkeys follow.
// One window per project, but the list is global. Chosen from design/agents.html (variant B).

import { For, Show, createSignal } from "solid-js";
import { type Agent, type Project, addAgent, app, moveAgent, removeAgent, restoreAgent, updateAgent } from "./state";
import { hotkeyKeys, hotkeyProblem, launchAgent, nameProblem, newAgent, recording, setRecording } from "./agents";
import { Icon, toggleIconPicker } from "./lucide";
import { flash, showToast } from "./ui";
import "./agents.css";

const MODIFIERS = new Set(["Alt", "Shift", "Control", "Meta", "AltGraph"]);

/** Click, then press an Alt chord. Backspace clears, Escape (or clicking away) cancels. */
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
    if (!e.altKey) return flash("hotkeys start with Alt, so plain keys and Ctrl chords still reach the terminal");
    updateAgent(props.agent.id, { hotkey: { code: e.code, ...(e.shiftKey ? { shift: true } : {}), ...(e.ctrlKey ? { ctrl: true } : {}) } });
    setRecording(null);
  };
  return (
    <button
      class="ag-hk"
      classList={{ rec: on(), bad: !!hotkeyProblem(props.agent) }}
      title={on() ? "Press Alt + a key · Backspace clears · Esc cancels" : "Click, then press a chord"}
      onClick={() => setRecording(on() ? null : props.agent.id)}
      onKeyDown={onKey}
      onBlur={() => on() && setRecording(null)}
    >
      <Show when={!on()} fallback={<span>press Alt + a key…</span>}>
        <Show when={props.agent.hotkey} fallback={<span>no hotkey</span>}>
          {(h) => <For each={hotkeyKeys(h())}>{(k) => <kbd>{k}</kbd>}</For>}
        </Show>
      </Show>
    </button>
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
          <span /><span>Icon</span><span>Name</span><span>Command</span><span>Hotkey</span><span />
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
                <input
                  class="ag-in mono"
                  value={a.command}
                  placeholder="(login shell)"
                  spellcheck={false}
                  onInput={(e) => updateAgent(a.id, { command: e.currentTarget.value })}
                />
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
              <Show when={nameProblem(a) || hotkeyProblem(a)}>
                {(msg) => <div class="ag-msg">{msg()}{hotkeyProblem(a) ? " · the hotkey is ignored" : ""}</div>}
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
          <input class="ag-in" placeholder="add an agent…" spellcheck={false} onInput={(e) => addFrom(e.currentTarget)} />
        </div>
        <p class="ag-note">
          Commands run in the project folder on the project's host (over ssh for remote projects); an empty command is your
          login shell. Editing a command changes new windows only. Hotkeys start with Alt, so plain keys and Ctrl chords keep
          reaching the terminal. The list is shared by every project.
        </p>
      </div>
    </div>
  );
}
