/* @refresh reload */
import { render } from "solid-js/web";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";

// Opening the Vite URL in a normal browser has no Rust backend, so nothing
// (terminals, saved state, folder listing) can work there.
const inTauri = "__TAURI_INTERNALS__" in window;

render(
  () =>
    inTauri ? (
      <App />
    ) : (
      <div class="empty no-tauri">
        This page needs the tri-code backend. Run <code>bun run tauri dev</code> and use the app window
        instead of opening this URL in a browser.
      </div>
    ),
  document.getElementById("root")!,
);
