// The phone page of Remote Control: pair once, then tri-code as the sidebar shows it (pins, each
// Environment's projects and their Worktrees), a project's workspaces with its windows as tiles,
// and a terminal window live with quick keys and a line to type into. On a tablet the sidebar
// stays on the left. phone/mod.rs serves it and speaks the socket protocol; sw.js shows pushed signals.
// Chosen from design/remote-view.html (variant B).
"use strict";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const canPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
/** On an iPhone over HTTPS the Home Screen app pairs (only it gets pushes), not the Safari tab.
 *  Over plain HTTP (the local network) there are no pushes, so Safari pairs. */
const homeScreenPairs = ios && !standalone && window.isSecureContext;
const wideQuery = matchMedia("(min-width: 760px)");

const SIG_TEXT = { working: "working", blocked: "needs you", done: "done", error: "error" };
const SIG_RANK = { blocked: 3, error: 2, done: 1, working: 0 };
const KIND_TEXT = { term: "terminal", browser: "browser", issues: "issues", editor: "editor", git: "git", agents: "commands", db: "database", docker: "docker", monitor: "monitor" };
const SPACES = 4;

// Storage can throw (private mode); the page then just pairs again next time.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let token = store.get("tri-token");
let vapid = store.get("tri-vapid");
let ws = null;
let backoff = 1000;
let retry = 0;
/** The last snapshot from tri-code: { envs: [{ host, name, remote, locked }], pinned: [id],
 *  projects: [{ id, name, repo, parent, host, tile, branch, accent, ws, windows: [...] }] }. */
let snap = { envs: [], pinned: [], projects: [] };
/** The last lines of each terminal's screen, by window id. */
let tails = {};
let loaded = false;
/** What is on screen: { screen: "home" } | { screen: "proj", project } | { screen: "term" | "win", tab }. */
let view = { screen: "home" };
/** The terminal being watched: its window id and PTY. */
let open = null;
/** The workspace picked per project; unset follows the desktop's. */
const pickedSpace = {};
/** A window to open once the snapshot arrives (a tapped notification). */
let pending = params.get("tab");

const wide = () => wideQuery.matches;

function show(id) {
  document.body.classList.toggle("wide", wide());
  const side = wide() && id !== "pair";
  const shown = id === "home" && side ? "blank" : id;
  for (const s of document.querySelectorAll(".screen")) s.hidden = !(s.id === shown || (side && s.id === "home"));
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (ios && !/iPhone/.test(ua)) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Phone";
  const browser = /EdgA?\//.test(ua) ? "Edge" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser";
  return standalone ? `${os} · Home Screen` : `${os} · ${browser}`;
}

/** "4m", "2h": how long ago a signal came, from the desktop's clock. */
function ago(at) {
  if (!at) return "";
  const s = Math.max(0, (Date.now() - at) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

/** A window's state as its title bar shows it (canvas.css .ast): a dot, or a ring while working. */
function sigPill(w, withAge) {
  if (!w.sig) return "";
  const age = withAge && w.sig !== "working" ? ago(w.at) : "";
  return `<span class="ast s-${w.sig}"><i class="sg s-${w.sig}"></i>${SIG_TEXT[w.sig]}${age ? ` · ${age}` : ""}</span>`;
}

/** One of the desktop's icons (snapshot.icons), as SVG markup. */
const icon = (name) => (snap.icons && snap.icons[name]) || "";

/** Follow the desktop's look: its theme and keycaps, kept for the next visit's first paint. */
function applyLook() {
  const look = snap.look || {};
  const root = document.documentElement;
  if (look.theme === "light" || look.theme === "dark") root.dataset.theme = look.theme;
  else delete root.dataset.theme;
  if (look.accentKeys) root.dataset.keys = "accent";
  else delete root.dataset.keys;
  store.set("tri-theme", look.theme || null);
  if (term) term.options.theme = termTheme();
}

/** The accent follows the project on screen, as the desktop's does. */
function applyAccent() {
  const id = currentProject();
  const p = id && projectById(id);
  document.documentElement.style.setProperty("--accent-raw", (p && p.accent) || "#7aa2f7");
}

/** The loudest signal of some windows; `working` counts last. */
function topSig(windows) {
  let best = null;
  for (const w of windows) if (w.sig && (!best || SIG_RANK[w.sig] > SIG_RANK[best.sig])) best = w;
  return best;
}

// ---------- the visible height (iOS keeps the layout size when the keyboard opens) ----------

function fitHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-h", `${h}px`);
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener("resize", fitHeight);
window.visualViewport?.addEventListener("scroll", () => window.scrollTo(0, 0));
fitHeight();

wideQuery.addEventListener("change", () => {
  if (!$("pair").hidden) return;
  show(view.screen);
});

// ---------- pairing ----------

function pairScreen(message) {
  const code = params.get("pair");
  const steps = [];
  if (ios && !standalone && canPushLater()) {
    steps.push(`<div class="step"><span class="k">1</span><div>Add to Home Screen<div class="s">Tap Share, then Add to Home Screen, and open tri-code from there. iPhones only send notifications to Home Screen apps. It pairs itself when it opens.</div></div></div>`);
    steps.push(`<div class="step"><span class="k">2</span><div>Allow notifications<div class="s">When an agent needs you, finishes or stops with an error.</div></div></div>`);
  }
  $("pair-steps").innerHTML = steps.join("");
  // On an iPhone in Safari, the Home Screen app pairs with the code instead: leave it unused.
  $("pair-code").value = code && !homeScreenPairs ? code : "";
  $("pair-msg").textContent = message || "";
  show("pair");
}

/** iOS 16.4+ can push to Home Screen apps; Safari tabs can't. */
function canPushLater() {
  return "serviceWorker" in navigator;
}

async function pair(code) {
  $("pair-msg").textContent = "";
  try {
    const res = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: deviceName() }),
    });
    if (!res.ok) throw new Error((await res.text()) || `pairing failed (${res.status})`);
    const r = await res.json();
    token = r.token;
    vapid = r.vapid;
    store.set("tri-token", token);
    store.set("tri-vapid", vapid);
    history.replaceState({ screen: "home" }, "", "/");
    connect();
    route({ screen: "home" });
  } catch (e) {
    pairScreen(e.message || String(e));
  }
}

