// Select element and Screenshot: injected into every browser page by src-tauri/src/browser.rs and
// dormant until tri-code calls window.__tricodePick(opts). It draws over the page itself, since
// tri-code's own HTML cannot paint above a native webview.
//
// Select element: click an element, Shift+click to add more, drag for an area (the elements
// inside it); describe the change (Shift+Enter for a new line); choose the agent window under
// "→", or a new claude or pi; Enter hands the text to tri-code, which types it into the agent
// unsent, so it can be edited there; Copy copies it instead. The Screenshot switch adds a cropped
// image of each selection (the element and 16px around it), shown as thumbnails; "Draw on it"
// opens that crop in Screenshot.
//
// Screenshot (opts.mode "draw"): the visible page is frozen as an image to draw on: pen, arrow,
// box, numbered pins (each with a note in the composer) and text. Sending captures the frozen
// image with the marks on it.
//
// It reports by navigating to https://tricode.invalid/pick, which browser.rs cancels and
// forwards; with screenshots it sends the rects to capture, and browser_shot.rs takes the snapshot
// before the overlay comes down (window.__tricodeDone). A snapshot to show in the page is asked
// for at /capture and comes back through window.__tricodeImage. Both carry the session's token.
(() => {
  if (window.top !== window || window.__tricodePick) return;
  const MAX_HTML = 300;
  const MAX_TEXT = 80;
  const MAX_IN_AREA = 8;
  const MAX_OUT = 20000;
  /** Room kept around an element in its screenshot, in CSS px. */
  const PAD = 16;
  /** How long a screenshot may take before the composer comes back with an error. */
  const SHOT_WAIT = 10000;
  // Kept before the page's own scripts run, which could replace them.
  const atob_ = window.atob.bind(window);
  const bitmapOf = window.createImageBitmap.bind(window);
  const Blob_ = window.Blob;
  let session = null;
  const define = (name, value) => Object.defineProperty(window, name, { value, writable: false, configurable: false });
  define("__tricodePick", (opts) => {
    session?.end();
    session = opts ? start(opts) : null;
  });
  // Replies from browser_shot.rs: a snapshot (base64 PNG, or "" and the error), and "captured".
  define("__tricodeImage", (b64, err) => session?.image(b64, err));
  define("__tricodeDone", () => session?.end());

  /** `agents`: the project's agent windows ({ id, name, icon, sig, msg, ws }); `target`: the one
   *  chosen at first; `new`: agents that can be started for the result ({ id, name, icon });
   *  `mode`: "pick" (Select element) or "draw" (Screenshot); `shot`: the Screenshot switch;
   *  `crop`: the part of the page Screenshot is about ({ x, y, w, h, name }, viewport px);
   *  `comment`: text to start the composer with; `token`: this session's, for screenshots. */
  function start(opts) {
    const { accent = "#7aa2f7", agents = [], target = "", new: starts = [], colors = {}, keys = {}, token = "" } = opts;
    const draw = opts.mode === "draw";
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    const safe = (v) => typeof v === "string" && /^[#\w(),.%\s-]+$/.test(v);
    const SIG = { working: "#7aa2f7", blocked: "#e0af68", done: "#9ece6a", error: "#f7768e" };
    for (const [k, v] of Object.entries(colors)) if (safe(v)) SIG[k] = v;
    // tri-code's keycap colours (styles.css --key*), in its theme and Keys setting.
    const KEY = { key: "#e8eaf0", "key-edge": "#f6f7fa", "key-base": "#8b90a0", "key-ink": "#15171c" };
    for (const [k, v] of Object.entries(keys)) if (k in KEY && safe(v) && v) KEY[k] = v;
    const ink = safe(accent) ? accent : "#7aa2f7";
    // Constructed sheets rather than <style>: a page's CSP (claude.ai, GitHub) blocks inline styles.
    adopt(root, `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
      svg.i { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
      .to { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 210px; padding: 0 6px 0 4px;
        color: #6b7080; font-size: 11.5px; }
      .to b { color: #23262d; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .to .car { font-size: 9px; }
      .to.open { background: #e6e8ee; }
      .to:disabled { cursor: default; background: none; }
      .av { position: relative; width: 16px; height: 16px; flex: none; display: grid; place-items: center; border-radius: 4px;
        color: ${ink}; background: color-mix(in srgb, ${ink} 20%, transparent); }
      .av svg { width: 11px; height: 11px; }
      .av.new { background: transparent; border: 1px dashed #d9dce3; color: #6b7080; }
      .dot { position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 1.5px #fbfbfc; }
      ${Object.entries(SIG).map(([k, v]) => `.dot.${k} { background: ${v}; }`).join("\n")}
      .menu { position: absolute; left: -2px; bottom: calc(100% + 6px); width: min(300px, calc(100vw - 32px)); max-height: min(340px, 60vh);
        overflow: auto; display: none; padding: 5px; border-radius: 9px; background: #fbfbfc; border: 1px solid #d9dce3;
        box-shadow: 0 14px 40px -10px rgba(20,24,34,.45); }
      .menu.on { display: block; }
      .menu h6 { display: flex; justify-content: space-between; margin: 3px 7px 4px; font-size: 10px; font-weight: 600;
        letter-spacing: .08em; text-transform: uppercase; color: #6b7080; }
      .menu h6 em { font-style: normal; font-weight: 400; letter-spacing: 0; }
      .menu hr { border: 0; border-top: 1px solid #d9dce3; margin: 4px 3px; }
      .mi { display: flex; align-items: center; gap: 9px; width: 100%; height: auto; min-height: 30px; padding: 4px 7px;
        border-radius: 6px; text-align: left; }
      .mi.kb { background: #e6e8ee; }
      .mi .ck { width: 10px; flex: none; color: ${ink}; font-weight: 700; }
      .mi .t { flex: 1; min-width: 0; display: grid; }
      .mi .t b { font-weight: 500; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mi .t small { color: #6b7080; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mi .ws { font: 10.5px ui-monospace, Consolas, monospace; color: #6b7080; border: 1px solid #d9dce3; border-radius: 3px; padding: 0 4px; }
      .mi.new { min-height: 28px; color: #6b7080; }
      .none { padding: 4px 7px 6px; font-size: 11.5px; color: #6b7080; }
      .box { position: fixed; pointer-events: none; border: 1.5px solid ${ink}; border-radius: 2px;
        background: color-mix(in srgb, ${ink} 10%, transparent); }
      .box.sel { border-width: 2px; background: color-mix(in srgb, ${ink} 16%, transparent); }
      .box.area { border-style: dashed; }
      .box.pad { border: 1px dashed ${ink}; background: none; opacity: .7; }
      .box b { position: absolute; left: -2px; top: -19px; padding: 1px 5px; border-radius: 3px 3px 3px 0;
        background: ${ink}; color: #fff; font: 600 10px/15px ui-monospace, Consolas, monospace; white-space: nowrap; }
      .box.below b { top: auto; bottom: -19px; border-radius: 0 3px 3px 3px; }
      /* The hidden attribute must win over the display a class gives (.bar is flex). */
      [hidden] { display: none !important; }
      /* Above the highlight boxes, which are appended after it. */
      .card { position: fixed; z-index: 1; left: 50%; transform: translateX(-50%); pointer-events: auto; color: #23262d;
        background: #fbfbfc; border: 1px solid #d9dce3; box-shadow: 0 14px 40px -12px rgba(30,34,44,.35); }
      .bar { top: 8px; display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 10px; border-radius: 8px;
        font-size: 12px; white-space: nowrap; max-width: calc(100vw - 16px); }
      .bar span { color: #6b7080; }
      .bar.tools { gap: 3px; padding: 4px 5px 4px 10px; flex-wrap: wrap; justify-content: center; }
      .bar.tools .lbl { margin-right: 5px; }
      .bar.tools button { height: 26px; min-width: 26px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center; color: #6b7080; }
      .bar.tools button[aria-pressed="true"] { background: #dfe2ea; color: #23262d; border-color: #d9dce3; }
      .bar .div { width: 1px; height: 18px; background: #d9dce3; margin: 0 4px; }
      .bar.err span { color: #c4314b; white-space: normal; }
      .sw i { width: 14px; height: 14px; border-radius: 50%; display: block; box-shadow: inset 0 0 0 1px rgba(0,0,0,.15); }
      .bar.tools .sw[aria-pressed="true"] { background: none; border-color: transparent; }
      .sw[aria-pressed="true"] i { box-shadow: 0 0 0 2px #fbfbfc, 0 0 0 3.5px #23262d; }
      button { font: inherit; color: inherit; background: none; border: 1px solid transparent; border-radius: 5px;
        cursor: pointer; height: 24px; padding: 0 9px; font-size: 12px; }
      button:hover { background: #e6e8ee; }
      button:focus-visible { outline: 2px solid ${ink}; outline-offset: 1px; }
      .composer { bottom: 12px; width: min(460px, calc(100vw - 24px)); display: none; gap: 6px; padding: 8px;
        border-radius: 10px; font-size: 13px; }
      .composer.on { display: grid; }
      .chips { display: flex; flex-wrap: wrap; gap: 4px; }
      .chip { display: flex; align-items: center; gap: 4px; height: 20px; padding: 0 2px 0 6px; border-radius: 4px;
        background: #dfe2ea; font: 11px ui-monospace, Consolas, monospace; max-width: 100%; }
      .chip i { font-style: normal; font-weight: 700; color: ${ink}; }
      .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chip button { height: 16px; width: 16px; padding: 0; color: #6b7080; }
      .thumbs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
      .thumbs:empty { display: none; }
      .thumbs .msg { font-size: 11.5px; color: #6b7080; padding: 2px 0; }
      .thumb { flex: none; display: grid; gap: 3px; justify-items: start; }
      .thumb .frame { position: relative; width: 132px; height: 76px; border-radius: 6px; border: 1px solid #d9dce3; overflow: hidden; background: #e6e8ee; }
      .thumb canvas { display: block; width: 132px; height: 76px; }
      .thumb .no { position: absolute; left: 4px; top: 4px; padding: 0 4px; border-radius: 3px; background: ${ink}; color: #fff;
        font: 700 10px/15px ui-monospace, Consolas, monospace; }
      .thumb button { height: 20px; padding: 0 5px; font-size: 11.5px; color: ${ink}; display: inline-flex; align-items: center; gap: 4px; }
      .thumb button svg { width: 12px; height: 12px; }
      .notes { display: grid; gap: 5px; }
      .notes:empty { display: none; }
      .note { display: flex; align-items: center; gap: 7px; }
      .note .no { flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 700 11px system-ui, sans-serif; }
      input.n { flex: 1; min-width: 0; font: 13px system-ui, "Segoe UI", sans-serif; color: inherit; background: transparent; border: 0;
        border-bottom: 1px solid #d9dce3; padding: 3px 0; outline: none; }
      input.n:focus { border-bottom-color: ${ink}; }
      textarea { font: 13px/1.4 system-ui, "Segoe UI", sans-serif; color: inherit; background: transparent; border: 0;
        border-bottom: 1px solid #d9dce3; padding: 4px 0; resize: none; outline: none; }
      textarea:focus { border-bottom-color: ${ink}; }
      .row { position: relative; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .row .sp { flex: 1; }
      /* The keycap, as tri-code draws it (Keys.tsx, kbd in styles.css). */
      kbd { display: inline-grid; place-items: center; height: 17px; min-width: 16px; padding: 0 3px; vertical-align: middle;
        border: 1px solid ${KEY["key-edge"]}; border-bottom: 3px solid ${KEY["key-base"]}; border-radius: 3px;
        background: ${KEY.key}; color: ${KEY["key-ink"]}; font: 700 10px/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
        font-style: normal; white-space: nowrap; }
      kbd + kbd { margin-left: 2px; }
      kbd svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
      .keys { display: inline-flex; align-items: center; flex: none; vertical-align: middle; }
      .hint { display: inline-flex; align-items: center; gap: 5px; color: #6b7080; font-size: 11px; white-space: nowrap; }
      .row > button:not(.to) { display: inline-flex; align-items: center; gap: 6px; border-color: #d9dce3; }
      .row .primary { background: ${ink}; border-color: ${ink}; color: #fff; padding-right: 4px; }
      .copy.done { color: ${ink}; }
      /* The Screenshot switch */
      .tog { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px 0 6px; border-radius: 5px;
        font-size: 12px; color: #6b7080; border: 1px solid #d9dce3; cursor: pointer; user-select: none; }
      .tog:hover { background: #e6e8ee; }
      .tog:focus-visible { outline: 2px solid ${ink}; outline-offset: 1px; }
      .tog .track { position: relative; width: 24px; height: 14px; border-radius: 7px; background: #d9dce3; }
      .tog .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%;
        background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .12s; }
      .tog[aria-checked="true"] { color: #23262d; }
      .tog[aria-checked="true"] .track { background: ${ink}; }
      .tog[aria-checked="true"] .track::after { transform: translateX(10px); }
      /* Screenshot: the frozen page and the marks, one canvas */
      canvas.shot { position: fixed; left: 0; top: 0; pointer-events: auto; cursor: crosshair; touch-action: none; }
      .frame-edge { position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 2px ${ink}; }
      .textin { position: fixed; pointer-events: auto; font: 700 18px system-ui, sans-serif; padding: 1px 4px; min-width: 140px;
        border: 1.5px dashed currentColor; border-radius: 4px; background: rgba(255,255,255,.92); outline: none; }
      .capturing .card, .capturing .frame-edge, .capturing .textin { visibility: hidden; }
      @media (prefers-reduced-motion: reduce) { .tog .track::after { transition: none; } }
      @media (prefers-color-scheme: dark) {
        .card, .menu { color: #d6d8de; background: #15171c; border-color: #2c3039; box-shadow: 0 14px 40px -12px #000; }
        .bar span, .to, .chip button, .menu h6, .mi .t small, .mi .ws, .mi.new, .none, .av.new, .hint, .tog, .bar.tools button, .thumbs .msg { color: #7d828f; }
        .to b, .tog[aria-checked="true"], .bar.tools button[aria-pressed="true"] { color: #d6d8de; }
        button:hover, .to.open, .mi.kb, .tog:hover { background: #232733; }
        .bar.tools button[aria-pressed="true"] { background: #232733; border-color: #2c3039; }
        .bar.err span { color: #f7768e; }
        .sw[aria-pressed="true"] i { box-shadow: 0 0 0 2px #15171c, 0 0 0 3.5px #d6d8de; }
        .row .primary:hover { background: ${ink}; }
        .chip { background: #232733; }
        .thumb .frame { background: #232733; border-color: #2c3039; }
        textarea, input.n, .menu hr, .mi .ws, .av.new, .tog, .row > button:not(.to):not(.primary), .bar .div { border-color: #2c3039; }
        .bar .div, .tog .track { background: #2c3039; }
        .dot { box-shadow: 0 0 0 1.5px #15171c; }
      }`);

    const send = `<button class="copy" data-a="copy" title="Copy the description instead">Copy</button>
        <button class="primary" data-a="send" title="Type into the agent without submitting it, to edit there">Send ${caps("Enter")}</button>`;
    root.innerHTML = draw ? `
    <canvas class="shot" hidden></canvas><div class="frame-edge" hidden></div>
    <div class="card bar tools" role="toolbar" aria-label="Drawing tools" hidden>
      <span class="lbl"></span>
      ${TOOLS.map(([t, name, k]) => `<button data-tool="${t}" title="${name} (${k})">${icon(t)}</button>`).join("")}
      <span class="div"></span>
      ${INKS.map(([c, name], i) => `<button class="sw" data-ink="${c}" title="${name} (${i + 1})"><i style="background:${c}"></i></button>`).join("")}
      <span class="div"></span>
      <button data-a="undo" title="Undo the last mark (Ctrl+Z)">${icon("undo")}</button>
      <button data-a="clear" title="Clear all marks">${icon("clear")}</button>
      <button data-a="retake" title="Take the screenshot again; the marks stay">${icon("retake")}</button>
      <button data-a="end" title="Stop">${caps("Esc")}</button>
    </div>
    <div class="card bar err" hidden><span></span><button data-a="end" title="Stop">${caps("Esc")}</button></div>
    <div class="card composer">
      <div class="notes"></div>
      <textarea rows="1" placeholder="Anything else to change…"></textarea>
      <div class="row"><div class="menu" role="listbox"></div>
        <button class="to" data-a="menu" title="Which agent gets it"></button><span class="sp"></span>
        <span class="hint">${caps("Shift", "Enter")} new line</span>${send}</div>
    </div>` : `
    <div class="card bar"><span>Click an element · drag an area · ${caps("Shift")} adds</span><button data-a="end" title="Stop selecting">${caps("Esc")}</button></div>
    <div class="card composer">
      <div class="chips"></div>
      <div class="thumbs"></div>
      <textarea rows="2" placeholder="Describe the change…"></textarea>
      <div class="row"><div class="menu" role="listbox"></div>
        <button class="to" data-a="menu" title="Which agent gets it"></button>
        <span class="tog" role="switch" tabindex="0" data-a="shot" title="Attach a cropped screenshot of each selection"><span class="track"></span>${icon("camera")}Screenshot</span>
        <span class="sp"></span>
        <span class="hint">${caps("Shift", "Enter")} new line</span>${send}</div>
    </div>`;
    const composer = root.querySelector(".composer");
    const comment = root.querySelector("textarea");
    const toBtn = root.querySelector(".to");
    const menu = root.querySelector(".menu");
    comment.value = opts.comment || "";

    // Where the result goes: an agent window ({ to }) or an agent to start ({ new }).
    const choices = [...agents.map((a) => ({ to: a.id, a })), ...starts.map((a) => ({ new: a.id, a }))];
    let choice = choices.find((c) => c.to === target) ?? choices.find((c) => opts.startNew && c.new === opts.startNew) ?? choices[0] ?? null;
    let kb = -1;
    const avatar = (a, isNew) =>
      `<span class="av${isNew ? " new" : ""}">${isNew ? "+" : a.icon || ""}${a.sig ? `<span class="dot ${esc(a.sig)}"></span>` : ""}</span>`;

    function paintTarget() {
      toBtn.disabled = !choices.length;
      toBtn.innerHTML = !choice ? "no agent to send to"
        : `→ ${avatar(choice.a, false)}<b>${choice.new ? "new " : ""}${esc(choice.a.name)}</b><span class="car">▾</span>`;
    }

    function paintMenu() {
      const rows = choices.map((c, i) => {
        const on = c === choice ? "✓" : "";
        const cls = `mi${c.new ? " new" : ""}${i === kb ? " kb" : ""}`;
        const sub = c.new ? "" : `<small>${esc(c.a.msg || "")}</small>`;
        const ws = c.new ? "" : `<span class="ws">${esc(String(c.a.ws))}</span>`;
        return `<button class="${cls}" data-i="${i}"><span class="ck">${on}</span>${avatar(c.a, !!c.new)}`
          + `<span class="t"><b>${c.new ? "New " : ""}${esc(c.a.name)}</b>${sub}</span>${ws}</button>`;
      });
      const head = `<h6>Agents in this project <em>${agents.length}</em></h6>`;
      const none = agents.length ? "" : `<div class="none">None open. Start one and the selection goes to it.</div>`;
      const split = agents.length && starts.length ? "<hr>" : "";
      menu.innerHTML = head + none + rows.slice(0, agents.length).join("") + split + rows.slice(agents.length).join("");
      menu.querySelector(".kb")?.scrollIntoView({ block: "nearest" });
    }

    const menuOpen = () => menu.classList.contains("on");
    function openMenu(on) {
      if (!choices.length) return;
      kb = on ? Math.max(0, choices.indexOf(choice)) : -1;
      menu.classList.toggle("on", on);
      toBtn.classList.toggle("open", on);
      if (on) paintMenu();
      else comment.focus();
    }
    function choose(i) {
      if (choices[i]) choice = choices[i];
      paintTarget();
      openMenu(false);
    }
    paintTarget();
    document.documentElement.append(host);

    const inOverlay = (e) => e.composedPath().includes(host);
    const stop = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const block = (e) => inOverlay(e) || stop(e);
    const go = (path) => (location.href = `https://tricode.invalid/${path}`);
    const typing = () => /^(INPUT|TEXTAREA)$/.test(root.activeElement?.tagName ?? "");

    // ---- snapshots (browser_shot.rs) ----

    let waiting = null;
    let refocus = null;
    /** A snapshot of the page without this overlay: `done(bitmap)`, or `done(null, error)`. */
    function capture(done) {
      waiting = done;
      // Hiding the overlay takes the focus out of it; it goes back once the snapshot is in.
      refocus = root.activeElement;
      host.style.visibility = "hidden";
      // Two frames, so the overlay is off the screen before the snapshot is taken.
      requestAnimationFrame(() => requestAnimationFrame(() => go(`capture?k=${encodeURIComponent(token)}`)));
    }
    function image(b64, err) {
      host.style.visibility = "";
      refocus?.focus?.();
      refocus = null;
      const done = waiting;
      waiting = null;
      if (!done) return;
      if (!b64) return done(null, err || "no image");
      try {
        const bin = atob_(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        bitmapOf(new Blob_([bytes], { type: "image/png" })).then((bmp) => done(bmp), (e) => done(null, String(e)));
      } catch (e) {
        done(null, String(e));
      }
    }

    /** `rect` (viewport px) clipped to the viewport, or null when none of it is on the screen. */
    function onScreen(r) {
      const x = Math.max(0, r.x), y = Math.max(0, r.y);
      const w = Math.min(innerWidth, r.x + r.width) - x, h = Math.min(innerHeight, r.y + r.height) - y;
      return w >= 1 && h >= 1 ? new DOMRect(x, y, w, h) : null;
    }

    /** Report the result with screenshots: `rects` are cut from a snapshot taken after `hide`. */
    let sendTimer = 0;
    function sendWithShots(t, rects, { copy = false, hide, show, shotPref } = {}) {
      hide();
      const q = new URLSearchParams({ d: t, k: token, vw: String(innerWidth), shots: JSON.stringify(rects.map((r) => [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100))) });
      if (choice?.to) q.set("to", choice.to);
      if (choice?.new) q.set("new", choice.new);
      if (copy) q.set("copy", "1");
      if (shotPref !== undefined) q.set("shot", shotPref ? "1" : "0");
      requestAnimationFrame(() => requestAnimationFrame(() => go(`pick?${q}`)));
      // browser_shot.rs ends the session once the snapshot is taken; if it never answers, say so.
      clearTimeout(sendTimer);
      sendTimer = setTimeout(() => {
        show();
        flashError("The screenshot didn't come back. Try again, or press Esc.");
      }, SHOT_WAIT);
    }

    /** Report the result without screenshots. */
    function sendPlain(t, extra = {}) {
      const q = new URLSearchParams({ d: t, ...extra });
      if (choice?.to) q.set("to", choice.to);
      if (choice?.new) q.set("new", choice.new);
      go(`pick?${q}`);
    }

    /** Copy `t` in the page, show it worked, then stop. Inside the click, so the page's clipboard
     *  allows it; execCommand covers pages that aren't a secure context. */
    function copyHere(btn, t) {
      const fallback = () => {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.cssText = "position:fixed;opacity:0";
        root.append(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      };
      const done = (ok) => {
        btn.textContent = ok ? "Copied ✓" : "Copy failed";
        btn.classList.add("done");
        setTimeout(end, ok ? 700 : 1500);
      };
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(t).then(() => done(true), () => done(fallback()));
      } else done(fallback());
    }

    let flashError = () => {};
    const clip = (t) => (t.length > MAX_OUT ? t.slice(0, MAX_OUT) + "\n…" : t);

    const mode = draw ? drawMode() : pickMode();

    root.addEventListener("click", (e) => {
      const item = e.target.closest?.(".mi");
      if (item) return choose(+item.dataset.i);
      const a = e.target.closest?.("[data-a]")?.dataset.a;
      if (a === "menu") return openMenu(!menuOpen());
      if (menuOpen()) openMenu(false);
      if (a === "end") end();
      else if (a === "copy") mode.submit(true, e.target.closest("button"));
      else if (a === "send") mode.submit(false);
      else mode.click?.(e, a);
    });

    function onKey(e) {
      if (menuOpen()) {
        const keys = { ArrowDown: 1, ArrowUp: -1 };
        if (e.key in keys) kb = (kb + keys[e.key] + choices.length) % choices.length, paintMenu();
        else if (e.key === "Enter" || e.key === " ") choose(kb);
        else if (e.key === "Escape" || e.key === "Tab") openMenu(false);
        else return;
        return stop(e);
      }
      if (mode.key?.(e)) return;
      if (e.key === "Escape") return block(e), end();
      if (root.activeElement === toBtn && (e.key === "ArrowUp" || e.key === "ArrowDown")) return stop(e), openMenu(true);
      // The shadow root is closed, so the event path seen from window stops at the host.
      if (e.key === "Enter" && !e.shiftKey && (root.activeElement === comment || root.activeElement?.matches?.("input.n"))) {
        e.preventDefault();
        mode.submit(false);
      }
      // Keys typed into the composer stay out of the page's own shortcuts.
      if (inOverlay(e)) e.stopImmediatePropagation();
    }

    const listeners = [...mode.listeners, ["keydown", onKey]];
    for (const [t, f, o] of listeners) addEventListener(t, f, { capture: true, ...o });

    function end() {
      for (const [t, f] of listeners) removeEventListener(t, f, { capture: true });
      clearTimeout(sendTimer);
      mode.end?.();
      host.remove();
      if (session?.end === end) session = null;
    }

    /** Start over in the other mode, keeping the composer's text and agent. */
    function restart(extra) {
      const keep = { comment: comment.value, target: choice?.to ?? "", startNew: choice?.new ?? "" };
      window.__tricodePick({ ...opts, ...keep, ...extra });
    }

    // ---- Select element ----

    function pickMode() {
      const chips = root.querySelector(".chips");
      const thumbs = root.querySelector(".thumbs");
      const tog = root.querySelector(".tog");
      const cursor = adopt(document, "html, html * { cursor: crosshair !important; }");
      let shotOn = !!opts.shot;

      /** Elements, or areas with the elements inside them, in pick order. */
      let sel = [];
      let hover = null;
      let drag = null;
      const boxes = [];

      function box(r, cls, label) {
        const b = document.createElement("div");
        b.className = "box " + cls + (r.top < 22 ? " below" : "");
        Object.assign(b.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
        if (label) {
          const l = document.createElement("b");
          l.textContent = label;
          b.append(l);
        }
        root.append(b);
        boxes.push(b);
        return b;
      }

      const areaRect = (a) => new DOMRect(a.x - scrollX, a.y - scrollY, a.w, a.h);
      /** What a selection's screenshot covers, in viewport px (before clipping to the screen). */
      const shotRect = (t) => {
        if (t.area) return areaRect(t.area);
        const r = t.el.getBoundingClientRect();
        return new DOMRect(r.x - PAD, r.y - PAD, r.width + PAD * 2, r.height + PAD * 2);
      };
      const nameOfSel = (t) => (t.area ? `area · ${t.els.length} el` : nameOf(t.el));

      function paint() {
        boxes.splice(0).forEach((b) => b.remove());
        sel.forEach((t, i) => {
          if (shotOn && !t.area) box(shotRect(t), "pad", "");
          if (t.area) box(areaRect(t.area), "sel area", `${i + 1} area · ${t.els.length} el`);
          else box(t.el.getBoundingClientRect(), "sel", `${i + 1} ${nameOf(t.el)}`);
        });
        if (drag?.rect) box(drag.rect, "area", `${Math.round(drag.rect.width)}×${Math.round(drag.rect.height)}`);
        else if (hover) {
          const r = hover.getBoundingClientRect();
          box(r, "", `${nameOf(hover)}  ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
      }

      function refresh() {
        composer.classList.toggle("on", sel.length > 0);
        chips.innerHTML = "";
        sel.forEach((t, i) => {
          const c = document.createElement("span");
          c.className = "chip";
          c.innerHTML = `<i>${i + 1}</i><span></span><button title="Remove">×</button>`;
          c.querySelector("span").textContent = nameOfSel(t);
          c.querySelector("button").onclick = () => { sel.splice(i, 1); refresh(); };
          chips.append(c);
        });
        tog.setAttribute("aria-checked", String(shotOn));
        paint();
        wantThumbs();
        if (sel.length) comment.focus();
      }

      // Thumbnails: one snapshot after the selection settles, cut into a small canvas each.
      let thumbTimer = 0, busy = false, again = false;
      function wantThumbs() {
        clearTimeout(thumbTimer);
        if (!shotOn || !sel.length) return void (thumbs.innerHTML = "");
        thumbTimer = setTimeout(takeThumbs, 150);
      }
      function takeThumbs() {
        if (busy) return void (again = true);
        busy = true;
        const taken = sel.slice();
        const rects = taken.map((t) => onScreen(shotRect(t)));
        capture((bmp, err) => {
          busy = false;
          if (again) return (again = false), takeThumbs();
          paint();
          thumbs.innerHTML = "";
          if (!bmp) return void (thumbs.innerHTML = `<span class="msg">Screenshot failed: ${esc(err || "")}</span>`);
          const s = bmp.width / innerWidth;
          taken.forEach((t, i) => {
            const n = sel.indexOf(t);
            if (n < 0) return;
            const el = document.createElement("div");
            el.className = "thumb";
            el.innerHTML = `<div class="frame"><canvas></canvas><span class="no">${n + 1}</span></div>`
              + (rects[i] ? `<button data-a="drawon" data-i="${n}" title="Open this crop in Screenshot, to draw on">${icon("pen")}Draw on it</button>` : `<span class="msg">off screen</span>`);
            const r = rects[i];
            if (r) {
              const cv = el.querySelector("canvas");
              const dpr = devicePixelRatio || 1;
              cv.width = 132 * dpr;
              cv.height = 76 * dpr;
              const ctx = cv.getContext("2d");
              const fit = Math.min(132 / r.width, 76 / r.height);
              const w = r.width * fit, h = r.height * fit;
              ctx.scale(dpr, dpr);
              ctx.drawImage(bmp, r.x * s, r.y * s, r.width * s, r.height * s, (132 - w) / 2, (76 - h) / 2, w, h);
            }
            thumbs.append(el);
          });
          bmp.close?.();
        });
      }

      function onMove(e) {
        if (inOverlay(e)) { hover = null; return paint(); }
        if (drag) {
          if (!drag.rect && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
          const x = Math.min(e.clientX, drag.x), y = Math.min(e.clientY, drag.y);
          drag.rect = new DOMRect(x, y, Math.abs(e.clientX - drag.x), Math.abs(e.clientY - drag.y));
        } else {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          hover = el && el !== document.documentElement && el !== document.body ? el : null;
        }
        paint();
      }

      function onDown(e) {
        if (inOverlay(e) || e.button !== 0) return;
        block(e);
        if (menuOpen()) openMenu(false);
        drag = { x: e.clientX, y: e.clientY, rect: null, shift: e.shiftKey, target: hover };
      }

      function onUp(e) {
        if (!drag) return;
        block(e);
        const d = drag;
        drag = null;
        if (!d.shift) sel = [];
        if (d.rect) {
          const a = { x: d.rect.left + scrollX, y: d.rect.top + scrollY, w: d.rect.width, h: d.rect.height };
          sel.push({ area: a, els: inside(d.rect) });
        } else if (d.target) {
          const i = sel.findIndex((t) => t.el === d.target);
          if (i >= 0 && d.shift) sel.splice(i, 1);
          else if (i < 0) sel.push({ el: d.target });
        }
        refresh();
      }

      // Thumbnails go stale when the page scrolls; take them again once it stops.
      let scrollTimer = 0;
      function onScroll() {
        paint();
        if (!shotOn || !sel.length) return;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(wantThumbs, 250);
      }

      function toggle() {
        shotOn = !shotOn;
        refresh();
      }

      function submit(copy, btn) {
        if (!sel.length) return;
        // Each selection on the screen gets an image; ⟦shot N⟧ stands for its path.
        const rects = [];
        const shots = sel.map((t) => {
          if (!shotOn) return 0;
          const r = onScreen(shotRect(t));
          if (!r) return -1;
          rects.push(r);
          return rects.length;
        });
        const t = clip(describeAll(sel, comment.value.trim(), shots));
        if (!rects.length) {
          if (copy) return copyHere(btn, t);
          end();
          return sendPlain(t, { shot: shotOn ? "1" : "0" });
        }
        sendWithShots(t, rects, {
          copy,
          shotPref: shotOn,
          hide: () => (host.style.visibility = "hidden"),
          show: () => (host.style.visibility = ""),
        });
      }

      flashError = (msg) => {
        thumbs.innerHTML = `<span class="msg">${esc(msg)}</span>`;
        composer.classList.add("on");
      };

      return {
        listeners: [
          ["pointermove", onMove], ["pointerdown", onDown], ["pointerup", onUp],
          ["mousedown", block], ["mouseup", block], ["click", block], ["auxclick", block], ["dblclick", block],
          ["contextmenu", block], ["scroll", onScroll, { passive: true }], ["resize", paint],
        ],
        submit,
        click(e, a) {
          if (a === "shot") toggle();
          else if (a === "drawon") {
            const t = sel[+e.target.closest("[data-a]").dataset.i];
            const r = t && onScreen(shotRect(t));
            if (r) restart({ mode: "draw", crop: { x: r.x, y: r.y, w: r.width, h: r.height, name: nameOfSel(t) } });
          }
        },
        key(e) {
          if (root.activeElement === tog && (e.key === " " || e.key === "Enter")) {
            stop(e);
            toggle();
            return true;
          }
        },
        end() {
          clearTimeout(thumbTimer);
          clearTimeout(scrollTimer);
          cursor.remove();
        },
      };
    }

    // ---- Screenshot ----

    function drawMode() {
      const cv = root.querySelector("canvas.shot");
      const edge = root.querySelector(".frame-edge");
      const tools = root.querySelector(".bar.tools");
      const errBar = root.querySelector(".bar.err");
      const notesEl = root.querySelector(".notes");
      const ctx = cv.getContext("2d");
      const crop = opts.crop && opts.crop.w > 0 && opts.crop.h > 0 ? opts.crop : null;
      tools.querySelector(".lbl").textContent = crop ? `${crop.name} · draw on it` : "Screenshot · draw on it";
      let bmp = null;
      let tool = "pin", inkColor = INKS[0][0];
      /** Marks in viewport px: pen { pts }, arrow and box { a, b }, pin { p, note }, text { p, s }. */
      let marks = [];
      let live = null;
      let textIn = null;

      function setTool(t) {
        tool = t;
        tools.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
      }
      function setInk(c) {
        inkColor = c;
        tools.querySelectorAll("[data-ink]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ink === c)));
      }
      setTool(tool);
      setInk(inkColor);

      function size() {
        const dpr = devicePixelRatio || 1;
        cv.width = Math.round(innerWidth * dpr);
        cv.height = Math.round(innerHeight * dpr);
        cv.style.width = innerWidth + "px";
        cv.style.height = innerHeight + "px";
        redraw();
      }

      const pins = () => marks.filter((m) => m.t === "pin");

      function paintMark(m) {
        ctx.strokeStyle = ctx.fillStyle = m.c;
        ctx.lineWidth = 3;
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.setLineDash([]);
        if (m.t === "pen") {
          ctx.beginPath();
          m.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        } else if (m.t === "arrow") {
          const [ax, ay] = m.a, [bx, by] = m.b, ang = Math.atan2(by - ay, bx - ax), L = 14;
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - L * Math.cos(ang - 0.45), by - L * Math.sin(ang - 0.45));
          ctx.lineTo(bx - L * Math.cos(ang + 0.45), by - L * Math.sin(ang + 0.45));
          ctx.closePath(); ctx.fill();
        } else if (m.t === "box") {
          const x = Math.min(m.a[0], m.b[0]), y = Math.min(m.a[1], m.b[1]);
          ctx.strokeRect(x, y, Math.abs(m.b[0] - m.a[0]), Math.abs(m.b[1] - m.a[1]));
        } else if (m.t === "pin") {
          const [x, y] = m.p;
          ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.fill();
          ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
          ctx.fillStyle = "#fff";
          ctx.font = "700 14px system-ui, sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(String(pins().indexOf(m) + 1), x, y + 1);
        } else if (m.t === "text") {
          ctx.font = "700 18px system-ui, sans-serif";
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.lineWidth = 5; ctx.strokeStyle = "#fff";
          ctx.strokeText(m.s, m.p[0], m.p[1]);
          ctx.fillText(m.s, m.p[0], m.p[1]);
        }
      }

      function redraw() {
        const dpr = devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        if (!bmp) return;
        // The snapshot is in device px and at most a scrollbar wider than the viewport's CSS width.
        const s = innerWidth / bmp.width;
        ctx.drawImage(bmp, 0, 0, bmp.width * s, bmp.height * s);
        if (crop) {
          ctx.fillStyle = "rgba(15,18,24,.45)";
          ctx.beginPath();
          ctx.rect(0, 0, innerWidth, innerHeight);
          ctx.rect(crop.x, crop.y, crop.w, crop.h);
          ctx.fill("evenodd");
        }
        marks.forEach(paintMark);
        if (live) paintMark(live);
      }

      function paintNotes(focusLast) {
        const kept = new Map([...notesEl.querySelectorAll("input")].map((i) => [i.dataset.id, i.value]));
        notesEl.innerHTML = "";
        pins().forEach((m, i) => {
          if (kept.has(String(m.id))) m.note = kept.get(String(m.id));
          const row = document.createElement("div");
          row.className = "note";
          row.innerHTML = `<span class="no" style="background:${m.c}">${i + 1}</span><input class="n" placeholder="What should change at ${i + 1}?">`;
          const input = row.querySelector("input");
          input.dataset.id = String(m.id);
          input.value = m.note || "";
          input.addEventListener("input", () => (m.note = input.value));
          notesEl.append(row);
        });
        if (focusLast) notesEl.querySelector(".note:last-child input")?.focus();
      }

      let seq = 0;
      function add(m) {
        m.id = ++seq;
        marks.push(m);
        redraw();
        if (m.t === "pin") paintNotes(true);
      }
      function undo() {
        marks.pop();
        redraw();
        paintNotes(false);
      }

      const at = (e) => [e.clientX, e.clientY];
      cv.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !bmp) return;
        if (menuOpen()) openMenu(false);
        commitText();
        const p = at(e);
        if (tool === "pin") return add({ t: "pin", c: inkColor, p, note: "" });
        if (tool === "text") return void setTimeout(() => openText(p));
        cv.setPointerCapture(e.pointerId);
        live = tool === "pen" ? { t: "pen", c: inkColor, pts: [p] } : { t: tool, c: inkColor, a: p, b: p };
      });
      cv.addEventListener("pointermove", (e) => {
        if (!live) return;
        if (live.t === "pen") live.pts.push(at(e));
        else live.b = at(e);
        redraw();
      });
      cv.addEventListener("pointerup", () => {
        if (!live) return;
        const m = live;
        live = null;
        const big = m.t === "pen" ? m.pts.length > 2 : Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]) > 6;
        if (big) add(m);
        else redraw();
      });

      function openText(p) {
        const input = document.createElement("input");
        input.className = "textin";
        input.placeholder = "Type, then Enter";
        input.style.color = inkColor;
        input.style.left = p[0] - 5 + "px";
        input.style.top = p[1] - 14 + "px";
        root.append(input);
        textIn = { input, p, c: inkColor };
        input.focus();
        input.addEventListener("blur", () => commitText());
      }
      function commitText(cancel) {
        if (!textIn) return;
        const { input, p, c } = textIn;
        textIn = null;
        const s = input.value.trim();
        input.remove();
        if (s && !cancel) add({ t: "text", c, p: [p[0], p[1]], s });
      }

      /** The description: where the image is, what each pin's note says, what else is drawn. */
      function describeShot() {
        const title = document.title.trim();
        const out = [`Screenshot of ${location.href}${title ? ` ("${title}")` : ""}${crop ? `, cropped to ${crop.name}` : ""}, marked up:`];
        out.push(`   image: ⟦shot 1⟧`);
        const ps = pins();
        if (ps.length) out.push(`The numbered pins on it:`);
        ps.forEach((m, i) => out.push(`${i + 1}. ${(m.note || "").trim() || "(no note)"}`));
        const n = (t) => marks.filter((m) => m.t === t).length;
        const count = (t, one, many) => (n(t) ? `${n(t)} ${n(t) > 1 ? many : one}` : "");
        const words = marks.filter((m) => m.t === "text").map((m) => `"${m.s}"`);
        const also = [count("arrow", "arrow", "arrows"), count("box", "box", "boxes"), count("pen", "freehand mark", "freehand marks"),
          words.length ? `text ${words.join(", ")}` : ""].filter(Boolean);
        if (also.length) out.push(`${ps.length ? "Also drawn" : "Drawn on it"}: ${also.join(", ")}`);
        const c = comment.value.trim();
        if (c) out.push("", c);
        return out.join("\n");
      }

      function submit(copy) {
        if (!bmp) return;
        commitText();
        const area = crop ? onScreen(new DOMRect(crop.x, crop.y, crop.w, crop.h)) : new DOMRect(0, 0, innerWidth, innerHeight);
        sendWithShots(clip(describeShot()), [area ?? new DOMRect(0, 0, innerWidth, innerHeight)], {
          copy,
          hide: () => wrapClass(true),
          show: () => wrapClass(false),
        });
      }
      // The toolbar and composer leave the screen for the final snapshot; the image and marks stay.
      const wrap = document.createElement("div");
      wrap.append(...root.childNodes);
      root.append(wrap);
      const wrapClass = (on) => wrap.classList.toggle("capturing", on);

      function shoot(keepMarks) {
        capture((b, err) => {
          if (!b) {
            errBar.querySelector("span").textContent = `Couldn't take the screenshot: ${err || "no image"}`;
            errBar.hidden = false;
            tools.hidden = true;
            composer.classList.remove("on");
            return;
          }
          bmp?.close?.();
          bmp = b;
          if (!keepMarks) marks = [];
          cv.hidden = edge.hidden = tools.hidden = false;
          errBar.hidden = true;
          composer.classList.add("on");
          size();
          paintNotes(false);
          if (!keepMarks && comment.value) comment.focus();
        });
      }
      shoot(false);

      flashError = (msg) => {
        errBar.querySelector("span").textContent = msg;
        errBar.hidden = false;
      };

      const KEYS = Object.fromEntries(TOOLS.map(([t, , k]) => [k.toLowerCase(), t]));
      return {
        // The page is frozen: none of its own input gets through.
        listeners: [
          ["pointerdown", block], ["pointermove", block], ["pointerup", block],
          ["mousedown", block], ["mouseup", block], ["click", block], ["auxclick", block], ["dblclick", block],
          ["contextmenu", block], ["wheel", block, { passive: false }], ["touchmove", block, { passive: false }],
          ["resize", size],
        ],
        submit,
        click(e, a) {
          const t = e.target.closest?.("[data-tool]")?.dataset.tool;
          const c = e.target.closest?.("[data-ink]")?.dataset.ink;
          if (t) setTool(t);
          else if (c) setInk(c);
          else if (a === "undo") undo();
          else if (a === "clear") (marks = []), redraw(), paintNotes(false);
          else if (a === "retake") shoot(true);
        },
        key(e) {
          if (textIn && root.activeElement === textIn.input) {
            if (e.key === "Enter") commitText();
            else if (e.key === "Escape") commitText(true);
            else return e.stopImmediatePropagation(), true;
            stop(e);
            return true;
          }
          if (typing() || e.altKey) return false;
          const k = e.key.toLowerCase();
          if ((e.ctrlKey || e.metaKey) && k === "z") return stop(e), undo(), true;
          if (e.ctrlKey || e.metaKey) return false;
          if (KEYS[k]) return stop(e), setTool(KEYS[k]), true;
          if (/^[1-4]$/.test(e.key)) return stop(e), setInk(INKS[+e.key - 1][0]), true;
          if (e.key === "Enter" && !e.shiftKey && !root.activeElement) return stop(e), submit(false), true;
          if (e.key !== "Escape" && !inOverlay(e)) return stop(e), true; // scrolling keys and the page's shortcuts
          return false;
        },
        end() {
          bmp?.close?.();
        },
      };
    }

    return { end, image };
  }

  /** Screenshot's tools: [id, name, key]. */
  const TOOLS = [["pen", "Pen", "P"], ["arrow", "Arrow", "A"], ["box", "Box", "R"], ["pin", "Numbered pin, with a note", "N"], ["text", "Text", "T"]];
  /** Screenshot's ink colours: [colour, name]. */
  const INKS = [["#e5484d", "Red"], ["#f5a524", "Amber"], ["#3e7bfa", "Blue"], ["#30a46c", "Green"]];
  /** Lucide icons, as the app draws them. */
  const ICONS = {
    pen: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
    arrow: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
    box: '<rect width="18" height="14" x="3" y="5" rx="2"/>',
    pin: '<circle cx="12" cy="12" r="9"/><path d="M10.5 9.5 12.5 8v8"/>',
    text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    clear: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    retake: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  };
  const icon = (name) => `<svg class="i" viewBox="0 0 24 24">${ICONS[name]}</svg>`;

  /** The elements inside a viewport rect, outermost first, at most MAX_IN_AREA: those fully
   *  inside, and innermost ones it only partly covers (a line of text crossing the area). */
  function inside(r) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (out.length >= MAX_IN_AREA || c === document.currentScript) return;
        const b = c.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) { walk(c); continue; }
        if (b.left >= r.left && b.top >= r.top && b.right <= r.right && b.bottom <= r.bottom) out.push(c);
        else if (b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom) {
          const before = out.length;
          walk(c);
          if (out.length === before && out.length < MAX_IN_AREA) out.push(c);
        }
      }
    };
    walk(document.body);
    return out;
  }

  /** Adds `css` to a document or shadow root; returns { remove }. */
  function adopt(target, css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
      return { remove: () => (target.adoptedStyleSheets = target.adoptedStyleSheets.filter((s) => s !== sheet)) };
    } catch {
      const style = document.createElement("style");
      style.textContent = css;
      (target === document ? document.documentElement : target).append(style);
      return style;
    }
  }

  // Keys a keyboard marks with a symbol, drawn as that symbol (as Keys.tsx does).
  const KEY_ICONS = {
    Shift: ["Shift", "M12 3l9 10h-5v8H8v-8H3z"],
    Enter: ["Enter", "M20 5v6a3 3 0 0 1-3 3H5M10 9l-5 5 5 5"],
  };

  /** Keycaps for a chord, as tri-code's Keycap draws them. */
  function caps(...keys) {
    const one = (k) => {
      const icon = KEY_ICONS[k];
      return icon ? `<kbd><svg viewBox="0 0 24 24" role="img" aria-label="${icon[0]}"><path d="${icon[1]}"/></svg></kbd>` : `<kbd>${esc(k)}</kbd>`;
    };
    return `<span class="keys">${keys.map(one).join("")}</span>`;
  }

  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function nameOf(el) {
    const cls = [...el.classList].slice(0, 2).map((c) => "." + c).join("");
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : cls);
  }

  /** A short selector that matches only `el`, climbing at most six levels. */
  function selectorOf(el) {
    const parts = [];
    for (let e = el; e && e !== document.documentElement && parts.length < 6; e = e.parentElement) {
      if (e.id) { parts.unshift("#" + CSS.escape(e.id)); break; }
      let s = e.tagName.toLowerCase();
      const cls = [...e.classList].filter((c) => !/[:[\]/]/.test(c)).slice(0, 2);
      if (cls.length) s += cls.map((c) => "." + CSS.escape(c)).join("");
      const same = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
      const twin = same.some((x) => x !== e && cls.every((c) => x.classList.contains(c)));
      if (twin) s += `:nth-of-type(${same.indexOf(e) + 1})`;
      parts.unshift(s);
      try {
        if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
      } catch {}
    }
    return parts.join(" > ");
  }

  const STYLES = ["display", "position", "color", "background-color", "font-size", "font-weight", "font-family",
    "line-height", "padding", "margin", "border", "border-radius", "gap", "flex-direction", "justify-content",
    "align-items", "grid-template-columns", "opacity", "box-shadow"];
  const DULL = new Set(["none", "normal", "0px", "auto", "static", "rgba(0, 0, 0, 0)", "0px none rgb(0, 0, 0)", "1", "start"]);

  function stylesOf(el) {
    const cs = getComputedStyle(el);
    const flex = /flex|grid/.test(cs.display);
    return STYLES.filter((p) => flex || !/^(gap|flex-direction|justify-content|align-items|grid-template-columns)$/.test(p))
      .map((p) => [p, p === "font-family" ? cs[p].split(",")[0] : cs.getPropertyValue(p)])
      .filter(([, v]) => v && !DULL.has(v) && !v.startsWith("0px none"))
      .map(([p, v]) => `${p}: ${v}`)
      .join("; ");
  }

  /** The UI component and source file a dev build left on the element, if any (React <19, Vue, Svelte). */
  function componentOf(el) {
    const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    for (let f = fiberKey && el[fiberKey]; f; f = f.return) {
      if (typeof f.type !== "function") continue;
      const name = f.type.displayName || f.type.name || "";
      const src = f._debugSource;
      return name + (src ? ` (${src.fileName}:${src.lineNumber})` : "");
    }
    const vue = el.__vueParentComponent?.type;
    if (vue) return (vue.__name || vue.name || "") + (vue.__file ? ` (${vue.__file})` : "");
    const svelte = el.__svelte_meta?.loc;
    if (svelte) return `${svelte.file}:${svelte.line + 1}`;
    return "";
  }

  /** A screenshot line: `n` is its ⟦shot n⟧, -1 when it was off the screen, 0 for none. */
  const shotLine = (indent, n) => (n > 0 ? [`${indent}screenshot: ⟦shot ${n}⟧`] : n < 0 ? [`${indent}screenshot: none, it was off the screen`] : []);

  /** An element as lines of text; `brief` (inside an area) leaves out the html and styles. */
  function describe(el, n, indent, brief, shot = 0) {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    const html = el.outerHTML.replace(/\s+/g, " ");
    const lines = [`${n}<${nameOf(el)}>${text ? ` "${text.slice(0, MAX_TEXT)}${text.length > MAX_TEXT ? "…" : ""}"` : ""} ${Math.round(r.width)}×${Math.round(r.height)}`];
    const component = componentOf(el);
    if (component) lines.push(`${indent}component: ${component}`);
    lines.push(`${indent}selector: ${selectorOf(el)}`);
    lines.push(...shotLine(indent, shot));
    if (brief) return lines;
    lines.push(`${indent}html: ${html.slice(0, MAX_HTML)}${html.length > MAX_HTML ? "…" : ""}`);
    const styles = stylesOf(el);
    if (styles) lines.push(`${indent}styles: ${styles}`);
    return lines;
  }

  /** `shots[i]`: selection i's screenshot, as `shotLine` takes it. */
  function describeAll(sel, comment, shots = []) {
    const title = document.title.trim();
    const out = [`Selected in the browser on ${location.href}${title ? ` ("${title}")` : ""}:`];
    sel.forEach((t, i) => {
      if (!t.area) return out.push(...describe(t.el, `${i + 1}. `, "   ", false, shots[i]));
      const a = t.area;
      out.push(`${i + 1}. area ${Math.round(a.w)}×${Math.round(a.h)} at ${Math.round(a.x)},${Math.round(a.y)} (page px), containing:`);
      out.push(...shotLine("   ", shots[i]));
      t.els.forEach((el, k) => out.push(...describe(el, `   ${String.fromCharCode(97 + k)}) `, "      ", true)));
    });
    if (comment) out.push("", comment);
    return out.join("\n");
  }
})();
