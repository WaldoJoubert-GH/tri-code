# Revisit: ideas from Claude Code sessions

Mined from 176 Claude Code sessions in `~/.claude/projects` (411 prompts, 170 tool errors), 2026-11-18, and checked against README, CONTEXT.md and `mcp/README.md` so nothing here already exists.

## Top picks

### 1. Worktrees that start ready to run: carry ignored files, a port each

The most repeated manual chore, in about ten forms:

- "copy the .env and the db" (imapp-10, imapp-13)
- "copy the .env over from main" (workshop-planner)
- "give me the commands to copy the .env and db to a new worktree"
- "whats windows alternative to cp ../imapp/.env .env"
- `.dev/tauri.test.conf.json` into a worktree (twice; also in memory)
- "the csv and json are on main, import them to this worktree"

Idea: New worktree lists the ignored files present in the repo's own folder (`.env*`, `*.db`/`*.sqlite`, `.dev/*.conf.json`, data files) with checkboxes, remembered per repo. Add a `{port}` variable and a `PORT` env var in every terminal of the worktree, so two worktrees don't both fight over the same port (imapp-13: "getting nothing on localhost:7501" / "no i did run the server on 7501").

### 2. Terminal output and screenshots → agent

Tracebacks are pasted into claude by hand ("see errors in shell", Flask/Alembic tracebacks, "check the vite logs"), and UI bugs come as `[Image #1]` screenshots. Select element does this for pages, but text only.

- A terminal selection, or the last failed command's output: "→ agent" through the same composer.
- A region screenshot of any window, saved as a PNG, `@path` typed into the agent.
- A dev server that prints a traceback offers "Send to agent".

### 3. Release and CI in the Git window

"lets release" ~20 times, plus "commit, push and release", "what are we releasing", "didnt we merge a notification fix?", "release failed can you check the logs", and in imapp "gh action failed" / "why is the action taking so long".

Idea: a Release drawer: commits and merged PRs since the last tag, ✦ drafts the `CHANGELOG.md` section, `bun pm version` and push the tag, then watch the workflow run; a failed job shows its log with "Send to agent". The CI watching part is useful for any repo.

### 4. MCP for remote agents

Reported directly: "remote agents / terminals dont work with the mcp we have for tri-code". `mcp/README.md` still says ssh projects aren't covered. A `-R 7521:127.0.0.1:7521` on the ssh of remote agent tabs, plus the per-terminal token, is likely most of it.

Rough edges seen in sessions:

- "the window did not start in time" (4×)
- "no window … in this project" (3×)
- "agents may not open "shell" here", though shell should be on for agents by default

## Worth doing

### 5. Design board for the design-first loop

Nearly every feature went design HTML → "lets go with B" → "build it out". Open new or changed `design/*.html` beside the agent automatically; pick a variant with notes, and it types "build variant B of design/x.html, notes: …" into the agent.

### 6. What each agent is doing, and its context use

Many sessions ran out of context and continued from a summary; one asked for "one agent to update a workspace.html of how far are we". Show each agent window's todo list and context % on hover, the tab and the phone page (Claude Code's statusline data and session files likely have this).

### 7. Move changes between worktrees

"move the following to the reminders worktree … this repo must be clean", "fetch the untracked files from main into this worktree". A Git window action to carry selected files or a stash to another checkout.

### 8. Keep ✦ drafts out of session history

Every commit/PR draft leaves a "Write a git commit message…" session (~10 so far), and there are three "Reply with only the word ok" sessions from a temp folder (a probe?). Run them so they don't clutter `claude --resume`, if `claude -p` has a no-persist option.

### 9. Fix ssh key permissions in the Environment dialog

A OneDrive `.pem` was rejected for "bad permissions" on Windows. The dialog takes `ssh -i key …` already; it could detect that error and offer a one-click `icacls` fix.

## Smaller

- On `os error 32` during `tauri dev` (file in use), name the process holding it with the Leftovers code instead of a manual `taskkill`.
- Per-worktree toolchain check via mise ("rustc 1.88 not supported").

## Suggested start

#1 and #2: the most frequent friction, and both build on code already there (worktree setup script, the Select element composer).
