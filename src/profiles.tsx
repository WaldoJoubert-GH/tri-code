// Browser Profiles: the avatar in a browser window's nav bar, the menu it opens, and the
// Settings › Browser page that names, colours and deletes them. Each profile has its own webview
// data (cookies, logins, history, saved passwords, autofill). Chosen from design/browser-profiles.html.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import {
  DEFAULT_PROFILE, PROFILE_COLORS, Profile, activePage, addProfile, app, pageProfile, projectById, projectProfile, removeProfile,
  setDefaultProfile, setPageProfile, setProfileScope, setProjectProfile, setSettings, setTabProfile, tabName, tabProfile, updateProfile,
} from "./shared/state/state";
import { applyProfileAutofill, browserInfo, debugSupport, leaveProfile, nativeBrowsers, profilesSupported } from "./browsers";
import { freePort, setDebugPort } from "./debugmenu";
import { isMac } from "./shared/keys/modkey";
import { Icon, toggleIconPicker } from "./shared/ui/lucide";
import { openSettings } from "./shared/nav";
import { flash } from "./shared/ui/ui";
import { isEnter } from "./shared/ui/enterkey";

/** A profile's colour as a CSS value; the --p-* tokens are tuned for light and dark. */
export const profileColor = (p: Profile) => `var(--p-${p.color})`;

/** Profiles only show on windows once there are two: until then nothing needs telling apart. */
export const profilesInUse = () => app.profiles.length > 1 && profilesSupported();

export function ProfileAvatar(props: { profile: Profile; size?: number }) {
  const size = () => props.size ?? 18;
  return (
    <span class="pav" style={{ "--pc": profileColor(props.profile), width: `${size()}px`, height: `${size()}px` }} aria-hidden="true">
      <Icon name={props.profile.icon} size={Math.round(size() * 0.58)} />
    </span>
  );
}

