// Select element: injected into every browser page by src-tauri/src/browser.rs and dormant
// until tri-code calls window.__tricodePick(opts). It draws over the page itself, since
// tri-code's own HTML cannot paint above a native webview. Click an element, Shift+click to add
// more, drag for an area (the elements inside it); describe the change (Shift+Enter for a new
// line); choose the agent window under "→", or a new claude or pi; Enter hands the text to
// tri-code, which types it into the agent unsent, so it can be edited there; Copy copies it
// instead. It reports by
// navigating to https://tricode.invalid/pick, which browser.rs cancels and forwards.
(() => {
  if (window.top !== window || window.__tricodePick) return;
  const MAX_HTML = 300;
  const MAX_TEXT = 80;
  const MAX_IN_AREA = 8;
  const MAX_OUT = 20000;
  let session = null;
  window.__tricodePick = (opts) => {
    session?.end();
    session = opts ? start(opts) : null;
  };

  /** `agents`: the project's agent windows ({ id, name, icon, sig, msg, ws }); `target`: the one
   *  chosen at first; `new`: agents that can be started for the result ({ id, name, icon }). */
  function start({ accent = "#7aa2f7", agents = [], target = "", new: starts = [], colors = {}, keys = {} }) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    const safe = (v) => typeof v === "string" && /^[#\w(),.%\s-]+$/.test(v);
    const SIG = { working: "#7aa2f7", blocked: "#e0af68", done: "#9ece6a", error: "#f7768e" };
    for (const [k, v] of Object.entries(colors)) if (safe(v)) SIG[k] = v;
    // tri-code's keycap colours (styles.css --key*), in its theme and Keys setting.
    const KEY = { key: "#e8eaf0", "key-edge": "#f6f7fa", "key-base": "#8b90a0", "key-ink": "#15171c" };
    for (const [k, v] of Object.entries(keys)) if (k in KEY && safe(v) && v) KEY[k] = v;
    // Constructed sheets rather than <style>: a page's CSP (claude.ai, GitHub) blocks inline styles.
    adopt(root, `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
      .to { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 210px; padding: 0 6px 0 4px;
        color: #6b7080; font-size: 11.5px; }
      .to b { color: #23262d; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .to .car { font-size: 9px; }
      .to.open { background: #e6e8ee; }
      .to:disabled { cursor: default; background: none; }
      .av { position: relative; width: 16px; height: 16px; flex: none; display: grid; place-items: center; border-radius: 4px;
        color: ${accent}; background: color-mix(in srgb, ${accent} 20%, transparent); }
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
      .mi .ck { width: 10px; flex: none; color: ${accent}; font-weight: 700; }
      .mi .t { flex: 1; min-width: 0; display: grid; }
      .mi .t b { font-weight: 500; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mi .t small { color: #6b7080; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mi .ws { font: 10.5px ui-monospace, Consolas, monospace; color: #6b7080; border: 1px solid #d9dce3; border-radius: 3px; padding: 0 4px; }
      .mi.new { min-height: 28px; color: #6b7080; }
      .none { padding: 4px 7px 6px; font-size: 11.5px; color: #6b7080; }
      .box { position: fixed; pointer-events: none; border: 1.5px solid ${accent}; border-radius: 2px;
        background: color-mix(in srgb, ${accent} 10%, transparent); }
      .box.sel { border-width: 2px; background: color-mix(in srgb, ${accent} 16%, transparent); }
      .box.area { border-style: dashed; }
      .box b { position: absolute; left: -2px; top: -19px; padding: 1px 5px; border-radius: 3px 3px 3px 0;
        background: ${accent}; color: #fff; font: 600 10px/15px ui-monospace, Consolas, monospace; white-space: nowrap; }
      .box.below b { top: auto; bottom: -19px; border-radius: 0 3px 3px 3px; }
      .card { position: fixed; left: 50%; transform: translateX(-50%); pointer-events: auto; color: #23262d;
        background: #fbfbfc; border: 1px solid #d9dce3; box-shadow: 0 14px 40px -12px rgba(30,34,44,.35); }
      .bar { top: 8px; display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 10px; border-radius: 8px;
        font-size: 12px; white-space: nowrap; }
      .bar span { color: #6b7080; }
      button { font: inherit; color: inherit; background: none; border: 1px solid transparent; border-radius: 5px;
        cursor: pointer; height: 24px; padding: 0 9px; font-size: 12px; }
      button:hover { background: #e6e8ee; }
      .composer { bottom: 12px; width: min(440px, calc(100vw - 24px)); display: none; gap: 6px; padding: 8px;
        border-radius: 10px; font-size: 13px; }
      .composer.on { display: grid; }
      .chips { display: flex; flex-wrap: wrap; gap: 4px; }
      .chip { display: flex; align-items: center; gap: 4px; height: 20px; padding: 0 2px 0 6px; border-radius: 4px;
        background: #dfe2ea; font: 11px ui-monospace, Consolas, monospace; max-width: 100%; }
      .chip i { font-style: normal; font-weight: 700; color: ${accent}; }
      .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chip button { height: 16px; width: 16px; padding: 0; color: #6b7080; }
      textarea { font: 13px/1.4 system-ui, "Segoe UI", sans-serif; color: inherit; background: transparent; border: 0;
        border-bottom: 1px solid #d9dce3; padding: 4px 0; resize: none; outline: none; }
      textarea:focus { border-bottom-color: ${accent}; }
      .row { position: relative; display: flex; align-items: center; gap: 6px; }
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
      .row .primary { background: ${accent}; border-color: ${accent}; color: #fff; padding-right: 4px; }
      .copy.done { color: ${accent}; }
      @media (prefers-color-scheme: dark) {
        .card, .menu { color: #d6d8de; background: #15171c; border-color: #2c3039; box-shadow: 0 14px 40px -12px #000; }
        .bar span, .to, .chip button, .menu h6, .mi .t small, .mi .ws, .mi.new, .none, .av.new, .hint { color: #7d828f; }
        .to b { color: #d6d8de; }
        button:hover, .to.open, .mi.kb { background: #232733; }
        .row .primary:hover { background: ${accent}; }
        .chip { background: #232733; }
        textarea, .menu hr, .mi .ws, .av.new, .row > button:not(.to):not(.primary) { border-color: #2c3039; }
        .dot { box-shadow: 0 0 0 1.5px #15171c; }
      }`);
    root.innerHTML = `
    <div class="card bar"><span>Click an element · drag an area · ${caps("Shift")} adds</span><button data-a="end" title="Stop selecting">${caps("Esc")}</button></div>
    <div class="card composer">
      <div class="chips"></div>
      <textarea rows="2" placeholder="Describe the change…"></textarea>
      <div class="row"><div class="menu" role="listbox"></div>
        <button class="to" data-a="menu" title="Which agent gets it"></button><span class="sp"></span>
        <span class="hint">${caps("Shift", "Enter")} new line</span>
        <button class="copy" data-a="copy" title="Copy the description instead">Copy</button>
        <button class="primary" data-a="send" title="Type into the agent without submitting it, to edit there">Send ${caps("Enter")}</button></div>
    </div>`;
    const composer = root.querySelector(".composer");
    const chips = root.querySelector(".chips");
    const comment = root.querySelector("textarea");
    const toBtn = root.querySelector(".to");
    const menu = root.querySelector(".menu");

    // Where the result goes: an agent window ({ to }) or an agent to start ({ new }).
    const choices = [...agents.map((a) => ({ to: a.id, a })), ...starts.map((a) => ({ new: a.id, a }))];
    let choice = choices.find((c) => c.to === target) ?? choices[0] ?? null;
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
    const cursor = adopt(document, "html, html * { cursor: crosshair !important; }");
    document.documentElement.append(host);

    /** Elements, or areas with the elements inside them, in pick order. */
    let sel = [];
    let hover = null;
    let drag = null;
    const boxes = [];

    const inOverlay = (e) => e.composedPath().includes(host);
    const stop = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const block = (e) => inOverlay(e) || stop(e);

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

    function paint() {
      boxes.splice(0).forEach((b) => b.remove());
      sel.forEach((t, i) => {
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
        c.querySelector("span").textContent = t.area ? `area · ${t.els.length} el` : nameOf(t.el);
        c.querySelector("button").onclick = () => { sel.splice(i, 1); refresh(); };
        chips.append(c);
      });
      paint();
      if (sel.length) comment.focus();
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

    function onKey(e) {
      if (menuOpen()) {
        const keys = { ArrowDown: 1, ArrowUp: -1 };
        if (e.key in keys) kb = (kb + keys[e.key] + choices.length) % choices.length, paintMenu();
        else if (e.key === "Enter" || e.key === " ") choose(kb);
        else if (e.key === "Escape" || e.key === "Tab") openMenu(false);
        else return;
        return stop(e);
      }
      if (e.key === "Escape") return block(e), end();
      if (root.activeElement === toBtn && (e.key === "ArrowUp" || e.key === "ArrowDown")) return stop(e), openMenu(true);
      // The shadow root is closed, so the event path seen from window stops at the host.
      if (root.activeElement === comment && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
      // Keys typed into the composer stay out of the page's own shortcuts.
      if (inOverlay(e)) e.stopImmediatePropagation();
    }

    root.addEventListener("click", (e) => {
      const item = e.target.closest?.(".mi");
      if (item) return choose(+item.dataset.i);
      const a = e.target.closest?.("button[data-a]")?.dataset.a;
      if (a === "menu") return openMenu(!menuOpen());
      if (menuOpen()) openMenu(false);
      if (a === "end") end();
      else if (a === "copy") copy(e.target.closest("button"));
      else if (a === "send") submit();
    });

    function text() {
      const t = describeAll(sel, comment.value.trim());
      return t.length > MAX_OUT ? t.slice(0, MAX_OUT) + "\n…" : t;
    }

    /** Copy the description, show it worked, then stop picking. Inside the click, so the page's
     *  clipboard allows it; execCommand covers pages that aren't a secure context. */
    function copy(btn) {
      if (!sel.length) return;
      const t = text();
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

    /** Hand the text to tri-code, which types it into the agent without submitting it, to edit there. */
    function submit() {
      if (!sel.length) return;
      const t = text();
      end();
      const to = choice?.to ? `&to=${encodeURIComponent(choice.to)}` : "";
      const fresh = choice?.new ? `&new=${encodeURIComponent(choice.new)}` : "";
      location.href = `https://tricode.invalid/pick?d=${encodeURIComponent(t)}${to}${fresh}`;
    }

    const listeners = [
      ["pointermove", onMove], ["pointerdown", onDown], ["pointerup", onUp],
      ["mousedown", block], ["mouseup", block], ["click", block], ["auxclick", block], ["dblclick", block],
      ["contextmenu", block], ["keydown", onKey],
    ];
    for (const [t, f] of listeners) addEventListener(t, f, { capture: true });
    addEventListener("scroll", paint, { capture: true, passive: true });
    addEventListener("resize", paint);

    function end() {
      for (const [t, f] of listeners) removeEventListener(t, f, { capture: true });
      removeEventListener("scroll", paint, { capture: true });
      removeEventListener("resize", paint);
      host.remove();
      cursor.remove();
      if (session?.end === end) session = null;
    }
    return { end };
  }

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

  /** An element as lines of text; `brief` (inside an area) leaves out the html and styles. */
  function describe(el, n, indent, brief) {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    const html = el.outerHTML.replace(/\s+/g, " ");
    const lines = [`${n}<${nameOf(el)}>${text ? ` "${text.slice(0, MAX_TEXT)}${text.length > MAX_TEXT ? "…" : ""}"` : ""} ${Math.round(r.width)}×${Math.round(r.height)}`];
    const component = componentOf(el);
    if (component) lines.push(`${indent}component: ${component}`);
    lines.push(`${indent}selector: ${selectorOf(el)}`);
    if (brief) return lines;
    lines.push(`${indent}html: ${html.slice(0, MAX_HTML)}${html.length > MAX_HTML ? "…" : ""}`);
    const styles = stylesOf(el);
    if (styles) lines.push(`${indent}styles: ${styles}`);
    return lines;
  }

  function describeAll(sel, comment) {
    const title = document.title.trim();
    const out = [`Selected in the browser on ${location.href}${title ? ` ("${title}")` : ""}:`];
    sel.forEach((t, i) => {
      if (!t.area) return out.push(...describe(t.el, `${i + 1}. `, "   "));
      const a = t.area;
      out.push(`${i + 1}. area ${Math.round(a.w)}×${Math.round(a.h)} at ${Math.round(a.x)},${Math.round(a.y)} (page px), containing:`);
      t.els.forEach((el, k) => out.push(...describe(el, `   ${String.fromCharCode(97 + k)}) `, "      ", true)));
    });
    if (comment) out.push("", comment);
    return out.join("\n");
  }
})();