$("pair-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("pair-code").value.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (code) pair(code);
});

// ---------- the socket ----------

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setConn(cls, text) {
  const el = $("conn");
  el.className = `conn ${cls}`;
  el.textContent = text;
}

function connect() {
  clearTimeout(retry);
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  setConn("", "connecting");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  let bye = false;
  ws.onopen = () => {
    backoff = 1000;
    setConn("on", location.hostname.split(".")[0]);
    if (open) watch(open.tab);
  };
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) return output(e.data);
    const m = JSON.parse(e.data);
    if (m.t === "hello") {
      vapid = m.vapid;
      store.set("tri-vapid", vapid);
      void syncPush();
    } else if (m.t === "snap") {
      snap = m.data;
      loaded = true;
      applyLook();
      render();
    } else if (m.t === "reply") {
      const w = waiting.get(m.req);
      if (!w) return;
      waiting.delete(m.req);
      if (m.data && m.data.error) w.reject(new Error(m.data.error));
      else w.resolve(m.data);
    } else if (m.t === "tails") {
      tails = m.data;
      if (view.screen === "proj") renderTails();
    } else if (m.t === "exit") {
      if (open && open.pty === m.pty) ended();
    } else if (m.t === "bye") {
      bye = true;
      if (m.why === "forgotten") {
        token = null;
        store.set("tri-token", null);
        pairScreen("tri-code forgot this phone. Pair it again from Settings › Remote.");
      } else {
        setConn("off", "Remote control is off");
        retry = setTimeout(connect, 15000);
      }
    }
  };
  ws.onclose = () => {
    ws = null;
    if (bye || !token) return;
    setConn("off", "offline");
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
}

/** Questions to tri-code (phoneask.ts) waiting for their answer, by number. */
const waiting = new Map();
let asked = 0;

/** Ask tri-code something: open a window, a project's git changes, a diff, a folder, a file. */
function ask(q) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("Not connected to tri-code"));
    const req = ++asked;
    waiting.set(req, { resolve, reject });
    send({ t: "ask", req, q });
    setTimeout(() => {
      if (waiting.delete(req)) reject(new Error("tri-code didn't answer"));
    }, 20000);
  });
}

// A phone that wakes up has usually lost its socket; reconnect at once.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token && (!ws || ws.readyState > WebSocket.OPEN)) {
    backoff = 1000;
    connect();
  }
});

// ---------- finding things in the snapshot ----------

const projectById = (id) => snap.projects.find((p) => p.id === id);

function findWindow(tab) {
  for (const p of snap.projects) for (const w of p.windows) if (w.id === tab) return { p, w };
  return null;
}

/** A Worktree's place in its repo's name: "tri-code › fix-sync". */
const fullName = (p) => (p.repo ? `${p.repo} › ${p.name}` : p.name);

/** The workspace a project opens on: the one picked here, else the desktop's if it has windows,
 *  else the first that has any. */
function spaceOf(p) {
  if (pickedSpace[p.id]) return pickedSpace[p.id];
  const has = (n) => p.windows.some((w) => w.ws === n);
  if (has(p.ws)) return p.ws;
  for (let n = 1; n <= SPACES; n++) if (has(n)) return n;
  return p.ws;
}

// ---------- navigation ----------

/** Go to a view, adding it to the history so Back (the button, a swipe, Android's key) returns. */
function go(next) {
  history.pushState(next, "", next.screen === "home" ? "/" : `#${next.screen}:${encodeURIComponent(next.project || next.tab || "")}`);
  route(next);
}

/** Open a window once the snapshot has it (one the phone just started). */
function openWhenThere(tab) {
  if (findWindow(tab)) openWindow(tab);
  else pending = tab;
}

