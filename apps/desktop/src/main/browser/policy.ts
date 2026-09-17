/**
 * Chromium enterprise policy for force-installing the bundled extension from the app's loopback
 * update URL (pure; the installer writes it). Chrome on Windows/macOS only force-installs Web Store
 * extensions, so the policy is meant for Linux Chrome and every Chromium-based build — see
 * docs/browser-extension.md.
 */
import type { BrowserPolicyJson } from '@rp/shared';

/** File name the installer writes into each managed-policy directory. */
export const BROWSER_POLICY_FILENAME = 'rpchat.json';

/**
 * Managed-policy directories of the Chromium-based browsers on Linux. Each browser only reads its
 * own directory. Flatpak builds keep their policies elsewhere (`~/.var/app/<id>/…` is per user and
 * `/var/lib/flatpak/extension/…` is not a policy path) and are documented as manual.
 */
export const BROWSER_POLICY_DIRS: ReadonlyArray<{ browser: string; dir: string }> = [
  { browser: 'Chromium', dir: '/etc/chromium/policies/managed' },
  { browser: 'Google Chrome', dir: '/etc/opt/chrome/policies/managed' },
  { browser: 'Brave', dir: '/etc/brave/policies/managed' },
  { browser: 'Microsoft Edge', dir: '/etc/opt/edge/policies/managed' },
  { browser: 'Vivaldi', dir: '/etc/vivaldi/policies/managed' },
  { browser: 'Opera', dir: '/etc/opera/policies/managed' },
];

export function updateUrlFor(port: number): string {
  return `http://127.0.0.1:${port}/extension/update.xml`;
}

export function crxUrlFor(port: number): string {
  return `http://127.0.0.1:${port}/extension/rpchat.crx`;
}

/**
 * The policy document: force-install from the loopback update URL and hand the extension its port.
 * The `3rdparty` block reaches the extension's `chrome.storage.managed` verbatim (Chromium passes
 * the JSON through, checked against the extension's `schema.json`); the nested `policy` object is
 * the layout Chrome documents for the Windows registry / macOS plist, and the extension accepts
 * a flat `{ "port": n }` as well.
 */
export function browserPolicy(extensionId: string, port: number, updateUrl: string = updateUrlFor(port), homePage?: string): BrowserPolicyJson {
  return {
    ExtensionInstallForcelist: [`${extensionId};${updateUrl}`],
    ExtensionInstallSources: [`http://127.0.0.1:${port}/*`],
    '3rdparty': { extensions: { [extensionId]: { policy: { port } } } },
    // The home page a character set: `HomepageLocation` covers the Home button and browsers where
    // the user disabled the extension's new-tab override; `HomepageIsNewTabPage: false` keeps it a URL.
    ...(homePage && /^https?:\/\//i.test(homePage) ? { HomepageLocation: homePage, HomepageIsNewTabPage: false } : {}),
  };
}

export function browserPolicyText(extensionId: string, port: number, updateUrl?: string, homePage?: string): string {
  return `${JSON.stringify(browserPolicy(extensionId, port, updateUrl, homePage), null, 2)}\n`;
}

/** Omaha v2 update manifest Chromium polls for force-installed extensions. */
export function updateXml(extensionId: string, version: string, crxUrl: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;');
  return [
    `<?xml version='1.0' encoding='UTF-8'?>`,
    `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>`,
    `  <app appid='${esc(extensionId)}'>`,
    `    <updatecheck codebase='${esc(crxUrl)}' version='${esc(version)}' />`,
    `  </app>`,
    `</gupdate>`,
    '',
  ].join('\n');
}
