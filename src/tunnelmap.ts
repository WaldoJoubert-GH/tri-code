// The address arithmetic of remote browser tunnels (tunnels.ts), kept pure for tests. In a remote
// project `localhost:5173` and `file:///…` name the remote's port and file; the webview loads them
// from a local port that an ssh tunnel forwards there. The page keeps the remote address, so the
// address bar, favourites and a restart all see that one.

import { NOT_HTTP } from "./dockerdata";

/** What a forward reaches on the remote: a port of its localhost, or a folder its file server serves. */
export type Target = { kind: "port"; port: number } | { kind: "dir"; dir: string };

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** A `file:` URL's path as the remote's shell reads it: `/~/x` is `~/x`, the remote's home. */
function filePath(u: URL): string {
  const p = decodeURIComponent(u.pathname);
  return p === "/~" || p.startsWith("/~/") ? p.slice(1) : p;
}

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/**
 * Where a remote project's address points on its host, or null for one that needs no tunnel. A
 * file inside the project is served from the project's folder, so links between its pages and
 * up to shared assets work; any other from its own folder.
 */
export function targetOf(url: string, projectPath: string): { target: Target; key: string } | null {
  const u = parse(url);
  if (!u) return null;
  if ((u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.test(u.hostname)) {
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    return { target: { kind: "port", port }, key: `port:${port}` };
  }
  if (u.protocol === "file:" && !u.host) {
    const path = filePath(u);
    const root = projectPath.replace(/\/+$/, "");
    const dir = root && path.startsWith(`${root}/`) ? root : dirname(path);
    return { target: { kind: "dir", dir }, key: `dir:${dir}` };
  }
  return null;
}

/** The address the webview loads for remote `url`, through a forward on local port `local`. */
export function toLocal(url: string, target: Target, local: number): string {
  const u = new URL(url);
  if (target.kind === "port") {
    if (u.hostname === "0.0.0.0") u.hostname = "localhost";
    u.port = String(local);
    return u.toString();
  }
  const rel = filePath(u).slice(target.dir === "/" ? 0 : target.dir.length);
  return `http://127.0.0.1:${local}${encodeURI(rel)}${u.search}${u.hash}`;
}

/** The remote address for a local one the webview reports, or null when it isn't through this forward. */
export function toRemote(localUrl: string, target: Target, local: number): string | null {
  const u = parse(localUrl);
  if (!u || !/^https?:$/.test(u.protocol) || !LOOPBACK.test(u.hostname) || Number(u.port) !== local) return null;
  if (target.kind === "port") {
    u.port = String(target.port);
    return u.toString();
  }
  const path = (target.dir === "/" ? "" : target.dir) + decodeURIComponent(u.pathname);
  return `file://${encodeURI(path.startsWith("~") ? `/${path}` : path)}${u.search}${u.hash}`;
}

/** A `file:` URL for a path on the remote, `~/…` included. */
export function fileUrlOf(path: string): string {
  return `file://${encodeURI(path.startsWith("/") ? path : `/${path}`)}`;
}

/** A TCP port something of the user's listens on, on the remote. */
export type Listener = { port: number; pid: number; name: string; args: string; http: boolean };

const NOT_HTTP_NAME = /^(postgres|redis|mongo|mysql|mariadb|sshd|memcached|rabbitmq|beam\.smp|clickhouse)/i;

/** Parse `remote_listening`: `ss -ltnpH` or `lsof` lines, then `ps` lines, each after its marker. */
export function parseListening(out: string): Listener[] {
  const lines = out.split(/\r?\n/);
  const args = new Map<number, string>();
  const found: { port: number; pid: number; name: string }[] = [];
  let part = "";
  for (const line of lines) {
    const m = /^<<(ss|lsof|ps)>>$/.exec(line.trim());
    if (m) {
      part = m[1];
      continue;
    }
    if (!line.trim()) continue;
    if (part === "ps") {
      const p = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (p) args.set(Number(p[1]), p[2].trim());
    } else if (part === "ss") {
      const f = line.trim().split(/\s+/);
      const proc = /\("([^"]+)",pid=(\d+)/.exec(line);
      const port = Number(f[3]?.slice(f[3].lastIndexOf(":") + 1));
      if (proc && port) found.push({ port, pid: Number(proc[2]), name: proc[1] });
    } else if (part === "lsof") {
      const f = line.trim().split(/\s+/);
      const addr = f.find((x, i) => i > 1 && /:\d+$/.test(x));
      if (f[0] === "COMMAND" || !addr) continue;
      found.push({ port: Number(addr.slice(addr.lastIndexOf(":") + 1)), pid: Number(f[1]), name: f[0].replace(/\\x20/g, " ") });
    }
  }
  const byPort = new Map<number, Listener>();
  for (const f of found) {
    if (byPort.has(f.port)) continue;
    byPort.set(f.port, { ...f, args: args.get(f.pid) ?? f.name, http: !NOT_HTTP.has(f.port) && !NOT_HTTP_NAME.test(f.name) });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}
