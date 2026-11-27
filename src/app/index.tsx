/* @refresh reload */
import { render } from "solid-js/web";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
// Before any module's CSS, as when Canvas.tsx was the first to load it: a module's index.ts now loads
// all of its files early, so files.css and git.css would otherwise come first and lose `.fnote` and
// `.lucide.spin` to canvas.css. Goes when canvas.css is split.
import "./canvas.css";
import App from "./App";
import { restoreLook } from "../shared/look";

restoreLook();
// TEMPORARY self-test, removed before commit.
if (import.meta.env.VITE_MDPDF_SELFTEST) setTimeout(() => void import("./__selftest").then((m) => m.selftest(import.meta.env.VITE_MDPDF_SELFTEST)), 3000);

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
