// Feedback: the status line's popover for reporting a bug or suggesting a feature to tri-code
// itself. It files an issue on tri-code's GitHub repo with the local gh login (`gh_feedback`);
// without gh, or when gh refuses, it opens GitHub's new-issue form prefilled instead.
// What was typed survives closing the popover until it is sent. Chosen from
// design/support-widget.html (variant A).

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { openExternal } from "./browsers";
import { appVersion } from "./updater";
import { showToast } from "./ui";

const REPO = "WaldoJoubert-GH/tri-code";
const KINDS = { bug: { name: "Bug", label: "bug", ask: "What went wrong?" }, idea: { name: "Idea", label: "enhancement", ask: "What would you like?" } };
type Kind = keyof typeof KINDS;

const platform = (() => {
  const ua = navigator.userAgent;
  return /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "unknown OS";
})();
/** What a report carries besides the user's words; each can be left out with a click. */
const CONTEXT = { version: `tri-code ${appVersion}`, platform };
type Ctx = keyof typeof CONTEXT;

const blank = () => ({ kind: "bug" as Kind, title: "", body: "", ctx: { version: true, platform: true } as Record<Ctx, boolean> });
const [form, setForm] = createStore(blank());
const [sending, setSending] = createSignal(false);

const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
export const feedbackOpen = () => anchor() !== null;
export const closeFeedback = () => setAnchor(null);
export function toggleFeedback(a?: HTMLElement | null) {
  if (anchor()) return closeFeedback();
  setAnchor(a ?? document.getElementById("feedbackBtn"));
}

function bodyOf() {
  const ctx = (Object.keys(CONTEXT) as Ctx[]).filter((k) => form.ctx[k]).map((k) => `- ${CONTEXT[k]}`);
  return [form.body.trim() || "_No details given._", ...(ctx.length ? ["", "<sub>Sent from tri-code</sub>", ...ctx] : [])].join("\n");
}

/** GitHub's new-issue form, prefilled. Kept well under the length browsers and GitHub accept. */
function formUrl(title: string, body: string, label: string) {
  const u = (b: string) => `https://github.com/${REPO}/issues/new?labels=${label}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
  return u(body).length < 7000 ? u(body) : u(body.slice(0, 3000) + "\n\n…");
}

async function send() {
  const title = form.title.trim();
  if (!title || sending()) return;
  const body = bodyOf(), label = KINDS[form.kind].label;
  setSending(true);
  try {
    const url = await invoke<string>("gh_feedback", { title, body, label });
    const n = url.match(/\/issues\/(\d+)/)?.[1];
    showToast({ msg: `Filed ${n ? `#${n}` : "it"} on ${REPO}. Thanks!` });
  } catch (e) {
    console.warn("gh_feedback failed, opening the GitHub form:", e);
    openExternal(formUrl(title, body, label));
    showToast({ msg: "gh couldn't file it, so GitHub's form is open in your browser to finish" });
  } finally {
    setSending(false);
  }
  setForm(blank());
  closeFeedback();
}

/** The status line's Feedback popover. Mount once (in App); Escape is handled in hotkeys.ts. */
export function FeedbackPopover() {
  const onDown = (e: PointerEvent) => {
    if (anchor() && !(e.target as Element).closest(".pop, #feedbackBtn")) closeFeedback();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  /** Above the button, kept inside the window. */
  const place = (el: HTMLElement, a: HTMLElement) => {
    const r = a.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8)) + "px";
    el.style.top = Math.max(8, r.top - el.offsetHeight - 6) + "px";
    el.querySelector<HTMLInputElement>("input")?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <Show when={anchor()} keyed>
      {(a) => (
        <div class="pop feedback" role="dialog" aria-label="Feedback" onKeyDown={onKey} ref={(el) => requestAnimationFrame(() => place(el, a))}>
          <div class="ttl">
            Tell us about tri-code
            <div class="seg" role="group" aria-label="Kind">
              <For each={Object.entries(KINDS) as [Kind, (typeof KINDS)[Kind]][]}>
                {([k, v]) => <button type="button" aria-pressed={form.kind === k} onClick={() => setForm("kind", k)}>{v.name}</button>}
              </For>
            </div>
          </div>
          <input placeholder={KINDS[form.kind].ask} value={form.title} onInput={(e) => setForm("title", e.currentTarget.value)} />
          <textarea placeholder="Details, steps, what you expected… (optional)" value={form.body} onInput={(e) => setForm("body", e.currentTarget.value)} />
          <div class="chips" title="Sent with the report. Click one to leave it out.">
            <For each={Object.keys(CONTEXT) as Ctx[]}>
              {(k) => (
                <button type="button" class="chip" classList={{ off: !form.ctx[k] }} aria-pressed={form.ctx[k]} onClick={() => setForm("ctx", k, (on) => !on)}>
                  {CONTEXT[k]}
                </button>
              )}
            </For>
          </div>
          <div class="foot">
            <span>Files a GitHub issue as you, via gh</span>
            <button type="button" class="primary" disabled={!form.title.trim() || sending()} onClick={() => void send()}>
              {sending() ? "Sending…" : "Send"} <kbd>Ctrl+⏎</kbd>
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
