import { describe, expect, test } from "bun:test";
import {
  containerOfPrefix, failureOf, groupStacks, isInside, levelOf, localAddr, matchesFind, opensPage, parseContainers, parseEvent, parseLabels, parseLogLine, parsePorts, phaseOf, phaseText, portUrl, rowName, stoppedCleanly, stripAnsi, tunnelTarget, withLevel,
} from "./dockerdata";

const row = (o: Record<string, string>) => JSON.stringify({ ID: "abc", Names: "n", Image: "img", State: "running", Status: "Up 2 hours", Ports: "", Labels: "", ...o });

describe("parseLabels", () => {
  test("splits on commas and keeps a comma inside a value", () => {
    expect(parseLabels("a=1,b=x=y")).toEqual({ a: "1", b: "x=y" });
    expect(parseLabels("com.docker.compose.project.working_dir=/srv/a,b,c=2")).toEqual({ "com.docker.compose.project.working_dir": "/srv/a,b", c: "2" });
    expect(parseLabels("")).toEqual({});
  });
});

describe("parsePorts", () => {
  test("one chip for the v4 and v6 lines of a port", () => {
    expect(parsePorts("0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp")).toEqual([{ cont: 3000, proto: "tcp", host: 3000, bind: "0.0.0.0" }]);
    expect(parsePorts(":::3000->3000/tcp, 0.0.0.0:3000->3000/tcp")).toEqual([{ cont: 3000, proto: "tcp", host: 3000, bind: "0.0.0.0" }]);
  });
  test("host and container ports can differ", () => {
    expect(parsePorts("127.0.0.1:5433->5432/tcp")).toEqual([{ cont: 5432, proto: "tcp", host: 5433, bind: "127.0.0.1" }]);
  });
  test("exposed ports come after published ones", () => {
    expect(parsePorts("6379/tcp, 0.0.0.0:80->80/tcp")).toEqual([{ cont: 80, proto: "tcp", host: 80, bind: "0.0.0.0" }, { cont: 6379, proto: "tcp" }]);
  });
  test("ranges expand, and udp stays udp", () => {
    expect(parsePorts("0.0.0.0:8000-8001->9000-9001/tcp").map((p) => [p.host, p.cont])).toEqual([[8000, 9000], [8001, 9001]]);
    expect(parsePorts("8000-8001/tcp").map((p) => p.cont)).toEqual([8000, 8001]);
    expect(parsePorts("0.0.0.0:53->53/udp")[0].proto).toBe("udp");
  });
  test("a many-to-one range maps every host port to the one container port", () => {
    expect(parsePorts("0.0.0.0:8000-8001->80/tcp").map((p) => [p.host, p.cont])).toEqual([[8000, 80], [8001, 80]]);
  });
  test("nothing published", () => {
    expect(parsePorts("")).toEqual([]);
  });
});

describe("phaseOf", () => {
  test("health comes from the status text", () => {
    expect(phaseOf("running", "Up 2 hours (healthy)")).toEqual({ phase: "healthy", up: "2 hours" });
    expect(phaseOf("running", "Up 5 seconds (health: starting)")).toEqual({ phase: "starting", up: "5 seconds" });
    expect(phaseOf("running", "Up 1 minute (unhealthy)").phase).toBe("unhealthy");
    expect(phaseOf("running", "Up About an hour")).toEqual({ phase: "running", up: "About an hour" });
  });
  test("stopped containers keep their exit code and how long ago", () => {
    expect(phaseOf("exited", "Exited (137) 3 days ago")).toEqual({ phase: "exited", code: 137, up: "3 days ago" });
    expect(phaseOf("restarting", "Restarting (1) 4 seconds ago")).toEqual({ phase: "restarting", code: 1, up: "4 seconds ago" });
  });
});

describe("parseContainers", () => {
  test("reads a compose container and skips noise", () => {
    const [c, ...rest] = parseContainers(`warning: something\n${row({ Names: "app-web-1", Labels: "com.docker.compose.project=app,com.docker.compose.service=web,com.docker.compose.container-number=1,com.docker.compose.project.working_dir=/srv/app", Ports: "0.0.0.0:80->80/tcp" })}\n`);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ name: "app-web-1", stack: "app", service: "web", number: "1", dir: "/srv/app", phase: "running", up: "2 hours" });
    expect(c.ports[0].host).toBe(80);
  });
});

describe("isInside", () => {
  test("the folder and folders under it, not its neighbours", () => {
    expect(isInside("/srv/app", ["/srv/app"])).toBe(true);
    expect(isInside("/srv/app/docker", ["/srv/app/"])).toBe(true);
    expect(isInside("/srv/app-fix", ["/srv/app"])).toBe(false);
    expect(isInside(undefined, ["/srv/app"])).toBe(false);
    expect(isInside("/srv/app", [])).toBe(false);
  });
  test("Windows paths ignore slashes and case", () => {
    expect(isInside("C:\\Users\\W\\App", ["c:/users/w/app"])).toBe(true);
  });
  test("other paths are case sensitive", () => {
    expect(isInside("/srv/App", ["/srv/app"])).toBe(false);
  });
});

