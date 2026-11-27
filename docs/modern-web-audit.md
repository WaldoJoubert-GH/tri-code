# Modern web audit

Every frontend in the repo, checked against the modern-web-guidance catalogue (209 guides):

| Frontend | Where | Engine |
|---|---|---|
| The app | `index.html`, `src/` | WebView2 (Chromium, evergreen) on Windows, WKWebView on macOS, WebKitGTK on Linux |
| Phone (Remote Control) | `src-tauri/phone/` | Any phone browser, mostly Safari iOS |
| Tour | `src-tauri/tour/` | The app's webview |
| Site | `site/` | Any browser |
| Injected into pages | `src-tauri/src/browser/pick.js`, `passwords.js` | The browser window's webview, inside arbitrary sites |

Method: `legacy-scan` on each (it covers about 20% of the guides), then a pattern inventory over all 236 files and a read of each hit against the guides for `accessibility`, `color`, `html`, `css`, `js`, `security`, `motion`, `dark-mode`, `viewport-aware-dropdowns`, `ime-safe-enter-submit`, `copy-button` and `calculate-event-differentials`.

The floor the code already assumes: `popover` needs Safari 17, so the app needs Safari 17-era WebKit. Vite 8's default build target is Baseline widely available. Anchor positioning is newer (Chrome 157, Safari 27, not Firefox), so anything that uses it keeps a JS fallback for older macOS and for WebKitGTK.

## Already modern

- **Modals:** `shared/ui/Modal.tsx` is a native `<dialog>` opened with `showModal()`: focus trap, inert background, top layer, focus returned to the opener.
- **Untrusted HTML:** Markdown goes through DOMPurify (`shared/text/markdown.ts`). Mermaid runs with `securityLevel: "strict"`, and KaTeX outputs MathML only.
- **IME-safe Enter:** `shared/ui/enterkey.ts` checks `isComposing` and `keyCode 229`. The bare `e.key === "Enter"` checks left are on non-text widgets or need Ctrl/Cmd, which composition can't trigger.
- **DbPanel's export menu** (`DbPanel.tsx:1014-1083`) is the model for popups: native `popover`, anchor positioning detected with `CSS.supports`, a JS `place()` only when that's missing, and `focusgroup` with a fallback.
- **Clipboard:** uses `navigator.clipboard`. The one `execCommand` (`shared/ui/clipboard.ts:83-88`) is `insertText`, which keeps the field's undo history. Nothing newer does that, so it stays.
- **Layout and theme:** container queries (20 uses), `color-scheme` on the root, and `field-sizing` detected before use.
- **Phone:** `100dvh`, `interactive-widget=resizes-content`, safe-area insets, and every name escaped before it reaches `innerHTML`.
- **Site:** images carry `width` and `height` (no layout shift) and below-the-fold ones use `loading="lazy"`.

## Findings

### High

**1. The app has no Content Security Policy.** `src-tauri/tauri.conf.json` sets `"csp": null`. The app webview holds the Tauri IPC bridge (211 commands, including PTY spawn), so script injection there means running commands on the machine. Markdown sanitising closes the known path, and a CSP is the backstop for the next one. Tauri adds hashes for its own bundled scripts when a CSP is set. A starting point to test against, since Solid sets `style=` and Mermaid's SVG uses inline styles:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data: blob: https:; connect-src 'self' ipc: http://ipc.localhost; frame-src *; object-src 'none'; base-uri 'none'`
Check `frame-src` against what `.page .frame` loads (`canvas.css:364`). Needs a full click-through on all three platforms before it ships.

