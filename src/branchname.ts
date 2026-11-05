// Branch names from free text, for New worktree and an agent's create_worktree.

/** A branch name from free text: lowercase, words joined by `-`, `/` kept for prefixes. */
export const toBranch = (text: string) =>
  text.trim().toLowerCase().replace(/[^a-z0-9/._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-/.]+|[-/.]+$/g, "").slice(0, 60);

/** A branch prefix as git gets it (`Waldo` → `waldo/`): ending in one `/`, or "" for none. */
export const cleanPrefix = (prefix?: string) => {
  const t = toBranch(prefix ?? "").replace(/\/+$/, "");
  return t ? `${t}/` : "";
};

/** The branch an agent's `name` means: one git already has as it is, else a new one with the repo's prefix. */
export function agentBranch(name: string, known: string[], prefix?: string): string {
  const typed = name.trim();
  if (known.includes(typed)) return typed;
  const clean = toBranch(typed);
  if (!clean) return "";
  const pre = cleanPrefix(prefix);
  return clean.startsWith(pre) ? clean : pre + clean;
}
