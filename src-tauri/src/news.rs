//! The News Window: fetching RSS, Atom and JSON feeds, and the page a feed or site icon is found on.
//! Parsing is feed-rs's, so every format arrives as one shape. What the window keeps between runs
//! (items, what was read, each feed's ETag) is the frontend's JSON, stored here as one file.
//!
//! Requests go out from here rather than the webview, so no site's CORS rules apply.

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use feed_rs::model::{Entry, Feed, MediaObject};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use ureq::ResponseExt;

/// A feed bigger than this is cut off (some send years of items).
const MAX_FEED: u64 = 8 * 1024 * 1024;
/// A site's page is only read for its <head>, which is near the top.
const MAX_PAGE: u64 = 512 * 1024;
/// Items kept per feed per fetch.
const MAX_ITEMS: usize = 100;
const UA: &str = concat!("tri-code/", env!("CARGO_PKG_VERSION"), " (feed reader)");

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub title: String,
    pub link: String,
    /// The item's summary or full content as the feed gave it: HTML, cleaned by the frontend.
    pub html: String,
    /// The item's picture from Media RSS or an image enclosure; the frontend falls back to the
    /// first <img> in `html`.
    pub image: Option<String>,
    /// Unix ms; 0 when the feed gives no date.
    pub published: i64,
    pub author: Option<String>,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    /// The server answered 304: nothing changed since `etag` / `modified`.
    pub same: bool,
    pub etag: Option<String>,
    pub modified: Option<String>,
    pub title: String,
    /// The site the feed is for (its HTML link), to find a favicon on.
    pub site: Option<String>,
    /// The feed's own icon (Atom <icon>, JSON Feed favicon).
    pub icon: Option<String>,
    /// Its logo (RSS <image>, Atom <logo>): often a wide banner, so the frontend prefers the site's favicon.
    pub logo: Option<String>,
    pub items: Vec<Item>,
}

fn agent() -> ureq::Agent {
    let config = ureq::config::Config::builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build();
    ureq::Agent::new_with_config(config)
}

fn is_image(mime: &str) -> bool {
    mime.starts_with("image/")
}

/// The first picture Media RSS gives: a thumbnail, else an image <media:content>.
fn media_image(media: &[MediaObject]) -> Option<String> {
    let thumb = media.iter().flat_map(|m| m.thumbnails.iter()).map(|t| t.image.uri.clone()).next();
    thumb.or_else(|| {
        media
            .iter()
            .flat_map(|m| m.content.iter())
            .filter(|c| c.content_type.as_ref().is_none_or(|t| is_image(t.as_ref())))
            // Untyped content counts only when its address looks like a picture.
            .filter(|c| c.content_type.is_some() || c.url.as_ref().is_some_and(|u| looks_like_image(u.as_str())))
            // The widest, so a hero image wins over an icon-sized one.
            .max_by_key(|c| c.width.unwrap_or(0))
            .and_then(|c| c.url.as_ref().map(|u| u.to_string()))
    })
}

fn looks_like_image(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"].iter().any(|e| path.ends_with(e))
}

fn entry_image(e: &Entry) -> Option<String> {
    media_image(&e.media).or_else(|| {
        e.links
            .iter()
            .find(|l| l.rel.as_deref() == Some("enclosure") && (l.media_type.as_deref().is_some_and(is_image) || looks_like_image(&l.href)))
            .map(|l| l.href.clone())
    })
}

/// The link a reader opens: rel="alternate" (or no rel), else the first.
fn entry_link(e: &Entry) -> String {
    e.links
        .iter()
        .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
        .or(e.links.first())
        .map(|l| l.href.clone())
        .unwrap_or_default()
}

