/**
 * Browser extension bridge (docs/browser-extension.md): the desktop app accepts one WebSocket per
 * trusted extension id on its loopback server; characters drive tabs through `sdk.browser`.
 */

/** Default TCP port of the app's loopback server, and so of the bridge (`settings.browser.bridgePort`). */
export const BROWSER_BRIDGE_DEFAULT_PORT = 47821;
/** Chrome extension ids are 32 characters, `a`–`p` (hex of the key hash mapped onto letters). */
export const EXTENSION_ID_RE = /^[a-p]{32}$/;

export interface BrowserTabInfo {
  id: number;
  windowId: number;
  /** Empty (or just `chrome://`) for pages the extension does not expose. */
  url: string;
  title: string;
  active: boolean;
  index: number;
}

export interface BrowserBridgeStatus {
  /** A trusted extension is connected and has said hello. */
  connected: boolean;
  /** Id of the connected extension. */
  extensionId?: string;
  /** Browser brands reported by the connected extension ("Chromium 141; Google Chrome 141"). */
  browser?: string;
  /** Port the loopback server is actually listening on. */
  port: number;
  /** `settings.browser.bridgePort`; differs from `port` when that port was taken at start. */
  requestedPort: number;
  /** Extension ids the user has allowed (`settings.browser.trustedExtensionIds`). */
  trusted: string[];
  /** Id the bundled extension gets when installed through the policy (derived from this user's key). */
  installedExtensionId?: string;
  /** Version of the bundled extension (its manifest). */
  extensionVersion?: string;
  /** `http://127.0.0.1:<port>/extension/update.xml` — what the policy points the browser at. */
  updateUrl: string;
  /** Absolute path of the unpacked extension for "Load unpacked"; absent when not bundled. */
  extensionDir?: string;
  /** Extension ids that asked to connect and were refused this run (until trusted in Settings). */
  denied: string[];
  /** `settings.browser.homePage` (mirrored to the extension and the policy). */
  homePage: string;
}

/** A page block installed through `sdk.browser.block` (as `rules.list` reports it). */
export interface BrowserBlock {
  id: string;
  patterns: string[];
  redirect?: string;
  expiresAt?: string;
  /** Character name shown on the blocked page. */
  by?: string;
  /** The character's stated reason, shown on the blocked page. */
  reason?: string;
  createdAt: string;
}

/** Events the extension pushes; `tab-updated` with `status: 'complete'` becomes the `browser-navigated` host event. */
export interface BrowserBridgeEvent {
  event: 'tab-updated' | 'tab-activated' | 'tab-removed';
  data: { tabId: number; windowId?: number; url?: string; title?: string; status?: string };
}

/** Chromium policy JSON the installer writes to every managed-policy directory (`policy.ts`). */
export interface BrowserPolicyJson {
  ExtensionInstallForcelist: string[];
  ExtensionInstallSources: string[];
  '3rdparty': { extensions: Record<string, { policy: { port: number } }> };
  /** `settings.browser.homePage` when set (the new-tab override covers new tabs regardless). */
  HomepageLocation?: string;
  HomepageIsNewTabPage?: boolean;
}
