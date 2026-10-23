// The phone page of Remote Control: pair once, then a list of the agents by project and, for
// one agent, its live terminal with quick keys and a line to type into. phone.rs serves it
// and speaks the socket protocol; sw.js shows pushed signals.
"use strict";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const canPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const SIG_TEXT = { working: "working", blocked: "needs you", done: "done", error: "error" };

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
/** The last agents snapshot from tri-code: { projects: [{ id, name, accent, env, agents: [...] }] }. */
let snap = { projects: [] };
let loaded = false;
/** The agent on screen: its tab id and the PTY being watched. */
let open = null;
/** A tab to open once the agents arrive (a tapped notification). */
let pending = params.get("tab");

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
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

// ---------- the visible height (iOS keeps the layout size when the keyboard opens) ----------

function fitHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-h", `${h}px`);
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener("resize", fitHeight);
window.visualViewport?.addEventListener("scroll", () => window.scrollTo(0, 0));
fitHeight();

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
  $("pair-code").value = code && !(ios && !standalone) ? code : "";
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
    history.replaceState(null, "", "/");
    connect();
    show("list");
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
    } else if (m.t === "agents") {
      snap = m.data;
      loaded = true;
      render();
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

// A phone that wakes up has usually lost its socket; reconnect at once.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token && (!ws || ws.readyState > WebSocket.OPEN)) {
    backoff = 1000;
    connect();
  }
});

// ---------- the agent list ----------

function findAgent(tab) {
  for (const p of snap.projects) for (const a of p.agents) if (a.id === tab) return { p, a };
  return null;
}

function render() {
  const list = $("agents");
  if (!snap.projects.length) {
    list.innerHTML = `<p class="empty">No agents running. Start claude or pi in tri-code and they show up here.</p>`;
  } else {
    list.innerHTML = snap.projects.map((p) => `
      <div class="grp"><i style="background:${esc(p.accent)}"></i>${esc(p.name)}${p.env ? ` <em>· ${esc(p.env)}</em>` : ""}</div>
      ${p.agents.map((a) => `
        <button class="ag ${a.sig || ""}" data-tab="${esc(a.id)}">
          <span class="ic">${a.icon || ""}</span>
          <span class="mid"><div class="nm">${esc(a.name)}</div><div class="ln">${esc(a.msg || `workspace ${a.ws}`)}</div></span>
          ${a.sig ? `<span class="sig s-${a.sig}">${SIG_TEXT[a.sig]}</span>` : ""}
        </button>`).join("")}`).join("");
  }
  if (open) {
    const hit = findAgent(open.tab);
    if (!hit) ended();
    else {
      header(hit);
      // The agent restarted (or became a shell) on a new PTY: follow it.
      if (hit.a.pty !== open.pty) watch(open.tab);
    }
  }
  if (pending && loaded) {
    const tab = pending;
    pending = null;
    if (findAgent(tab)) openAgent(tab);
  }
}

$("agents").addEventListener("click", (e) => {
  const b = e.target.closest(".ag");
  if (b) openAgent(b.dataset.tab);
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
    banner(ios && !standalone ? "Add this page to your Home Screen to get notifications." : "");
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
    if (loaded && findAgent(tab)) openAgent(tab);
    else pending = tab;
  });
}

// ---------- one agent's terminal ----------

let term = null;
let fit = null;
let sizeTimer = 0;
let lastSize = "";

function ensureTerm() {
  if (term) return;
  term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", monospace',
    fontSize: 11,
    scrollback: 3000,
    cursorBlink: false,
    // Output only: what a phone types goes through the keys and the line below, and xterm's own
    // answers to a program's queries come from the desktop's terminal.
    disableStdin: true,
    theme: {
      background: "#0e0f12", foreground: "#d6d8de", cursor: "#d6d8de", selectionBackground: "#3a3f4b",
      black: "#15171c", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7",
      cyan: "#7dcfff", white: "#d6d8de", brightBlack: "#7d828f", brightWhite: "#d6d8de",
    },
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

function header({ p, a }) {
  $("tv-name").textContent = a.name;
  const sig = $("tv-sig");
  sig.className = `sig ${a.sig ? `s-${a.sig}` : ""}`;
  sig.textContent = a.sig ? `· ${SIG_TEXT[a.sig]}` : "";
  $("tv-proj").textContent = `${p.name} · workspace ${a.ws}`;
}

function watch(tab) {
  const hit = findAgent(tab);
  if (!hit) return;
  open = { tab, pty: hit.a.pty };
  term.reset();
  fit.fit();
  lastSize = `${term.cols}x${term.rows}`;
  send({ t: "watch", pty: hit.a.pty, cols: term.cols, rows: term.rows });
}

function openAgent(tab) {
  const hit = findAgent(tab);
  if (!hit) return;
  document.querySelector(".gone")?.remove();
  show("term");
  ensureTerm();
  header(hit);
  if (!history.state || history.state.tab !== tab) history.pushState({ tab }, "", `#${encodeURIComponent(tab)}`);
  // Fit once the screen has its size.
  requestAnimationFrame(() => watch(tab));
}

function closeAgent() {
  if (!open) return;
  send({ t: "unwatch" });
  open = null;
  show("list");
}

/** The agent's window closed, or its PTY ended. */
function ended() {
  if (!open || document.querySelector(".gone")) return;
  const el = document.createElement("div");
  el.className = "gone";
  el.textContent = "This agent's window is gone.";
  $("termhost").after(el);
}

function output(buf) {
  if (!open || !term) return;
  const pty = new DataView(buf).getUint32(0);
  if (pty === open.pty) term.write(new Uint8Array(buf, 4));
}

function input(data) {
  if (open) send({ t: "input", pty: open.pty, data });
}

$("back").addEventListener("click", () => history.back());
window.addEventListener("popstate", () => {
  if (!history.state?.tab) closeAgent();
});

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

if (token) {
  show("list");
  connect();
} else if (params.get("pair") && !(ios && !standalone)) {
  pair(params.get("pair").toUpperCase());
} else {
  pairScreen();
}