/** Where a profile is used, for the list and the delete warning. */
function usage(id: string) {
  let projects = 0, windows = 0;
  for (const p of app.projects) {
    if (p.profile === id) projects++;
    for (const t of p.tabs) if (t.kind === "browser" && (t.pages ?? []).some((pg) => pageProfile(p, t, pg).id === id)) windows++;
  }
  return { projects, windows };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Delete a profile; `erase` also deletes its data folder once its webviews are closed. */
async function deleteProfile(p: Profile, erase: boolean) {
  // Its windows reopen in their project's profile.
  if (!erase) {
    removeProfile(p.id);
    return flash(`deleted ${p.name}; its data folder is kept`);
  }
  await leaveProfile(p.id, () => removeProfile(p.id));
  try {
    await invoke("browser_profile_erase", { profile: p.id });
    flash(`deleted ${p.name} and erased its data`);
  } catch (e) {
    flash(`deleted ${p.name}, but its data wasn't erased: ${e}`);
  }
}

/** A profile just made (here or from a window's menu), whose name takes the caret. */
const [fresh, setFresh] = createSignal<string | null>(null);

// ---- the menu under a window's avatar ----

type Menu = { projectId: string; tabId: string; anchor: HTMLElement };
const [menu, setMenu] = createSignal<Menu | null>(null);

/** The menu is HTML, so native browser webviews under it hide while it is open (see App). */
export const profileMenuOpen = () => menu() !== null;
export const closeProfileMenu = () => setMenu(null);

export function toggleProfileMenu(projectId: string, tabId: string, anchor: HTMLElement) {
  setMenu((m) => (m?.anchor === anchor ? null : { projectId, tabId, anchor }));
}

function place(el: HTMLElement, a: HTMLElement) {
  const r = a.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth)) + "px";
  el.style.top = Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 4) + "px";
}

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function ProfileMenu() {
  const onDown = (e: PointerEvent) => {
    const m = menu();
    if (m && !(e.target as Element).closest(".profmenu") && !m.anchor.contains(e.target as Node)) closeProfileMenu();
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  return (
    <Show when={menu()} keyed>
      {(m) => (
        <Show when={projectById(m.projectId)} keyed>
          {(project) => (
            <Show when={project.tabs.find((t) => t.id === m.tabId)} keyed>
              {(tab) => {
                const perPage = () => tab.profileScope === "page";
                const page = () => activePage(tab);
                const win = () => tabProfile(project, tab);
                const cur = () => pageProfile(project, tab, page());
                const def = () => projectProfile(project);
                /** Pages use more than one profile, so turning Page Profiles off would move some. */
                const mixed = () => new Set((tab.pages ?? []).map((pg) => pageProfile(project, tab, pg).id)).size > 1;
                const [confirming, setConfirming] = createSignal(false);
                const pageName = () => (page() && browserInfo[page()!.id]?.title) || "this page";
                const pick = (p: Profile) => {
                  closeProfileMenu();
                  if (p.id === cur().id) return;
                  if (perPage() && page()) {
                    setPageProfile(project.id, tab.id, page()!.id, p.id === win().id ? undefined : p.id);
                    return flash(`${pageName()} reopens in ${p.name}`);
                  }
                  setTabProfile(project.id, tab.id, p.id === def().id ? undefined : p.id);
                  flash(`${tabName(tab)} reopens in ${p.name}`);
                };
                const scope = (on: boolean) => {
                  if (on === perPage()) return setConfirming(false);
                  if (on) {
                    setProfileScope(project.id, tab.id, true);
                    return flash(`each page of ${tabName(tab)} can pick its own profile`);
                  }
                  if (mixed() && !confirming()) return setConfirming(true);
                  setConfirming(false);
                  setProfileScope(project.id, tab.id, false);
                  flash(`${tabName(tab)}'s pages share ${win().name}`);
                };
                const manage = () => {
                  closeProfileMenu();
                  openSettings("browser");
                };
                const sub = () =>
                  perPage()
                    ? cur().id === win().id ? "this page · same as the window" : `this page · the window uses ${win().name}`
                    : cur().id === def().id ? `${project.name}'s profile` : `this window · ${project.name} uses ${def().name}`;
                return (
                  <div class="profmenu" role="menu" aria-label="Browser profile" ref={(el) => requestAnimationFrame(() => place(el, m.anchor))}>
                    <div class="pm-scope">
                      <span>Profile for</span>
                      <span class="pm-seg" role="radiogroup" aria-label="Profile applies to">
                        <button role="radio" aria-checked={!perPage()} onClick={() => scope(false)}>
                          <Icon name="app-window" size={12} /> This window
                        </button>
                        <button role="radio" aria-checked={perPage()} onClick={() => scope(true)}>
                          <Icon name="layers" size={12} /> Each page
                        </button>
                      </span>
                    </div>
                    <Show when={confirming()}>
                      <div class="pm-confirm">
                        Pages here use different profiles. Reopen all {tab.pages?.length} in <b>{win().name}</b>?
                        <span>
                          <button class="primary" onClick={() => scope(false)}>Reopen in {win().name}</button>
                          <button onClick={() => setConfirming(false)}>Cancel</button>
                        </span>
                      </div>
                    </Show>
                    <div class="pm-cur">
                      <ProfileAvatar profile={cur()} size={30} />
                      <div>
                        <b>{cur().name}</b>
                        <small>{sub()}</small>
                      </div>
                    </div>
                    <div class="mt">{perPage() ? "Open this page in" : "Open this window in"}</div>
                    <For each={app.profiles}>
                      {(p) => (
                        <button role="menuitemradio" aria-checked={p.id === cur().id} onClick={() => pick(p)}>
                          <ProfileAvatar profile={p} />
                          <span>{p.name}</span>
                          <Show when={debugSupport().protocol && p.id !== DEFAULT_PROFILE && p.debugPort}>
                            <small class="pm-port" title="Remote debugging is on for this profile">:{p.debugPort}</small>
                          </Show>
                          <Show when={p.id === cur().id}><Icon name="check" size={13} class="pm-check" /></Show>
                        </button>
                      )}
                    </For>
                    <div class="msep" />
                    <Show when={perPage() && cur().id !== win().id}>
                      <button
                        role="menuitem"
                        onClick={() => {
                          closeProfileMenu();
                          const p = cur();
                          setTabProfile(project.id, tab.id, p.id === def().id ? undefined : p.id);
                          for (const pg of tab.pages ?? []) setPageProfile(project.id, tab.id, pg.id, undefined);
                          flash(`every page of ${tabName(tab)} reopens in ${p.name}`);
                        }}
                      >
                        <Icon name="layers" size={13} /> Use {cur().name} for every page here
                      </button>
                    </Show>
                    <Show when={cur().id !== def().id}>
                      <button
                        role="menuitem"
                        onClick={() => {
                          closeProfileMenu();
                          const p = cur();
                          setProjectProfile(project.id, p.id);
                          flash(`${project.name}'s browser windows open in ${p.name}`);
                        }}
                      >
                        <Icon name="pin" size={13} /> Use {cur().name} for {project.name}
                      </button>
                    </Show>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setFresh(addProfile());
                        manage();
                      }}
                    >
                      <Icon name="plus" size={13} /> New profile…
                    </button>
                    <button role="menuitem" onClick={manage}>
                      <Icon name="settings-2" size={13} /> Manage profiles…
                    </button>
                  </div>
                );
              }}
            </Show>
          )}
        </Show>
      )}
    </Show>
  );
}

// ---- Settings › Browser ----

