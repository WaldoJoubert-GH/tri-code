// bun test: Markdown rendering before sanitising (markdown.ts). The DOM half (enhance) needs a webview.

import { describe, expect, test } from "bun:test";
import { alerts, splitFrontMatter, titleOf, toHtml } from "./markdown";

describe("front matter", () => {
  test("becomes rows, and the body follows it", () => {
    const { rows, body } = splitFrontMatter("---\ntitle: \"Release 2.4\"\ntags:\n  - a\n  - b\ndraft:\n---\n# Hi\n");
    expect(rows).toEqual([["title", "Release 2.4"], ["tags", "- a\n- b"], ["draft", ""]]);
    expect(body).toBe("# Hi\n");
  });
  test("only at the very start", () => {
    expect(splitFrontMatter("# Hi\n\n---\na: b\n---\n").rows).toEqual([]);
  });
  test("is drawn as a table", () => {
    expect(toHtml("---\na: <b>\n---\nx")).toContain('<table class="frontmatter"><tbody><tr><th>a</th><td>&lt;b&gt;</td></tr>');
  });
});

describe("alerts", () => {
  test("a marker line starts an alert", () => {
    const html = toHtml("> [!NOTE]\n> Keep it.\n");
    expect(html).toContain('<blockquote class="alert alert-note"><p class="alert-title">Note</p><p>Keep it.</p>');
  });
  test("a marker alone in its paragraph leaves no empty one", () => {
    const html = toHtml("> [!caution]\n>\n> Gone.\n");
    expect(html).toContain('<p class="alert-title">Caution</p>\n<p>Gone.</p>');
    expect(html).not.toContain("<p></p>");
  });
  test("other quotes and unknown markers stay quotes", () => {
    expect(alerts("<blockquote>\n<p>[!FOO] x</p>")).toBe("<blockquote>\n<p>[!FOO] x</p>");
    expect(toHtml("> plain\n")).toContain("<blockquote>\n<p>plain</p>");
  });
});

describe("math", () => {
  test("inline needs no space inside the dollars", () => {
    expect(toHtml("Inline $a^2$ here.")).toContain('<span class="math" data-tex="a^2"></span>');
    expect(toHtml("It costs $5 and $6 today.")).not.toContain("math");
    expect(toHtml("Spaced $ a $ stays.")).not.toContain("math");
  });
  test("not inside code", () => {
    expect(toHtml("`$a$`")).toContain("<code>$a$</code>");
  });
  test("display math on its own lines", () => {
    expect(toHtml("$$\nT = \\frac{b}{c}\n$$\n")).toContain('<div class="math-block" data-tex="T = \\frac{b}{c}"></div>');
  });
  test("escapes what it carries", () => {
    expect(toHtml('$a<b"$')).toContain('data-tex="a&lt;b&quot;"');
  });
});

describe("mermaid", () => {
  test("a mermaid fence is kept as source for enhance", () => {
    expect(toHtml("```mermaid\nflowchart LR\n A-->B\n```\n")).toContain('<pre class="mermaid-src"><code>flowchart LR\n A--&gt;B</code></pre>');
  });
  test("other fences are unchanged", () => {
    expect(toHtml("```ts\nlet a\n```\n")).toContain('<pre><code class="language-ts">let a');
  });
});

test("footnotes", () => {
  const html = toHtml("Hi[^1].\n\n[^1]: Note.\n");
  expect(html).toContain('href="#footnote-1"');
  expect(html).toContain('<section class="footnotes"');
});

test("title: front matter first, then the first heading", () => {
  expect(titleOf("---\ntitle: Doc\n---\n# Other\n")).toBe("Doc");
  expect(titleOf("intro\n\n## Sub ##\n")).toBe("Sub");
  expect(titleOf("nothing")).toBe("");
});
