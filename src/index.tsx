/* @refresh reload */
import { render } from "solid-js/web";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";

// Opening the Vite URL in a normal browser has no Rust backend, so nothing
// (terminals, saved state, folder listing) can work there.
const inTauri = "__TAURI_INTERNALS__" in window;
// Only the main webview's top-level page boots the app. A browser window pointed at
// this dev server (a child webview or an iframe) must not start a second copy that
// would kill the real one's terminals on startup.
const isMainView = window.top === window &&
  (window as any).__TAURI_INTERNALS__?.metadata?.currentWebview?.label === "main";

render(
  () =>
    inTauri && isMainView ? (
      <App />
    ) : inTauri ? (
      <div class="empty no-tauri">This is tri-code's own UI, opened inside a tri-code browser window.</div>
    ) : (
      <div class="empty no-tauri">
        This page needs the tri-code backend. Run <code>bun run tauri dev</code> and use the app window
        instead of opening this URL in a browser.
      </div>
    ),
  document.getElementById("root")!,
);
