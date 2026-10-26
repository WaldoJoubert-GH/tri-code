# Agent windows: the tri-code MCP server

`tri-code.mjs` lets an agent in a tri-code terminal open, read, type into, wait on and close the
terminal windows of its own project or worktree. It has no dependencies; it needs Node, which
Claude Code already runs on.

## Set up

Open a project and tri-code offers to install it for each agent it finds on this machine (Claude,
pi). Settings › Agents shows the state and can install, update the path, or remove it. The answer
is remembered, so the question is asked once.

By hand, the same registration is:

```sh
claude mcp add --scope user tri-code -- node "<path to this repo>/mcp/tri-code.mjs"
pi mcp add tri-code --exposure direct -- node "<path to this repo>/mcp/tri-code.mjs"
```

`--exposure direct` makes pi show the seven tools to the agent directly (its default, `codemode`,
hides them behind code mode). The agent gets them as `mcp__tri-code__open_window`, `list_windows`,
`status`, `read`, `send`, `wait_for` and `close_window`. They only work from a terminal that
tri-code started: the terminal carries its own token, which names its project.

## What an agent can do

- **Open** only the project's Commands with **Agent** switched on in the Commands window (the
  `agent` / `off` toggle on each row). Web apps and raw shell commands are never opened for an agent.
- **See and drive** only the windows of its own project or worktree. Other projects, and other
  worktrees of the same repo, are invisible to it.
- **Close** only windows an agent opened. Your own windows stay yours.

The endpoint listens on `127.0.0.1:7521` only. Remote (ssh) projects are not covered yet: their
agents can't reach a loopback endpoint on this machine.
