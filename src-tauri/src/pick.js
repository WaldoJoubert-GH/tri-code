// Select element: injected into every browser page by src-tauri/src/browser.rs and dormant
// until tri-code calls window.__tricodePick({ agent, accent }). It draws over the page itself,
// since tri-code's own HTML cannot paint above a native webview. Click an element, Shift+click
// to add more, drag for an area (the elements inside it); describe the change; Enter hands the
// text to tri-code to type into the agent, Ctrl+Enter to type and send it. It reports by
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

  function start({ agent = "", accent = "#7aa2f7" }) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
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
      .composer { bottom: 12px; width: min(380px, calc(100vw - 24px)); display: none; gap: 6px; padding: 8px;
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
      .row { display: flex; align-items: center; gap: 6px; }
      .to { flex: 1; color: #6b7080; font-size: 11.5px; }
      .to b { color: #23262d; }
      .row button { border-color: #d9dce3; }
      .row .primary { background: ${accent}; border-color: ${accent}; color: #fff; }
      @media (prefers-color-scheme: dark) {
        .card { color: #d6d8de; background: #15171c; border-color: #2c3039; box-shadow: 0 14px 40px -12px #000; }
        .bar span, .to, .chip button { color: #7d828f; }
        .to b { color: #d6d8de; }
        button:hover { background: #232733; }
        .chip { background: #232733; }
        textarea, .row button { border-color: #2c3039; }
      }
    </style>
    <div class="card bar"><span>Click an element · drag an area · <b>Shift</b> adds</span><button data-a="end">Esc</button></div>
    <div class="card composer">
      <div class="chips"></div>
      <textarea rows="2" placeholder="Describe the change…"></textarea>
      <div class="row"><span class="to"></span>
        <button data-a="type" title="Type into the agent without sending (Enter)">Type ⏎</button>
        <button class="primary" data-a="send" title="Type and send (Ctrl+Enter)">Send ⌃⏎</button></div>
    </div>`;
    const composer = root.querySelector(".composer");
    const chips = root.querySelector(".chips");
    const comment = root.querySelector("textarea");
    root.querySelector(".to").innerHTML = agent ? `→ <b>${esc(agent)}</b>` : "no agent window open";
    const cursor = document.createElement("style");
    cursor.textContent = "html, html * { cursor: crosshair !important; }";
    document.documentElement.append(host, cursor);

    /** Elements, or areas with the elements inside them, in pick order. */
    let sel = [];
    let hover = null;
    let drag = null;
    const boxes = [];

    const inOverlay = (e) => e.composedPath().includes(host);
    const block = (e) => {
      if (inOverlay(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };

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
      if (e.key === "Escape") return block(e), end();
      // The shadow root is closed, so the event path seen from window stops at the host.
      if (root.activeElement === comment && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit(e.ctrlKey || e.metaKey);
      }
      // Keys typed into the composer stay out of the page's own shortcuts.
      if (inOverlay(e)) e.stopImmediatePropagation();
    }

    root.addEventListener("click", (e) => {
      const a = e.target.closest?.("button[data-a]")?.dataset.a;
      if (a === "end") end();
      else if (a === "type" || a === "send") submit(a === "send");
    });

    function submit(send) {
      if (!sel.length) return;
      let text = describeAll(sel, comment.value.trim());
      if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + "\n…";
      end();
      location.href = `https://tricode.invalid/pick?send=${send ? 1 : 0}&d=${encodeURIComponent(text)}`;
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
