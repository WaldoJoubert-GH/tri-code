import { describe, expect, test } from "bun:test";
import { fileUrlOf, parseListening, targetOf, toLocal, toRemote } from "./tunnelmap";

describe("targetOf", () => {
  test("a loopback address is a port of the remote", () => {
    expect(targetOf("http://localhost:5173/dashboard", "/srv/app")).toEqual({ target: { kind: "port", port: 5173 }, key: "port:5173" });
    expect(targetOf("http://127.0.0.1:3000", "")?.key).toBe("port:3000");
    expect(targetOf("https://localhost/", "")?.key).toBe("port:443");
    expect(targetOf("http://0.0.0.0:8080/x", "")?.key).toBe("port:8080");
  });

  test("other sites need no tunnel", () => {
    expect(targetOf("https://github.com/", "/srv/app")).toBeNull();
    expect(targetOf("http://devbox:5173/", "/srv/app")).toBeNull();
    expect(targetOf("about:blank", "/srv/app")).toBeNull();
  });

  test("a file in the project is served from the project's folder, any other from its own", () => {
    expect(targetOf("file:///srv/app/coverage/index.html", "/srv/app")?.target).toEqual({ kind: "dir", dir: "/srv/app" });
    expect(targetOf("file:///tmp/report/index.html", "/srv/app")?.target).toEqual({ kind: "dir", dir: "/tmp/report" });
    expect(targetOf("file:///~/app/a%20b/index.html", "~/app")?.target).toEqual({ kind: "dir", dir: "~/app" });
  });
});

describe("toLocal and toRemote", () => {
  test("a port keeps its path and swaps the port", () => {
    const t = targetOf("http://localhost:5173/a?b=1#c", "")!.target;
    expect(toLocal("http://localhost:5173/a?b=1#c", t, 49731)).toBe("http://localhost:49731/a?b=1#c");
    expect(toRemote("http://localhost:49731/next", t, 49731)).toBe("http://localhost:5173/next");
    expect(toRemote("http://localhost:5174/next", t, 49731)).toBeNull();
    expect(toRemote("https://github.com/", t, 49731)).toBeNull();
  });

  test("0.0.0.0 loads as localhost", () => {
    const t = targetOf("http://0.0.0.0:8080/", "")!.target;
    expect(toLocal("http://0.0.0.0:8080/", t, 8080)).toBe("http://localhost:8080/");
  });

  test("a file loads from the folder's server and maps back to the file", () => {
    const url = "file:///srv/app/coverage/my%20file.html#L3";
    const t = targetOf(url, "/srv/app")!.target;
    const local = toLocal(url, t, 49740);
    expect(local).toBe("http://127.0.0.1:49740/coverage/my%20file.html#L3");
    expect(toRemote(local, t, 49740)).toBe(url);
    expect(toRemote("http://127.0.0.1:49740/coverage/other.html", t, 49740)).toBe("file:///srv/app/coverage/other.html");
  });

  test("a home folder survives the round trip", () => {
    const url = fileUrlOf("~/app/docs/index.html");
    expect(url).toBe("file:///~/app/docs/index.html");
    const t = targetOf(url, "~/app")!.target;
    expect(toRemote(toLocal(url, t, 5000), t, 5000)).toBe(url);
  });
});

describe("parseListening", () => {
  test("reads ss with ps, the user's processes only, one row per port", () => {
    const out = [
      "<<ss>>",
      'LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=48211,fd=23))',
      'LISTEN 0      511            [::1]:5173         [::]:*    users:(("node",pid=48211,fd=24))',
      "LISTEN 0      128          0.0.0.0:22        0.0.0.0:*",
      'LISTEN 0      244        127.0.0.1:5432      0.0.0.0:*    users:(("postgres",pid=900,fd=5))',
      "<<ps>>",
      "  48211 node /srv/app/node_modules/.bin/vite",
      "    900 postgres -D /var/lib/pg",
    ].join("\n");
    expect(parseListening(out)).toEqual([
      { port: 5173, pid: 48211, name: "node", args: "node /srv/app/node_modules/.bin/vite", http: true },
      { port: 5432, pid: 900, name: "postgres", args: "postgres -D /var/lib/pg", http: false },
    ]);
  });

  test("reads lsof on macOS", () => {
    const out = [
      "<<lsof>>",
      "COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node    48211 waldo   23u  IPv4 0x1234      0t0  TCP 127.0.0.1:3000 (LISTEN)",
      "<<ps>>",
      "48211 node server.js",
    ].join("\n");
    expect(parseListening(out)).toEqual([{ port: 3000, pid: 48211, name: "node", args: "node server.js", http: true }]);
  });
});
