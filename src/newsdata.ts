// The News Window's data and its pure parts: merging a fetch into what was kept, finding an item's
// picture, choosing a feed's icon from a page's <link>s. The fetching is news.ts's, the commands
// src-tauri/src/news.rs's.

// The feed type lives in state.ts, which persists it; re-exported for the news files.
export type { NewsFeed } from "./state";

/** One item as the Rust side returns it. */
export type RawItem = { id: string; title: string; link: string; html: string; image?: string | null; published: number; author?: string | null };

export type NewsItem = {
  id: string;
  title: string;
  link: string;
  html: string;
  /** The picture shown beside the headline and over the text. */
  image?: string;
  /** Unix ms: the feed's date, else when tri-code first saw it. */
  at: number;
  author?: string;
  /** The article's page was read for a picture (its og:image) and had none: don't look again. */
  noImage?: true;
};

/** What a fetch tells about a feed besides its items. */
export type FeedMeta = { etag?: string; modified?: string; fetched?: number; error?: string };

/** What news.json holds: items by feed id, read item keys, and each feed's last fetch. */
export type NewsCache = { items: Record<string, NewsItem[]>; read: string[]; meta: Record<string, FeedMeta> };

/** Items kept per feed, newest first; older ones drop off. */
export const KEEP = 150;

export const TOPICS = ["World", "Local", "Tech", "Business", "Science", "Other"];


export const emptyCache = (): NewsCache => ({ items: {}, read: [], meta: {} });

/** The key an item is marked read by. Item ids are only unique within their feed. */
export const readKey = (feedId: string, itemId: string) => `${feedId}\n${itemId}`;

/** `url` made absolute against `base`, or "" when it can't be. */
export function absolute(url: string, base: string): string {
  try {
    const u = new URL(url.trim(), base || undefined);
    return /^https?:$/.test(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  const k = e.toLowerCase();
  if (k in ENTITIES) return ENTITIES[k];
  if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
  if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
  return m;
});

/** The text of some HTML, for a headline or a one-line excerpt. */
export const plain = (html: string) => decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** Pictures not worth showing: tracking pixels, share buttons, emoji, feed-service badges. */
function isJunkImage(tag: string, src: string): boolean {
  const dim = (a: string) => Number(tag.match(new RegExp(`\\b${a}\\s*=\\s*["']?(\\d+)`, "i"))?.[1] ?? NaN);
  if (dim("width") <= 2 || dim("height") <= 2) return true;
  return /feedburner|feedsportal|doubleclick|pixel|tracking|\/emoji\/|gravatar|share[-_]?button|\.gif(\?|$)/i.test(src);
}

/** The first real <img> in an item's HTML, made absolute against the item's link. */
export function firstImage(html: string, base: string): string | undefined {
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = tag.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const raw = src ? decode(src[2] ?? src[3] ?? src[4] ?? "") : "";
    const url = raw && absolute(raw, base);
    if (url && !isJunkImage(tag, url)) return url;
  }
  return undefined;
}

/** A fetched item in the window's shape: its picture found, its date settled. `seen` is when this
 *  item was first fetched, for feeds without dates. */
export function toItem(r: RawItem, base: string, seen: number): NewsItem {
  const link = absolute(r.link, base) || r.link;
  const image = (r.image && absolute(r.image, link || base)) || firstImage(r.html, link || base);
  return {
    id: r.id || link || r.title,
    title: plain(r.title) || "(untitled)",
    link,
    html: r.html,
    ...(image ? { image } : {}),
    at: r.published || seen,
    ...(r.author ? { author: r.author } : {}),
  };
}

/** What was kept for a feed, updated by a fetch: new and changed items replace their old copy
 *  (keeping its first-seen date when the feed gives none), the rest stay, newest first, KEEP at most. */