/** Open a window from anywhere: its project's screen goes under it, so Back lands there. */
function openWindow(tab) {
  const hit = findWindow(tab);
  if (!hit) return;
  pickedSpace[hit.p.id] = hit.w.ws;
  const under = { screen: "proj", project: hit.p.id };
  if (view.screen !== "proj" || view.project !== hit.p.id) history.pushState(under, "", `#proj:${encodeURIComponent(hit.p.id)}`);
  go({ screen: hit.w.kind === "term" ? "term" : "win", tab });
}

function route(next) {
  if (next.screen !== "term" && open) closeTerm();
  closeSheet();
  view = next;
  if (next.screen === "proj" && !projectById(next.project)) view = { screen: "home" };
  if ((next.screen === "term" || next.screen === "win" || next.screen === "doc") && !findWindow(next.tab)) view = { screen: "home" };
  renderSide();
  if (view.screen === "proj") renderProject();
  if (view.screen === "win") renderWin();
  if (view.screen === "doc") renderDoc();
  applyAccent();
  show(view.screen);
  if (view.screen === "term") openTerm(view.tab);
}

window.addEventListener("popstate", (e) => route(e.state && e.state.screen ? e.state : { screen: "home" }));
for (const b of document.querySelectorAll("[data-back]")) b.addEventListener("click", () => history.back());

function render() {
  if (view.screen === "proj" && !projectById(view.project)) return route({ screen: "home" });
  renderSide();
  applyAccent();
  if (view.screen === "proj") renderProject();
  // A window's content was fetched when it opened; a new snapshot only changes its header.
  if (view.screen === "win" || view.screen === "doc") {
    const hit = findWindow(view.tab);
    if (hit) winHeader(hit);
  }
  if (view.screen === "proj" && !$("sheet").hidden) renderSheet();
  if (open) {
    const hit = findWindow(open.tab);
    if (!hit || hit.w.pty === undefined) ended();
    else {
      termHeader(hit);
      // The agent restarted (or became a shell) on a new PTY: follow it.
      if (hit.w.pty !== open.pty) watch(open.tab);
    }
  }
  if (pending && loaded) {
    const tab = pending;
    pending = null;
    if (findWindow(tab)) openWindow(tab);
  }
}

// ---------- home: the sidebar ----------

/** The signal badge on a tile's corner (styles.css .project > .sb). */
const badge = (windows) => {
  const top = topSig(windows);
  return top ? `<span class="sb s-${top.sig}"></span>` : "";
};

/** A repo's tile: its lucide icon, else its letter, tinted with its accent. */
const swatch = (p) => `<span class="swatch" style="--pa:${esc(p.accent)}">${p.glyph || esc(p.tile)}</span>`;

/** A project row as the sidebar draws it: tile, name, its window count, the loudest signal. */
function projectRow(p) {
  const here = view.screen !== "home" && currentProject() === p.id;
  return `<button class="project${here ? " active" : ""}" style="--pa:${esc(p.accent)}" data-project="${esc(p.id)}">
    ${swatch(p)}${badge(p.windows)}
    <span class="name">${esc(p.name)}${p.branch && p.branch !== "base" ? `<small>${esc(p.branch)}</small>` : ""}</span>
    <span class="count">${p.windows.length || ""}</span>
  </button>`;
}

/** A Worktree row: the small tile on the stem, its label, its count. Pinned, it names its repo too. */
function worktreeRow(w, pinned) {
  const here = view.screen !== "home" && currentProject() === w.id;
  const face = pinned && !w.parent;
  return `<button class="wt${here ? " active" : ""}" style="--wa:${esc(w.accent)}" data-project="${esc(w.id)}">
    <span class="wtile${face ? " face" : ""}">${face ? w.glyph || esc(w.tile) : esc(w.tile)}</span>${badge(w.windows)}
    <span class="bn${face ? " name" : ""}">${esc(w.name)}</span>
    ${pinned ? `<span class="sub">${esc(w.repo || w.branch)}</span>` : `<span class="count">${w.windows.length || ""}</span>`}
  </button>`;
}

function currentProject() {
  if (view.screen === "proj") return view.project;
  const hit = (view.screen === "term" || view.screen === "win") && findWindow(view.tab);
  return hit ? hit.p.id : null;
}