fn to_item(e: &Entry) -> Item {
    // The longer of content and summary, so a feed with both shows its full text.
    let content = e.content.as_ref().and_then(|c| c.body.clone()).unwrap_or_default();
    let summary = e.summary.as_ref().map(|s| s.content.clone()).unwrap_or_default();
    let media_desc = e.media.iter().find_map(|m| m.description.as_ref().map(|d| d.content.clone())).unwrap_or_default();
    let html = [content, summary, media_desc].into_iter().max_by_key(|s| s.len()).unwrap_or_default();
    Item {
        id: e.id.clone(),
        title: e.title.as_ref().map(|t| t.content.trim().to_string()).unwrap_or_default(),
        link: entry_link(e),
        html,
        image: entry_image(e),
        published: e.published.or(e.updated).map(|d| d.timestamp_millis()).unwrap_or(0),
        author: e.authors.iter().find_map(|a| a.name.clone()).filter(|n| !n.trim().is_empty()),
    }
}

fn to_fetched(feed: Feed) -> Fetched {
    let site = feed
        .links
        .iter()
        .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate") && l.media_type.as_deref().is_none_or(|t| t.contains("html")))
        .map(|l| l.href.clone());
    Fetched {
        title: feed.title.map(|t| t.content.trim().to_string()).unwrap_or_default(),
        site,
        icon: feed.icon.map(|i| i.uri),
        logo: feed.logo.map(|i| i.uri),
        items: feed.entries.iter().take(MAX_ITEMS).map(to_item).collect(),
        ..Default::default()
    }
}

/// The `<media:thumbnail url>` of each `<item>` / `<entry>`, in order. feed-rs only keeps a
/// thumbnail beside a `<media:content>`, and feeds like BBC's give the thumbnail alone.
fn raw_thumbnails(xml: &str) -> Vec<Option<String>> {
    let mut out = vec![];
    let mut rest = xml;
    loop {
        let start = ["<item", "<entry"]
            .iter()
            .filter_map(|t| {
                let mut from = 0;
                // `<item` but not `<itemize`: the tag name must end there.
                while let Some(i) = rest[from..].find(t) {
                    let at = from + i;
                    if rest[at + t.len()..].starts_with(|c: char| c == '>' || c.is_whitespace()) {
                        return Some((at, *t));
                    }
                    from = at + t.len();
                }
                None
            })
            .min_by_key(|(i, _)| *i);
        let Some((i, tag)) = start else { break };
        let close = format!("</{}>", &tag[1..]);
        let body_end = rest[i..].find(&close).map_or(rest.len(), |e| i + e);
        let block = &rest[i..body_end];
        out.push(block.find(":thumbnail").and_then(|t| {
            let attrs = &block[t..block[t..].find('>').map_or(block.len(), |e| t + e)];
            let u = attrs.find("url=")? + 4;
            let q = attrs[u..].chars().next().filter(|c| *c == '"' || *c == '\'')?;
            let v = &attrs[u + 1..];
            Some(v[..v.find(q)?].replace("&amp;", "&"))
        }));
        rest = &rest[body_end..];
    }
    out
}

/// Parse feed bytes; `url` resolves relative links.
fn parse(bytes: &[u8], url: &str) -> Result<Fetched, String> {
    let feed = feed_rs::parser::Builder::new()
        .base_uri(Some(url))
        .build()
        .parse(bytes)
        .map_err(|e| format!("not a feed: {e}"))?;
    let entries = feed.entries.len();
    let mut out = to_fetched(feed);
    let thumbs = raw_thumbnails(&String::from_utf8_lossy(bytes));
    // Only when every item lined up, so a picture never lands on the wrong item.
    if thumbs.len() == entries {
        for (item, thumb) in out.items.iter_mut().zip(thumbs) {
            if item.image.is_none() {
                item.image = thumb;
            }
        }
    }
    Ok(out)
}

fn header(r: &ureq::http::Response<ureq::Body>, name: &str) -> Option<String> {
    r.headers().get(name).and_then(|v| v.to_str().ok()).map(String::from)
}

