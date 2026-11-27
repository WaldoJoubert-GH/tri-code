// Site icons for browser page tabs. A page's icon is the one it declares (reported by the webview:
// WebView2's FaviconChanged, or browser.rs's FAVICON_SCRIPT elsewhere), else its origin's
// /favicon.ico, else a letter on a colour taken from the host (TabIcon in Canvas.tsx).

/** The origin of an http(s) address, or "" for anything else (about:blank, a typo). */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : "";
  } catch {
    return "";
  }
}

/** Where a site's icon usually is when the page declares none: `<origin>/favicon.ico`. */
export const guessIcon = (url: string): string => (originOf(url) ? `${originOf(url)}/favicon.ico` : "");

/** The host without `www.`, or "" when the address has none. */
export function hostOf(url: string): string {
  try {
    return /^https?:$/.test(new URL(url).protocol) ? new URL(url).host.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** The letter a site without an icon shows. */
export const monogram = (url: string): string => hostOf(url).charAt(0).toUpperCase();

/** A steady hue per host, port included, so localhost:3000 and localhost:5173 differ. */
export const hostHue = (url: string): number => [...hostOf(url)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
