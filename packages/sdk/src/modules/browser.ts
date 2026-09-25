import type { CapabilityModuleSpec } from '@rp/shared';

export const browserModule: CapabilityModuleSpec = {
  id: 'browser',
  version: '2.3.0',
  title: 'Web browser',
  summary:
    "Open web pages, and — with the rpchat browser extension installed — list, read, click, type into and screenshot the user's browser tabs, block pages for a while, style or swap images, set the home page, use bookmarks and history, and run JavaScript in a page. A closed browser is started for you.",
  permission: 'pack',
  apiTypeName: 'BrowserApi',
  typings: `/** A browser tab as the extension reports it. Internal pages (chrome://…) are listed with an empty url and title. */
interface BrowserTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  index: number;
}
/** An element matched by browser.query(): its position among the matches, tag, visible text, and href/value when it has one. */
interface BrowserElement {
  index: number;
  tag: string;
  text: string;
  href?: string;
  value?: string;
}
/** A page block installed with browser.block(). */
interface BrowserBlock {
  id: string;
  /** "deny": the patterns are the pages kept shut. "allow": they are the only ones that may open. */
  mode: "deny" | "allow";
  patterns: string[];
  redirect?: string;
  expiresAt?: string;
  by?: string;
  reason?: string;
}
/** A bookmark or bookmark folder (folders have no url); path is the folder path from the root, e.g. "Bookmarks bar/Work". */
interface BrowserBookmark {
  id: string;
  title: string;
  url?: string;
  parentId: string;
  path: string;
}
interface BrowserHistoryItem {
  url: string;
  title: string;
  lastVisitTime: string;
  visitCount: number;
}
type BrowserImageEffect = "blur" | "grayscale" | "sepia" | "invert" | "hue" | "pixelate" | "none" | { css: string };
/**
 * The user's web browser. \`open()\` always works (it runs the browser command from Settings). Everything
 * else drives tabs through the rpchat browser extension, so it needs the extension installed — but not
 * the browser open: when no browser is running, rpchat starts one and waits for the extension (up to
 * ~20 s) before carrying the call out. Those methods fail with CAPABILITY_FAILED when the extension
 * never turns up or the user switched starting the browser off. Only http(s) URLs, and only hosts on
 * the user's web allowlist when they set one. Requires the 'browser' capability.
 */
interface BrowserApi {
  /**
   * Open a URL in the user's browser. Uses the extension when it is connected (returns the tab), else the
   * browser command from Settings (returns null).
   * @param url Must start with http:// or https://. Anything else is rejected.
   * @param options newWindow: ask for a new window rather than a tab.
   * @example await sdk.browser.open("https://en.wikipedia.org/wiki/Aurora", { newWindow: true });
   */
  open(url: string, options?: { newWindow?: boolean }): Promise<BrowserTab | null>;
  /** Whether the extension is connected right now, and which browser it runs in. Other methods start the browser themselves, so a false here is not a reason to give up. */
  status(): Promise<{ connected: boolean; browser?: string }>;
  /** Every open tab, across windows. */
  tabs(): Promise<BrowserTab[]>;
  /**
   * Open a URL in a new tab and wait for it to load.
   * @param options active: focus it (default true); newWindow: open a new browser window instead.
   */
  openTab(url: string, options?: { active?: boolean; newWindow?: boolean }): Promise<BrowserTab>;
  /** Bring a tab (and its window) to the front. */
  activate(tabId: number): Promise<BrowserTab>;
  /** Close a tab. Only close tabs you opened, unless the user asked. */
  close(tabId: number): Promise<void>;
  /** Navigate an existing tab to a URL and wait for it to load. */
  navigate(tabId: number, url: string): Promise<BrowserTab>;
  /** Browser history: back. */
  back(tabId: number): Promise<BrowserTab>;
  /** Browser history: forward. */
  forward(tabId: number): Promise<BrowserTab>;
  /** Reload the tab. */
  reload(tabId: number): Promise<BrowserTab>;
  /**
   * The visible text of a page, whitespace collapsed, capped at maxChars (default 20 000).
   * @param tabId Defaults to the active tab.
   * @example const { title, text } = await sdk.browser.read();
   */
  read(tabId?: number, options?: { maxChars?: number }): Promise<{ url: string; title: string; text: string }>;
  /**
   * Elements matching a CSS selector (document order, default limit 50, max 500). Use it to find links,
   * buttons and fields before click()/type().
   * @example const links = await sdk.browser.query(tab.id, "a[href*='weather']");
   */
  query(tabId: number, selector: string, options?: { limit?: number }): Promise<BrowserElement[]>;
  /**
   * Click the element matching a selector (index picks among several matches, default 0). Navigations
   * it causes are not awaited: call read() afterwards, or subscribe to the 'browser-navigated' event.
   */
  click(tabId: number, selector: string, options?: { index?: number }): Promise<{ clicked: boolean; tag?: string; text?: string }>;
  /**
   * Put text into an input, textarea, select or contenteditable (replacing its value) and fire the
   * events a web app listens for. submit: press Enter and submit the surrounding form.
   * @example await sdk.browser.type(tab.id, "input[name=q]", "aurora forecast", { submit: true });
   */
  type(tabId: number, selector: string, text: string, options?: { submit?: boolean }): Promise<{ typed: boolean; submitted: boolean }>;
  /** Scroll the page to a vertical offset, or bring the first element matching selector into view. */
  scroll(tabId: number, target: { y?: number; selector?: string }): Promise<{ x: number; y: number; height: number }>;
  /**
   * PNG screenshot of the visible part of a tab as a data: URL (the tab is brought to the front first).
   * @param tabId Defaults to the active tab.
   */
  screenshot(tabId?: number): Promise<{ dataUrl: string; url: string; title: string }>;
  /** Count occurrences of a text on the page (case-insensitive) and scroll the first one into view. */
  find(tabId: number, text: string): Promise<{ count: number; first?: { snippet: string; tag: string } }>;
  /**
   * Keep pages from opening for a while. Patterns are "example.com" (the host and its subdomains),
   * "*.example.com" or "example.com/path*", and name either the pages to keep shut (an array, or { deny })
   * or — with { allow } — the only pages that may open, everything else being shut. Either way only the page
   * the user opens is checked, never what it loads: allowing "google.com" allows every image, script and
   * frame google.com pulls in. Only one allowlist can be in place at a time: setting one lifts the last,
   * whose id comes back as replacedAllowlist, so a second call widens or narrows rather than adding.
   * Blocked navigations land on a page that names you and the end time (or on redirect); tabs already there are
   * moved. Without durationMs the block stays until unblock()/clearBlocks() or the user clears it in
   * Settings → Browser; with it, expiresAt says when it lifts. The app's own pages and browser pages can never
   * be blocked (an allowlist always lets them through). Fails when the user switched blocking off.
   * @example const b = await sdk.browser.block(["*.youtube.com"], { durationMs: 30 * 60_000, reason: "focus time, as you asked" });
   * @example await sdk.browser.block({ allow: ["wikipedia.org", "arxiv.org"] }, { durationMs: 60 * 60_000, reason: "the study hour" });
   */
  block(
    patterns: string[] | { allow: string[] } | { deny: string[] },
    options?: { durationMs?: number; redirect?: string; reason?: string },
  ): Promise<{ id: string; mode: "deny" | "allow"; expiresAt: string | null; patterns: string[]; replacedAllowlist?: string }>;
  /** Lift one block early. */
  unblock(id: string): Promise<{ removed: boolean }>;
  /** Blocks currently in place. */
  blocks(): Promise<BrowserBlock[]>;
  /** Lift every block. */
  clearBlocks(): Promise<{ removed: number }>;
  /**
   * Style the images (and pictures/videos) of a page with a CSS filter preset or your own filter value, and/or
   * swap every matching <img> for another picture (an http(s) URL or a pack asset). Gone on navigation; use
   * durationMs to revert earlier. pixelate is approximate. Strict sites (CSP img-src) may refuse a swapped picture.
   * @example await sdk.browser.imageEffect(tab.id, "grayscale", { durationMs: 60_000 });
   */
  imageEffect(tabId: number, effect: BrowserImageEffect, options?: { selector?: string; replaceWith?: AssetRef | string; durationMs?: number }): Promise<{ applied: boolean; replaced: number; total: number }>;
  /** Undo imageEffect() on a page right away. */
  clearImageEffects(tabId: number): Promise<{ cleared: boolean; restored: number }>;
  /** Set (http(s)) or clear (null) the page the browser opens in new tabs and as its home page. */
  setHomePage(url: string | null): Promise<{ url: string | null }>;
  /** The home page currently set, or null. */
  homePage(): Promise<{ url: string | null }>;
  /** Bookmarks and folders (at most 500), optionally only inside a folder given by title or path ("Bookmarks bar/Work"). */
  bookmarks(options?: { folder?: string }): Promise<BrowserBookmark[]>;
  /** Bookmarks whose title or URL contains the words. */
  searchBookmarks(query: string): Promise<BrowserBookmark[]>;
  /** Add a bookmark; folder is a folder title or an "A/B" path, created under "Other bookmarks" when missing. */
  addBookmark(url: string, title: string, options?: { folder?: string }): Promise<BrowserBookmark>;
  /** Remove a bookmark by id, or every bookmark of a URL. Folders are never removed. */
  removeBookmark(idOrUrl: string): Promise<{ removed: number }>;
  /**
   * Run JavaScript in a page and get its return value (the code is the body of an async function; return plain
   * JSON, at most 64 KiB). world "isolated" (default) is tried first, but Chromium's extension CSP refuses eval
   * there, so the code runs in the "main" world (as the page itself; result says world: "main" and fallback);
   * a page whose own CSP forbids eval refuses it, and the error says so. Timeout default 10 s. The user can
   * switch this off.
   * @example const links = await sdk.browser.eval(tab.id, "return [...document.querySelectorAll('a')].map(a => a.href).slice(0, 20)");
   */
  eval(tabId: number, code: string, options?: { world?: "isolated" | "main"; timeoutMs?: number }): Promise<{ value: unknown; world: "isolated" | "main"; fallback?: string }>;
  /**
   * Search the browser history (whole profile; the user can switch this off). since/until: ISO date-time or a
   * number of milliseconds ago; default the last 7 days, limit default 100 (max 500).
   */
  history(options?: { text?: string; since?: string | number; until?: string | number; limit?: number }): Promise<BrowserHistoryItem[]>;
  /** Every recorded visit of one URL. */
  historyVisits(url: string): Promise<Array<{ visitTime: string; transition: string }>>;
  /** The most recently visited pages (default 20). */
  recentHistory(limit?: number): Promise<BrowserHistoryItem[]>;
}`,
  docs: `Open pages and, when the user has installed the browser extension, work inside their browser. Requires the \`browser\` capability.

- \`open(url)\` always works (browser command or extension). Everything else needs the extension, not an open browser: with none running, the first call starts the browser and waits for the extension, so it takes a few seconds. If it still fails with CAPABILITY_FAILED, say so (Settings → Browser in rpchat) instead of retrying.
- Only http/https URLs, only hosts on the user's web allowlist when they set one (PERMISSION_DENIED otherwise). Never open pages the user did not ask for or would not expect; say what you opened.
- Read before you act: \`read()\` for the text, \`query()\` for the links/buttons/fields you need, then \`click()\` / \`type()\`. Keep to one page and a couple of interactions per action; return what you learned, not whole pages.
- Clicks and typing land in the user's real browser session (logged in accounts, forms). Do not submit forms or buy, post or send anything without the user asking for it in this conversation.
- Internal pages (chrome://, the web store) cannot be read or controlled. \`browser-navigated\` (sdk.events) fires when a tab finishes loading a page.
- \`block()\` keeps pages from opening for a while — a denylist (\`["*.social.test"]\`) or an allowlist (\`{ allow: ["wikipedia.org"] }\`, which shuts everything else; a second allowlist replaces the first, so change one by setting it again with the full list). It judges the page the user opens, not what that page loads. Say so when you use it and lift it with \`unblock()\` when asked. \`imageEffect()\` styles or swaps a page's pictures until navigation. \`setHomePage()\` changes what new tabs open. Bookmarks and history are the user's own — read them for what they asked, do not recite them. \`eval()\` runs code in a page: prefer the fixed helpers, keep scripts small and return plain data. Each of these can be switched off in Settings → Browser; then the call fails with CAPABILITY_FAILED and the message says so.

\`\`\`ts
const block = await sdk.browser.block(["*.example-social.com"], { durationMs: 45 * 60_000, reason: "the focus hour you asked for" });
const tab = await sdk.browser.openTab("https://open-meteo.com/");
await sdk.browser.imageEffect(tab.id, "sepia", { durationMs: 120_000 });
const page = await sdk.browser.read(tab.id, { maxChars: 4000 });
return { blockedUntil: block.expiresAt, title: page.title, snippet: page.text.slice(0, 300) };
\`\`\``,
  methods: {
    open: { description: "Open an http(s) URL in the user's browser.", dangerous: true },
    status: { description: 'Whether the browser extension is connected.' },
    tabs: { description: 'List open browser tabs.' },
    openTab: { description: 'Open a URL in a new tab (extension).', dangerous: true },
    activate: { description: 'Bring a tab to the front.' },
    close: { description: 'Close a tab.', dangerous: true },
    navigate: { description: 'Navigate a tab to a URL.', dangerous: true },
    back: { description: 'Go back in a tab.' },
    forward: { description: 'Go forward in a tab.' },
    reload: { description: 'Reload a tab.' },
    read: { description: 'Read the visible text of a page.' },
    query: { description: 'Find elements by CSS selector.' },
    click: { description: 'Click an element on the page.', dangerous: true },
    type: { description: 'Type into a field on the page.', dangerous: true },
    scroll: { description: 'Scroll the page.' },
    screenshot: { description: 'Screenshot the visible tab.', dangerous: true },
    find: { description: 'Find text on the page.' },
    block: { description: 'Block pages matching URL patterns for a while, or allow only those.', dangerous: true },
    unblock: { description: 'Lift one page block.' },
    blocks: { description: 'List active page blocks.' },
    clearBlocks: { description: 'Lift every page block.' },
    imageEffect: { description: 'Apply a CSS filter to, or swap, the images of a page.', dangerous: true },
    clearImageEffects: { description: 'Undo image effects on a page.' },
    setHomePage: { description: "Set or clear the browser's home / new-tab page.", dangerous: true },
    homePage: { description: 'The home page currently set.' },
    bookmarks: { description: 'List bookmarks.' },
    searchBookmarks: { description: 'Search bookmarks.' },
    addBookmark: { description: 'Add a bookmark.', dangerous: true },
    removeBookmark: { description: 'Remove a bookmark.', dangerous: true },
    eval: { description: 'Run JavaScript in a page.', dangerous: true },
    history: { description: 'Search the browser history.' },
    historyVisits: { description: 'Visits of one URL in the browser history.' },
    recentHistory: { description: 'The most recently visited pages.' },
  },
};
