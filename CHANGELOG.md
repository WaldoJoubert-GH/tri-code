# Changelog

Each release's section becomes its GitHub Release notes, and tri-code shows this file in the About dialog. Add a `## <version>` section above the newest one before tagging.

## 0.1.15 — 2026-10-19

- The toolbar starts with the workspaces, then the layout buttons, then the window tabs. The gap setting moved to the bottom-left of the status bar.

## 0.1.14 — 2026-10-19

- Select element works on sites that block inline styles, such as claude.ai and GitHub; its bar, boxes and composer showed up unstyled there.

## 0.1.13 — 2026-10-19

- Select element: the crosshair in a browser window's address row lets you click elements (Shift adds more) or drag an area, describe the change, and type it into your agent window with Enter, or send it with Ctrl+Enter. The agent gets each element's selector, HTML, main styles and text, and its component and source file when the dev build has them.

## 0.1.12 — 2026-10-19

- Browser windows have tabs. Ctrl+click or middle-click a link to open it in a background tab; `target=_blank` links open a tab and show it. The tabs sit in the window's title bar once there are two; `+` adds a blank one.
- Ctrl+click on a link in a terminal opens a new tab in the browser window instead of replacing its page.
- Sign-in and payment popups open in their own window, so signing in with GitHub and the like works.

## 0.1.11 — 2026-10-19

- The sidebar's project tiles and environment icons are the same size open or collapsed, and nothing shifts when it collapses, expands or peeks.

## 0.1.10 — 2026-10-19

- Edit any text file in its file window: Edit, then Save (or Ctrl+S); Revert discards. Preview shows unsaved edits.
- Markdown preview: relative images load, links to other files open them, `#heading` links scroll, and the scrollbar sits at the window edge.

## 0.1.9 — 2026-10-18

- The window title and the status bar show the running version.
- About dialog (click the version, or "About tri-code" in `Alt+X`): check for updates now and read the changelog.

## 0.1.8 — 2026-10-18

- Hover the collapsed sidebar to peek at the full project list.
- Environments can have a display name (double-click the header) and an icon.

## 0.1.7 — 2026-10-18

- Command Palette (`Alt+X`): run any command by name.

## 0.1.6 — 2026-10-17

- Agents window: add custom terminal apps and give them hotkeys.

## 0.1.5 — 2026-10-17

- Go to File (`Alt+T`): search and browse project files from the toolbar path.

## 0.1.4 — 2026-10-16

- The folder picker shows dot-folders and has a drive switcher.

## 0.1.3 — 2026-10-16

- SVG logos and favicons are picked up anywhere in a project.

## 0.1.2 — 2026-10-16

- Every platform's build uploads to one release.

## 0.1.1 — 2026-10-16

- First release: installers for Windows and macOS, and installed copies update themselves from GitHub.