function renderSide() {
  const el = $("side");
  if (!loaded) return void (el.innerHTML = `<div class="splash"><img src="/icon.svg" alt=""><p>Connecting to tri-code…</p></div>`);
  const parts = [];

  // What needs you, from every project: a level up from where it lives, so it's never buried.
  const loud = snap.projects.flatMap((p) => p.windows.filter((w) => w.sig === "blocked" || w.sig === "error").map((w) => ({ p, w })))
    .sort((a, b) => SIG_RANK[b.w.sig] - SIG_RANK[a.w.sig] || a.w.at - b.w.at);
  if (loud.length) {
    parts.push(`<h2><span class="env-icon"><i class="sg s-blocked"></i></span><span class="host">Needs you</span></h2>`);
    for (const { p, w } of loud) {
      parts.push(`<button class="ag s-${w.sig}" data-tab="${esc(w.id)}">
        <span class="mark">${w.icon || ""}</span>
        <span class="mid"><span class="nm">${esc(w.name)} <em>· ${esc(fullName(p))}</em></span><span class="ln">${esc(w.msg || `workspace ${w.ws}`)}</span></span>
        ${sigPill(w, true)}
      </button>`);
    }
  }

  const pins = snap.pinned.map(projectById).filter(Boolean);
  if (pins.length) {
    parts.push(`<h2><span class="env-icon">${icon("pin")}</span><span class="host">Pinned</span></h2>`);
    for (const p of pins) parts.push(worktreeRow(p, true));
  }

  for (const env of snap.envs) {
    const repos = snap.projects.filter((p) => p.host === env.host && !p.parent);
    if (!repos.length && !env.locked) continue;
    parts.push(`<h2><span class="env-icon">${env.icon || ""}</span><span class="host">${esc(env.name)}${env.remote && env.name !== env.host ? `<span class="real">${esc(env.host)}</span>` : ""}</span>${env.locked ? `<span class="lk">${icon("lock")}</span>` : ""}</h2>`);
    if (env.locked) {
      parts.push(`<span class="locked">Locked. Unlock it on the desktop to see its projects here.</span>`);
      continue;
    }
    for (const p of repos) {
      parts.push(projectRow(p));
      const wts = snap.projects.filter((w) => w.parent === p.id);
      if (wts.length) parts.push(`<div class="wts">${wts.map((w) => worktreeRow(w, false)).join("")}</div>`);
    }
  }

  el.innerHTML = parts.length ? parts.join("") : `<div class="splash"><img src="/icon.svg" alt=""><p>No projects yet. Open a folder in tri-code and it shows up here.</p></div>`;
}

$("side").addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab]");
  if (t) return openWindow(t.dataset.tab);
  const p = e.target.closest("[data-project]");
  if (!p) return;
  const next = { screen: "proj", project: p.dataset.project };
  // On a tablet the sidebar is beside the project: switching projects replaces the view.
  if (wide() && view.screen !== "home") {
    history.replaceState(next, "", `#proj:${encodeURIComponent(next.project)}`);
    route(next);
  } else go(next);
});

// ---------- a project: workspaces and window tiles ----------

function renderProject() {
  const p = projectById(view.project);
  if (!p) return;
  $("pv-name").textContent = p.name;
  $("pv-swatch").innerHTML = p.parent ? `<span class="wtile" style="--wa:${esc(p.accent)}">${esc(p.tile)}</span>` : swatch(p);
  const env = snap.envs.find((e) => e.host === p.host);
  $("pv-sub").textContent = [p.repo, p.parent ? "" : p.branch, env && env.remote ? env.name : ""].filter(Boolean).join(" · ");
  // Back is for the phone's stack; beside the sidebar it has nowhere to go.
  $("proj").querySelector("[data-back]").hidden = wide();

  // The toolbar's workspace buttons (styles.css .spaces): used ones underlined, a dot for a signal.
  const cur = spaceOf(p);
  const spaces = [];
  for (let n = 1; n <= SPACES; n++) {
    const wins = p.windows.filter((w) => w.ws === n);
    const top = topSig(wins);
    spaces.push(`<button class="${n === cur ? "on" : ""}${wins.length ? " used" : ""}" data-ws="${n}" aria-label="Workspace ${n}">
      ${n}${top ? `<i class="sg s-${top.sig}"></i>` : ""}${n === p.ws ? `<span class="desk" title="On screen on the desktop"></span>` : ""}
    </button>`);
  }
  $("spaces").innerHTML = spaces.join("");

  const wins = p.windows.filter((w) => w.ws === cur).sort((a, b) => Number(a.min) - Number(b.min));
  $("ws-info").textContent = wins.length ? `${wins.length} window${wins.length === 1 ? "" : "s"}` : "";
  $("tiles").innerHTML = wins.length
    ? wins.map((w, i) => tile(w, i === 0 && !w.min)).join("")
    : `<p class="empty">Nothing on workspace ${cur}. + opens a window here.</p>`;
  renderTails();
}

/** A window as the canvas draws it (canvas.css .win): its bar, then a terminal's last lines or what a panel shows. */
function tile(w, big) {
  const running = w.kind !== "term" || w.pty !== undefined;
  const body = w.kind === "term"
    ? `<pre class="pv" data-tail="${esc(w.id)}"></pre>`
    : `<div class="pv panel">${w.icon || ""}<span>${esc(KIND_TEXT[w.kind] || w.kind)}</span>${w.msg ? `<span class="pm">${esc(w.msg)}</span>` : ""}</div>`;
  const mark = w.kind === "term" ? (running ? "running" : "") : w.kind === "browser" ? "web" : "";
  return `<button class="win${big ? " big" : ""}${w.min ? " min" : ""}${running ? "" : " off"}${w.sig && w.sig !== "working" ? ` sig-${w.sig}` : ""}" data-tab="${esc(w.id)}">
    <span class="bar"><span class="mark ${mark}">${w.icon || ""}</span><span class="kind">${esc(w.name)}</span>
      <span class="ttl">${esc(w.min ? "minimised" : w.kind === "term" ? w.msg : "")}</span>${sigPill(w, false)}</span>
    ${body}
  </button>`;
}

