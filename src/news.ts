// The News Window's feeds and items: the list in state.json (`app.feeds`), the items and read marks
// in news.json, fetching on a timer while a News Window is open. Commands are in
// src-tauri/src/news.rs, the pure parts in newsdata.ts.

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { type Project, addTab, app, focusTab, setApp } from "./state";
import { guessIcon, originOf } from "./favicons";
import {
  type FeedMeta, type HeadLink, type HeadMeta, type NewsCache, type NewsFeed, type NewsItem, type RawItem,
  TOPICS, bestIcon, emptyCache, feedId, feedLinks, merge, pageImage, pruneRead, readKey,
} from "./newsdata";

/** How often open News Windows fetch every feed. */
const EVERY = 15 * 60_000;
/** Opening a News Window fetches feeds older than this. */
const STALE = 5 * 60_000;

type Fetched = { same: boolean; etag?: string | null; modified?: string | null; title: string; site?: string | null; icon?: string | null; logo?: string | null; items: RawItem[] };
type Page = { url: string; html: string };

/** Open or focus the project's News Window. */
export function openNewsPanel(project: Project): string {
  const existing = project.tabs.find((t) => t.kind === "news");
  const id = existing?.id ?? addTab(project.id, "news");
  focusTab(project.id, id);
  return id;
}

// ── feeds (state.json) ─────────────────────────────────────────────

export const feeds = (): NewsFeed[] => app.feeds ?? [];
export const feedById = (id: string) => feeds().find((f) => f.id === id);

function editFeeds(fn: (fs: NewsFeed[]) => void) {
  if (!app.feeds) setApp("feeds", []);
  setApp("feeds", produce((fs) => fn(fs!)));
}

// ── topics (state.json, Settings › News) ───────────────────────────

/** The topics feeds list under, in order. */
export const topics = (): string[] => (app.newsTopics?.length ? app.newsTopics : TOPICS);

/** Store the topic list: trimmed, no repeats, unset again when it is the default. */
function setTopics(list: string[]) {
  const clean = [...new Set(list.map((t) => t.trim()).filter(Boolean))];
  const same = clean.length === TOPICS.length && clean.every((t, i) => t === TOPICS[i]);
  setApp("newsTopics", same || !clean.length ? undefined : clean);
}

/** Add a topic at the end. False when it is blank or already there. */
export function newTopic(name: string): boolean {
  const t = name.trim();
  if (!t || topics().includes(t)) return false;
  setTopics([...topics(), t]);
  return true;
}

/** Rename a topic, its feeds with it; renaming onto another topic joins the two. */
export function renameTopic(from: string, to: string) {
  const t = to.trim();
  if (!t || t === from) return;
  setTopics(topics().map((x) => (x === from ? t : x)));
  if (feeds().some((f) => f.topic === from)) editFeeds((fs) => fs.forEach((f) => { if (f.topic === from) f.topic = t; }));
}

/** Remove a topic; its feeds move to the first topic left. The last topic can't go. */
export function removeTopic(name: string) {
  const left = topics().filter((t) => t !== name);
  if (!left.length) return;
  setTopics(left);
  if (feeds().some((f) => f.topic === name)) editFeeds((fs) => fs.forEach((f) => { if (f.topic === name) f.topic = left[0]; }));
}

/** Move a topic up (-1) or down (+1) the list. */
export function shiftTopic(name: string, by: number) {
  const list = [...topics()];
  const i = list.indexOf(name);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  setTopics(list);
}

/** Back to the default topics. Feeds under a topic that is gone keep it, listed after the rest. */
export const resetTopics = () => setApp("newsTopics", undefined);

export function updateFeed(id: string, patch: Partial<Omit<NewsFeed, "id">>) {
  editFeeds((fs) => {
    const f = fs.find((x) => x.id === id);
    if (!f) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (f as Record<string, unknown>)[k];
      else (f as Record<string, unknown>)[k] = v;
    }
  });
}

export function removeFeed(id: string) {
  editFeeds((fs) => {
    const i = fs.findIndex((f) => f.id === id);
    if (i >= 0) fs.splice(i, 1);
  });
  setNews(produce((s) => {
    delete s.items[id];
    delete s.meta[id];
    for (const k of Object.keys(s.read)) if (k.startsWith(id + "\n")) delete s.read[k];
  }));
  save();
}

// ── items (news.json) ──────────────────────────────────────────────

type Store = { items: Record<string, NewsItem[]>; read: Record<string, true>; meta: Record<string, FeedMeta>; busy: Record<string, true> };
const [news, setNews] = createStore<Store>({ items: {}, read: {}, meta: {}, busy: {} });
export { news };