describe("groupStacks", () => {
  const list = parseContainers([
    row({ ID: "1", Names: "portainer" }),
    row({ ID: "2", Names: "z-web-1", Labels: "com.docker.compose.project=zeta,com.docker.compose.service=web,com.docker.compose.project.working_dir=/srv/zeta" }),
    row({ ID: "3", Names: "b-db-1", Labels: "com.docker.compose.project=beta,com.docker.compose.service=db,com.docker.compose.project.working_dir=/srv/beta" }),
    row({ ID: "4", Names: "b-api-1", Labels: "com.docker.compose.project=beta,com.docker.compose.service=api,com.docker.compose.project.working_dir=/srv/beta" }),
    row({ ID: "5", Names: "a-web-1", Labels: "com.docker.compose.project=alpha,com.docker.compose.service=web,com.docker.compose.project.working_dir=/srv/alpha" }),
  ].join("\n"));

  test("the project's stack first, others by name, loose containers last", () => {
    const s = groupStacks(list, ["/srv/zeta"]);
    expect(s.map((x) => x.name)).toEqual(["zeta", "alpha", "beta", undefined]);
    expect(s.map((x) => x.mine)).toEqual([true, false, false, false]);
  });
  test("services sort within a stack", () => {
    expect(groupStacks(list, []).find((x) => x.name === "beta")!.containers.map((c) => c.service)).toEqual(["api", "db"]);
  });
});

describe("running goes to the top", () => {
  const stack = (s: string, svc: string) => `com.docker.compose.project=${s},com.docker.compose.service=${svc}`;
  const list = parseContainers([
    row({ ID: "1", Names: "a-web-1", State: "exited", Status: "Exited (0) 1 hour ago", Labels: stack("a", "web") }),
    row({ ID: "2", Names: "a-api-1", State: "exited", Status: "Exited (1) 1 hour ago", Labels: stack("a", "api") }),
    row({ ID: "3", Names: "a-worker-1", State: "restarting", Status: "Restarting (1) 2 seconds ago", Labels: stack("a", "worker") }),
    row({ ID: "4", Names: "a-zed-1", Labels: stack("a", "zed") }),
    row({ ID: "5", Names: "b-db-1", Labels: stack("b", "db") }),
    row({ ID: "6", Names: "loose-up" }),
    row({ ID: "7", Names: "loose-off", State: "exited", Status: "Exited (0) 1 hour ago" }),
    row({ ID: "8", Names: "c-db-1", State: "exited", Status: "Exited (0) 1 hour ago", Labels: stack("c", "db") }),
  ].join("\n"));

  test("within a stack: running, then restarting, then stopped", () => {
    expect(groupStacks(list, []).find((s) => s.name === "a")!.containers.map((c) => c.service)).toEqual(["zed", "worker", "api", "web"]);
  });
  test("loose containers sort the same way", () => {
    expect(groupStacks(list, []).find((s) => !s.name)!.containers.map((c) => c.name)).toEqual(["loose-up", "loose-off"]);
  });
  test("stacks with something running come first, a stopped one last", () => {
    expect(groupStacks(list, []).map((s) => s.name)).toEqual(["a", "b", undefined, "c"]);
  });
  test("the project's own stack stays first even when stopped", () => {
    const stopped = list.map((c) => (c.stack === "c" ? { ...c, dir: "/srv/c" } : c));
    expect(groupStacks(stopped, ["/srv/c"])[0].name).toBe("c");
  });
});

test("matchesFind looks at names, stack, image, state and ports", () => {
  const c = parseContainers(row({ Names: "acme-db-1", Image: "postgres:16", State: "exited", Status: "Exited (1) 1 hour ago", Ports: "", Labels: "com.docker.compose.project=acme,com.docker.compose.service=db" }))[0];
  const up = parseContainers(row({ Names: "web", Ports: "127.0.0.1:5433->5432/tcp" }))[0];
  for (const q of ["", "  ", "DB", "acme", "postgres", "exited", "acme postgres"]) expect(matchesFind(c, q)).toBe(true);
  for (const q of ["redis", "acme redis"]) expect(matchesFind(c, q)).toBe(false);
  expect(matchesFind(up, "5433")).toBe(true);
  expect(matchesFind(up, "5432")).toBe(true);
  expect(matchesFind(up, "5434")).toBe(false);
});

test("stoppedCleanly hides finished jobs and compose stop, not crashes", () => {
  const c = (o: Partial<ReturnType<typeof parseContainers>[0]>) => ({ ...parseContainers(row({}))[0], ...o });
  expect(stoppedCleanly(c({ phase: "exited", code: 0 }))).toBe(true);
  expect(stoppedCleanly(c({ phase: "exited", code: 143 }))).toBe(true);
  expect(stoppedCleanly(c({ phase: "exited", code: 1 }))).toBe(false);
  expect(stoppedCleanly(c({ phase: "created" }))).toBe(false);
  expect(phaseText(c({ phase: "exited", code: 1 }))).toBe("exited (1)");
});

