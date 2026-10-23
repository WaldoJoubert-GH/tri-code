// Settings › Remote: turn Remote Control on, pair phones and pick which signals push to them.
// Chosen from design/remote-control.html (desktop variant B).

import { For, Show, createSignal, onCleanup } from "solid-js";
import { EVENTS } from "./signals";
import {
  cancelPairing, forgetPhone, pairPhone, phoneBusy, phoneError, phonePairing, phoneStatus, pushesFor, setPushFor, startPhone, stopPhone, testPush,
} from "./phone";
import { copyText } from "./clipboard";
import { Icon } from "./lucide";
import { flash } from "./ui";

function ago(secs: number) {
  const s = Math.max(0, Date.now() / 1000 - secs);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function Pairing() {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const left = () => Math.max(0, Math.round(((phonePairing()?.until ?? 0) - now()) / 1000));
  return (
    <Show when={phonePairing()}>
      {(p) => (
        <div class="rc-pair">
          <div class="rc-qr" innerHTML={p().qr} />
          <div class="rc-pair-text">
            <Show
              when={left() > 0}
              fallback={<p>That code has expired.</p>}
            >
              <p>Scan with your phone's camera, or open the address on the phone and type the code:</p>
              <div class="rc-code">{p().code.slice(0, 3)} {p().code.slice(3)}</div>
              <p class="rc-dim">Expires in {Math.floor(left() / 60)}:{String(left() % 60).padStart(2, "0")}. On an iPhone, add the page to the Home Screen before pairing; it pairs when it opens from there.</p>
            </Show>
            <div class="rc-actions">
              <button type="button" class="rc-btn" onClick={pairPhone}>New code</button>
              <button type="button" class="rc-btn ghost" onClick={cancelPairing}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

export function RemotePage() {
  const on = () => !!phoneStatus().url;
  return (
    <>
      <h4>Remote control</h4>
      <div class="row">
        <button
          type="button"
          class="rc-switch"
          role="switch"
          aria-checked={on()}
          disabled={phoneBusy()}
          onClick={() => (on() ? stopPhone() : startPhone())}
        >
          <span class="track" />
          Serve the agents to your phone
        </button>
        <Show when={phoneBusy()}><span class="rc-dim">{on() ? "stopping…" : "starting…"}</span></Show>
      </div>
      <Show when={phoneError()}><p class="rc-err">{phoneError()}</p></Show>
      <Show when={phoneStatus().url}>
        {(url) => (
          <>
            <div class="row">
              Address
              <code class="rc-url">{url()}</code>
              <button type="button" class="rc-icon" title="Copy" onClick={() => { copyText(url()); flash("address copied"); }}>
                <Icon name="copy" size={13} />
              </button>
            </div>

            <h4>Phones</h4>
            <For each={phoneStatus().devices} fallback={<p class="note">No phone paired yet.</p>}>
              {(d) => (
                <div class="row rc-dev">
                  <Icon name="smartphone" size={14} />
                  <span class="rc-name">{d.name}</span>
                  <span classList={{ "rc-on": d.online, "rc-dim": !d.online }}>{d.online ? "connected" : ago(d.seen)}</span>
                  <span class="rc-dim" title={d.push ? "Notifications are on" : "Notifications aren't allowed on this phone yet"}>
                    <Icon name={d.push ? "bell" : "bell-off"} size={13} />
                  </span>
                  <button type="button" class="rc-btn ghost" onClick={() => forgetPhone(d)}>Forget</button>
                </div>
              )}
            </For>
            <Show when={phonePairing()} fallback={<button type="button" class="rc-btn" onClick={pairPhone}><Icon name="plus" size={12} /> Pair a phone</button>}>
              <Pairing />
            </Show>

            <h4>Push to phones</h4>
            <div class="row rc-push">
              <For each={EVENTS}>
                {([ev, label]) => (
                  <label>
                    <input type="checkbox" checked={pushesFor(ev)} onChange={(e) => setPushFor(ev, e.currentTarget.checked)} />
                    {label}
                  </label>
                )}
              </For>
            </div>
            <button type="button" class="rc-btn" onClick={testPush}><Icon name="bell-ring" size={12} /> Send a test push</button>
            <p class="note">A phone gets a push whenever the desktop alerts: it follows the project's alert setting and Do not disturb.</p>
          </>
        )}
      </Show>
      <p class="note">
        Needs Tailscale on this computer and the phone, with HTTPS certificates on for the tailnet. Only your tailnet can reach the page, and
        each phone pairs once. Phones see the agent windows and their terminals, and can type into them; nothing else. Remote control stays on
        across restarts until you turn it off.
      </p>
    </>
  );
}