const [loaded, setLoaded] = createSignal(false);
export { loaded };

let loading: Promise<void> | undefined;
function load(): Promise<void> {
  loading ??= invoke<string | null>("news_load")
    .then((json) => {
      const c: NewsCache = json ? { ...emptyCache(), ...JSON.parse(json) } : emptyCache();
      setNews({ items: c.items, meta: c.meta, read: Object.fromEntries(c.read.map((k) => [k, true as const])) });
    })
    .catch((e) => console.warn("news_load failed:", e))
    .finally(() => setLoaded(true));
  return loading;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const cache: NewsCache = { items: news.items, read: Object.keys(news.read), meta: news.meta };
    cache.read = pruneRead(cache);
    invoke("news_save", { json: JSON.stringify(cache) }).catch((e) => console.warn("news_save failed:", e));
  }, 800);
}

export const isRead = (feedId: string, itemId: string) => !!news.read[readKey(feedId, itemId)];

export function setRead(feedId: string, itemId: string, read = true) {
  const k = readKey(feedId, itemId);
  if (!!news.read[k] === read) return;
  setNews("read", produce((r) => {
    if (read) r[k] = true;
    else delete r[k];
  }));
  save();
}

export function markAllRead(items: { feed: string; item: NewsItem }[]) {
  setNews("read", produce((r) => {
    for (const { feed, item } of items) r[readKey(feed, item.id)] = true;
  }));
  save();
}

export const unreadOf = (feedId: string) => (news.items[feedId] ?? []).filter((i) => !news.read[readKey(feedId, i.id)]).length;

// ── icons ──────────────────────────────────────────────────────────

/** The `<link>`s in a page's head. */
function headLinks(html: string): HeadLink[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("link[rel][href]")].map((l) => ({
    rel: l.getAttribute("rel") ?? "",
    href: l.getAttribute("href") ?? "",
    type: l.getAttribute("type") ?? undefined,
    sizes: l.getAttribute("sizes") ?? undefined,
  }));
}

/** The `<meta property|name content>`s in a page's head. */
function headMetas(html: string): HeadMeta[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("meta[content]")].map((m) => ({
    key: m.getAttribute("property") ?? m.getAttribute("name") ?? "",
    content: m.getAttribute("content") ?? "",
  }));
}

/** The best icon a site declares: on `site`, else on the home page of each fallback address
 *  (a feed's "site" link is sometimes another feed). Else the first one's /favicon.ico. */
async function siteIcon(site: string, ...more: string[]): Promise<string | undefined> {
  const tried = new Set<string>();
  for (const url of [site, ...more.map(originOf)]) {
    if (!url || tried.has(url)) continue;
    tried.add(url);
    try {
      const page = await invoke<Page>("news_page", { url });
      const icon = bestIcon(headLinks(page.html), page.url);
      if (icon) return icon;
    } catch {
      /* try the next */
    }
  }
  return guessIcon(site) || undefined;
}

/** Find a feed's icon once and remember it on the feed. The feed's own <icon> wins, then the
 *  site's declared icon. Only looked for while the feed has none. */
async function rememberIcon(f: NewsFeed, got: Fetched) {
  const site = got.site || f.site || originOf(f.url);
  const patch: Partial<NewsFeed> = {};
  if (got.site && got.site !== f.site) patch.site = got.site;
  if (got.logo && got.logo !== f.logo) patch.logo = got.logo;
  if (!f.icon) {
    const icon = got.icon || (site ? await siteIcon(site, f.url) : undefined);
    if (icon) patch.icon = icon;
  }
  if (Object.keys(patch).length) updateFeed(f.id, patch);
}

/** Look for a feed's icon again (its remembered one stopped loading). */
export async function refindIcon(id: string) {
  const f = feedById(id);
  if (!f) return;
  const icon = await siteIcon(f.site || originOf(f.url), f.url);
  updateFeed(id, { icon: icon && icon !== f.icon ? icon : undefined });
}

// ── article pictures ───────────────────────────────────────────────

const looking = new Set<string>();

/** An item the feed gave no picture: read its article's page for the picture it shares itself
 *  with (og:image), and remember it on the item, or that there is none. Once per item. */
export async function findArticleImage(feedId: string, itemId: string) {
  const k = readKey(feedId, itemId);
  const item = news.items[feedId]?.find((i) => i.id === itemId);
  if (!item || item.image || item.noImage || !item.link || looking.has(k)) return;
  looking.add(k);
  let image: string | undefined;
  try {
    const page = await invoke<Page>("news_page", { url: item.link });
    image = pageImage(headMetas(page.html), page.url);
  } catch {
    // Unreachable now isn't "has none": try again next time it's opened.
    looking.delete(k);
    return;
  }
  setNews("items", feedId, (i) => i.id === itemId, image ? { image } : { noImage: true });
  save();
  looking.delete(k);
}