function renderTails() {
  for (const pre of document.querySelectorAll("#tiles [data-tail]")) {
    const hit = findWindow(pre.dataset.tail);
    const lines = tails[pre.dataset.tail];
    pre.textContent = hit && hit.w.pty === undefined ? "not running" : lines && lines.length ? lines.join("\n") : "";
  }
}

$("spaces").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ws]");
  if (!b || view.screen !== "proj") return;
  pickedSpace[view.project] = +b.dataset.ws;
  renderProject();
});

$("tiles").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  const hit = findWindow(b.dataset.tab);
  if (hit) go({ screen: hit.w.kind === "term" ? "term" : "win", tab: hit.w.id });
});

// ---------- a window that isn't a terminal: Git, the Editor, or what the others show ----------

/** Bumped by each render of a window or doc, so an answer that comes after the view moved on is dropped. */
let seq = 0;

function winHeader({ p, w }) {
  const sub = `${fullName(p)} · workspace ${w.ws}`;
  if (view.screen === "win") {
    $("wv-mark").innerHTML = view.dir ? icon("folder") : w.icon || "";
    $("wv-name").textContent = view.dir ? baseName(view.dir) : w.name;
    $("wv-sub").textContent = view.dir ? relPath(view.root || "", view.dir) || sub : sub;
  }
}

const baseName = (path) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const sepOf = (path) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
/** A path shown relative to the project's folder: "src/app.js". */
function relPath(root, path) {
  const r = root.replace(/[\\/]+$/, "");
  return path.startsWith(r) ? path.slice(r.length).replace(/^[\\/]+/, "").replace(/\\/g, "/") : path;
}

function loading(el) {
  el.innerHTML = `<p class="dim pad">Loading…</p>`;
}

function failed(el, e) {
  el.innerHTML = `<p class="msg pad">${esc(e.message || e)}</p>`;
}

function renderWin() {
  const hit = findWindow(view.tab);
  if (!hit) return;
  winHeader(hit);
  const { p, w } = hit;
  const el = $("wv-body");
  el.className = "wv";
  if (w.kind === "git") return void loadGit(el, p, w);
  if (w.kind === "editor") return void (view.dir ? loadDir(el, p) : loadEditor(el, p, w));
  el.innerHTML = `
    <div class="wv-ic">${w.icon || ""}</div>
    <div class="wv-k">${esc(KIND_TEXT[w.kind] || w.kind)} window</div>
    ${w.msg ? `<div class="wv-m">${esc(w.msg)}</div>` : ""}
    <p class="dim">The phone shows terminals, Git and the Editor for now. Use this window on the desktop.</p>`;
}

// Git: the changes of the project's repo (or each repo of a folder of repos), staged first.
const isStaged = (c) => c.x !== "." && c.x !== "?";
const isUnstaged = (c) => c.y !== "." || c.x === "?";
const LETTER = { M: "M", A: "A", D: "D", R: "R", C: "C", U: "U", "?": "U", T: "M" };

function changeRow(repo, c, staged) {
  const code = staged ? c.x : c.x === "?" ? "?" : c.y;
  const n = staged ? c.index : c.work;
  const name = baseName(c.path);
  const dir = c.path.slice(0, c.path.length - name.length).replace(/\/$/, "");
  const letter = c.x === "?" ? "U" : LETTER[code] || code;
  return `<button class="g-frow" data-repo="${esc(repo)}" data-path="${esc(c.path)}" data-staged="${staged ? 1 : ""}" data-untracked="${c.x === "?" ? 1 : ""}" data-orig="${esc(c.orig || "")}">
    <span class="g-st s-${esc(letter)}">${esc(letter)}</span>
    <span class="g-fp">${esc(name)}${dir ? `<span class="d">${esc(dir)}</span>` : ""}</span>
    ${n ? `<span class="g-n"><span class="a">+${n[0]}</span><span class="r">−${n[1]}</span></span>` : ""}
  </button>`;
}

/** A row of the Editor's lists or the New window menu: an icon, a name, a muted line. */
function fileRow(attrs, glyph, name, sub, mono = true) {
  return `<button class="g-frow" ${attrs}>
    <span class="g-st plain">${glyph}</span>
    <span class="g-fp${mono ? "" : " name"}">${esc(name)}${sub ? `<span class="d">${esc(sub)}</span>` : ""}</span>
  </button>`;
}

