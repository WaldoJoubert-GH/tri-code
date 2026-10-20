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
            <dd>Switch layout: main + stack, grid, or mono (a centered column)</dd>
            <dt><Keys keys={["Alt", ","]} /> <Keys keys={["Alt", "."]} /></dt>
            <dd>Less / more gap between windows</dd>
            <dt><Keys keys={["Alt", "F"]} /></dt>
            <dd>Maximize the focused window, again to restore</dd>
            <dt><Keys keys={["Alt", "N"]} /></dt>
            <dd>Minimise the focused window: it leaves the canvas and its tab dims; click the tab to bring it back</dd>
            <dt><Keys keys={["Alt", "Shift", "N"]} /></dt>
            <dd>Bring back the window minimised last</dd>
          </dl>
          <h4>Project</h4>
          <dl>
            <dt><Keys keys={["Alt", "O"]} /></dt>
            <dd>Open a project, or add an environment (local or ssh)</dd>
            <dt><Keys keys={["Alt", "S"]} /></dt>
            <dd>Collapse or expand the sidebar · while collapsed, hover the rail to peek at the full list</dd>
            <dt><Keys keys={["Alt", "W"]} /></dt>
            <dd>New worktree: another checkout of this repo on its own branch, listed under the project with its own windows</dd>
            <dt><Keys keys={["Alt", "P"]} /></dt>
            <dd>Change this project's name, icon, accent colour and background</dd>
          </dl>
          <h4>Windows and links</h4>
          <dl>
            <dt><Keys keys={["Alt", "I"]} /></dt>
            <dd>Open or focus this project's issues panel (the `.dev/` folder)</dd>
            <dt><Keys keys={["Alt", "E"]} /></dt>
            <dd>Open or focus this project's files window (the project folder)</dd>
            <dt><Keys keys={["Alt", "T"]} /></dt>
            <dd>
              Go to file (or click the project path in the toolbar). Type to fuzzy-search the project's files, or a folder and <kbd>/</kbd> to
              browse it: <kbd>Tab</kbd> completes, <kbd>Backspace</kbd> after a <kbd>/</kbd> goes up. <kbd>Enter</kbd> opens the file,
              <kbd>Ctrl</kbd><kbd>Enter</kbd> in a new window, <kbd>Shift</kbd><kbd>Enter</kbd> types <code>@path</code> into the agent window
            </dd>
            <dt><Keys keys={["Alt", "C"]} /></dt>
            <dd>Open or focus this project's git window: stage, commit, push, open a PR and merge, with ✦ drafts</dd>
            <dt><Keys keys={["Alt", "Enter"]} /></dt>
            <dd>New terminal like the focused one, else a shell</dd>
            <dt><Keys keys={["Alt", ";"]} /></dt>
            <dd>Open or focus the agents window: the terminal apps and web apps in the + menu, each with a command or URL, an icon and an optional Alt hotkey of its own</dd>
            <dt><Keys keys={["Alt", "B"]} /></dt>
            <dd>New browser window</dd>
            <dt><Keys keys={["Ctrl", "D"]} /></dt>
            <dd>Favourite the browser's page (or click ☆). Favourites belong to the project: a bar under the address and the tiles on a new browser. Right-click one to rename or remove it, drag to reorder</dd>
            <dt><Keys keys={["Ctrl"]} /> + click link</dt>
            <dd>Open it in this project's browser window (one tiles in if needed)</dd>
            <dt><Keys keys={["Ctrl", "Shift"]} /> + click link</dt>
            <dd>Open it in the system browser</dd>
            <dt><Keys keys={["Alt", "Q"]} /></dt>
            <dd>Close the focused window (undo for 5s)</dd>
            <dt><Keys keys={["Alt", "X"]} /></dt>
            <dd>Command palette: type to run any command, go to a window on any workspace, or switch project (or the prompt button next to ? in the toolbar)</dd>
            <dt><Keys keys={["Alt", "/"]} /></dt>
            <dd>Show or hide this list</dd>
          </dl>
          <h4>Signals</h4>
          <dl>
            <dt><Keys keys={["Alt", "U"]} /></dt>
            <dd>Go to the next agent that needs you: waiting for input first, then errors, then finished work. The same dot marks its project icon, workspace number, tab and title bar</dd>
            <dt>🔔 in the status line</dt>
            <dd>A sound per signal, when to alert, desktop notifications and Do not disturb, for every project. Appearance › Signals sets them per project</dd>
          </dl>
          <h4>Text</h4>
          <dl>
            <dt><Keys keys={["Ctrl", "C"]} /></dt>
            <dd>Copy the selection (sends Ctrl+C to the app when nothing is selected)</dd>
            <dt><Keys keys={["Ctrl", "V"]} /></dt>
            <dd>Paste into the focused window</dd>
            <dt><Keys keys={["Shift"]} /> + drag</dt>
            <dd>Select text in claude, pi or any app that captures the mouse</dd>
          </dl>
        </div>
      </div>
    </Show>
  );
}
