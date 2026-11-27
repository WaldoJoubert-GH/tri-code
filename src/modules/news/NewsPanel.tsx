// The News Window (design/rss-feed.html, variant A): feeds by topic, their headlines, and the item's
// text with its pictures. Each feed shows its site's icon (found once and remembered on the feed);
// headlines show the item's picture, and the reading pane shows it over the text. Articles open in
// the project's browser window. Fetching runs while a News Window is mounted (news.ts).

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import DOMPurify from "dompurify";
import { type Project, type Tab } from "../../shared/state/state";
import {
  addFeed, feedById, feeds, fetching, findArticleImage, isRead, lastFetched, loaded, markAllRead, moveFeed, news, refindIcon,
  refresh, removeFeed, setRead, topics as allTopics, unreadOf, updateFeed, watchNews,
} from "./news";
import { type NewsFeed, type NewsItem, absolute, ago, plain } from "./newsdata";
import { openSettings } from "../../shared/nav";
import { guessIcon, hostHue, hostOf, monogram } from "../../shared/ui/favicons";
import { openExternal, openUrlInProject } from "../browser";
import { openCtxMenu } from "../../shared/ui/ctxmenu";
import { copyText } from "../../shared/ui/clipboard";
import { Icon } from "../../shared/ui/lucide";
import { Key } from "../../shared/keys/Keys";
import { flash } from "../../shared/ui/ui";
import "./news.css";
import { isEnter } from "../../shared/ui/enterkey";

/** Headlines listed at most, newest first. */
const LIST_MAX = 400;
/** Narrower than this, the window shows the list or the item, not both. */
const NARROW = 760;

/** What the sources pane has picked: every feed ("all"), a topic ("topic:World") or one feed
 *  ("feed:<id>"). A string, as a store merges objects set into it. */
type Pick = "all" | `topic:${string}` | `feed:${string}`;
type View = { pick: Pick; sel: string | null; unreadOnly: boolean };
const views = new Map<string, View>();
const viewOf = (id: string): View => {
  let v = views.get(id);
  if (!v) views.set(id, (v = { pick: "all", sel: null, unreadOnly: false }));
  return v;
};
const pickedTopic = (p: Pick) => (p.startsWith("topic:") ? p.slice(6) : null);
const pickedFeed = (p: Pick) => (p.startsWith("feed:") ? p.slice(5) : null);

type Row = { feed: NewsFeed; item: NewsItem; key: string };
const keyOf = (feedId: string, itemId: string) => `${feedId}\n${itemId}`;

const [minute, setMinute] = createSignal(Date.now());
setInterval(() => setMinute(Date.now()), 30_000);

/** An icon from a list of addresses, trying the next when one fails, else the host's letter. */
function TryIcon(props: { srcs: (string | undefined)[]; host: string; class?: string; onAllFailed?: () => void }): JSX.Element {
  const [broken, setBroken] = createSignal<string[]>([]);
  const src = () => props.srcs.find((s): s is string => !!s && !broken().includes(s));
  createEffect(on(src, (s, was) => {
    if (!s && was) props.onAllFailed?.();
  }));
  const url = () => `https://${props.host}/`;
  return (
    <Show
      when={src()}
      keyed
      fallback={<i class={`nw-ico nw-letter ${props.class ?? ""}`} style={{ "--h": hostHue(url()) }} aria-hidden="true">{monogram(url()) || "?"}</i>}
    >
      {(s) => (
        <img
          class={`nw-ico ${props.class ?? ""}`}
          src={s}
          alt=""
          aria-hidden="true"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setBroken((b) => [...b, s])}
        />
      )}
    </Show>
  );
}

/** A feed's icon: the remembered one, the site's /favicon.ico, the feed's logo, then a letter. */
function FeedIcon(props: { feed: NewsFeed; class?: string }): JSX.Element {
  const site = () => props.feed.site || props.feed.url;
  let asked = false;
  return (
    <TryIcon
      class={props.class}
      host={hostOf(site())}
      srcs={[props.feed.icon, guessIcon(site()), props.feed.logo]}
      onAllFailed={() => {
        // The remembered icon broke (the site changed it): look once more.
        if (asked || !props.feed.icon) return;
        asked = true;
        void refindIcon(props.feed.id);
      }}
    />
  );
}