async function loadGit(el, p, w) {
  const mine = ++seq;
  el.className = "wv list";
  loading(el);
  try {
    const r = await ask({ what: "git", project: p.id });
    if (mine !== seq) return;
    const many = r.repos.length > 1;
    el.innerHTML = r.repos.map((repo) => {
      const st = repo.files.filter(isStaged), un = repo.files.filter(isUnstaged);
      const head = `<div class="g-head">
        ${icon("git-branch")}<span class="br">${esc(repo.branch || "detached")}</span>${many ? `<em>${esc(repo.repo || "(folder)")}</em>` : ""}
        ${repo.ahead ? `<span class="ab">↑${repo.ahead}</span>` : ""}${repo.behind ? `<span class="ab">↓${repo.behind}</span>` : ""}
        ${repo.op ? `<span class="ast s-blocked"><i class="sg s-blocked"></i>${esc(repo.op)} stopped</span>` : ""}
      </div>`;
      if (repo.error) return `${head}<p class="msg pad">${esc(repo.error)}</p>`;
      if (!st.length && !un.length) return `${head}<p class="dim pad">No changes.</p>`;
      return head
        + (st.length ? `<div class="g-sec">Staged <span class="n">${st.length}</span></div>${st.map((c) => changeRow(repo.repo, c, true)).join("")}` : "")
        + (un.length ? `<div class="g-sec">Changes <span class="n">${un.length}</span></div>${un.map((c) => changeRow(repo.repo, c, false)).join("")}` : "");
    }).join("") + `<button class="cta ghost refresh" data-refresh>Refresh</button>`;
  } catch (e) {
    if (mine === seq) failed(el, e);
  }
}

// Editor: the files the window has open, and the project's folders to browse.
async function loadEditor(el, p, w) {
  const mine = ++seq;
  el.className = "wv list";
  loading(el);
  try {
    const r = await ask({ what: "editor", project: p.id, tab: w.id });
    if (mine !== seq) return;
    const files = r.files.map((f) => fileRow(
      `data-file="${esc(f)}" data-root="${esc(r.root)}"`,
      f === r.current ? `<i class="sg" style="--sc:var(--accent)"></i>` : icon("file"),
      baseName(f), relPath(r.root, f.slice(0, f.length - baseName(f).length)) || "/",
    )).join("");
    el.innerHTML = `<div class="g-sec">Open files <span class="n">${r.files.length || ""}</span></div>
      ${files || `<p class="dim pad">No files open in this window.</p>`}
      <div class="g-sec">Project</div>
      ${fileRow(`data-dir="${esc(r.root)}" data-root="${esc(r.root)}"`, icon("folder"), "Browse files", baseName(r.root), false)}`;
  } catch (e) {
    if (mine === seq) failed(el, e);
  }
}

async function loadDir(el, p) {
  const mine = ++seq;
  el.className = "wv list";
  loading(el);
  try {
    const r = await ask({ what: "list", project: p.id, path: view.dir });
    if (mine !== seq) return;
    const sep = sepOf(r.path);
    const join = (name) => `${r.path.replace(/[\\/]+$/, "")}${sep}${name}`;
    el.innerHTML = r.entries.length
      ? r.entries.map((e) => fileRow(
          `${e.dir ? "data-dir" : "data-file"}="${esc(join(e.name))}" data-root="${esc(view.root || r.root)}"`,
          icon(e.dir ? "folder" : "file"), e.name, "",
        )).join("")
      : `<p class="dim pad">Empty folder.</p>`;
  } catch (e) {
    if (mine === seq) failed(el, e);
  }
}

$("wv-body").addEventListener("click", (e) => {
  if (e.target.closest("[data-refresh]")) return renderWin();
  const b = e.target.closest("button");
  if (!b || view.screen !== "win") return;
  const tab = view.tab;
  if (b.dataset.path !== undefined) {
    const d = b.dataset;
    return go({ screen: "doc", tab, doc: { type: "diff", repo: d.repo, path: d.path, staged: !!d.staged, untracked: !!d.untracked, orig: d.orig || undefined } });
  }
  if (b.dataset.dir !== undefined) return go({ screen: "win", tab, dir: b.dataset.dir, root: b.dataset.root });
  if (b.dataset.file !== undefined) return go({ screen: "doc", tab, doc: { type: "file", path: b.dataset.file, root: b.dataset.root } });
});

// ---------- a diff or a file, read-only ----------

const MAX_LINES = 6000;

