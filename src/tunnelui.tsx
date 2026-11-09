// What a browser window in a remote project shows of its tunnels (tunnels.ts): the chip at the
// start of the address field, its popover, the panel a page shows while its tunnel opens or has
// failed, the bar while one reconnects, and the remote's ports and HTML files on a new tab.
// Chosen from design/remote-tunnels.html.

import { invoke } from "@tauri-apps/api/core";
import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { type Project, envName, isRemote, skipFolders } from "./state";
import { type Fwd, fwdOfPage, fwds, reconnect, remoteLabel } from "./tunnels";
import { type Listener, fileUrlOf, parseListening } from "./tunnelmap";
import { copyText } from "./clipboard";
import { Icon } from "./lucide";
import { KeyText } from "./Keys";
import { flash } from "./ui";

const STATE_TEXT: Record<Fwd["state"], string> = { opening: "Opening", open: "Open", reconnecting: "Reconnecting", failed: "Failed" };

type Pop = { pageId: string; project: Project; anchor: HTMLElement; openExternal: () => void };
const [pop, setPop] = createSignal<Pop | null>(null);
/** The popover is HTML, so the browser webviews it overlaps hide while it is open (see App). */
export const tunnelPopOpen = () => pop() !== null;
export const closeTunnelPop = () => setPop(null);

/**
 * The chip at the start of a remote project's address field: the Environment the page is on, or
 * "this machine" for a page opened with Alt+Enter. Absent for pages that need no tunnel.
 */
export function TunnelChip(props: { project: Project; pageId: string; here: boolean; openExternal: () => void }) {
  const f = () => fwdOfPage(props.pageId);
  const show = () => isRemote(props.project) && (props.here || f());
  const icon = () => (props.here ? "monitor" : f()?.target.kind === "dir" ? "file-code" : f()?.state === "open" ? "arrow-left-right" : "loader-circle");
  const title = () => {
    if (props.here) return `On this machine, not ${envName(props.project.host)} · Enter in the address field goes back to ${envName(props.project.host)}`;
    const x = f();
    if (!x) return "";
    return `${remoteLabel(x)} on ${envName(x.host)}${x.local ? ` · here ${x.target.kind === "dir" ? "127.0.0.1" : "localhost"}:${x.local}` : ""} · ${STATE_TEXT[x.state]}${x.error ? `: ${x.error}` : ""}`;
  };
  return (
    <Show when={show()}>
      <button
        class="tunchip"
        classList={{ [`s-${f()?.state ?? "open"}`]: true, here: props.here }}
        title={title()}
        aria-label={title()}
        aria-haspopup="dialog"
        aria-expanded={pop()?.pageId === props.pageId}
        onClick={(e) => {
          const a = e.currentTarget;
          if (pop()?.pageId === props.pageId) return setPop(null);
          setPop({ pageId: props.pageId, project: props.project, anchor: a, openExternal: props.openExternal });
        }}
      >
        <Icon name={icon()} size={12} class={f()?.state === "opening" || f()?.state === "reconnecting" ? "spin" : ""} />
        <span>{props.here ? "this machine" : envName(props.project.host)}</span>
      </button>
    </Show>
  );
}

