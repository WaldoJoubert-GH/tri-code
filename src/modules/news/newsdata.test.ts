import { describe, expect, test } from "bun:test";
import { KEEP, ago, bestIcon, feedId, feedLinks, firstImage, merge, pageImage, plain, pruneRead, readKey, toItem, type RawItem } from "./newsdata";

const raw = (id: string, more: Partial<RawItem> = {}): RawItem => ({ id, title: `T ${id}`, link: `https://x.example/${id}`, html: "", published: 0, ...more });

describe("firstImage", () => {
  test("takes the first real picture, made absolute", () => {
    const html = `<p><img src="/px.gif" width="1" height="1"><img alt="x" src='/img/a.jpg?w=600'></p>`;
    expect(firstImage(html, "https://x.example/post/1")).toBe("https://x.example/img/a.jpg?w=600");
  });
  test("skips tracking pixels and feed badges", () => {
    expect(firstImage(`<img src="https://feeds.feedburner.com/~r/x.png">`, "https://x.example/")).toBeUndefined();
    expect(firstImage(`<img src="https://x.example/a.png" height="1">`, "https://x.example/")).toBeUndefined();
  });
  test("decodes entities in the address", () => {
    expect(firstImage(`<img src="https://x.example/a.jpg?w=1&amp;h=2">`, "")).toBe("https://x.example/a.jpg?w=1&h=2");
  });
  test("none", () => expect(firstImage("<p>words</p>", "https://x.example/")).toBeUndefined());
});

describe("toItem", () => {
  test("the feed's picture wins over one in the text", () => {
    const i = toItem(raw("a", { image: "https://cdn.example/hero.jpg", html: `<img src="https://x.example/b.jpg">` }), "https://x.example/", 5);
    expect(i.image).toBe("https://cdn.example/hero.jpg");
  });
  test("falls back to the text's picture, relative to the item link", () => {
    const i = toItem(raw("a", { link: "https://x.example/post/a", html: `<img src="pic.png">` }), "https://x.example/", 5);
    expect(i.image).toBe("https://x.example/post/pic.png");
  });
  test("plain headline, undated item takes when it was seen", () => {
    const i = toItem(raw("a", { title: "Rates &amp; <b>markets</b>" }), "", 42);
    expect(i.title).toBe("Rates & markets");
    expect(i.at).toBe(42);
  });
});

describe("merge", () => {
  test("new items join, old ones stay, newest first", () => {
    const kept = merge([], [raw("a", { published: 100 })], "", 0);
    const next = merge(kept, [raw("b", { published: 200 })], "", 0);
    expect(next.map((i) => i.id)).toEqual(["b", "a"]);
  });
  test("an undated item keeps its first-seen time across fetches", () => {
    const kept = merge([], [raw("a")], "", 1000);
    expect(merge(kept, [raw("a", { title: "edited" })], "", 9000)[0]).toMatchObject({ at: 1000, title: "edited" });
  });
  test("a picture found on the article's page survives the next fetch", () => {
    const kept = [{ ...merge([], [raw("a")], "", 0)[0], image: "https://x.example/og.jpg" }];
    expect(merge(kept, [raw("a")], "", 5)[0].image).toBe("https://x.example/og.jpg");
  });
  test("keeps at most KEEP", () => {
    const many = Array.from({ length: KEEP + 20 }, (_, n) => raw(String(n), { published: n }));
    const out = merge([], many, "", 0);
    expect(out.length).toBe(KEEP);
    expect(out[0].id).toBe(String(KEEP + 19));
  });
});

test("pruneRead drops marks of items no longer kept", () => {
  const items = { f: merge([], [raw("a")], "", 0) };
  expect(pruneRead({ items, read: [readKey("f", "a"), readKey("f", "gone")], meta: {} })).toEqual([readKey("f", "a")]);
});

describe("icons", () => {
  test("a 180px apple-touch-icon beats a 16px favicon; svg beats both", () => {
    const base = "https://x.example/news/";
    expect(bestIcon([{ rel: "icon", href: "/favicon.ico" }, { rel: "apple-touch-icon", href: "/apple.png" }], base)).toBe("https://x.example/apple.png");
    expect(bestIcon([{ rel: "shortcut icon", href: "/f.ico" }, { rel: "icon", href: "/i.svg", type: "image/svg+xml" }, { rel: "apple-touch-icon", href: "/a.png" }], base)).toBe("https://x.example/i.svg");
  });
  test("sizes near 64 win", () => {
    const l = [{ rel: "icon", href: "/16.png", sizes: "16x16" }, { rel: "icon", href: "/48.png", sizes: "48x48" }, { rel: "icon", href: "/512.png", sizes: "512x512" }];
    expect(bestIcon(l, "https://x.example/")).toBe("https://x.example/48.png");
  });
  test("mask-icon and stylesheets are not icons", () => {
    expect(bestIcon([{ rel: "mask-icon", href: "/m.svg" }, { rel: "stylesheet", href: "/s.css" }], "https://x.example/")).toBeUndefined();
  });
});

test("feedLinks finds RSS, Atom and JSON feeds a page offers", () => {
  const links = [
    { rel: "alternate", href: "/rss.xml", type: "application/rss+xml" },
    { rel: "alternate", href: "https://x.example/atom", type: "application/atom+xml" },
    { rel: "alternate", href: "/fr", type: "text/html" },
    { rel: "alternate", href: "/feed.json", type: "application/feed+json" },
  ];
  expect(feedLinks(links, "https://x.example/")).toEqual(["https://x.example/rss.xml", "https://x.example/atom", "https://x.example/feed.json"]);
});

test("pageImage prefers og:image over twitter:image, made absolute", () => {
  const metas = [{ key: "twitter:image", content: "https://x.example/t.jpg" }, { key: "og:image", content: "/og.jpg" }, { key: "og:title", content: "x" }];
  expect(pageImage(metas, "https://x.example/a/b")).toBe("https://x.example/og.jpg");
  expect(pageImage([{ key: "og:image", content: " " }], "https://x.example/")).toBeUndefined();
});

test("plain", () => expect(plain("<p>a&nbsp;<i>b</i></p><script>x</script>&#8217;")).toBe("a b ’"));

test("ago", () => {
  const now = 10 * 86_400_000;
  expect(ago(now, now)).toBe("now");
  expect(ago(now - 5 * 60_000, now)).toBe("5m");
  expect(ago(now - 3 * 3_600_000, now)).toBe("3h");
  expect(ago(now - 2 * 86_400_000, now)).toBe("2d");
});

test("feedId", () => {
  expect(feedId("https://feeds.bbci.co.uk/news/rss.xml", [])).toBe("bbci");
  expect(feedId("https://www.theverge.com/rss", ["theverge"])).toBe("theverge-2");
});
