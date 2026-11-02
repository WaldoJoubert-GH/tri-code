// The Environment dialog's rules, for New and Edit alike. Pure, so bun test can run them
// (envform.test.ts); EnvDialog.tsx draws what envFormView says.

import type { EnvSsh } from "./state";

export type EnvKind = "local" | "ssh";
export type TestState = "wait" | "ok" | "bad" | null;

/** What the dialog's fields hold. */
export type EnvFields = {
  kind: EnvKind;
  name: string;
  dest: string;
  port: string;
  key: string;
  /** `-o` options as typed: separated by spaces, one with spaces in double quotes. */
  options: string;
  pinOn: boolean;
  /** Changing a PIN that exists, as against keeping it. */
  changing: boolean;
  cur: string;
  pin: string;
  pin2: string;
  test: TestState;
};

/** The Environment being edited, as its fields would read. New has none. */
export type EnvOriginal = { host: string; port: string; key: string; options: string; hasPin: boolean; local?: boolean };

export type EnvFormContext = {
  original?: EnvOriginal;
  /** Every Environment, the edited one too. */
  hosts: string[];
  /** The edited Environment's PIN is up: only its name and icon can change. */
  locked: boolean;
  /** What a new destination would move. */
  projects: number;
  terminals: number;
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const PIN = /^\d{4,8}$/;

export const emptyFields = (kind: EnvKind): EnvFields => ({
  kind, name: "", dest: "", port: "", key: "", options: "", pinOn: false, changing: false, cur: "", pin: "", pin2: "", test: null,
});

export const fieldsFrom = (o: EnvOriginal): EnvFields => ({
  ...emptyFields(o.local ? "local" : "ssh"),
  dest: o.local ? "" : o.host, port: o.port, key: o.key, options: o.options, pinOn: o.hasPin,
});

/** Words as a shell splits them: double or single quotes hold spaces together. */
function words(raw: string): string[] {
  const out: string[] = [];
  let cur = "", quote = "", any = false;
  for (const c of raw.trim()) {
    if (quote) c === quote ? (quote = "") : (cur += c);
    else if (c === "'" || c === '"') (quote = c), (any = true);
    else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

export const isSshCommand = (raw: string) => /^\s*ssh(\.exe)?\s/i.test(raw);

/** What a pasted `ssh ...` means: a destination plus the options it can't carry. */
export function parseSsh(raw: string): { dest: string } & EnvSsh {
  const all = words(raw);
  if (/^ssh(\.exe)?$/i.test(all[0] ?? "")) all.shift();

  let dest = "", user = "", identityFile = "", port = "";
  const options: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    if (w === "-i") identityFile = all[++i] ?? "";
    else if (w === "-p") port = all[++i] ?? "";
    else if (w === "-l") user = all[++i] ?? "";
    else if (w === "-o") options.push(all[++i] ?? "");
    else if (!w.startsWith("-") && !dest) dest = w;
  }
  // A terminal usually starts in the home folder, so `.\key.pem` there means `~\key.pem`.
  identityFile = identityFile.replace(/^\.(?=[\\/])/, "~");
  if (user && dest && !dest.includes("@")) dest = `${user}@${dest}`;
  return { dest, identityFile: identityFile || undefined, port: port || undefined, options: options.length ? options : undefined };
}

/** The options field's text: an option with spaces (`ProxyCommand ssh jump`) goes in quotes. */
export const optionsText = (options: string[] | undefined) =>
  (options ?? []).map((o) => (/\s/.test(o) ? `"${o}"` : o)).join(" ");

export function optionsList(text: string): string[] | undefined {
  const list = words(text);
  return list.length ? list : undefined;
}

/** The fields as ssh options to keep, or undefined when none are set. */
export function sshOf(f: Pick<EnvFields, "key" | "port" | "options">): EnvSsh | undefined {
  const identityFile = f.key.trim() || undefined, port = f.port.trim() || undefined, options = optionsList(f.options);
  return identityFile || port || options ? { identityFile, port, options } : undefined;
}

/** Everything the dialog shows and allows follows from the fields. */
export function envFormView(f: EnvFields, ctx: EnvFormContext) {
  const o = ctx.original, isNew = !o;
  const local = f.kind === "local";
  // Locked, the connection and PIN aren't shown, so whatever the fields read doesn't count.
  const locked = !isNew && !local && ctx.locked;
  const open = !local && !locked;
  const host = local ? (o?.host ?? "local") : locked ? o!.host : f.dest.trim();

  const moving = open && !isNew && host !== o.host;
  const connChanged = open && (isNew || moving || f.port !== o.port || f.key !== o.key || f.options !== o.options);
  const taken = open && ctx.hosts.some((h) => h !== o?.host && h === host);
  const badDest = open && !!host && (/\s/.test(host) || host.startsWith("-"));

  const hasPin = !!o?.hasPin;
  const removing = open && hasPin && !f.pinOn;
  const needCur = open && hasPin && (!f.pinOn || f.changing);
  const needNew = open && f.pinOn && (!hasPin || f.changing);
  let pinProblem = "";
  if (needCur && !PIN.test(f.cur)) pinProblem = "Enter the current PIN";
  else if (needNew && !PIN.test(f.pin)) pinProblem = "PIN must be 4–8 digits";
  else if (needNew && f.pin !== f.pin2) pinProblem = "PINs don't match";

  const testing = open && f.test === "wait";
  const Verb = isNew ? "Add" : "Save";
  const moves = moving && !!host && !taken && !badDest && ctx.projects > 0;
  const primary = !connChanged ? Verb
    : testing ? "Testing…"
    : f.test === "bad" ? `${Verb} anyway`
    : f.test === "ok" ? (moves ? "Save and move" : Verb)
    : `Test and ${Verb.toLowerCase()}`;

  const n = ctx.terminals;
  return {
    isNew, local, locked, open, host, moving, taken, badDest, hasPin, removing, needCur, needNew, pinProblem, testing, primary,
    needsTest: connChanged && f.test === null,
    blocked: !host || taken || badDest || testing || !!pinProblem,
    /** New only: this machine can be added once. Edit keeps the kind it has. */
    localDisabled: isNew && ctx.hosts.some((h) => h === "local" || h === ""),
    moveText: moves
      ? `Moves ${plural(ctx.projects, "project")} to ${host}.${n ? ` ${n} open terminal${n === 1 ? " restarts" : "s restart"} there.` : ""} Folders keep their paths, so they need to exist on the new host.`
      : "",
  };
}
