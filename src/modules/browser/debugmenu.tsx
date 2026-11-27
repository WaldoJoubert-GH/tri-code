// The Debug Menu: the bug button in a browser window's nav bar (Settings › Browser › Debug menu) and
// the menu it opens. DevTools everywhere there are native webviews; the rest (console errors, cache,
// throttling, site data, remote debugging) needs the DevTools protocol, which only WebView2 has, and
// is left out elsewhere. Chosen from design/browser-debug-profile.html.

import { For, Show, createSignal } from "solid-js";
import { DEFAULT_PROFILE, activePage, app, pageProfile, projectById, updateProfile } from "../../shared/state/state";
import {
  THROTTLE_NAMES, type Throttle, browserInfo, clearSiteData, consoleErrors, debugPortOf, debugSupport, hardReload, openDevtools,
  pageDebug, pageOrigin, restartProfile, sendErrorsToAgent, setNoCache, setThrottle,
} from "./browsers";
import { ProfileAvatar } from "./profiles";
import { Key } from "../../shared/keys/Keys";
import { Icon } from "../../shared/ui/lucide";
import { openSettings } from "../../shared/nav";
import { copyText } from "../../shared/ui/clipboard";
import { flash } from "../../shared/ui/ui";
import { Popover } from "../../shared/ui/Popover";

type Menu = { projectId: string; tabId: string; anchor: HTMLElement };
const [menu, setMenu] = createSignal<Menu | null>(null);

/** The menu is HTML, so native browser webviews under it hide while it is open (see App). */
export const debugMenuOpen = () => menu() !== null;
export const closeDebugMenu = () => setMenu(null);

/** The first free port from 9222 up, for a profile turning remote debugging on. */
export function freePort(app: { profiles: { debugPort?: number }[] }): number {
  const used = new Set(app.profiles.map((p) => p.debugPort));
  let port = 9222;
  while (used.has(port)) port++;
  return port;
}

/** Turn a profile's remote debugging on (at `port`) or off. Its pages reopen with the new setting. */
export function setDebugPort(profileId: string, name: string, port: number | undefined): void {
  void restartProfile(profileId, () => updateProfile(profileId, { debugPort: port }));
  flash(port ? `${name}'s pages reopen with remote debugging on 127.0.0.1:${port}` : `remote debugging off for ${name}; its pages reopen`);
}

/** The bug button: a red count of console errors, a green dot while agents can attach. */
export function DebugButton(props: { projectId: string; tabId: string; pageId: string; port?: number }) {
  const errors = () => consoleErrors[props.pageId]?.length ?? 0;
  const title = () =>
    ["Debug", errors() && `${errors()} console error${errors() === 1 ? "" : "s"}`, props.port && `agents can attach on 127.0.0.1:${props.port}`]
      .filter(Boolean)
      .join(" · ");
  return (
    <button
      class="dbgbtn"
      aria-haspopup="menu"
      aria-expanded={menu()?.tabId === props.tabId}
      title={title()}
      aria-label={title()}
      onClick={(e) => {
        const anchor = e.currentTarget;
        setMenu((m) => (m?.anchor === anchor ? null : { projectId: props.projectId, tabId: props.tabId, anchor }));
      }}
    >
      <Icon name="bug" size={14} />
      <Show when={errors()}>
        <span class="badge">{errors() > 99 ? "99+" : errors()}</span>
      </Show>
      <Show when={props.port}>
        <span class="attach" />
      </Show>
    </button>
  );
}