fn get(url: &str, accept: &str, etag: Option<&str>, modified: Option<&str>) -> Result<ureq::http::Response<ureq::Body>, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("not a web address: {url}"));
    }
    let mut req = agent().get(url).header("User-Agent", UA).header("Accept", accept);
    if let Some(e) = etag {
        req = req.header("If-None-Match", e);
    }
    if let Some(m) = modified {
        req = req.header("If-Modified-Since", m);
    }
    let r = req.call().map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    if status >= 400 {
        return Err(format!("{url}: the server answered {status}"));
    }
    Ok(r)
}

/// Fetch and parse one feed. With `etag` / `modified` from the last fetch, an unchanged feed
/// comes back as `same` without a body.
#[tauri::command]
pub async fn news_fetch(url: String, etag: Option<String>, modified: Option<String>) -> Result<Fetched, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = get(
            &url,
            "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
            etag.as_deref(),
            modified.as_deref(),
        )?;
        if r.status().as_u16() == 304 {
            return Ok(Fetched { same: true, etag, modified, ..Default::default() });
        }
        let (etag, modified) = (header(&r, "etag"), header(&r, "last-modified"));
        let bytes = r.into_body().with_config().limit(MAX_FEED).read_to_vec().map_err(|e| e.to_string())?;
        Ok(Fetched { etag, modified, ..parse(&bytes, &url)? })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// Where the request ended up after redirects, so relative hrefs resolve against it.
    pub url: String,
    pub html: String,
}

/// The top of a web page, for its icons (`<link rel="icon">`) or the feed it offers
/// (`<link rel="alternate" type="application/rss+xml">`).
#[tauri::command]
pub async fn news_page(url: String) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = get(&url, "text/html, application/xhtml+xml, */*;q=0.5", None, None)?;
        let ended = r.get_uri().to_string();
        let bytes = r.into_body().with_config().limit(MAX_PAGE).read_to_vec().map_err(|e| e.to_string())?;
        let html = String::from_utf8_lossy(&bytes);
        // Everything an icon or feed link can be in; the body only costs parsing time.
        let head = match html.find("</head>").or_else(|| html.find("<body")) {
            Some(i) => html[..i].to_string(),
            None => html.into_owned(),
        };
        Ok(Page { url: ended, html: head })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn cache_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("news.json"))
}