test("rowName leaves out the first replica's number", () => {
  const c = parseContainers(row({ Names: "x", Labels: "com.docker.compose.service=web,com.docker.compose.container-number=2" }))[0];
  expect(rowName(c)).toBe("web-2");
  expect(rowName({ ...c, number: "1" })).toBe("web");
  expect(rowName({ ...c, service: undefined })).toBe("x");
});

describe("ports", () => {
  test("what a click does goes by the container's port", () => {
    expect(opensPage({ cont: 3000, proto: "tcp", host: 3000 })).toBe(true);
    expect(opensPage({ cont: 5432, proto: "tcp", host: 5433 })).toBe(false);
    expect(opensPage({ cont: 53, proto: "udp", host: 5353 })).toBe(false);
    expect(opensPage({ cont: 3000, proto: "udp", host: 3000 })).toBe(false);
  });
  test("addresses", () => {
    expect(localAddr({ cont: 1, proto: "tcp", bind: "0.0.0.0" })).toBe("localhost");
    expect(localAddr({ cont: 1, proto: "tcp", bind: "192.168.1.5" })).toBe("192.168.1.5");
    expect(tunnelTarget({ cont: 1, proto: "tcp", bind: "0.0.0.0" })).toBe("127.0.0.1");
    expect(tunnelTarget({ cont: 1, proto: "tcp", bind: "10.0.0.2" })).toBe("10.0.0.2");
    expect(portUrl({ cont: 443, proto: "tcp" }, "localhost", 8443)).toBe("https://localhost:8443");
    expect(portUrl({ cont: 80, proto: "tcp" }, "localhost", 53012)).toBe("http://localhost:53012");
  });
});

describe("log lines", () => {
  test("a compose line has a prefix and a timestamp", () => {
    expect(parseLogLine("api-1  | 2026-11-03T10:00:00.123456789Z GET / 200", true)).toEqual({ prefix: "api-1", stamp: "2026-11-03T10:00:00.123456789Z", text: "GET / 200" });
  });
  test("a container line has only a timestamp, even with a pipe in it", () => {
    expect(parseLogLine("2026-11-03T10:00:00Z a | b", false)).toEqual({ prefix: undefined, stamp: "2026-11-03T10:00:00Z", text: "a | b" });
  });
  test("a line with neither stays whole", () => {
    expect(parseLogLine("no configuration file provided", true).text).toBe("no configuration file provided");
  });
  test("colours are stripped", () => {
    expect(stripAnsi("\u001b[32mok\u001b[0m")).toBe("ok");
    expect(parseLogLine("\u001b[36mapi-1  |\u001b[0m 2026-11-03T10:00:00Z hi", true).prefix).toBe("api-1");
  });
  test("levels", () => {
    expect(levelOf("ERROR connect refused")).toBe("bad");
    expect(levelOf('{"level":"error","msg":"x"}')).toBe("bad");
    expect(levelOf("level=fatal msg=x")).toBe("bad");
    expect(levelOf("WARNING: disk")).toBe("warn");
    expect(levelOf("level=warn x")).toBe("warn");
    expect(levelOf("GET /errors 200")).toBe("info");
    expect(levelOf("build finished with 0 errors")).toBe("info");
    expect(levelOf("terrorist")).toBe("info");
  });
  test("an indented line continues the error above it", () => {
    expect(withLevel({ text: "    at foo (a.js:1)" }, "bad").level).toBe("bad");
    expect(withLevel({ text: "    at foo (a.js:1)" }, "info").level).toBe("info");
    expect(withLevel({ text: "next line" }, "bad").level).toBe("info");
  });
  test("a compose prefix finds its container", () => {
    const list = parseContainers([
      row({ ID: "1", Names: "x-api-1", Labels: "com.docker.compose.service=api,com.docker.compose.container-number=1" }),
      row({ ID: "2", Names: "custom", Labels: "com.docker.compose.service=db,com.docker.compose.container-number=1" }),
    ].join("\n"));
    expect(containerOfPrefix("api-1", list)?.id).toBe("1");
    expect(containerOfPrefix("custom", list)?.id).toBe("2");
    expect(containerOfPrefix("gone-1", list)).toBeUndefined();
  });
});

test("parseEvent reads the action and exit code", () => {
  expect(parseEvent('{"status":"die","id":"x","Type":"container","Action":"die","Actor":{"ID":"x","Attributes":{"exitCode":"1","name":"app-web-1"}}}')).toEqual({ name: "app-web-1", action: "die", code: 1 });
  expect(parseEvent("not json")).toBeUndefined();
});

test("failureOf says why docker didn't answer", () => {
  expect(failureOf("docker: command not found")).toBe("missing");
  expect(failureOf("bash: line 1: docker: command not found")).toBe("missing");
  expect(failureOf("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")).toBe("down");
  expect(failureOf("error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.")).toBe("down");
  expect(failureOf("permission denied while trying to connect to the Docker daemon socket")).toBe("other");
  expect(failureOf("devbox: ssh failed")).toBe("other");
});
