#!/usr/bin/env node
// tri-code's MCP server for agent windows: lets the agent in a tri-code terminal open, read and
// type into, wait on and close the terminal windows of its own project. It speaks MCP over stdio
// with no dependencies. tri-code sets TRICODE_URL and TRICODE_TOKEN in every terminal; the
// endpoint (src-tauri/src/agent_windows.rs) decides what the token may see.

const URL_BASE = process.env.TRICODE_URL;
const TOKEN = process.env.TRICODE_TOKEN;

const WINDOW = { type: "string", description: "The window id, from open_window or list_windows." };

const TOOLS = [
  {
    name: "open_window",
    description:
      "Open a terminal window in this project from one of its Commands that is allowed for agents, such as a dev server. Returns the window id. The window runs in the project folder.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The Command's name, as the Commands window shows it." } },
      required: ["command"],
    },
  },
  {
    name: "list_windows",
    description: "List the terminal windows of this project, including this one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "status",
    description: "Show one window's name and who opened it.",
    inputSchema: { type: "object", properties: { window: WINDOW }, required: ["window"] },
  },
  {
    name: "read",
    description: "Read the last lines of a window's output.",
    inputSchema: {
      type: "object",
      properties: { window: WINDOW, lines: { type: "number", description: "How many lines (default 40, max 2000)." } },
      required: ["window"],
    },
  },
  {
    name: "send",
    description: "Type text into a window. Enter is pressed after it unless enter is false.",
    inputSchema: {
      type: "object",
      properties: { window: WINDOW, text: { type: "string" }, enter: { type: "boolean", description: "Press Enter after the text (default true)." } },
      required: ["window", "text"],
    },
  },
  {
    name: "wait_for",
    description:
      "Wait until a window prints text that contains the pattern, such as 'ready on', or until the timeout. Only output that arrives after the call counts.",
    inputSchema: {
      type: "object",
      properties: {
        window: WINDOW,
        pattern: { type: "string", description: "Text to look for." },
        timeout_secs: { type: "number", description: "Seconds to wait (default 60, max 300)." },
      },
      required: ["window", "pattern"],
    },
  },
  {
    name: "close_window",
    description: "Close a window that an agent opened. Windows you opened are not closed by agents.",
    inputSchema: { type: "object", properties: { window: WINDOW }, required: ["window"] },
  },
];

async function api(method, path, body) {
  if (!URL_BASE || !TOKEN) throw new Error("not in a tri-code terminal: TRICODE_URL and TRICODE_TOKEN are not set");
  const res = await fetch(`${URL_BASE}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `tri-code answered ${res.status}`);
  return data;
}

const win = (args) => encodeURIComponent(args.window);

async function run(name, args) {
  switch (name) {
    case "open_window": {
      const r = await api("POST", "/windows", { command: args.command });
      return `opened ${r.name} as window ${r.window}`;
    }
    case "list_windows": {
      const r = await api("GET", "/windows");
      return r.windows.length ? r.windows.map((w) => `${w.window}  ${w.name}  (opened by ${w.by})`).join("\n") : "no windows";
    }
    case "status": {
      const r = await api("GET", `/windows/${win(args)}`);
      return `${r.name} · window ${r.window} · opened by ${r.by}`;
    }
    case "read": {
      const q = args.lines ? `?lines=${Number(args.lines)}` : "";
      const r = await api("GET", `/windows/${win(args)}/output${q}`);
      return r.output || "(no output yet)";
    }
    case "send": {
      await api("POST", `/windows/${win(args)}/input`, { text: args.text, enter: args.enter ?? true });
      return "sent";
    }
    case "wait_for": {
      const r = await api("POST", `/windows/${win(args)}/wait`, { pattern: args.pattern, timeout_secs: args.timeout_secs });
      return `${r.matched ? "matched" : "timed out without a match"}\n${r.output}`;
    }
    case "close_window": {
      await api("DELETE", `/windows/${win(args)}`);
      return "closed";
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // a notification: nothing to answer
  try {
    let result;
    if (method === "initialize") {
      result = {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tri-code", version: "0.1.0" },
      };
    } else if (method === "ping") {
      result = {};
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      try {
        const text = await run(params.name, params.arguments ?? {});
        result = { content: [{ type: "text", text }] };
      } catch (e) {
        // A failed tool call is a result the agent can read, not a protocol error.
        result = { content: [{ type: "text", text: e.message }], isError: true };
      }
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${method}` } });
      return;
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    void handle(msg);
  }
});
