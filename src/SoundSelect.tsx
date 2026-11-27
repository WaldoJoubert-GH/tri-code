// The one picker for a signal's sound, wherever one is chosen (the bell, Appearance › Signals, a
// Command's sounds, the Welcome window). Sounds come in groups: tri-code's built-ins, the
// system's alert sounds and My sounds; "Upload a sound…" adds a file to My sounds and picks it.
// Chosen from design "Signal Sounds" (variant B).

import { For, Show, onMount } from "solid-js";
import { Project, SoundEvent, app } from "./shared/state/state";
import { SOUNDS, SYSTEM_NAME, addMySound, loadSystemSounds, soundName, systemSounds } from "./signals";

const UPLOAD = "__upload";

/** A <select> and its hidden file input, so it fits a grid cell like a plain select. */
export function SoundSelect(props: {
  value: string;
  onPick: (id: string) => void;
  label: string;
  /** Options above the groups: "Default", or a project's sound. */
  lead?: [string, string][];
  /** The project whose own upload ("custom") the value may be. */
  project?: Project;
  ev?: SoundEvent;
  class?: string;
}) {
  let file: HTMLInputElement | undefined;
  onMount(loadSystemSounds);

  /** The system's sounds, plus the chosen one when this machine lacks it (a configuration from another OS). */
  const system = () => {
    const list = systemSounds();
    const cur = props.value.startsWith("system:") ? props.value.slice(7) : "";
    return cur && !list.includes(cur) ? [...list, cur] : list;
  };
  const mine = (): [string, string][] => {
    const list: [string, string][] = app.notify.mine.map((m) => [`mine:${m.id}`, m.name]);
    if (props.value.startsWith("mine:") && !list.some(([k]) => k === props.value)) list.push([props.value, soundName(props.value)]);
    if (props.value === "custom") list.push(["custom", soundName("custom", props.project, props.ev)]);
    return list;
  };
  const opt = (k: string, name: string) => <option value={k} selected={k === props.value}>{name}</option>;

  return (
    <>
      <select
        class={props.class}
        aria-label={props.label}
        onChange={(e) => {
          const el = e.currentTarget;
          if (el.value !== UPLOAD) return props.onPick(el.value);
          el.value = props.value;
          file?.click();
        }}
      >
        <For each={props.lead}>{([k, name]) => opt(k, name)}</For>
        <optgroup label="Built-in">
          <For each={Object.entries(SOUNDS)}>{([k, s]) => opt(k, s.name)}</For>
        </optgroup>
        <Show when={system().length}>
          <optgroup label={`System · ${SYSTEM_NAME}`}>
            <For each={system()}>{(n) => opt(`system:${n}`, n)}</For>
          </optgroup>
        </Show>
        <Show when={mine().length}>
          <optgroup label="My sounds">
            <For each={mine()}>{([k, name]) => opt(k, name)}</For>
          </optgroup>
        </Show>
        {opt("off", "Off")}
        <option value={UPLOAD}>Upload a sound…</option>
      </select>
      <input
        ref={file}
        type="file"
        accept="audio/*"
        hidden
        onChange={async (e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          const id = f && (await addMySound(f));
          if (id) props.onPick(id);
        }}
      />
    </>
  );
}
