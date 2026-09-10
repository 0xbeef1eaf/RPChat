import type { CapabilityModuleSpec } from '@rp/shared';

export const browserModule: CapabilityModuleSpec = {
  id: 'browser',
  version: '1.0.0',
  title: 'Web browser',
  summary: "Open a web page in a browser window using the user's configured browser command.",
  permission: 'pack',
  apiTypeName: 'BrowserApi',
  typings: `/**
 * Open http(s) URLs in the user's browser. The app runs the browser command configured in
 * Settings (default: the system default browser). Requires the 'browser' capability.
 */
interface BrowserApi {
  /**
   * Open a URL in a browser window.
   * @param url Must start with http:// or https://. Anything else is rejected.
   * @param options newWindow: ask for a new window rather than a tab when the user's command supports it.
   * @example await sdk.browser.open("https://en.wikipedia.org/wiki/Aurora", { newWindow: true });
   */
  open(url: string, options?: { newWindow?: boolean }): Promise<void>;
}`,
  docs: `Open a web page for the user. Requires the \`browser\` capability.

- Only http/https URLs. Never open pages the user did not ask for or would not expect; tell them what you opened.
- One page per action; do not spam windows.
- Fails with CAPABILITY_FAILED when the user's browser command exits non-zero or its program is missing (the message says which; relay it).

\`\`\`ts
await sdk.browser.open("https://open-meteo.com/");
\`\`\``,
  methods: {
    open: { description: "Open an http(s) URL in the user's browser.", dangerous: true },
  },
};
