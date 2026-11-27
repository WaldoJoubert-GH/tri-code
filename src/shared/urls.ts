// URL helpers with no app imports, so the Browser, Commands and the phone can share them.

/** Normalise an address typed by the user: add a scheme when missing. */
export function normalizeUrl(s: string): string {
  const t = s.trim();
  if (!t) return "";
  // "host:port" is not a scheme; anything else with "name:" is.
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(t)) return t;
  const host = t.split(/[/:?#]/)[0];
  if (host === "localhost" || /^127\./.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return `http://${t}`;
  return `https://${t}`;
}