/// What the News Window kept last time, or None on a first run.
#[tauri::command]
pub fn news_load(app: AppHandle) -> Result<Option<String>, String> {
    match std::fs::read_to_string(cache_file(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Keep the News Window's items and read marks. Written aside then renamed, so never torn.
#[tauri::command]
pub fn news_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = cache_file(&app)?;
    let tmp = path.with_extension("json.tmp");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = r#"<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title> World news </title>
  <link>https://news.example.com/</link>
  <image><url>https://news.example.com/logo.png</url><title>x</title><link>https://news.example.com/</link></image>
  <item>
    <title>Talks resume</title>
    <link>https://news.example.com/a/1</link>
    <guid>a1</guid>
    <pubDate>Mon, 23 Nov 2026 07:00:00 GMT</pubDate>
    <description>&lt;p&gt;Short.&lt;/p&gt;</description>
    <media:thumbnail url="https://img.example.com/1.jpg" width="240" height="135"/>
  </item>
  <item>
    <title>Floods</title>
    <link>/a/2</link>
    <enclosure url="https://img.example.com/2.png" type="image/png" length="1"/>
  </item>
  <item>
    <title>No picture</title>
    <link>https://news.example.com/a/3</link>
    <description>&lt;p&gt;Text &lt;img src="https://img.example.com/3.jpg"&gt;&lt;/p&gt;</description>
  </item>
</channel>
</rss>"#;

    const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Blog</title>
  <icon>https://blog.example.com/icon.png</icon>
  <link href="https://blog.example.com/feed.xml" rel="self"/>
  <link href="https://blog.example.com/" rel="alternate" type="text/html"/>
  <id>urn:blog</id><updated>2026-11-22T10:00:00Z</updated>
  <entry>
    <title>Post</title><id>urn:p1</id>
    <link href="https://blog.example.com/p1"/>
    <updated>2026-11-22T10:00:00Z</updated>
    <author><name>Sam</name></author>
    <summary>Short</summary>
    <content type="html">&lt;p&gt;The whole post, which is longer.&lt;/p&gt;</content>
  </entry>
</feed>"#;

    #[test]
    fn rss_items_with_media_and_enclosure_images() {
        let f = parse(RSS.as_bytes(), "https://news.example.com/rss").unwrap();
        assert_eq!(f.title, "World news");
        assert_eq!(f.site.as_deref(), Some("https://news.example.com/"));
        assert_eq!(f.icon, None);
        assert_eq!(f.logo.as_deref(), Some("https://news.example.com/logo.png"));
        assert_eq!(f.items.len(), 3);
        assert_eq!(f.items[0].title, "Talks resume");
        assert_eq!(f.items[0].image.as_deref(), Some("https://img.example.com/1.jpg"));
        assert!(f.items[0].published > 0);
        assert_eq!(f.items[1].image.as_deref(), Some("https://img.example.com/2.png"));
        assert_eq!(f.items[1].link, "https://news.example.com/a/2");
        // The <img> in the text is the frontend's to find.
        assert_eq!(f.items[2].image, None);
        assert!(f.items[2].html.contains("<img"));
    }

    #[test]
    fn atom_takes_icon_site_and_the_longer_text() {
        let f = parse(ATOM.as_bytes(), "https://blog.example.com/feed.xml").unwrap();
        assert_eq!(f.icon.as_deref(), Some("https://blog.example.com/icon.png"));
        assert_eq!(f.site.as_deref(), Some("https://blog.example.com/"));
        let p = &f.items[0];
        assert_eq!(p.link, "https://blog.example.com/p1");
        assert_eq!(p.author.as_deref(), Some("Sam"));
        assert!(p.html.contains("whole post"));
    }

    #[test]
    fn html_is_not_a_feed() {
        assert!(parse(b"<!doctype html><html><head></head></html>", "https://x.example/").is_err());
    }

    #[test]
    fn raw_thumbnails_line_up_with_items() {
        let xml = r#"<channel><itemize/><item id="1"><media:thumbnail width="1" url="https://i/a.jpg?x=1&amp;y=2"/></item>
            <item><title>none</title></item><item><media:thumbnail url='https://i/c.png'/></item></channel>"#;
        assert_eq!(raw_thumbnails(xml), vec![Some("https://i/a.jpg?x=1&y=2".into()), None, Some("https://i/c.png".into())]);
    }

    /// The starter feeds, live: `cargo test --lib news::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live() {
        for url in [
            "https://feeds.bbci.co.uk/news/world/rss.xml",
            "https://www.aljazeera.com/xml/rss/all.xml",
            "https://www.dailymaverick.co.za/dmrss/",
            "https://www.citizen.co.za/feed/",
            "https://hnrss.org/frontpage",
            "https://feeds.arstechnica.com/arstechnica/index",
            "https://www.theverge.com/rss/index.xml",
            "https://www.nature.com/nature.rss",
        ] {
            let got = get(url, "*/*", None, None).and_then(|r| {
                let b = r.into_body().with_config().limit(MAX_FEED).read_to_vec().map_err(|e| e.to_string())?;
                parse(&b, url)
            });
            match got {
                Ok(f) => {
                    let pics = f.items.iter().filter(|i| i.image.is_some()).count();
                    let imgs = f.items.iter().filter(|i| i.image.is_none() && i.html.contains("<img")).count();
                    println!("{url}\n  {:?} · {} items · {pics} pictures, {imgs} more in text · site {:?} icon {:?} logo {:?}", f.title, f.items.len(), f.site, f.icon, f.logo);
                }
                Err(e) => println!("{url}\n  FAILED {e}"),
            }
        }
    }

    #[test]
    fn image_addresses() {
        assert!(looks_like_image("https://x/a.JPG?w=200"));
        assert!(!looks_like_image("https://x/video.mp4"));
    }
}
