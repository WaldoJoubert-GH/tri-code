// Worktree Setup: the script New worktree runs once in a new checkout. Pure, so bun test can run it
// (setup.test.ts). The lines become one command for the PTY: the setup window closes when it
// succeeds, and a line that fails stops it and leaves a shell in the new checkout to fix it.

/** What `{name}` in a setup line becomes. */
export type SetupVars = { repo: string; worktree: string; branch: string };

export const SETUP_VARS: { name: keyof SetupVars; hint: string }[] = [
  { name: "repo", hint: "the project's folder" },
  { name: "worktree", hint: "the new checkout's folder" },
  { name: "branch", hint: "the new branch" },
];

/** The script's lines with `{repo}`, `{worktree}` and `{branch}` filled in; blank lines dropped.
 *  An unknown `{name}` stays as typed. */
export function setupLines(script: string, vars: SetupVars): string[] {
  return script
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k as keyof SetupVars] : m)));
}

const STOPPED = "[setup stopped: this shell is in the new worktree; exit closes it]";

/**
 * One command line that runs `lines` in order and stops at the first that fails.
 *
 * Windows (a local project there): PowerShell, given the script encoded so cmd.exe's quoting can't
 * touch it, so `cp`, `mv` and `rm` work as they do on a Mac. A failed line exits 1 and the window
 * carries on in a shell, as for any Command. Elsewhere, the login shell (zsh, bash; a remote one
 * over ssh): a failed line starts a shell inside the same program, because tmux and shpool don't
 * pass the exit code back.
 */
export function setupCommand(lines: string[], windows: boolean): string {
  if (windows) {
    const ps = lines
      .map((l) => `${l}\nif (-not $?) { Write-Host "\`n${STOPPED}" -ForegroundColor Yellow; exit 1 }`)
      .join("\n");
    return `powershell -NoLogo -EncodedCommand ${utf16Base64(ps)}`;
  }
  return `${lines.map((l) => `{ ${l}; }`).join(" && ")} || { printf '\\n%s\\n' '${STOPPED}'; exec "\${SHELL:-/bin/sh}" -l; }`;
}

/** PowerShell's -EncodedCommand: the script as UTF-16LE, in base64. */
function utf16Base64(s: string): string {
  let bin = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    bin += String.fromCharCode(c & 0xff, c >> 8);
  }
  return btoa(bin);
}