async function renderDoc() {
  const hit = findWindow(view.tab);
  if (!hit) return;
  const { p } = hit;
  const d = view.doc;
  const el = $("dv-body");
  $("dv-name").textContent = baseName(d.path);
  $("dv-sub").textContent = d.type === "diff" ? `${d.staged ? "staged" : "changes"} · ${d.repo ? `${d.repo}/` : ""}${d.path}` : relPath(d.root || "", d.path);
  const mine = ++seq;
  loading(el);
  try {
    if (d.type === "diff") {
      const r = await ask({ what: "diff", project: p.id, repo: d.repo, path: d.path, staged: d.staged, untracked: d.untracked, orig: d.orig });
      if (mine !== seq) return;
      const lines = (r.text || "").split("\n").slice(0, MAX_LINES);
      el.innerHTML = lines.length > 1 || lines[0]
        ? `<pre class="code diff">${lines.map((l) => {
            const cls = l.startsWith("@@") ? "hk" : /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l) ? "mt" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : "";
            return `<span class="${cls}">${esc(l) || " "}</span>`;
          }).join("")}</pre>`
        : `<p class="dim pad">No difference to show (binary, or only a mode change).</p>`;
    } else {
      const r = await ask({ what: "read", project: p.id, path: d.path });
      if (mine !== seq) return;
      if (r.binary || r.text == null) return void (el.innerHTML = `<p class="dim pad">A binary file (${r.size} bytes): open it on the desktop.</p>`);
      const lines = r.text.split("\n");
      const shown = lines.slice(0, MAX_LINES);
      el.innerHTML = `<pre class="code file">${shown.map((l, i) => `<span><i>${i + 1}</i>${esc(l) || " "}</span>`).join("")}</pre>`
        + (r.truncated || lines.length > MAX_LINES ? `<p class="dim pad">Only the start of this file is shown.</p>` : "");
    }
  } catch (e) {
    if (mine === seq) failed(el, e);
  }
}

// ---------- a new window ----------

function renderSheet() {
  const p = projectById(view.project);
  if (!p) return closeSheet();
  const n = spaceOf(p);
  $("sheet-sub").textContent = `${fullName(p)} · on workspace ${n}`;
  $("sheet-list").innerHTML = (p.commands || [])
    .map((c) => fileRow(`data-cmd="${esc(c.id)}"`, c.icon || icon(c.web ? "globe" : "square-terminal"), c.name, c.web ? "browser window, on the desktop" : "", false))
    .join("");
}

function closeSheet() {
  $("sheet").hidden = true;
  $("sheet-msg").textContent = "";
}

$("new").addEventListener("click", () => {
  if (view.screen !== "proj") return;
  renderSheet();
  $("sheet").hidden = false;
});
$("sheet-cancel").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", (e) => {
  if (e.target === $("sheet")) closeSheet();
});
$("sheet-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cmd]");
  const p = projectById(view.project);
  if (!b || !p) return;
  const c = (p.commands || []).find((x) => x.id === b.dataset.cmd);
  for (const x of $("sheet-list").querySelectorAll("button")) x.disabled = true;
  try {
    const r = await ask({ what: "open", project: p.id, command: b.dataset.cmd, ws: spaceOf(p) });
    closeSheet();
    // A terminal opens here; a browser window lives on the desktop, so stay on its tiles.
    if (c && !c.web) openWhenThere(r.tab);
  } catch (err) {
    $("sheet-msg").textContent = err.message || String(err);
    for (const x of $("sheet-list").querySelectorAll("button")) x.disabled = false;
  }
});

// ---------- notifications ----------

function urlB64(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function banner(html, action, label) {
  const el = $("notify");
  if (!html) return void (el.hidden = true);
  el.innerHTML = `<span>${html}</span>${label ? `<button>${label}</button>` : ""}`;
  el.hidden = false;
  if (action) el.querySelector("button").onclick = action;
}

/** Keep tri-code's copy of this phone's push subscription current, and offer to turn it on. */
async function syncPush() {
  if (!canPush) {
    // Over plain HTTP that was chosen in Settings › Remote, which says so: no banner to nag.
    banner(window.isSecureContext && ios && !standalone ? "Add this page to your Home Screen to get notifications." : "");
    return;
  }
  if (Notification.permission === "denied") return banner("Notifications are blocked for this page in the phone's settings.");
  if (Notification.permission !== "granted") return banner("Get a notification when an agent needs you.", enablePush, "Allow");
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && vapid && sub.options.applicationServerKey) {
      const key = new Uint8Array(sub.options.applicationServerKey);
      const want = urlB64(vapid);
      if (key.length !== want.length || key.some((b, i) => b !== want[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(vapid) });
    const res = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) throw new Error(`tri-code said ${res.status}`);
    banner("");
  } catch (e) {
    banner(`Couldn't turn on notifications: ${esc(e.message || e)}`, enablePush, "Retry");
  }
}

async function enablePush() {
  const p = await Notification.requestPermission();
  if (p === "granted") await syncPush();
  else void syncPush();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker:", e));
  // A tapped notification while the page is open.
  navigator.serviceWorker.addEventListener("message", (e) => {
    const tab = e.data && e.data.open;
    if (!tab) return;
    if (loaded && findWindow(tab)) openWindow(tab);
    else pending = tab;
  });
}

// ---------- a terminal window ----------

let term = null;
let fit = null;
let sizeTimer = 0;
let lastSize = "";

