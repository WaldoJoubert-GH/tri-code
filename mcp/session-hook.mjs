#!/usr/bin/env node
// Claude's SessionStart hook, added to tri-code's own launches with --settings (src-tauri/src/resume.rs).
// Reports the session id to tri-code so the tab can reopen this conversation after a restart. It reads
// the hook's JSON on stdin. A failure here must never get in Claude's way, so it always exits 0 quietly.

const url = process.env.TRICODE_URL;
const token = process.env.TRICODE_TOKEN;

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

try {
  const { session_id: id } = JSON.parse(input);
  if (url && token && id) {
    await fetch(`${url}/v1/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "claude", id }),
      signal: AbortSignal.timeout(3000),
    });
  }
} catch {
  // Not in a tri-code terminal, or tri-code is closed: the tab keeps the id it had.
}
process.exit(0);
