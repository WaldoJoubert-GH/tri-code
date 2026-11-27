// Saved passwords on macOS (passwords.rs). Runs in a WKContentWorld of its own: it shares the
// page's DOM but not its JavaScript, so page scripts can't call __tricodeFill, read what it is
// given, or post to the handler. Evaluated after every page load, then given the saved logins.
(() => {
  if (window.__tricodeFill) return;
  const post = (m) => window.webkit.messageHandlers.tricodePasswords.postMessage(JSON.stringify(m));
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const passwords = (scope) => [...scope.querySelectorAll("input[type=password]")].filter(visible);
  /** The username: the last text, email or tel field before the password field. */
  const userFor = (pw) => {
    let best = null;
    for (const f of (pw.form || document).querySelectorAll("input")) {
      if (f === pw) break;
      if (/^(text|email|tel)$/.test(f.type) && visible(f)) best = f;
    }
    return best;
  };

  // A sign-in: a password was typed and the form submitted, or its button clicked, or Enter
  // pressed (pages that sign in with fetch never submit). The same login is reported once.
  let sent = "";
  const capture = (scope) => {
    const filled = passwords(scope || document).filter((p) => p.value);
    if (!filled.length) return;
    // A sign-up or change-password form has several: the last is the new password.
    const pw = filled[filled.length - 1];
    const user = (userFor(filled[0])?.value || "").trim();
    const key = user + "\n" + pw.value;
    if (key === sent) return;
    sent = key;
    post({ user, pass: pw.value });
  };
  addEventListener("submit", (e) => capture(e.target), true);
  addEventListener("click", (e) => {
    const b = e.composedPath().find((n) => n instanceof HTMLButtonElement || (n instanceof HTMLInputElement && n.type === "submit"));
    if (b) capture(b.form);
  }, true);
  addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) capture(e.target.form);
  }, true);
  addEventListener("pagehide", () => capture(document), true);

  // Filling: an empty password field gets the saved login whose username is typed, or the first.
  let logins = [];
  const done = new WeakSet();
  const setValue = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const fill = () => {
    for (const pw of passwords(document)) {
      if (done.has(pw) || pw.value || pw.autocomplete === "new-password") continue;
      const uf = userFor(pw);
      const typed = (uf?.value || "").trim();
      const login = typed ? logins.find((l) => l.user === typed) : logins[0];
      if (!login) continue;
      done.add(pw);
      if (uf && !typed && login.user) setValue(uf, login.user);
      setValue(pw, login.pass);
      // Already saved: don't offer to save it again.
      sent = login.user + "\n" + login.pass;
    }
  };
  let watching = false;
  window.__tricodeFill = (origin, list) => {
    if (location.origin !== origin || !list.length) return;
    logins = list;
    fill();
    if (watching) return;
    watching = true;
    // Sign-in forms that render later (single-page apps, a second step).
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fill(); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
})();
