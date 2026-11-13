// What the Docker Window knows: docker's output turned into stacks, containers, ports and log
// lines. Everything here is plain text in, plain data out; docker.ts runs docker.

export type Phase = "running" | "healthy" | "unhealthy" | "starting" | "restarting" | "paused" | "created" | "exited" | "dead" | "removing";

export type Port = {
  /** The container's port. */
  cont: number;
  proto: string;
  /** The published port, absent when it's only exposed inside the Docker network. */
  host?: number;
  /** The address it's published on, as docker prints it. */
  bind?: string;
};

export type Container = {
  id: string;
  name: string;
  image: string;
  phase: Phase;
  /** The exit code, while exited or restarting. */
  code?: number;
  /** "2 hours", or "2 hours ago" once stopped. */
  up: string;
  ports: Port[];
  /** The compose project, service and replica; absent when compose didn't start it. */
  stack?: string;
  service?: string;
  number?: string;
  /** The folder it was composed from. */
  dir?: string;
  /** Inside this Docker Sandbox's own daemon: `name` is then `<sandbox>/<raw>`, unique across daemons,
   *  and `raw` is what docker in the sandbox calls it. */
  sandbox?: string;
  raw?: string;
};

export type Stack = {
  /** Undefined for the containers compose didn't start. */
  name?: string;
  containers: Container[];
  /** Started from the project's folder, or one under it. */
  mine: boolean;
  /** A Docker Sandbox, listed as one group of what runs inside it (sandbox.ts); `name` is `sbx:<name>`. */
  sandbox?: { name: string; status: string };
  /** A sandbox's compose project, when everything in it is one: its compose logs. */
  compose?: string;
};

/** A Docker Sandbox as one group: what its daemon runs, each container named apart from the host's. */
export function sandboxStack(box: { name: string; status: string }, list: Container[], mine: boolean): Stack {
  const containers = list
    .map((c) => ({ ...c, name: `${box.name}/${c.name}`, raw: c.name, sandbox: box.name }))
    .sort((a, b) => runRank(a) - runRank(b) || (a.service ?? a.name).localeCompare(b.service ?? b.name));
  const stacks = new Set(containers.map((c) => c.stack));
  const compose = stacks.size === 1 ? [...stacks][0] : undefined;
  return { name: `sbx:${box.name}`, containers, mine, sandbox: box, ...(compose ? { compose } : {}) };
}

/** docker's `Labels`: `a=1,b=2`. A value can hold a comma, so a part with no `=` belongs to the one before. */
export function parseLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last: string | undefined;
  for (const part of text ? text.split(",") : []) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      last = part.slice(0, eq);
      out[last] = part.slice(eq + 1);
    } else if (last) {
      out[last] += `,${part}`;
    }
  }
  return out;
}

const RANGE_MAX = 32;

/** docker's `Ports`: `0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp, 6379/tcp, 0.0.0.0:80-81->80-81/tcp`. One entry per port, published first; the v4 and v6 lines of one port become one. */
export function parsePorts(text: string): Port[] {
  const out = new Map<string, Port>();
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const pub = part.match(/^(?:(.*):)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)$/);
    if (pub) {
      const [, bind, h0, h1, c0, c1, proto] = pub;
      const count = Math.min(RANGE_MAX, (h1 ? +h1 - +h0 : c1 ? +c1 - +c0 : 0) + 1);
      for (let i = 0; i < count; i++) {
        const host = +h0 + i;
        const cont = +c0 + (c1 ? i : 0);
        const key = `${host}/${proto}`;
        // Keep the IPv4 address when both are listed; it's the one every client can reach.
        if (!out.has(key) || isV6Any(out.get(key)!.bind)) out.set(key, { cont, proto, host, bind: bind || "0.0.0.0" });
      }
      continue;
    }
    const exposed = part.match(/^(\d+)(?:-(\d+))?\/(\w+)$/);
    if (exposed) {
      const [, c0, c1, proto] = exposed;
      for (let c = +c0; c <= Math.min(+(c1 ?? c0), +c0 + RANGE_MAX - 1); c++) out.set(`int ${c}/${proto}`, { cont: c, proto });
    }
  }
  const all = [...out.values()];
  return [...all.filter((p) => p.host), ...all.filter((p) => !p.host)];
}

const isV6Any = (bind?: string) => bind === "::" || bind === "[::]";

/** A container's lifecycle from docker's `State` and its human `Status`. */
export function phaseOf(state: string, status: string): { phase: Phase; code?: number; up: string } {
  const code = status.match(/\((\d+)\)/);
  const n = code ? +code[1] : undefined;
  const since = status.replace(/^\S+( \(\d+\))?\s*/, "");
  switch (state) {
    case "running": {
      const up = status.replace(/^Up\s+/, "").replace(/\s*\(.*\)\s*$/, "");
      const phase = /\(unhealthy\)/.test(status) ? "unhealthy" : /\(healthy\)/.test(status) ? "healthy" : /\(health: starting\)/.test(status) ? "starting" : "running";
      return { phase, up };
    }
    case "restarting":
      return { phase: "restarting", code: n, up: since };
    case "paused":
      return { phase: "paused", up: status.replace(/^Up\s+/, "").replace(/\s*\(.*\)\s*$/, "") };
    case "exited":
      return { phase: "exited", code: n, up: since };
    case "dead":
    case "removing":
    case "created":
      return { phase: state, up: "" };
    default:
      return { phase: "created", up: "" };
  }
}

