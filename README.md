<img src="assets/icon.svg" width="64" height="64" alt="">

# tri-code

tri-code is a minimal agent development environment. The left sidebar lists projects grouped by host (`local` or an ssh destination). Each project has terminal tabs that run `claude` (Claude Code), `pi`, or a plain shell. Local tabs run in a local PTY. Remote tabs run the system `ssh` client and attach to a persistent session on the remote host, so agents survive network drops and app restarts. The app is built with Tauri v2 (Rust), SolidJS, and xterm.js. Projects and tabs are saved to `state.json` in the Tauri app config directory.

## Windows development setup

1. Install Microsoft C++ Build Tools with the "Desktop development with C++" workload.
2. Install Rust via rustup, using the default MSVC toolchain (https://rustup.rs).
3. Install bun:

   ```
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

4. WebView2 is preinstalled on Windows 10/11, so nothing is needed there.

Then, from the repo root:

```
bun install
bun run tauri dev      # run the app
bun run tauri build    # build an installer
```

`.cargo/config.toml` caps build jobs at 2 so builds fit on low-RAM machines. To raise the cap, set `CARGO_BUILD_JOBS`, for example in PowerShell: `$env:CARGO_BUILD_JOBS=8; bun run tauri build`.

## Remote hosts

A remote project needs the following on the remote machine:

- Key-based ssh that works non-interactively from the Windows OpenSSH client. `ssh <host>` must not prompt for a password or passphrase. An alias from `~/.ssh/config` works as the host.
- shpool, the preferred session backend: `cargo install shpool`.
- tmux as a fallback if shpool is not installed. If neither is installed, the tab runs the command directly and does not survive disconnects.
- `claude` and/or `pi` on the PATH of the login shell (`$SHELL -l`). Commands run through the login shell, so PATH must be set in its startup files.

When ssh exits with code 255 (connection failure), the tab reconnects automatically. The retry delay starts at 1s and doubles up to 10s. Closing a remote tab also ends its remote session.

## Usage

- Add a project with "+ Add project" in the sidebar. Enter a host (`local` or an ssh alias such as `devbox` or `user@host`), a path such as `~/code/app` (remote paths are resolved on the remote host), and an optional name.
  Click `…` next to the path to browse folders on that host (remote hosts are listed over ssh, so key auth must work).
- Open a tab with the "+ claude", "+ pi", or "+ shell" buttons in the tab bar. On Windows, local `claude` and `pi` tabs run through `cmd.exe /d /c`, and shell tabs run `powershell.exe`.
- Switch tabs by clicking them. Close a tab with its × button or a middle click. Closing a running tab asks for confirmation. For a remote tab, closing it also ends the remote shpool/tmux session.
- Remove a project with the × next to it in the sidebar. This closes all of its tabs.
- Tab dots show the status: connecting, running, reconnecting, or exited. Press Enter in an exited tab to restart it.
- A tab that rings the terminal bell while it is hidden is flagged, and its project shows a badge in the sidebar. To get this from Claude Code, set its notification channel to the terminal bell in Claude Code's `/config` (notifications setting).

## Development

Rust tests:

```
cd src-tauri && cargo test
```

The SSH end-to-end test is ignored by default. It needs passwordless ssh and shpool on the target host, and it only runs on Unix:

```
TRI_SSH_HOST=<host> cargo test -- --ignored
```

Frontend checks: `bun run typecheck` for TypeScript and `bun run build` for a Vite build.

Layout:

`src/`

- `index.tsx`: entry point. Mounts the app and loads the xterm and app stylesheets.
- `App.tsx`: sidebar, tab bar, terminal host, and the add-project form.
- `state.ts`: Solid stores for projects, tabs, and live tab status. Loads and debounced-saves the state file.
- `terms.ts`: one xterm and one PTY per tab. Handles output, resize, reconnect backoff, bell detection, and the WebGL renderer for the visible tab only.
- `styles.css`: application styles.
- `vite-env.d.ts`: Vite type declarations.

`src-tauri/src/`

- `main.rs`: binary entry point. Hides the console window in Windows release builds.
- `lib.rs`: Tauri setup. Registers the commands and the shared PTY state.
- `dirs.rs`: folder listing for the project picker, local or over ssh.
- `pty.rs`: PTY sessions (spawn, output channel, write, resize, kill) and remote session cleanup.
- `spawn.rs`: builds the program and arguments for local and ssh tabs, including the shpool and tmux fallback. Contains the unit tests and the ignored SSH end-to-end test.
- `store.rs`: loads and atomically saves `state.json`.
