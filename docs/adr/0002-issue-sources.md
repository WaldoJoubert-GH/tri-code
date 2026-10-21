# 0002. A project tracks issues in any of Plane, GitHub and Local

Date: 2026-10-21

## Status

Accepted. Extends 0001.

## Context

The Issues Panel only knew Plane (plus pulled Sentry issues). Some projects live on GitHub and use its issues; some have no tracker and just want a list. We prototyped three shapes in `design/issue-providers.html`: one tracker per project (A), any mix of Sources merged into one list (B), and an app default with a per-project override (C).

## Decision

1. **Variant B: Sources, tick any.** `.dev/config.json` gains `sources: ["plane" | "github" | "local"]`. A config without `sources` but with a `plane` section means Plane alone, so existing projects keep working. Sentry stays a pulled source beside whatever is ticked. Unticking a Source hides its issues; its entries stay in `issues.json` for the other clients.

2. **GitHub runs through `gh` on the project's host** (`github.rs`, reusing `git.rs`'s local/ssh runner). tri-code stores no GitHub token. GitHub has only open and closed, so its States are Open, In Progress (open with a configurable label, `in progress` by default, created on first use), Closed (completed) and Not planned. GitHub issues are cached in `issues.json` with `source: "github"`, labels in `github-labels.json`, comments in `github/comments/<n>.json`. Comments are text only.

3. **Local issues live in `.dev/local-issues.json`, not `issues.json`.** pi-todos and dev-hub rewrite `issues.json` on every Plane sync and kept only Plane and Sentry entries, which would have deleted Local issues for good: they exist nowhere else. Only tri-code writes `local-issues.json` (`{ next, issues }`). Four fixed States: Todo, In Progress, Done, Cancelled.

4. **Slug-IDs**: Plane `TRI-12`, GitHub `#231`, Local `<prefix>-3` or plain `3` when the project leaves the prefix empty (`local.prefix`), Sentry `S-4412`. GitHub keeps its `#` so a GitHub issue and an unprefixed Local issue can never share a Slug-ID.

5. **Time Entries key on the issue key** (`<plane uuid>`, `gh<n>`, `lo<n>`), so any tracked issue can be timed. pi-todos shows only Plane ones.

## Consequences

- pi-todos' `replacePlaneIssues` and dev-hub's Plane sync must keep every non-Plane entry, not only Sentry, or GitHub issues vanish from `issues.json` until tri-code's next sync. Until they read `local-issues.json`, the other clients don't show Local issues.
- The panel branches per Source for the State Dropdown, Labels, comments and New Issue (Tab picks where it goes when several Sources are on).
- GitHub's In Progress is a label, not a Projects v2 Status field. Moving to a Status field later is a change inside `gh_issue_set_state` and `stateOf`.