/** A labelled on/off switch. Not `Switch`: Solid's compiler takes that name for its own control flow. */
function Toggle(props: { on: boolean; label: string; title: string; onChange: (on: boolean) => void }) {
  return (
    <button type="button" class="rc-switch" role="switch" aria-checked={props.on} title={props.title} onClick={() => props.onChange(!props.on)}>
      <span class="track" />
      {props.label}
    </button>
  );
}

/** macOS: the logins tri-code saved for a profile in the Keychain, each with a remove button. */
function SavedLogins(props: { profile: Profile }) {
  const [open, setOpen] = createSignal(false);
  const [logins, { refetch }] = createResource(
    () => (open() ? props.profile.id : false),
    (id) => invoke<{ origin: string; user: string }[]>("browser_passwords", { profile: id }),
  );
  const forget = (origin: string, user: string) =>
    invoke("browser_password_forget", { profile: props.profile.id, origin, user })
      .then(() => refetch())
      .catch((e) => flash(`${e}`));
  return (
    <div class="pf-logins">
      <button type="button" class="pf-disclose" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Icon name={open() ? "chevron-down" : "chevron-right"} size={12} /> Saved passwords
      </button>
      <Show when={open()}>
        <Show when={!logins.error} fallback={<div class="pf-none">{`${logins.error}`}</div>}>
          <For each={logins() ?? []} fallback={<div class="pf-none">{logins.loading ? "Reading the Keychain…" : "None yet. Sign in to a site and choose Save."}</div>}>
            {(l) => (
              <div class="pf-login">
                <span class="site">{l.origin.replace(/^https?:\/\//, "")}</span>
                <span class="user">{l.user || "(no username)"}</span>
                <button type="button" title="Remove this saved password" aria-label="Remove" onClick={() => void forget(l.origin, l.user)}>×</button>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

/** Remote debugging for one profile: a switch and its port. Changing either reopens its pages. */
function DebugPort(props: { profile: Profile }) {
  const p = () => props.profile;
  const commit = (el: HTMLInputElement) => {
    const n = Number(el.value);
    const taken = app.profiles.some((q) => q.id !== p().id && q.debugPort === n);
    if (!Number.isInteger(n) || n < 1024 || n > 65535 || taken) {
      el.value = String(p().debugPort);
      return flash(taken ? `another profile uses port ${n}` : "pick a port from 1024 to 65535");
    }
    if (n !== p().debugPort) setDebugPort(p().id, p().name, n);
  };
  return (
    <span class="pf-debug">
      <Toggle
        on={!!p().debugPort}
        label="Remote debugging"
        title="Agents (Playwright, Chrome DevTools MCP) can drive this profile's pages, signed in, over the DevTools protocol on 127.0.0.1. Its pages reopen."
        onChange={(on) => setDebugPort(p().id, p().name, on ? freePort(app) : undefined)}
      />
      <Show when={p().debugPort}>
        <input
          class="pf-port"
          inputmode="numeric"
          aria-label={`${p().name}'s remote debugging port`}
          value={p().debugPort}
          onKeyDown={(e) => isEnter(e) && e.currentTarget.blur()}
          onBlur={(e) => commit(e.currentTarget)}
        />
      </Show>
    </span>
  );
}

function ProfileRow(props: { profile: Profile; focus: boolean }) {
  const p = () => props.profile;
  const [confirming, setConfirming] = createSignal(false);
  const isDefault = () => (app.settings.profile ?? DEFAULT_PROFILE) === p().id;
  const used = () => usage(p().id);
  const setAutofill = (patch: Pick<Profile, "autofill" | "passwords">) => {
    updateProfile(p().id, patch);
    applyProfileAutofill(p());
  };
  return (
    <div class="pf-row">
      <button
        type="button"
        class="pf-av"
        title="Choose an icon"
        onClick={(e) => toggleIconPicker(e.currentTarget, p().icon, (icon) => updateProfile(p().id, { icon }))}
      >
        <ProfileAvatar profile={p()} size={30} />
      </button>
      <div class="pf-main">
        <div class="pf-line">
          <input
            class="pf-name"
            value={p().name}
            spellcheck={false}
            aria-label="Profile name"
            ref={(el) => props.focus && requestAnimationFrame(() => { el.focus(); el.select(); })}
            onInput={(e) => updateProfile(p().id, { name: e.currentTarget.value })}
            onBlur={(e) => !e.currentTarget.value.trim() && updateProfile(p().id, { name: "Untitled" })}
          />
          <span class="pf-colors" role="radiogroup" aria-label="Colour">
            <For each={PROFILE_COLORS}>
              {(c) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={p().color === c}
                  title={c}
                  style={{ "--c": `var(--p-${c})` }}
                  onClick={() => updateProfile(p().id, { color: c })}
                />
              )}
            </For>
          </span>
        </div>
        <div class="pf-line">
          <Toggle
            on={p().passwords !== false}
            label="Save passwords"
            title="Offer to save passwords you sign in with, and fill them in next time. Saved in this profile only."
            onChange={(on) => setAutofill({ passwords: on ? undefined : false })}
          />
          {/* macOS's web view has no form autofill to turn on; passwords are tri-code's own there (SavedLogins). */}
          <Show when={!isMac}>
            <Toggle
              on={p().autofill !== false}
              label="Autofill forms"
              title="Suggest names, addresses and other things typed into forms before. Saved in this profile only."
              onChange={(on) => setAutofill({ autofill: on ? undefined : false })}
            />
          </Show>
          <Show when={debugSupport().protocol && p().id !== DEFAULT_PROFILE}>
            <DebugPort profile={p()} />
          </Show>
          <span class="pf-used">
            {[used().projects && plural(used().projects, "project"), used().windows && plural(used().windows, "window")].filter(Boolean).join(" · ") || "unused"}
          </span>
        </div>
        <Show when={isMac && p().passwords !== false}>
          <SavedLogins profile={p()} />
        </Show>
        <Show when={debugSupport().protocol && p().debugPort}>
          <div class="pf-warn">
            <Icon name="triangle-alert" size={12} /> Any program on this computer can control {p().name}'s signed-in pages while this is on.
          </div>
        </Show>
        <Show when={confirming()}>
          <div class="pf-confirm">
            <p>
              <b>Delete {p().name}?</b>{" "}
              {used().windows ? `Its ${plural(used().windows, "window")} reopen in their project's profile. ` : ""}
              Erasing its data removes its cookies, saved passwords, {isMac ? "" : "autofill, "}history and site storage, and can't be undone.
            </p>
            <div class="pf-acts">
              <button type="button" class="danger" onClick={() => void deleteProfile(p(), true)}>Delete and erase data</button>
              <button type="button" onClick={() => void deleteProfile(p(), false)}>Delete, keep data folder</button>
              <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        </Show>
      </div>
      <div class="pf-side">
        <Show when={isDefault()} fallback={<button type="button" class="pf-btn" title="Projects that haven't picked a profile use this one" onClick={() => setDefaultProfile(p().id)}>Make default</button>}>
          <span class="pf-pill">Default</span>
        </Show>
        <Show when={p().id !== DEFAULT_PROFILE}>
          <button type="button" class="pf-btn bad" disabled={confirming()} onClick={() => setConfirming(true)}>Delete</button>
        </Show>
      </div>
    </div>
  );
}

export function BrowserPage() {
  onCleanup(() => setFresh(null));
  return (
    <Show
      when={nativeBrowsers && profilesSupported()}
      fallback={
        <>
          <h4>Profiles</h4>
          <p class="note">
            {nativeBrowsers
              ? "Browser profiles need macOS 14 or later, the first version whose web view can keep their sign-ins apart. Every browser window uses one set of cookies here."
              : "Browser windows show pages in a frame of tri-code's own window (TRICODE_FRAMED_BROWSERS is set), which can't keep sign-ins apart, so there are no profiles here."}
          </p>
        </>
      }
    >
      <h4>Windows</h4>
      <div class="pf-opts">
        <Toggle
          on={!!app.settings.pageProfiles}
          label="New windows give each page its own profile"
          title="Off: a window's pages share one profile. Any window can change this from the avatar in its address bar."
          onChange={(on) => setSettings({ pageProfiles: on ? true : undefined })}
        />
        <Show when={debugSupport().devtools}>
          <Toggle
            on={!!app.settings.debugMenu}
            label="Show the debug menu"
            title={
              debugSupport().protocol
                ? "A bug button in each browser window's address bar: DevTools, console errors, cache, throttling, site data and remote debugging. F12 opens DevTools with it off."
                : "A bug button in each browser window's address bar that opens the Web Inspector. Right-click › Inspect Element does too."
            }
            onChange={(on) => setSettings({ debugMenu: on ? true : undefined })}
          />
        </Show>
      </div>
      <h4>Profiles</h4>
      <div class="pf-list">
        <For each={app.profiles}>{(p) => <ProfileRow profile={p} focus={fresh() === p.id} />}</For>
      </div>
      <button type="button" class="pf-add" onClick={() => setFresh(addProfile())}>
        <Icon name="plus" size={13} /> New profile
      </button>
      <p class="note">
        Each profile keeps its own cookies, sign-ins, saved passwords, autofill and history, so a project can stay signed in as a
        different person. A project's browser windows open in its profile (the avatar in a browser window's address bar changes it, for
        the project, one window, or one page once the window's menu is set to Each page); web apps can pick one in the commands window. Personal keeps the browser data from before profiles.
        {isMac ? " On macOS tri-code saves passwords itself, in your Keychain; macOS's web view can't fill other forms." : ""}
      </p>
    </Show>
  );
}