// The desktop's terminal colours (terms.ts), for the theme in force.
const TERM_DARK = {
  background: "#0e0f12", foreground: "#d6d8de", cursor: "#d6d8de", selectionBackground: "#3a3f4b",
  black: "#15171c", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7",
  cyan: "#7dcfff", white: "#d6d8de", brightBlack: "#7d828f", brightWhite: "#d6d8de",
};
const TERM_LIGHT = {
  background: "#fbfbfc", foreground: "#23262d", cursor: "#23262d", selectionBackground: "#cfd6e6",
  black: "#23262d", red: "#c4314b", green: "#3d7a1c", yellow: "#9a6400", blue: "#2f5fc4", magenta: "#7c4dbd",
  cyan: "#0f7a8a", white: "#6b7080", brightBlack: "#6b7080", brightWhite: "#6b7080",
};
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function termTheme() {
  const forced = document.documentElement.dataset.theme;
  return (forced ? forced === "dark" : darkQuery.matches) ? TERM_DARK : TERM_LIGHT;
}
darkQuery.addEventListener("change", () => term && (term.options.theme = termTheme()));

function ensureTerm() {
  if (term) return;
  term = new Terminal({
    fontFamily: '"Cascadia Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 11,
    scrollback: 3000,
    cursorBlink: false,
    // Output only: what a phone types goes through the keys and the line below, and xterm's own
    // answers to a program's queries come from the desktop's terminal.
    disableStdin: true,
    theme: termTheme(),
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($("termhost"));
  new ResizeObserver(() => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(refit, 120);
  }).observe($("termhost"));
}

function refit() {
  if (!term || !open || $("term").hidden) return;
  fit.fit();
  const size = `${term.cols}x${term.rows}`;
  if (size === lastSize) return;
  lastSize = size;
  send({ t: "size", cols: term.cols, rows: term.rows });
}

function termHeader({ p, w }) {
  $("tv-name").textContent = w.name;
  $("tv-mark").innerHTML = w.icon || "";
  $("tv-mark").className = `mark${w.pty !== undefined ? " running" : ""}`;
  $("tv-sig").innerHTML = sigPill(w, false);
  $("tv-proj").textContent = `${fullName(p)} · workspace ${w.ws}`;
  $("compose-in").placeholder = w.agent ? "Type to the agent…" : "Type to the terminal…";
}

function watch(tab) {
  const hit = findWindow(tab);
  if (!hit || hit.w.pty === undefined) return ended();
  document.querySelector(".gone")?.remove();
  open = { tab, pty: hit.w.pty };
  term.reset();
  fit.fit();
  lastSize = `${term.cols}x${term.rows}`;
  send({ t: "watch", pty: hit.w.pty, cols: term.cols, rows: term.rows });
}

function openTerm(tab) {
  const hit = findWindow(tab);
  if (!hit) return;
  document.querySelector(".gone")?.remove();
  ensureTerm();
  termHeader(hit);
  open = { tab, pty: hit.w.pty };
  // Fit once the screen has its size.
  requestAnimationFrame(() => watch(tab));
}

function closeTerm() {
  send({ t: "unwatch" });
  open = null;
}

/** The window closed, or its PTY ended. */
function ended() {
  if (document.querySelector(".gone")) return;
  const el = document.createElement("div");
  el.className = "gone";
  el.textContent = findWindow(view.tab) ? "This terminal isn't running." : "This window is gone.";
  $("termhost").after(el);
}

function output(buf) {
  if (!open || !term) return;
  const pty = new DataView(buf).getUint32(0);
  if (pty === open.pty) term.write(new Uint8Array(buf, 4));
}

function input(data) {
  if (open && open.pty !== undefined) send({ t: "input", pty: open.pty, data });
}

// Keys a TUI prompt asks for. Buttons don't take focus, so the keyboard stays up while typing.
const KEYS = [
  ["1", "1"], ["2", "2"], ["3", "3"], ["⏎", "\r"], ["esc", "\x1b"], ["↑", "\x1b[A"], ["↓", "\x1b[B"],
  ["←", "\x1b[D"], ["→", "\x1b[C"], ["tab", "\t"], ["⇧tab", "\x1b[Z"], ["y", "y"], ["n", "n"], ["^C", "\x03"],
];
$("keys").innerHTML = KEYS.map(([label], i) => `<button type="button" data-k="${i}">${esc(label)}</button>`).join("");
$("keys").addEventListener("mousedown", (e) => e.preventDefault());
$("keys").addEventListener("pointerdown", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  e.preventDefault();
  input(KEYS[+b.dataset.k][1]);
});

// A line goes in as typed, then Enter a moment later, so an agent reads it as typing and submits
// (all at once it can look like a paste, whose newline doesn't submit).
$("compose").addEventListener("submit", (e) => {
  e.preventDefault();
  const el = $("compose-in");
  const text = el.value;
  el.value = "";
  if (text) input(text);
  setTimeout(() => input("\r"), text ? 60 : 0);
});

// ---------- start ----------

history.replaceState({ screen: "home" }, "", location.pathname + location.search);
if (token) {
  route({ screen: "home" });
  connect();
} else if (params.get("pair") && !homeScreenPairs) {
  pair(params.get("pair").toUpperCase());
} else {
  pairScreen();
}
