// Settings › Remote: turn Remote Control on, pick how phones reach it (Tailscale, the local network
// or only this computer) and its ports, pair phones and pick which signals push to them.
// Chosen from design/remote-control.html (desktop variant B).

import { For, Show, createSignal, onCleanup } from "solid-js";
import { EVENTS } from "./modules/signals";
import {
  type PhoneReach, cancelPairing, forgetPhone, pairPhone, phoneBusy, phoneError, phonePairing, phoneStatus, pushesFor, setPhoneConfig, setPushFor,
  startPhone, stopPhone, testPush,
} from "./phone";
import { copyText } from "./shared/ui/clipboard";
import { Icon } from "./shared/ui/lucide";
import { flash } from "./shared/ui/ui";

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

const REACHES: [PhoneReach, string, string][] = [
  ["tailscale", "Tailscale", "HTTPS on your tailnet, with notifications. Needs Tailscale on this computer and the phone, with HTTPS certificates on for the tailnet."],
  ["lan", "Local network", "Plain HTTP on this computer's Wi-Fi or Ethernet address. No notifications, and anyone on the same network can read what is sent."],
  ["local", "Only this computer", "Listens on 127.0.0.1 only, for a tunnel or reverse proxy of your own (cloudflared, ngrok, a VPN). Notifications work when it gives HTTPS."],
];

/** A port box: saved when it loses focus or on Enter, and put back if tri-code refused it. */
function PortField(props: { label: string; value: number; save: (n: number) => Promise<void> }) {
  return (
    <div class="row">
      {props.label}
      <span class="px">
        <input
          type="number" min={1} max={65535} value={props.value} disabled={phoneBusy()}
          onChange={(e) => {
            const el = e.currentTarget, n = Math.round(+el.value);
            if (!el.value || n === props.value) return void (el.value = String(props.value));
            void props.save(n).then(() => (el.value = String(props.value)));
          }}
        />
      </span>
    </div>
  );
}

function Connection() {
  const s = phoneStatus;
  return (
    <>
      <h4>Connection</h4>
      <div class="radios">
        <For each={REACHES}>
          {([reach, name, about]) => (
            <label class="radio">
              <input type="radio" name="rc-reach" checked={s().reach === reach} disabled={phoneBusy()} onChange={() => void setPhoneConfig({ reach })} />
              <span>{name}<small>{about}</small></span>
            </label>
          )}
        </For>
      </div>
      <PortField label="Port on this computer" value={s().port} save={(port) => setPhoneConfig({ port })} />
      <Show when={s().reach === "tailscale"}>
        <PortField label="Tailnet HTTPS port" value={s().tsPort} save={(tsPort) => setPhoneConfig({ tsPort })} />
      </Show>
      <Show when={s().reach === "local"}>
        <div class="row">
          Address your tunnel gives
          <input
            class="rc-addr" placeholder={`http://127.0.0.1:${s().port}`} value={s().address} disabled={phoneBusy()} spellcheck={false}
            onChange={(e) => {
              const el = e.currentTarget;
              if (el.value.trim() === s().address) return;
              void setPhoneConfig({ address: el.value }).then(() => (el.value = s().address));
            }}
          />
        </div>
      </Show>
      <p class="note">
        Changing these serves again at the new address, if it is on. A phone opens the new address and pairs there once, since each
        address keeps its own sign-in.{s().reach === "lan" ? " The first time, Windows or macOS may ask to let tri-code accept connections." : ""}
      </p>
    </>
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
          Serve tri-code to your phone
        </button>
        <Show when={phoneBusy()}><span class="rc-dim">{on() ? "working…" : "starting…"}</span></Show>
      </div>
      <Show when={phoneError()}><p class="rc-err">{phoneError()}</p></Show>
      <Connection />
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

            <Show when={phoneStatus().reach !== "lan"} fallback={<><h4>Push to phones</h4><p class="note">Notifications need HTTPS, which the local network can't give: pick Tailscale to get them.</p></>}>
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
            </Show>
          </>
        )}
      </Show>
      <p class="note">
        {{
          tailscale: "Only your tailnet can reach the page.",
          lan: "Anything on your local network can reach the page; a phone still needs a pair code to use it.",
          local: "Only this computer can reach the page, and whatever you put in front of it.",
        }[phoneStatus().reach]}{" "}
        Each phone pairs once. Phones see the projects of unlocked Environments and their windows, watch any terminal and can type into
        it. Remote control stays on across restarts until you turn it off.
      </p>
    </>
  );
}