/** An item's picture; hides itself when it doesn't load. */
function Picture(props: { src: string; class: string }): JSX.Element {
  const [bad, setBad] = createSignal(false);
  createEffect(on(() => props.src, () => setBad(false)));
  return (
    <Show when={!bad()}>
      <img class={props.class} src={props.src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} onError={() => setBad(true)} />
    </Show>
  );
}

/** An item's HTML, cleaned: no scripts, styles, frames or forms; links and pictures made absolute;
 *  pictures lazy and sent without a referrer; the hero picture left out, as it is shown above. */
function articleBody(item: NewsItem): DocumentFragment {
  const frag = DOMPurify.sanitize(item.html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "frame", "object", "embed", "video", "audio", "svg", "math", "link", "meta"],
    FORBID_ATTR: ["style", "class", "id", "srcset", "sizes", "width", "height", "align", "border"],
  }) as DocumentFragment;
  const base = item.link;
  for (const img of [...frag.querySelectorAll("img")]) {
    const src = absolute(img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "", base);
    if (!src || src === item.image || /feedburner|feedsportal|doubleclick|\/emoji\//i.test(src)) {
      img.remove();
      continue;
    }
    for (const a of [...img.attributes]) if (a.name !== "alt" && a.name !== "title") img.removeAttribute(a.name);
    img.setAttribute("src", src);
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("referrerpolicy", "no-referrer");
  }
  for (const a of [...frag.querySelectorAll("a")]) {
    const href = absolute(a.getAttribute("href") || "", base);
    if (href) a.setAttribute("href", href);
    else a.removeAttribute("href");
    a.removeAttribute("target");
  }
  // Empty paragraphs left where pictures or frames were.
  for (const p of [...frag.querySelectorAll("p, figure, div")]) if (!p.textContent?.trim() && !p.querySelector("img")) p.remove();
  return frag;
}

