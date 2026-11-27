// TEMPORARY: dev-only self-test of Export PDF. Removed before commit.
import { invoke } from "@tauri-apps/api/core";
import { enhance, renderMarkdown, titleOf } from "../shared/text/markdown";
import { printDocument } from "../modules/editor";

const SRC = `---
title: Release 2.4
author: Docs team
---

# Release 2.4 :rocket:

The sync engine now batches writes[^1]. :tada: but not in \`:code:\`.

> [!NOTE]
> Upgrading keeps every existing config.

> [!WARNING]
> The \`--legacy\` flag is gone.

## How a write flows

\`\`\`mermaid
flowchart LR
  A[Client] --> B{Batch?}
  B -- yes --> C[Queue]
  B -- no --> D[(Store)]
  C --> D
\`\`\`

## Throughput

With batch size $b$ and latency $\\ell$, costs $5 and $6:

$$
T = \\frac{b}{\\ell + b\\,c} \\quad\\text{writes/s}
$$

| Batch | Before | After |
|------:|-------:|------:|
| 1     | 410/s  | 420/s |
| 64    | 410/s  | 9.8k/s |

![dot](img/dot.png)

\`\`\`mermaid
this is not mermaid
\`\`\`

[^1]: Up to 64 writes or 5 ms.
`;

const DOT = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="orange"/></svg>');

export async function selftest(out: string) {
  const log: string[] = [];
  try {
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(SRC);
    const t0 = performance.now();
    await enhance(el, async () => DOT, { dark: false });
    log.push(`enhance ${Math.round(performance.now() - t0)}ms`);
    log.push(`mermaid svgs: ${el.querySelectorAll(".mermaid svg").length}, errors: ${el.querySelectorAll(".mermaid-error").length}`);
    log.push(`math: ${el.querySelectorAll("math").length}, alerts: ${el.querySelectorAll(".alert").length}, emoji rocket: ${el.innerHTML.includes("🚀")}`);
    const css = "h1 { color: #c2410c; border-bottom: 3px solid #c2410c; } h2 { color: #9a3412; }";
    const html = printDocument(el.innerHTML, { css, page: "A4", margin: 18 }, titleOf(SRC));
    await invoke("config_write", { path: `${out}\\selftest.html`, json: html });
    const t1 = performance.now();
    const ok = await invoke("md_pdf", { html, path: `${out}\\selftest.pdf` });
    log.push(`md_pdf ${ok} ${Math.round(performance.now() - t1)}ms`);
  } catch (e) {
    log.push(`FAILED: ${e instanceof Error ? e.stack : e}`);
  }
  await invoke("config_write", { path: `${out}\\selftest.log`, json: log.join("\n") });
}