/** `docker ps --format '{{json .}}'`, one object per line. A line that isn't one is skipped. */
export function parseContainers(out: string): Container[] {
  const list: Container[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, string>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const labels = parseLabels(r.Labels ?? "");
    list.push({
      id: r.ID,
      name: (r.Names ?? "").split(",")[0],
      image: r.Image ?? "",
      ...phaseOf(r.State ?? "", r.Status ?? ""),
      ports: parsePorts(r.Ports ?? ""),
      stack: labels["com.docker.compose.project"],
      service: labels["com.docker.compose.service"],
      number: labels["com.docker.compose.container-number"],
      dir: labels["com.docker.compose.project.working_dir"],
    });
  }
  return list;
}

/** Windows paths compare whatever their slashes and case; others exactly. */
const normPath = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
};

/** Is `dir` one of `roots`, or under one? A compose file in `<project>/docker` still belongs to the project. */
export function isInside(dir: string | undefined, roots: string[]): boolean {
  if (!dir) return false;
  const d = normPath(dir);
  return roots.map(normPath).some((r) => r !== "" && (d === r || d.startsWith(`${r}/`)));
}

/** Running first, then what's trying to (restarting, paused), then everything stopped. */
const runRank = (c: Container) => (isUp(c) ? 0 : isAlive(c) ? 1 : 2);

/** Stacks in the order the window lists them: the project's, then those with something running, then by name, with the containers compose didn't start after the named ones. Within a stack, running first. */
export function groupStacks(list: Container[], roots: string[]): Stack[] {
  const byName = new Map<string, Container[]>();
  const loose: Container[] = [];
  for (const c of list) {
    if (c.stack) byName.set(c.stack, [...(byName.get(c.stack) ?? []), c]);
    else loose.push(c);
  }
  const sortC = (a: Container, b: Container) => runRank(a) - runRank(b) || (a.service ?? a.name).localeCompare(b.service ?? b.name) || (a.number ?? "").localeCompare(b.number ?? "", undefined, { numeric: true });
  const stacks: Stack[] = [...byName].map(([name, cs]) => ({ name, containers: cs.sort(sortC), mine: cs.some((c) => isInside(c.dir, roots)) }));
  if (loose.length) stacks.push({ containers: loose.sort(sortC), mine: false });
  const running = (s: Stack) => +s.containers.some(isUp);
  return stacks.sort((a, b) => +b.mine - +a.mine || running(b) - running(a) || +!a.name - +!b.name || (a.name ?? "").localeCompare(b.name ?? ""));
}

/** Stopped on purpose or finished its job: `docker compose stop` and one-shots like a migration. */
export const stoppedCleanly = (c: Container) => c.phase === "exited" && (c.code === 0 || c.code === 143);
/** Counted as up in a stack's `4/5 up`. */
export const isUp = (c: Container) => c.phase === "running" || c.phase === "healthy" || c.phase === "unhealthy" || c.phase === "starting";
export const needsLook = (c: Container) => c.phase === "restarting" || c.phase === "unhealthy" || c.phase === "dead" || (c.phase === "exited" && !stoppedCleanly(c));
/** Is anything writing logs, or about to? */
export const isAlive = (c: Container) => isUp(c) || c.phase === "restarting" || c.phase === "paused";
export const rowName = (c: Container) => (c.service ? (c.number && c.number !== "1" ? `${c.service}-${c.number}` : c.service) : c.name);

export function phaseText(c: Container): string {
  if (c.phase === "exited" || c.phase === "restarting") return c.code === undefined ? c.phase : `${c.phase} (${c.code})`;
  return c.phase === "starting" ? "starting" : c.phase;
}