const THROTTLES: Throttle[] = ["fast4g", "slow3g", "offline"];

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function DebugMenu() {
  return (
    <Show when={menu()} keyed>
      {(m) => (
        <Show when={projectById(m.projectId)} keyed>
          {(project) => (
            <Show when={project.tabs.find((t) => t.id === m.tabId)} keyed>
              {(tab) => {
                const page = () => activePage(tab);
                const pid = () => page()?.id ?? "";
                const prof = () => pageProfile(project, tab, page());
                const proto = () => debugSupport().protocol;
                const errors = () => consoleErrors[pid()] ?? [];
                const host = () => {
                  const o = pageOrigin(pid());
                  return o ? o.replace(/^https?:\/\//, "") : browserInfo[pid()]?.url || "this page";
                };
                const dbg = () => pageDebug[pid()] ?? {};
                const port = () => debugPortOf(prof());
                const run = (f: () => void) => () => {
                  closeDebugMenu();
                  f();
                };
                return (
                  <Popover class="dbgmenu" role="menu" label="Debug" anchor={m.anchor} side="below-end" gap={4} onClose={closeDebugMenu}>
                    <div class="pm-cur">
                      <ProfileAvatar profile={prof()} size={24} />
                      <div>
                        <b>{host()}</b>
                        <small>in {prof().name}{tab.profileScope === "page" ? " · this page" : ""}</small>
                      </div>
                    </div>
                    <Show when={errors().length}>
                      <div class="dm-errs">
                        <Icon name="triangle-alert" size={13} />
                        <span><b>{errors().length}</b> console error{errors().length === 1 ? "" : "s"}</span>
                        <button onClick={run(() => sendErrorsToAgent(project, pid()))} title="Type them into the project's agent window, unsent">
                          Send to agent
                        </button>
                      </div>
                    </Show>
                    <button role="menuitem" onClick={run(() => openDevtools(pid()))}>
                      <Icon name="panel-bottom" size={13} /> <span>Open DevTools</span> <Key k="F12" />
                    </button>
                    <button role="menuitem" onClick={run(() => hardReload(pid()))}>
                      <Icon name="refresh-cw" size={13} /> <span>Hard reload</span>
                    </button>
                    <Show when={proto()}>
                      <div class="msep" />
                      <div class="mt">Network</div>
                      <button role="menuitemcheckbox" aria-checked={!!dbg().noCache} onClick={() => void setNoCache(pid(), !dbg().noCache)}>
                        <Icon name="database-zap" size={13} /> <span>Disable cache</span>
                        <span class="sw" />
                      </button>
                      <div class="dm-row">
                        <Icon name="gauge" size={13} /> <span>Throttle</span>
                        <span class="dm-seg" role="radiogroup" aria-label="Throttle">
                          <button role="radio" aria-checked={!dbg().throttle} onClick={() => void setThrottle(pid(), undefined)}>Off</button>
                          <For each={THROTTLES}>
                            {(t) => <button role="radio" aria-checked={dbg().throttle === t} onClick={() => void setThrottle(pid(), t)}>{THROTTLE_NAMES[t]}</button>}
                          </For>
                        </span>
                      </div>
                      <button role="menuitem" class="danger" onClick={run(() => void clearSiteData(pid(), prof().name))}>
                        <Icon name="eraser" size={13} /> <span>Clear site data for {host()}</span>
                      </button>
                      <div class="dm-sub">Its cookies, storage and cache in {prof().name} only.</div>
                      <div class="msep" />
                      <div class="mt">Agents</div>
                      <Show
                        when={prof().id !== DEFAULT_PROFILE}
                        fallback={
                          <div class="dm-sub flat">
                            Remote debugging needs a profile of its own: {prof().name} shares tri-code's browser process.{" "}
                            <a href="#" onClick={(e) => { e.preventDefault(); closeDebugMenu(); openSettings("browser"); }}>Make one in Settings</a>
                          </div>
                        }
                      >
                        <button
                          role="menuitemcheckbox"
                          aria-checked={!!port()}
                          onClick={() => setDebugPort(prof().id, prof().name, port() ? undefined : prof().debugPort ?? freePort(app))}
                        >
                          <Icon name="plug" size={13} /> <span>Remote debugging for {prof().name}</span>
                          <span class="sw" />
                        </button>
                        <Show
                          when={port()}
                          fallback={<div class="dm-sub">Lets agents drive {prof().name}'s pages over the DevTools protocol. Its pages reopen.</div>}
                        >
                          {(p) => (
                            <>
                              <div class="dm-cdp">
                                <code>http://127.0.0.1:{p()}</code>
                                <button title="Copy" aria-label="Copy the address" onClick={() => { copyText(`http://127.0.0.1:${p()}`); flash("copied"); }}>
                                  <Icon name="copy" size={13} />
                                </button>
                              </div>
                              <div class="dm-sub">Playwright or Chrome DevTools MCP can attach, signed in as {prof().name}. Connections from this computer only.</div>
                            </>
                          )}
                        </Show>
                      </Show>
                    </Show>
                  </Popover>
                );
              }}
            </Show>
          )}
        </Show>
      )}
    </Show>
  );
}