export function merge(kept: NewsItem[], fetched: RawItem[], base: string, now: number): NewsItem[] {
  const old = new Map(kept.map((i) => [i.id, i]));
  const fresh = fetched.map((r) => {
    const i = toItem(r, base, now);
    const was = old.get(i.id);
    if (!was) return i;
    return {
      ...i,
      ...(!r.published ? { at: was.at } : {}),
      // A picture found on the article's page outlives the next fetch.
      ...(!i.image && was.image ? { image: was.image } : {}),
      ...(!i.image && was.noImage ? { noImage: true as const } : {}),
    };
  });
  const ids = new Set(fresh.map((i) => i.id));
  return [...fresh, ...kept.filter((i) => !ids.has(i.id))].sort((a, b) => b.at - a.at).slice(0, KEEP);
}

/** Drop read marks for items no longer kept, so the list doesn't grow forever. */
export function pruneRead(cache: NewsCache): string[] {
  const live = new Set(Object.entries(cache.items).flatMap(([f, items]) => items.map((i) => readKey(f, i.id))));
  return cache.read.filter((k) => live.has(k));
}

/** A `<link>` from a page's head, as news.ts reads it. */
export type HeadLink = { rel: string; href: string; type?: string; sizes?: string };

/** How good an icon link is: a sized PNG or SVG near 64px beats a 16px .ico; apple-touch-icon is
 *  180px and always square. 0 means not an icon. */
export function iconScore(l: HeadLink): number {
  const rel = l.rel.toLowerCase().split(/\s+/);
  if (!rel.some((r) => r === "icon" || r === "apple-touch-icon" || r === "apple-touch-icon-precomposed")) return 0;
  if (rel.includes("mask-icon")) return 0;
  const size = Math.max(0, ...(l.sizes ?? "").split(/\s+/).map((s) => (s === "any" ? 64 : parseInt(s, 10) || 0)));
  const svg = /svg/i.test(l.type ?? "") || /\.svg(\?|$)/i.test(l.href);
  const touch = rel.some((r) => r.startsWith("apple-touch-icon"));
  const px = svg ? 64 : size || (touch ? 180 : 16);
  // Closest to 64px wins; a bigger one scales down better than a smaller one scales up.
  return 1000 - Math.abs(64 - px) * (px < 64 ? 3 : 1);
}

/** The best icon a page declares, absolute, or undefined. */
export function bestIcon(links: HeadLink[], base: string): string | undefined {
  return links
    .map((l) => ({ l, s: iconScore(l), href: absolute(l.href, base) }))
    .filter((x) => x.s > 0 && x.href)
    .sort((a, b) => b.s - a.s)[0]?.href;
}

/** A `<meta>` from a page's head: its property or name, and content. */
export type HeadMeta = { key: string; content: string };

/** The picture a page shares itself with (og:image, else twitter:image), absolute. */
export function pageImage(metas: HeadMeta[], base: string): string | undefined {
  for (const key of ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]) {
    const m = metas.find((x) => x.key.toLowerCase() === key && x.content.trim());
    const url = m && absolute(m.content, base);
    if (url) return url;
  }
  return undefined;
}

const FEED_TYPES =/application\/(rss|atom|feed)\+(xml|json)|application\/(rss|atom)$/i;

/** The feeds a page offers (`<link rel="alternate" type="application/rss+xml">`), absolute. */
export function feedLinks(links: HeadLink[], base: string): string[] {
  return links
    .filter((l) => l.rel.toLowerCase().split(/\s+/).includes("alternate") && FEED_TYPES.test(l.type ?? ""))
    .map((l) => absolute(l.href, base))
    .filter(Boolean);
}

/** "now", "12m", "3h", "2d", then a date. */
export function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h`;
  if (m < 7 * 24 * 60) return `${Math.floor(m / 1440)}d`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A new feed's id from its address, unique among `taken`. */
export function feedId(url: string, taken: string[]): string {
  let base = "feed";
  try {
    base = new URL(url).host.replace(/^(www|feeds?|rss)\./, "").split(".")[0] || base;
  } catch {
    /* keep "feed" */
  }
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}