// ── fetching ───────────────────────────────────────────────────────

async function fetchFeed(f: NewsFeed): Promise<void> {
  if (news.busy[f.id]) return;
  setNews("busy", f.id, true);
  const meta = news.meta[f.id] ?? {};
  try {
    const got = await invoke<Fetched>("news_fetch", { url: f.url, etag: meta.etag ?? null, modified: meta.modified ?? null });
    const now = Date.now();
    setNews(produce((s) => {
      if (!got.same) s.items[f.id] = merge(s.items[f.id] ?? [], got.items, got.site || f.url, now);
      s.meta[f.id] = { ...(got.etag ? { etag: got.etag } : {}), ...(got.modified ? { modified: got.modified } : {}), fetched: now };
    }));
    if (!got.same) void rememberIcon(f, got);
  } catch (e) {
    setNews("meta", f.id, { ...meta, error: String(e).replace(/^Error: /, ""), fetched: Date.now() });
  } finally {
    setNews("busy", produce((b) => void delete b[f.id]));
    save();
  }
}

/** Fetch every feed that's on, or just `ids`. Old ones only, when `staleOnly`. */
export async function refresh(opts: { ids?: string[]; staleOnly?: boolean } = {}) {
  await load();
  const now = Date.now();
  const todo = feeds().filter((f) => !f.off && (!opts.ids || opts.ids.includes(f.id)) && (!opts.staleOnly || now - (news.meta[f.id]?.fetched ?? 0) > STALE));
  await Promise.allSettled(todo.map(fetchFeed));
}

export const fetching = () => Object.keys(news.busy).length > 0;
/** When the least recently fetched feed that's on was fetched, or 0. */
export const lastFetched = () => Math.max(0, ...feeds().filter((f) => !f.off).map((f) => news.meta[f.id]?.fetched ?? 0));

let open = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** A News Window mounted: load what was kept, fetch what's old, and keep fetching while any is open. */
export function watchNews(): () => void {
  open++;
  void refresh({ staleOnly: true });
  timer ??= setInterval(() => void refresh(), EVERY);
  return () => {
    if (--open > 0) return;
    clearInterval(timer);
    timer = undefined;
  };
}

/** Add a feed by its address or a site's (which is searched for the feed it offers). Resolves to
 *  the new feed's id; rejects with a message to show. */
export async function addFeed(input: string, topic: string): Promise<string> {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (!originOf(url)) throw new Error("that isn't a web address");
  if (feeds().some((f) => f.url === url)) throw new Error("that feed is already in the list");
  let got: Fetched;
  try {
    got = await invoke<Fetched>("news_fetch", { url, etag: null, modified: null });
  } catch (first) {
    // A site rather than a feed: use the feed its page offers.
    const page = await invoke<Page>("news_page", { url }).catch(() => null);
    const offered = page ? feedLinks(headLinks(page.html), page.url) : [];
    if (!offered.length) throw new Error(String(first).includes("not a feed") ? "no feed found at that address" : String(first).replace(/^Error: /, ""));
    url = offered[0];
    if (feeds().some((f) => f.url === url)) throw new Error("that site's feed is already in the list");
    got = await invoke<Fetched>("news_fetch", { url, etag: null, modified: null });
  }
  const id = feedId(url, feeds().map((f) => f.id));
  const host = new URL(url).host.replace(/^www\./, "");
  const f: NewsFeed = { id, url, name: (got.title || host).slice(0, 60), topic, ...(got.site ? { site: got.site } : {}) };
  editFeeds((fs) => void fs.push(f));
  const now = Date.now();
  setNews(produce((s) => {
    s.items[id] = merge([], got.items, got.site || url, now);
    s.meta[id] = { ...(got.etag ? { etag: got.etag } : {}), ...(got.modified ? { modified: got.modified } : {}), fetched: now };
  }));
  save();
  void rememberIcon(f, got);
  return id;
}

/** Move a feed before another one (or to the end of `topic`), taking that topic. */
export function moveFeed(id: string, topic: string, before?: string) {
  editFeeds((fs) => {
    const i = fs.findIndex((f) => f.id === id);
    if (i < 0) return;
    const [f] = fs.splice(i, 1);
    f.topic = topic;
    const j = before ? fs.findIndex((x) => x.id === before) : -1;
    if (j >= 0) fs.splice(j, 0, f);
    else {
      const last = fs.map((x) => x.topic).lastIndexOf(topic);
      fs.splice(last + 1 || fs.length, 0, f);
    }
  });
}
