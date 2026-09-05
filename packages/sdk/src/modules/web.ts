import type { CapabilityModuleSpec } from '@rp/shared';

export const webModule: CapabilityModuleSpec = {
  id: 'web',
  version: '1.0.0',
  title: 'Web access',
  summary: 'Fetch web pages/APIs and RSS feeds (any site, or only the sites the user allowlisted) and get the weather.',
  permission: 'pack',
  apiTypeName: 'WebApi',
  typings: `/**
 * Reach the internet. fetch() and rss() are allowed silently for hostnames on the user's
 * allowlist (Settings > Web) when they set one — other hosts then throw PERMISSION_DENIED; with no allowlist any http(s) host works. weather() is always allowed.
 * Responses are text only and size-capped; there is no browser, no JavaScript, no cookies.
 */
interface WebApi {
  /**
   * HTTP request to an http(s) URL. Returns the body as text (HTML, JSON, ...). 20 s timeout.
   * @param url Absolute http(s) URL.
   * @param opts method: 'GET' (default) or 'POST'; headers: extra request headers; body: request body for POST;
   *   maxBytes: truncate the body after this many bytes (default from settings, 512 KiB).
   * @returns HTTP status, lower-cased response headers and the (possibly truncated) body text.
   * @example const r = await sdk.web.fetch("https://api.github.com/repos/torvalds/linux"); return JSON.parse(r.text).stargazers_count;
   */
  fetch(url: string, opts?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; maxBytes?: number }): Promise<{ status: number; headers: Record<string, string>; text: string }>;
  /**
   * Fetch and parse an RSS or Atom feed.
   * @param url Feed URL.
   * @param limit Max items, newest first. Default 10, max 50.
   * @returns Items with title, link, optional ISO published time and a plain-text summary.
   * @example const items = await sdk.web.rss("https://hnrss.org/frontpage", 5);
   */
  rss(url: string, limit?: number): Promise<Array<{ title: string; link: string; published?: string; summary?: string }>>;
  /**
   * Current weather and a short forecast for a place (via open-meteo; no approval needed).
   * @param place City or address, e.g. "Berlin" or "Kyoto, Japan". Throws NOT_FOUND if it cannot be located.
   * @returns Current conditions in metric units plus a per-day forecast (day is an ISO date).
   * @example const w = await sdk.web.weather("Oslo"); return w.tempC + "°C, " + w.condition;
   */
  weather(place: string): Promise<{ place: string; tempC: number; feelsLikeC: number; condition: string; windKph: number; humidity: number; forecast: Array<{ day: string; minC: number; maxC: number; condition: string }> }>;
}`,
  docs: `Read from the internet. Requires the \`web\` capability. If the user configured an allowlist, only those hosts work (others throw PERMISSION_DENIED); otherwise any http(s) site is fine. \`weather()\` always works.

- Prefer APIs and feeds that return JSON/RSS over scraping HTML: responses are plain text, truncated at the size cap, with no JavaScript run.
- Never send the user's private data (state, transcripts, file contents) to a site unless they explicitly asked you to.
- Keep it to one or two requests per action; a PERMISSION_DENIED means the host is not on the user's allowlist — do not retry.

\`\`\`ts
const w = await sdk.web.weather("Lisbon");
const news = await sdk.web.rss("https://hnrss.org/frontpage", 3);
return { weather: w.condition + ", " + w.tempC + "°C", headlines: news.map(n => n.title) };
\`\`\``,
  methods: {
    fetch: { description: 'HTTP GET/POST a URL and return the body text.', dangerous: true },
    rss: { description: 'Fetch and parse an RSS/Atom feed.' },
    weather: { description: 'Current weather and forecast for a place.' },
  },
};
