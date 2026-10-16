// Hotkey overlay (Alt+/). Click the backdrop or press Escape to close.

import { For, Show, createSignal } from "solid-js";

export const [helpOpen, setHelpOpen] = createSignal(false);

function Keys(props: { keys: string[] }) {
  return <For each={props.keys}>{(k) => <kbd>{k}</kbd>}</For>;
}

export function HelpOverlay() {
  return (
    <Show when={helpOpen()}>
      <div class="help" onClick={(e) => e.target === e.currentTarget && setHelpOpen(false)}>
        <div class="card" role="dialog" aria-label="Hotkeys">
          <h3>Window hotkeys</h3>
          <p>
            Windows always tile. Every window binding starts with Alt, so plain keys and Ctrl chords still reach the terminal.
            Arrow keys work anywhere H J K L do.
          </p>
          <h4>Focus</h4>
          <dl>
            <dt><Keys keys={["Alt", "H J K L"]} /></dt>
            <dd>Focus the nearest window in that direction</dd>
            <dt><Keys keys={["Alt", "1…4"]} /></dt>
            <dd>Go to workspace 1–4 of this project</dd>
            <dt><Keys keys={["Alt", "Shift", "1…4"]} /></dt>
            <dd>Send the focused window to that workspace (or drag its title bar onto a workspace number)</dd>
            <dt><Keys keys={["Alt", "["]} /> <Keys keys={["Alt", "]"]} /></dt>
            <dd>Previous / next project</dd>
          </dl>
          <h4>Arrange</h4>
          <dl>
            <dt><Keys keys={["Alt", "Shift", "dir"]} /></dt>
            <dd>Swap with the neighbouring window (or drag a title bar onto another window)</dd>
            <dt><Keys keys={["Alt", "Ctrl", "H / L"]} /></dt>
            <dd>Move the main / stack split (or drag the gap)</dd>
            <dt><Keys keys={["Alt", "M"]} /></dt>
            <dd>Make the focused window the main one (Main + stack)</dd>
            <dt><Keys keys={["Alt", "G"]} /></dt>
            <dd>Switch layout: main + stack, or grid</dd>
            <dt><Keys keys={["Alt", ","]} /> <Keys keys={["Alt", "."]} /></dt>
            <dd>Less / more gap between windows</dd>
            <dt><Keys keys={["Alt", "F"]} /></dt>
            <dd>Maximize the focused window, again to restore</dd>
          </dl>
          <h4>Project</h4>
          <dl>
            <dt><Keys keys={["Alt", "S"]} /></dt>
            <dd>Collapse or expand the sidebar</dd>
            <dt><Keys keys={["Alt", "P"]} /></dt>
            <dd>Change this project's accent colour and background</dd>
          </dl>
          <h4>Windows and links</h4>
          <dl>
            <dt><Keys keys={["Alt", "I"]} /></dt>
            <dd>Open or focus this project's issues panel (the `.dev/` folder)</dd>
            <dt><Keys keys={["Alt", "Enter"]} /></dt>
            <dd>New window of the focused kind</dd>
            <dt><Keys keys={["Alt", "B"]} /></dt>
            <dd>New browser window</dd>
            <dt><Keys keys={["Ctrl"]} /> + click link</dt>
            <dd>Open it in this project's browser window (one tiles in if needed)</dd>
            <dt><Keys keys={["Ctrl", "Shift"]} /> + click link</dt>
            <dd>Open it in the system browser</dd>
            <dt><Keys keys={["Alt", "Q"]} /></dt>
            <dd>Close the focused window (undo for 5s)</dd>
            <dt><Keys keys={["Alt", "/"]} /></dt>
            <dd>Show or hide this list</dd>
          </dl>
        </div>
      </div>
    </Show>
  );
}
