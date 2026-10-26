// The Worktree dialog: rename it, start its next feature, or finish it. Opened from a Worktree's
// row (double-click to rename, the right-click menu for the rest), so it works with the sidebar
// collapsed. Finish only explains what is about to happen; removeWorktree then asks for the exact list.

import { For, Show, createSignal } from "solid-js";
import { type Project, projectById } from "./state";
import { folderStatus } from "./git";
import { Icon } from "./lucide";
import { labelOf, removeWorktree, renameWorktree, startNextFeature, toBranch } from "./worktrees";

export type WorktreeAction = "rename" | "next" | "finish";

/** The Worktree (by id) and the action the dialog is open for, or null when it is closed. */
export const [worktreeDialog, setWorktreeDialog] = createSignal<{ id: string; action: WorktreeAction } | null>(null);
export const openWorktreeDialog = (id: string, action: WorktreeAction) => setWorktreeDialog({ id, action });
const closeWorktreeDialog = () => setWorktreeDialog(null);

export function WorktreeDialog() {
  return (
    <Show when={worktreeDialog()} keyed>
      {(d) => (
        <Show when={projectById(d.id)} keyed>
          {(w) => <Dialog w={w} action={d.action} />}
        </Show>
      )}
    </Show>
  );
}

function Dialog(props: { w: Project; action: WorktreeAction }) {
  const [name, setName] = createSignal(props.action === "rename" ? props.w.title ?? "" : "");
  const title = () =>
    props.action === "rename" ? "Rename worktree" : props.action === "next" ? "Start next feature" : props.w.copy ? "Finish" : "Remove worktree";
  const repos = () => folderStatus[props.w.id] ?? [];
  const dirty = () => repos().filter((r) => (r.status?.files.length ?? 0) > 0).map((r) => r.repo);
  const clean = () => repos().filter((r) => !dirty().includes(r.repo));
  const branch = () => toBranch(name());
  const canNext = () => !!branch() && clean().length > 0;

  const run = () => {
    if (props.action === "rename") {
      renameWorktree(props.w, name());
    } else if (props.action === "next") {
      if (!canNext()) return;
      void startNextFeature(props.w, branch());
    } else {
      void removeWorktree(props.w);
    }
    closeWorktreeDialog();
  };

  return (
    <div class="dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && closeWorktreeDialog()}>
      <div
        class="wt-dlg"
        role="dialog"
        aria-label={title()}
        onKeyDown={(e) => {
          if (e.key === "Escape") closeWorktreeDialog();
          else if (e.key === "Enter" && props.action !== "finish") run();
        }}
      >
        <header>
          <span>
            <Icon name={props.action === "next" ? "git-branch-plus" : props.action === "finish" ? "trash-2" : "pencil"} size={14} />
            {title()} · {labelOf(props.w).text}
          </span>
          <button type="button" title="Close (Esc)" aria-label="Close" onClick={closeWorktreeDialog}>×</button>
        </header>
        <div class="body">
          <Show when={props.action === "rename"}>
            <input
              ref={(el) => requestAnimationFrame(() => (el.focus(), el.select()))}
              value={name()}
              placeholder={labelOf(props.w).text}
              spellcheck={false}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <div class="note">
              A label only: the folder and branches keep their names. Empty goes back to following the branch. Pinned names show a badge on the tile.
            </div>
          </Show>

          <Show when={props.action === "next"}>
            <input
              ref={(el) => requestAnimationFrame(() => el.focus())}
              value={name()}
              placeholder="branch for the next feature"
              spellcheck={false}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <Show when={repos().length} fallback={<div class="note bad">No nested repos to switch.</div>}>
              <For each={repos()}>
                {(r) => (
                  <div class="note">
                    {r.repo}: {r.status?.branch ?? "detached"} → <b>{branch() || "…"}</b>
                    {(r.status?.files.length ?? 0) > 0 ? " · uncommitted changes, so it stays" : ""}
                  </div>
                )}
              </For>
              <div class="note">Each clean repo is fetched, then branched from origin/{repos()[0]?.status?.base || "main"}.</div>
            </Show>
          </Show>

          <Show when={props.action === "finish"}>
            <div class="note">
              Closes its windows, copies what changed outside git back to {props.w.copy ? "the folder" : "its repo"}, removes the nested worktrees and deletes
              their branches where merged. Unmerged branches are kept. Next, a confirmation lists the exact files.
            </div>
          </Show>
        </div>
        <footer>
          <button type="button" onClick={closeWorktreeDialog}>Cancel</button>
          <button
            type="button"
            class="primary"
            disabled={props.action === "next" && !canNext()}
            onClick={run}
          >
            {props.action === "rename" ? "Save" : props.action === "next" ? `Switch ${clean().length} repo${clean().length === 1 ? "" : "s"}` : "Continue"}
          </button>
        </footer>
      </div>
    </div>
  );
}