/** Mount once (in App). Closes on an outside pointerdown; Escape is handled in hotkeys.ts. */
export function TunnelPopover() {
  const onDown = (e: PointerEvent) => {
    if (pop() && !(e.target as Element).closest(".tunpop, .tunchip")) setPop(null);
  };
  onMount(() => document.addEventListener("pointerdown", onDown));
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  const place = (el: HTMLElement, a: HTMLElement) => {
    const r = a.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.left)) + "px";
    el.style.top = Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 6) + "px";
  };

  return (
    <Show when={pop()} keyed>
      {(s) => {
        const f = () => fwdOfPage(s.pageId);
        const env = envName(s.project.host);
        const localAddr = (x: Fwd) => `http://${x.target.kind === "dir" ? "127.0.0.1" : "localhost"}:${x.local}`;
        return (
          <div class="pop tunpop" role="dialog" aria-label={`Tunnel to ${env}`} ref={(el) => requestAnimationFrame(() => place(el, s.anchor))}>
            <Show
              when={f()}
              fallback={
                <>
                  <div class="tunhead"><Icon name="monitor" size={14} /><b>On this machine</b></div>
                  <p class="tunnote">
                    This page's <span class="mono">localhost</span> is this computer's, not {env}'s. Press <KeyText text="Enter" /> in the
                    address field to open an address on {env} again.
                  </p>
                </>
              }
            >
              {(x) => (
                <>
                  <div class="tunhead">
                    <Icon name={x().target.kind === "dir" ? "file-code" : "arrow-left-right"} size={14} />
                    <b>{x().target.kind === "dir" ? `Files on ${env}` : `Tunnel to ${env}`}</b>
                    <span class={`tunstate s-${x().state}`}><i />{STATE_TEXT[x().state]}</span>
                  </div>
                  <dl class="tungrid">
                    <dt>On {env}</dt><dd class="mono">{remoteLabel(x())}</dd>
                    <Show when={x().local}>
                      <dt>Here</dt>
                      <dd class="mono">
                        {x().target.kind === "dir" ? "127.0.0.1" : "localhost"}:{x().local}
                        <Show when={x().target.kind === "port" && x().local === (x().target as { port: number }).port}>
                          <span class="dim"> · same port</span>
                        </Show>
                      </dd>
                    </Show>
                    <dt>Through</dt><dd class="mono">ssh {x().host}</dd>
                    <dt>Used by</dt><dd>{x().pages.filter((p) => !p.startsWith("ext:")).length} page{x().pages.filter((p) => !p.startsWith("ext:")).length === 1 ? "" : "s"}</dd>
                  </dl>
                  <Show when={x().error}><p class="tunerr">{x().error}</p></Show>
                  <div class="acts">
                    <button disabled={!x().local || x().state !== "open"} onClick={() => { copyText(localAddr(x())); flash(`copied ${localAddr(x())}`); }}>
                      Copy local address
                    </button>
                    <button onClick={() => { s.openExternal(); setPop(null); }}>Open in system browser</button>
                    <button class="primary" onClick={() => reconnect(x().key)}>Reconnect</button>
                  </div>
                  <p class="tunnote">
                    {x().target.kind === "dir"
                      ? `Served from this folder on ${env} by python3, so the page's relative files load too.`
                      : "Same port here when it is free, so cookies, hot reload and sign-in redirects keep working."}{" "}
                    Closes 30 s after the last page using it.
                  </p>
                </>
              )}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

/** What a page shows while its tunnel opens for the first time, or after it failed. */
export function TunnelHeld(props: { project: Project; fwd: Fwd; url: string; onHere: () => void }) {
  const env = () => envName(props.fwd.host);
  const refused = () => /nothing is listening/i.test(props.fwd.error ?? "");
  return (
    <div class="tunheld" classList={{ failed: props.fwd.state === "failed" }}>
      <Show
        when={props.fwd.state === "failed"}
        fallback={
          <>
            <Icon name="loader-circle" size={18} class="spin" />
            <b>Opening a tunnel to {env()}…</b>
            <span class="mono dim">{remoteLabel(props.fwd)}</span>
          </>
        }
      >
        <b>{refused() ? `Nothing is listening on ${remoteLabel(props.fwd)} on ${env()}` : `Can't reach ${remoteLabel(props.fwd)} on ${env()}`}</b>
        <span class="dim">{refused() ? "The dev server may not be running yet." : props.fwd.error}</span>
        <div class="acts">
          <button class="primary" onClick={() => reconnect(props.fwd.key)}>Retry</button>
          <Show when={props.fwd.target.kind === "port"}>
            <button onClick={props.onHere}>Try on this machine</button>
          </Show>
        </div>
        <span class="dim small">Tries again by itself every few seconds while this page is open.</span>
      </Show>
    </div>
  );
}

/** A row of the window, like the password bar: the page stays while its tunnel comes back. */
export function TunnelBar(props: { fwd: Fwd }) {
  return (
    <Show when={props.fwd.state === "reconnecting"}>
      <div class="pwbar tunbar" role="status">
        <Icon name="loader-circle" size={14} class="spin" />
        <span>Lost the tunnel to {envName(props.fwd.host)} · reconnecting, the page reloads once it is back</span>
        <button onClick={() => reconnect(props.fwd.key)}>Reconnect now</button>
      </div>
    </Show>
  );
}

type FileIndex = { files: string[] };
const HTML_MAX = 8;

/** HTML files worth offering: reports and builds before the rest, shallow before deep. */
function htmlFiles(files: string[]): string[] {
  const rank = (f: string) => (/(^|\/)(coverage|playwright-report|reports?|dist|build|docs?|site|storybook-static)\//.test(f) ? 0 : 1) * 100 + f.split("/").length;
  return files.filter((f) => /\.html?$/i.test(f) && !/(^|\/)node_modules\//.test(f)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, HTML_MAX);
}

/** A new tab in a remote project: what listens on the remote, and the project's HTML files. */
export function RemoteStart(props: { project: Project; onOpen: (url: string) => void }) {
  const env = () => envName(props.project.host);
  const [ports, { refetch }] = createResource(
    () => props.project.host,
    async (host) => parseListening(await invoke<string>("remote_listening", { host })),
  );
  const [html] = createResource(
    () => props.project,
    async (p) => htmlFiles((await invoke<FileIndex>("project_files", { host: p.host, path: p.path, skip: skipFolders() })).files),
  );
  const openPort = (l: Listener) => {
    if (l.http) return props.onOpen(`http://localhost:${l.port}/`);
    copyText(`localhost:${l.port}`);
    flash(`${l.name} doesn't speak HTTP · copied localhost:${l.port}`);
  };
  const isOpen = (port: number) => Object.values(fwds).some((f) => f.host === props.project.host && f.state === "open" && f.target.kind === "port" && f.target.port === port);
  const full = (rel: string) => `${props.project.path.replace(/\/+$/, "")}/${rel}`;

  return (
    <div class="remstart">
      <section>
        <h4>
          <Icon name="server" size={12} /> Listening on {env()}
          <button class="link" onClick={() => refetch()} disabled={ports.loading}>{ports.loading ? "scanning…" : "↻ Rescan"}</button>
        </h4>
        <Show when={!ports.error} fallback={<span class="dim">Couldn't list ports on {env()}: {String(ports.error)}</span>}>
          <Show when={ports.loading || ports()?.length} fallback={<span class="dim">Nothing of yours is listening on {env()}. Start a dev server in a terminal and rescan.</span>}>
            <div class="ports">
              <For each={ports()}>
                {(l) => (
                  <button class="port" classList={{ nothttp: !l.http, live: isOpen(l.port) }} title={l.args} onClick={() => openPort(l)}>
                    <span class="top">
                      <b class="mono">:{l.port}</b>
                      <Show when={isOpen(l.port)}><span class="ok"><i />tunnel open</span></Show>
                      <Show when={!l.http}><span class="dim">not http</span></Show>
                    </span>
                    <span>{l.name}</span>
                    <small class="mono">{l.args}</small>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>
      <Show when={html()?.length}>
        <section>
          <h4><Icon name="file-code" size={12} /> HTML files in this project</h4>
          <div class="htmls">
            <For each={html()}>
              {(rel) => (
                <button class="hrow" onClick={() => props.onOpen(fileUrlOf(full(rel)))} title={full(rel)}>
                  <span class="ficon">HTML</span>
                  <span class="mono">{rel}</span>
                </button>
              )}
            </For>
          </div>
          <span class="dim small">Served from {env()} over ssh, so their relative CSS, JS and images load too. Needs python3 there.</span>
        </section>
      </Show>
    </div>
  );
}