/** Does the container match every word typed? Looks at its names, stack, image, state and ports, so `5432`, `postgres` or `exited` all find it. */
export function matchesFind(c: Container, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [c.name, c.service, c.stack, c.image, phaseText(c), ...c.ports.flatMap((p) => [p.host, p.cont])].filter((x) => x !== undefined).join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

export type Tone = "good" | "warn" | "bad" | "off";
export function phaseTone(c: Container): Tone {
  if (needsLook(c)) return c.phase === "restarting" ? "warn" : "bad";
  if (isUp(c) && c.phase !== "starting") return "good";
  return c.phase === "starting" || c.phase === "paused" ? "warn" : "off";
}

/** Ports that don't speak HTTP, so a click copies the address rather than opening a page. */
export const NOT_HTTP = new Set([21, 22, 25, 53, 110, 143, 465, 587, 993, 995, 1025, 1433, 1521, 2181, 3306, 4222, 5432, 5672, 6379, 9042, 9092, 9229, 11211, 27017, 27018]);
const HTTPS = new Set([443, 4443, 8443, 9443]);

export const opensPage = (p: Port) => p.proto === "tcp" && !NOT_HTTP.has(p.cont);

/** Where this machine reaches a published port on itself: an all-interfaces bind answers on localhost. */
export function localAddr(p: Port): string {
  const b = p.bind ?? "";
  if (!b || b === "0.0.0.0" || isV6Any(b) || b === "127.0.0.1" || b === "::1" || b === "[::1]") return "localhost";
  return b.includes(":") && !b.startsWith("[") ? `[${b}]` : b;
}

/** Where a tunnel from an ssh host goes, as the host sees it. */
export function tunnelTarget(p: Port): string {
  const b = (p.bind ?? "").replace(/^\[|\]$/g, "");
  return !b || b === "0.0.0.0" || b === "::" ? "127.0.0.1" : b;
}

export const portUrl = (p: Port, addr: string, port: number) => `${HTTPS.has(p.cont) ? "https" : "http"}://${addr}:${port}`;

// ── logs ─────────────────────────────────────────────────────────────

export type Level = "info" | "warn" | "bad";

export type LogLine = {
  /** The docker timestamp as printed, for `--since` and ordering. */
  stamp?: string;
  /** The compose prefix (`api-1`), when the line came through compose logs. */
  prefix?: string;
  text: string;
  level: Level;
  /** A marker the window adds (a restart), not something the container wrote. */
  mark?: boolean;
};

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) ?/;
const PREFIX = /^(\S+)\s+\| ?/;

export const stripAnsi = (s: string) => s.replace(ANSI, "");

export function levelOf(text: string): Level {
  if (/\b(ERROR|ERR|FATAL|PANIC|CRITICAL|CRIT|EMERG|ALERT)\b|\bTraceback \(most recent|(?:\blevel"?[=:]\s*"?|\bseverity"?[=:]\s*"?)(error|fatal|panic|crit)/i.test(text) && !/\b(no|0|without) errors?\b/i.test(text)) return "bad";
  if (/\bWARN(ING)?\b|(?:\blevel"?[=:]\s*"?|\bseverity"?[=:]\s*"?)warn/i.test(text)) return "warn";
  return "info";
}

/** One line of `docker logs --timestamps`, or with `compose` of `docker compose logs --timestamps`. */
export function parseLogLine(raw: string, compose: boolean): Omit<LogLine, "level"> {
  let rest = stripAnsi(raw);
  let prefix: string | undefined;
  if (compose) {
    const m = rest.match(PREFIX);
    if (m) {
      prefix = m[1];
      rest = rest.slice(m[0].length);
    }
  }
  const s = rest.match(STAMP);
  return { stamp: s?.[1], prefix, text: s ? rest.slice(s[0].length) : rest };
}

/** A stack trace's indented lines take the level of the error above them, per source. */
export function withLevel(line: Omit<LogLine, "level">, prev: Level | undefined): LogLine {
  const own = levelOf(line.text);
  const continues = /^\s+(at |File |\S)/.test(line.text) && own === "info";
  return { ...line, level: continues && prev === "bad" ? "bad" : own };
}

/** The clock time of a docker timestamp, in the viewer's timezone. */
export function clockOf(stamp: string | undefined): string {
  if (!stamp) return "";
  const d = new Date(stamp);
  return Number.isNaN(+d) ? "" : d.toTimeString().slice(0, 8);
}

/** Which container a compose prefix means: `api-1` is service `api`, replica 1; a custom `container_name` prints itself. */
export function containerOfPrefix(prefix: string | undefined, list: Container[]): Container | undefined {
  if (!prefix) return undefined;
  return list.find((c) => (c.service && `${c.service}-${c.number ?? 1}` === prefix) || c.name === prefix || c.service === prefix);
}

/** A `docker events` line, or undefined when it isn't one. */
export function parseEvent(line: string): { name: string; action: string; code?: number } | undefined {
  try {
    const e = JSON.parse(line);
    const code = e.Actor?.Attributes?.exitCode;
    return { name: e.Actor?.Attributes?.name ?? "", action: e.Action ?? e.status ?? "", ...(code !== undefined ? { code: +code } : {}) };
  } catch {
    return undefined;
  }
}

export type Failure = "missing" | "down" | "other";

/** Why docker didn't answer, so the window can say what to do about it. */
export function failureOf(err: string): Failure {
  if (/command not found|not recognized|docker: .*not found|unknown command: .*docker/i.test(err)) return "missing";
  if (/cannot connect to the docker daemon|is the docker daemon running|error during connect|dockerDesktop.*Engine|docker_engine/i.test(err)) return "down";
  return "other";
}
