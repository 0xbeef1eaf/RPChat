import type { CapabilityModuleSpec } from '@rp/shared';

export const browserModule: CapabilityModuleSpec = {
  id: 'browser',
  version: '2.0.0',
  title: 'Web browser',
  summary: "Open web pages, and — with the rp-code browser extension connected — list, read, click, type into and screenshot the user's browser tabs.",
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
/**
 * The user's web browser. \`open()\` always works (it runs the browser command from Settings). Everything
 * else drives tabs through the rp-code browser extension, so it needs the extension installed and
 * connected (check \`status()\`); without it those methods fail with CAPABILITY_FAILED. Only http(s)
 * URLs, and only hosts on the user's web allowlist when they set one. Requires the 'browser' capability.
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
  /** Whether the extension is connected, and which browser it runs in. */
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
}`,
  docs: `Open pages and, when the user has installed the browser extension, work inside their browser. Requires the \`browser\` capability.

- \`open(url)\` always works (browser command or extension). Everything else needs the extension: check \`status()\` first, and if it is not connected tell the user (Settings → Browser in rp-code) instead of retrying.
- Only http/https URLs, only hosts on the user's web allowlist when they set one (PERMISSION_DENIED otherwise). Never open pages the user did not ask for or would not expect; say what you opened.
- Read before you act: \`read()\` for the text, \`query()\` for the links/buttons/fields you need, then \`click()\` / \`type()\`. Keep to one page and a couple of interactions per action; return what you learned, not whole pages.
- Clicks and typing land in the user's real browser session (logged in accounts, forms). Do not submit forms or buy, post or send anything without the user asking for it in this conversation.
- Internal pages (chrome://, the web store) cannot be read or controlled. \`browser-navigated\` (sdk.events) fires when a tab finishes loading a page.

\`\`\`ts
const tab = await sdk.browser.openTab("https://open-meteo.com/");
const page = await sdk.browser.read(tab.id, { maxChars: 4000 });
const docs = await sdk.browser.query(tab.id, "a[href*='docs']", { limit: 5 });
if (docs[0]) await sdk.browser.click(tab.id, "a[href*='docs']");
return { title: page.title, snippet: page.text.slice(0, 300), followed: docs[0]?.href ?? null };
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
  },
};