export default function NewsPanel(props: { project: Project; tab: Tab; focused: boolean }): JSX.Element {
  const [v, setV] = createStore(viewOf(props.tab.id));
  // With no feeds yet, the window opens on adding one.
  const [adding, setAdding] = createSignal(feeds().length === 0);
  const [addUrl, setAddUrl] = createSignal("");
  const [addTopic, setAddTopic] = createSignal(allTopics()[0]);
  const [addBusy, setAddBusy] = createSignal(false);
  const [addError, setAddError] = createSignal("");
  const [narrow, setNarrow] = createSignal(false);
  /** Narrow windows: the item is showing instead of the list. */
  const [reading, setReading] = createSignal(false);

  let rootEl: HTMLDivElement | undefined;
  let listEl: HTMLDivElement | undefined;
  let readEl: HTMLDivElement | undefined;

  // ── what's listed ──────────────────────────────────────────────────

  const onFeeds = () => feeds().filter((f) => !f.off);
  const picked = (f: NewsFeed) => {
    const p = v.pick;
    return p === "all" || f.topic === pickedTopic(p) || f.id === pickedFeed(p);
  };

  /** Rows by key, reused while their feed and item are the same objects, so <For> keeps their
   *  elements (and loaded pictures) across a fetch. */
  let rowCache = new Map<string, Row>();
  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const next = new Map<string, Row>();
    for (const f of onFeeds()) {
      if (!picked(f)) continue;
      for (const item of news.items[f.id] ?? []) {
        const key = keyOf(f.id, item.id);
        // The open item stays listed after it is read, so the list doesn't jump.
        if (v.unreadOnly && isRead(f.id, item.id) && key !== v.sel) continue;
        const was = rowCache.get(key);
        const row = was && was.feed === f && was.item === item ? was : { feed: f, item, key };
        next.set(key, row);
        out.push(row);
      }
    }
    rowCache = next;
    return out.sort((a, b) => b.item.at - a.item.at).slice(0, LIST_MAX);
  });

  const selected = createMemo(() => rows().find((r) => r.key === v.sel) ?? null);
  const unreadTotal = () => onFeeds().reduce((n, f) => n + unreadOf(f.id), 0);
  const unreadIn = (topic: string) => onFeeds().filter((f) => f.topic === topic).reduce((n, f) => n + unreadOf(f.id), 0);
  /** The topics with feeds, in Settings › News order; ones no longer listed there come last. */
  const topics = () => {
    const used = [...new Set(feeds().map((f) => f.topic))];
    const all = allTopics();
    return [...all.filter((t) => used.includes(t)), ...used.filter((t) => !all.includes(t))];
  };
  const pickName = () => {
    const p = v.pick;
    return p === "all" ? "All feeds" : pickedTopic(p) ?? feedById(pickedFeed(p) ?? "")?.name ?? "";
  };

  // ── acting ─────────────────────────────────────────────────────────

  function select(r: Row | null, scroll = false) {
    setV("sel", r?.key ?? null);
    if (!r) return;
    setRead(r.feed.id, r.item.id);
    void findArticleImage(r.feed.id, r.item.id);
    const rs = rows();
    const next = rs[rs.indexOf(r) + 1];
    if (next) void findArticleImage(next.feed.id, next.item.id);
    if (narrow()) setReading(true);
    if (scroll) listEl?.querySelector(`[data-key="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function move(by: number) {
    const rs = rows();
    if (!rs.length) return;
    const i = rs.findIndex((r) => r.key === v.sel);
    select(rs[Math.max(0, Math.min(rs.length - 1, i < 0 ? 0 : i + by))], true);
  }

  function openArticle(r: Row | null, external = false) {
    if (!r?.item.link) return flash("this item has no link");
    setRead(r.feed.id, r.item.id);
    if (external) openExternal(r.item.link);
    else openUrlInProject(props.project.id, r.item.link, props.tab.id);
  }

  function setPick(p: Pick) {
    setV("pick", p);
    setV("sel", null);
    setReading(false);
    listEl?.scrollTo({ top: 0 });
  }

  function readAllListed() {
    const rs = rows();
    if (!rs.length) return;
    markAllRead(rs.map((r) => ({ feed: r.feed.id, item: r.item })));
    flash(`marked ${pickName()} read`);
  }

  async function submitAdd(e: Event) {
    e.preventDefault();
    if (!addUrl().trim() || addBusy()) return;
    setAddBusy(true);
    setAddError("");
    try {
      // The chosen topic may have been removed in Settings since.
      const id = await addFeed(addUrl(), allTopics().includes(addTopic()) ? addTopic() : allTopics()[0]);
      setAdding(false);
      setAddUrl("");
      setPick(`feed:${id}`);
      flash(`added ${feedById(id)?.name ?? "feed"}`);
    } catch (err) {
      setAddError(String(err instanceof Error ? err.message : err).replace(/^Error: /, ""));
    } finally {
      setAddBusy(false);
    }
  }

  function feedMenu(e: MouseEvent, f: NewsFeed) {
    openCtxMenu(e, [
      { label: "Refresh", run: () => void refresh({ ids: [f.id] }) },
      { label: "Mark all read", run: () => markAllRead((news.items[f.id] ?? []).map((item) => ({ feed: f.id, item }))) },
      { label: "Open site", disabled: !f.site, run: () => f.site && openUrlInProject(props.project.id, f.site, props.tab.id) },
      { label: "Copy feed address", run: () => { copyText(f.url); flash("feed address copied"); } },
      "sep",
      { label: "Rename…", run: () => renameFeed(f) },
      ...allTopics().filter((t) => t !== f.topic).map((t) => ({ label: `Move to ${t}`, run: () => moveFeed(f.id, t) })),
      { label: "Edit topics…", run: () => openSettings("news") },
      { label: "Find its icon again", run: () => void refindIcon(f.id).then(() => flash(`looked for ${f.name}'s icon`)) },
      "sep",
      { label: f.off ? "Turn on" : "Turn off", run: () => updateFeed(f.id, { off: f.off ? undefined : true }) },
      { label: "Remove", run: () => {
        removeFeed(f.id);
        if (v.pick === `feed:${f.id}`) setPick("all");
        flash(`removed ${f.name}`);
      } },
    ]);
  }

  const [renaming, setRenaming] = createSignal<string | null>(null);
  function renameFeed(f: NewsFeed) {
    setRenaming(f.id);
  }

  function itemMenu(e: MouseEvent, r: Row) {
    const read = isRead(r.feed.id, r.item.id);
    openCtxMenu(e, [
      { label: "Open in browser window", kbd: "Enter", run: () => openArticle(r) },
      { label: "Open in system browser", run: () => openArticle(r, true) },
      { label: "Copy link", disabled: !r.item.link, run: () => { copyText(r.item.link); flash("link copied"); } },
      "sep",
      { label: read ? "Mark unread" : "Mark read", kbd: "M", run: () => setRead(r.feed.id, r.item.id, !read) },
    ]);
  }

  // ── the reading pane's text ────────────────────────────────────────

  function onBodyClick(e: MouseEvent) {
    const a = (e.target as Element).closest("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href")!;
    if (e.ctrlKey || e.metaKey || e.shiftKey) openExternal(href);
    else openUrlInProject(props.project.id, href, props.tab.id);
  }

  // ── keys and lifecycle ─────────────────────────────────────────────

  const onKey = (e: KeyboardEvent) => {
    if (!props.focused || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest("input, textarea, select");
    if (e.key === "Escape" && typing) {
      setAdding(false);
      setRenaming(null);
      (target as HTMLInputElement).blur();
      e.preventDefault();
      return;
    }
    if (typing) return;
    if (e.key === "Escape") {
      // Only when there's something to step back from; otherwise Escape is the app's.
      if (reading()) setReading(false);
      else if (adding()) setAdding(false);
      else return;
      e.preventDefault();
      return;
    }
    const act: Record<string, () => void> = {
      j: () => move(1),
      k: () => move(-1),
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Enter: () => openArticle(selected()),
      o: () => openArticle(selected()),
      m: () => { const r = selected(); if (r) setRead(r.feed.id, r.item.id, !isRead(r.feed.id, r.item.id)); },
      u: () => setV("unreadOnly", (x) => !x),
      r: () => void refresh(),
      a: () => setAdding(true),
      " ": () => readEl?.scrollBy({ top: (readEl.clientHeight * 0.8) * (e.shiftKey ? -1 : 1), behavior: "smooth" }),
    };
    if (act[e.key]) {
      act[e.key]();
      e.preventDefault();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", onKey);
    const stop = watchNews();
    const ro = new ResizeObserver(([en]) => setNarrow(en.contentRect.width < NARROW));
    if (rootEl) ro.observe(rootEl);
    onCleanup(() => {
      stop();
      ro.disconnect();
    });
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));
  createEffect(on(narrow, (n) => !n && setReading(false)));

  // ── view ───────────────────────────────────────────────────────────

  const SrcRow = (p: { label: string; icon: JSX.Element; count: number; on: boolean; onPick: () => void; off?: boolean; error?: string; busy?: boolean; onMenu?: (e: MouseEvent) => void; id?: string }) => (
    <button
      class="nw-srow"
      classList={{ "nw-on": p.on, "nw-off": p.off }}
      onClick={p.onPick}
      onContextMenu={p.onMenu}
      title={p.error ? `Couldn't fetch: ${p.error}` : p.off ? `${p.label} (off)` : p.label}
    >
      {p.icon}
      <Show when={p.id && renaming() === p.id} fallback={<span class="nw-sname">{p.label}</span>}>
        <input
          class="nw-rename"
          value={p.label}
          spellcheck={false}
          ref={(el) => requestAnimationFrame(() => { el.focus(); el.select(); })}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (isEnter(e)) e.currentTarget.blur();
          }}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            if (name && p.id) updateFeed(p.id, { name });
            setRenaming(null);
          }}
        />
      </Show>
      <Show when={p.busy}><Icon name="loader-circle" size={11} class="nw-spin" /></Show>
      <Show when={p.error && !p.busy}><i class="nw-err" aria-label="couldn't fetch" /></Show>
      <span class="nw-n">{p.count || ""}</span>
    </button>
  );

  const Sources = () => (
    <nav class="nw-src" aria-label="Feeds">
      <SrcRow
        label="All feeds"
        icon={<span class="nw-ico nw-all"><Icon name="rss" size={11} /></span>}
        count={unreadTotal()}
        on={v.pick === "all"}
        onPick={() => setPick("all")}
        onMenu={(e) => openCtxMenu(e, [
          { label: "Refresh all", kbd: "R", run: () => void refresh() },
          { label: "Add a feed…", kbd: "A", run: () => setAdding(true) },
        ])}
      />
      <For each={topics()}>
        {(t) => (
          <>
            <button class="nw-topic" classList={{ "nw-on": v.pick === `topic:${t}` }} onClick={() => setPick(`topic:${t}`)}>
              <span>{t}</span>
              <span class="nw-n">{unreadIn(t) || ""}</span>
            </button>
            <For each={feeds().filter((f) => f.topic === t)}>
              {(f) => (
                <SrcRow
                  id={f.id}
                  label={f.name}
                  icon={<FeedIcon feed={f} />}
                  count={f.off ? 0 : unreadOf(f.id)}
                  on={v.pick === `feed:${f.id}`}
                  off={f.off}
                  error={news.meta[f.id]?.error}
                  busy={!!news.busy[f.id]}
                  onPick={() => setPick(`feed:${f.id}`)}
                  onMenu={(e) => feedMenu(e, f)}
                />
              )}
            </For>
          </>
        )}
      </For>
      <button class="nw-addrow" onClick={() => setAdding(true)}><Icon name="plus" size={12} /> Add feed</button>
    </nav>
  );

  const List = () => (
    <div class="nw-list" ref={listEl} role="listbox" aria-label={pickName()}>
      <Show
        when={rows().length}
        fallback={
          <div class="nw-empty">
            <Show when={feeds().length} fallback={<>No feeds yet. Add a feed's address, or a site's, and it finds the feed. <button class="nw-link" onClick={() => setAdding(true)}>Add a feed</button></>}>
            <Show when={loaded() && !fetching()} fallback={<><Icon name="loader-circle" size={14} class="nw-spin" /> Fetching…</>}>
              <Show when={v.unreadOnly} fallback={<>No items yet. <button class="nw-link" onClick={() => void refresh()}>Refresh</button></>}>
                All read. <button class="nw-link" onClick={() => setV("unreadOnly", false)}>Show read items</button>
              </Show>
            </Show>
            </Show>
          </div>
        }
      >
        <For each={rows()}>
          {(r) => {
            const read = () => isRead(r.feed.id, r.item.id);
            return (
              <div
                class="nw-item"
                classList={{ "nw-read": read(), "nw-sel": v.sel === r.key }}
                data-key={r.key}
                role="option"
                aria-selected={v.sel === r.key}
                onClick={() => select(r)}
                onDblClick={() => openArticle(r)}
                onContextMenu={(e) => itemMenu(e, r)}
              >
                <span class="nw-dot" />
                <div class="nw-mid">
                  <div class="nw-hl">{r.item.title}</div>
                  <div class="nw-by">
                    <FeedIcon feed={r.feed} class="nw-sm" />
                    <span class="nw-fname">{r.feed.name}</span>
                    <span>· {ago(r.item.at, minute())}</span>
                  </div>
                </div>
                <Show when={r.item.image}>{(src) => <Picture src={src()} class="nw-thumb" />}</Show>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );

  const Reader = () => (
    <div class="nw-reader" ref={readEl}>
      <Show when={selected()} fallback={<div class="nw-empty">Pick a headline. <Key k="J" /> <Key k="K" /> move, <Key k="Enter" /> opens it.</div>}>
        {(r) => {
          const linkHost = () => hostOf(r().item.link);
          const feedHost = () => hostOf(r().feed.site || r().feed.url);
          // An aggregator (Hacker News) links to other sites: show whose article it is.
          const elsewhere = () => !!linkHost() && linkHost() !== feedHost() && !linkHost().endsWith("." + feedHost().split(".").slice(-2).join("."));
          let textEl!: HTMLDivElement;
          createEffect(on(() => r().key, () => {
            textEl.replaceChildren(articleBody(r().item));
            readEl?.scrollTo({ top: 0 });
          }));
          return (
            <article class="nw-art">
              <Show when={narrow()}>
                <button class="nw-back" onClick={() => setReading(false)}><Icon name="arrow-left" size={13} /> {pickName()}</button>
              </Show>
              <div class="nw-meta">
                <FeedIcon feed={r().feed} />
                <span>{r().feed.name}</span>
                <Show when={elsewhere()}>
                  <span class="nw-via">
                    <TryIcon srcs={[guessIcon(r().item.link)]} host={linkHost()} />
                    {linkHost()}
                  </span>
                </Show>
                <Show when={r().item.author}><span>· {r().item.author}</span></Show>
                <span>· {ago(r().item.at, minute(), true)}</span>
              </div>
              <h2 class="nw-title">
                <a href={r().item.link} onClick={(e) => { e.preventDefault(); openArticle(r(), e.ctrlKey || e.metaKey); }}>{r().item.title}</a>
              </h2>
              <Show when={r().item.image}>{(src) => <Picture src={src()} class="nw-hero" />}</Show>
              <div class="nw-text" ref={textEl} onClick={onBodyClick} />
              <Show when={!plain(r().item.html)}>
                <p class="nw-dim">This feed only gives the headline. Open the article to read it.</p>
              </Show>
              <div class="nw-acts">
                <button class="nw-btn nw-primary" onClick={() => openArticle(r())}><Icon name="globe" size={13} /> Open article <Key k="Enter" /></button>
                <button class="nw-btn" onClick={() => openArticle(r(), true)} title="Open in the system browser"><Icon name="external-link" size={13} /></button>
                <button class="nw-btn" onClick={() => { copyText(r().item.link); flash("link copied"); }} title="Copy link"><Icon name="link" size={13} /></button>
                <button class="nw-btn" onClick={() => { setRead(r().feed.id, r().item.id, false); flash("marked unread"); }}>Mark unread <Key k="M" /></button>
              </div>
              <div class="nw-url">{r().item.link}</div>
            </article>
          );
        }}
      </Show>
    </div>
  );

  return (
    <div class="nw-root" ref={rootEl} data-news={props.tab.id} classList={{ "nw-narrow": narrow(), "nw-reading": reading() }}>
      <div class="nw-ph">
        <span class="nw-pick">{pickName()}</span>
        <span class="nw-count">{unreadTotal() ? `${unreadTotal()} unread` : "all read"}</span>
        <span class="nw-grow" />
        <span class="nw-updated">
          <Show when={fetching()} fallback={lastFetched() ? `updated ${ago(lastFetched(), minute(), true)}` : ""}>
            <Icon name="loader-circle" size={12} class="nw-spin" /> fetching…
          </Show>
        </span>
        <button class="nw-ib" aria-pressed={v.unreadOnly} onClick={() => setV("unreadOnly", (x) => !x)} title="Only unread (U)">Unread</button>
        <button class="nw-ib" onClick={readAllListed} title="Mark everything listed as read"><Icon name="check-check" size={13} /></button>
        <button class="nw-ib" onClick={() => void refresh()} disabled={fetching()} title="Refresh (R)"><Icon name="refresh-cw" size={13} /></button>
        <button class="nw-ib" onClick={() => setAdding((x) => !x)} aria-pressed={adding()} title="Add a feed (A)"><Icon name="plus" size={13} /></button>
      </div>
      <Show when={adding()}>
        <form class="nw-add" onSubmit={submitAdd}>
          <Icon name="rss" size={13} />
          <input
            class="nw-addurl"
            placeholder="Feed or site address, e.g. bbc.com/news or https://example.com/feed.xml"
            value={addUrl()}
            spellcheck={false}
            disabled={addBusy()}
            ref={(el) => requestAnimationFrame(() => el.focus())}
            onInput={(e) => { setAddUrl(e.currentTarget.value); setAddError(""); }}
          />
          <select value={addTopic()} onChange={(e) => setAddTopic(e.currentTarget.value)} disabled={addBusy()} aria-label="Topic">
            <For each={allTopics()}>{(t) => <option value={t}>{t}</option>}</For>
          </select>
          <button class="nw-btn nw-primary" disabled={addBusy() || !addUrl().trim()}>
            <Show when={addBusy()} fallback="Add">
              <Icon name="loader-circle" size={12} class="nw-spin" /> Looking…
            </Show>
          </button>
          <button type="button" class="nw-btn" onClick={() => setAdding(false)}>Cancel</button>
          <Show when={addError()}><span class="nw-adderr">{addError()}</span></Show>
        </form>
      </Show>
      <div class="nw-body">
        <Sources />
        <List />
        <Reader />
      </div>
    </div>
  );
}