**2. The element picker fails on Trusted Types sites.** `pick.js` builds its UI from HTML strings (`pick.js:205`, `:252`, `:268`, `:498`, `:526`, `:533`, `:630`, `:767`). Pages that send `require-trusted-types-for 'script'` (Google's properties, for one) make every one of those throw. Build these with `createElement` and `textContent`, or the picker is dead on those pages. A Trusted Types policy isn't a fix: a page's `trusted-types` allowlist can refuse it.

**3. No support for Windows High Contrast (forced colors).** There's no `forced-colors` rule anywhere, and 61 rules set `outline: none` or `outline: 0`, mostly inputs that show focus with `border-color` or a `background`. In forced colors those colours are replaced, so focus disappears. Windows is a primary platform. Two mechanical fixes, both invisible in normal colours:
- Write `outline: 2px solid transparent` where the code now says `outline: none`, for the focus cases. Forced colors paints transparent outlines in the system colour.
- Add one `@media (forced-colors: active)` block that gives selected rows (`.sel`, `.on`, `aria-selected`, `aria-pressed`) a `Highlight` outline or border. Those states are background-only now, and the background is overridden.

Where: `app/styles.css` (24), `app/canvas.css` (7), `app/files.css` (4), `modules/db/db.css` (7), `modules/agents/agents.css` (4), and the rest of the module CSS. The full list is the `outline:\s*(none|0)` search.

### Medium

**4. Ten hand-rolled popups.** Each has its own `place()` (measured with `getBoundingClientRect` after a `requestAnimationFrame`), its own outside-`pointerdown` listener and its own Escape handling. None is in the top layer, so each fights z-index:
`app/Feedback.tsx:79`, `modules/agents/AgentsPanel.tsx:273`, `modules/browser/debugmenu.tsx:70`, `downloads.tsx:218`, `favs.tsx:168`, `profiles.tsx:78`, `tunnelui.tsx:68`, `modules/leftovers/LeftoversPopover.tsx`, `modules/signals/SignalSettings.tsx`, `modules/appearance/Appearance.tsx`, `modules/issues/IssuesPanel.tsx:70`, `shared/ui/lucide.tsx:85`.
The target is one deep module in `shared/ui/`, a `Popover` built on `popover="auto"`. Light dismiss, Escape and the top layer come free. It's placed with `position-area` plus `position-try-fallbacks` where anchor positioning exists, and the one shared `place()` everywhere else. That's DbPanel's menu, lifted out and reused. Callers lose about 15 lines each, and fixing one popup fixes all ten.

**5. Overlays not built on `Modal`:**
- `IssuesPanel.tsx:817`: the New issue form (`.mback`).
- `IssuesPanel.tsx:718`: the image lightbox (`.ilight`).
- `DbPanel.tsx:824`: the review scrim (`.db-scrim`).
- Phone `index.html:120`: the New window sheet (`#sheet`).

None of these traps focus or makes the page behind inert, so Tab walks out into the page underneath. On the phone, use `<dialog>` with `showModal()`; in the app, use `Modal`.

**6. Rows that only a mouse can use.** Clickable `<div>`, `<span>` and `<tr>` elements with no keyboard path:
- **Git:** repo heads (`GitPanel.tsx:410`) and stash rows (`:332`). The panel has no arrow-key handling at all.
- **Database:** group headers (`DbPanel.tsx:362`, `:466`) toggle open and shut. Make them `<button aria-expanded>` or `<details>/<summary>`.
- **Database:** `db-conn-row` (`DbPanel.tsx:130`) is `role="button"` but answers only Enter, not Space. Make it a `<button>`.
- **Docker and Monitor:** table rows (`DockerPanel.tsx:627`, `:679`, `MonitorPanel.tsx:345`) select on click. Each panel has some arrow handling, but the rows can't take focus.
- **Sidebar:** renaming is double-click only (`Sidebar.tsx:407`, `:484`). Check whether F2 or the context menu also offers it; if neither does, add one.

**7. Animations that ignore reduced motion.** These run forever with no `prefers-reduced-motion` rule:
- **App:** `.wt > .sb.s-blocked` (`styles.css:276`; its `.project` twin is covered at `canvas.css:361`), `.mark.plane.syncing` and `i.rec` (`canvas.css:368`, `:759`), `dk-pulse` (`docker.css:75`), `mn-beat` (`monitor.css:32`).
- **Phone:** has none at all; `sbp`, `bell` and `spin` (`app.css:85-87`) always run.
- **Site:** the hero video (`site/index.html:37`) autoplays and loops for 40 seconds with no pause control. That fails WCAG 2.2.2 (Pause, Stop, Hide). Add `controls`, or a pause button, and don't autoplay under `prefers-reduced-motion: reduce`.

Spinners may keep turning more slowly, which is what the spinner guide allows. Pulses should stop.

**8. Seven "time ago" functions in five formats:**
- "4m ago": `Canvas.tsx:39`
- "4 min ago": `downloads.tsx:225`, `RemoteSettings.tsx:15`
- "4m": `leftovers.ts:61`
- "4h ago" or "4d ago": `issues.ts:371`
- `newsdata.ts:174`
- phone `app.js:70`

One `ago()` in `shared/text/` on `Intl.RelativeTimeFormat` (`style: "narrow"` for chips, `"long"` for prose) gives one format and the user's locale. The tests for News and Docker pin today's strings and would move with it. The phone keeps its own copy, since it has no build step.

### Low

**9. `100vh` → `100dvh`:** `app/files.css:117`, `app/styles.css:484`. They behave the same in a desktop webview, but `dvh` is correct if these ever render on a phone or tablet.

**10. `-webkit-overflow-scrolling: touch`:** phone `app.css:121`, `:197`, `:245`, `:271`. It has done nothing since iOS 13; delete it.

**11. The site's images and fonts:**
- **Images:** the screenshots are 2880px PNGs with no AVIF or WebP and no `srcset`. Use `<picture>` with AVIF or WebP at 1x and 2x.
- **Fonts:** Google Fonts is a third-party request that shares each visitor's IP. Self-host the two JetBrains Mono weights.
- **LCP:** the video poster is the largest paint. Give `demo-poster.jpg` `fetchpriority="high"` with a `<link rel="preload" as="image">`.

**12. CSS structure, during the CSS split.** No `@layer`, no nesting, and three large global files. When the split (blueprint step 7) moves rules to their modules:
- Declare the order once: `@layer reset, base, shared, modules, app;`. Order no longer depends on import order, which is what made step 4 move `canvas.css` up in `index.tsx`.
- Nest each module's rules under its root class.

## Checked and dropped

- `structuredClone` for the two JSON round-trips (`config.ts:71`, `agents.ts:63`): Solid store proxies can't be structured-cloned, and the comment at `agents.ts:62` already says so.
- `autocomplete` on the database password (`DbPanel.tsx:261`) and the Plane token (`IssuesPanel.tsx:1432`): these are service credentials, not sign-in forms.
- The Enter key in the PIN pad (`envlock.tsx:105`): it's a window-level shortcut that skips text inputs.
- `::-webkit-scrollbar { display: none }` (`styles.css:129`, phone `app.css:226`): both rules already set `scrollbar-width: none`; the `-webkit-` rule is the fallback for Safari before 18.2.
- Physical `margin-left` and `margin-right` (135 uses): the app is English-only, and the CSS guide says to use logical properties only where the layout should flip for RTL.

## Fixed already

- `bd27b21`: `pick.js` clears with `replaceChildren()`, and the phone keeps `<meta name="color-scheme">` in step with the desktop's theme.
- `5e66800` (item 7): the uncovered pulses, the phone's animations and the PIN shake animate only under `prefers-reduced-motion: no-preference`. The site's demo plays only then too, and has a Pause button.
- `487b745` (item 8): `shared/text/ago.ts` (`age`, `ago`) on `Intl.RelativeTimeFormat` and `Intl.DurationFormat` replaces six of the seven copies. The phone keeps its own, since it has no build step. News no longer says "now ago".
- `7b563ff` (item 6): Git's repo heads and history rows and Database's group headers are `<button>`s. Rows that hold their own buttons (Git's files and stashes, a Connection, Saved queries, a sidebar project) get a `.rowmain` label button whose click bubbles to the row. Git's row actions show on `:focus-within`, so Tab can reach them. A project's menu gains Rename.
- `4ac5894` (item 5): `shared/ui/windowModal.ts` makes the rest of a canvas window inert while Issues' New issue form or Database's Review is up. These stay modal to their window rather than to the app, so the other windows keep working. The phone's New window sheet is a modal `<dialog>`.
- `8eae83c` (item 4): `shared/ui/Popover.tsx`, a `popover="manual"` in the top layer with one `placeNear` and one outside-press rule, replaces twelve hand-rolled popups. Two more turned up during the work: the New window menu and the language picker.

Changed from the findings above:
- **Docker and Monitor rows (item 6):** dropped. Both windows already drive selection from the keyboard (arrows, j/k, Home/End).
- **The Issues lightbox (item 5):** dropped. While it's up, the window's key handler takes every key, Tab included.
- **The popover is `manual`, not `auto`:** `showModal()` hides every auto popover (Appearance opens the icon picker), and the popups keep presses from related controls, through `keep`.
- **No CSS anchor positioning in `Popover`:** older macOS and Linux webviews need the script anyway, so `placeNear` is the one placement. DbPanel's Export CSV keeps its CSS anchor positioning and uses `placeNear` as its fallback.
- **Git's in-panel menus:** these open inside the panel, not at viewport coordinates, and were left as they are.
