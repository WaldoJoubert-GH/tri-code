# 0001. tri-code renders the shared `.dev/` folder as an Issues Panel

Date: 2026-10-16

## Status

Accepted.

## Context

A project's `.dev/` folder is already the meeting point of two tools: pi-todos (a pi extension) and dev-hub (a Claude Code mod). They share a token in `~/.pi/agent/secrets/plane.json`, a config in `.dev/config.json`, a unified list in `.dev/issues.json`, the State cache in `.dev/plane-states.json`, and the Time Entry Store in `.dev/time-entries.json`.

We want a Plane/Sentry view inside tri-code's canvas, where the work actually happens. The alternatives were to give tri-code its own Plane store, or to talk to the Plane API and show data only in memory. Both would duplicate state and drift from the other two clients.

The canvas already tiles Windows, some of which are not terminals (the browser is a native child webview). The issues view has no PTY and no native view; it is plain HTML.

## Decision

1. **tri-code is a third `.dev/` client.** It stores no Plane data in `state.json`; it keeps only the Issues Panel tab. It reads and writes the same files, so a sync in any client shows up in the others. Rust exposes `dev_read`/`dev_write`; local projects use the filesystem, remote projects use `ssh cat` and an atomic `cat > tmp && mv`, sharing the ssh builder with `dirs.rs`.

2. **Plane HTTP runs in Rust** (`plane.rs`, `ureq` inside `spawn_blocking`). The webview's `fetch` would hit CORS, and the token must not reach the webview. The commands return data; TypeScript writes it through `dev_write` so file ownership stays in one place.

3. **The panel is a new `TabKind` `"issues"`**, one per project, rendered as HTML. `isTerminal(tab)` replaces the `kind === "browser"` checks. The panel keeps only view state; the issues live in `.dev/`.

4. **Sync timing**: every 5 minutes while the panel is open, on `r`, and after each mutation. The panel re-reads `.dev/` when it gains focus, which is how syncs from the other clients appear. We did **not** add a file watcher: a project may be on a remote host over ssh, and polling on focus is enough.

5. **Drafts and comments are cached locally.** The composer's text and images are kept per issue in memory so a repaint cannot lose them. Comments are cached in `.dev/plane/comments/<issue>.json`; images are uploaded as Plane assets and inlined as `data:` URLs when read, because fetching them needs the token.

## Consequences

- The three clients can never disagree about the issue list, States or Time Entries, because there is one copy.
- tri-code inherits pi-todos' contract. A change to `issues.json` (for example a new field) must be made in pi-todos first and then honoured here.
- A project without a Plane config shows a setup form that writes `.dev/config.json` and, if needed, `~/.pi/agent/secrets/plane.json` on the project's host.
- Label toggles and comment posts are optimistic: the file is rewritten after a successful API call, and failures surface as a flash without corrupting `.dev/`.
