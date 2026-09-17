/**
 * Chromium enterprise policy for force-installing the bundled extension from the app's loopback
 * update URL (pure; the installer writes it, one file per user). Chrome on Windows/macOS only force-installs Web Store
 * extensions, so the policy is meant for Linux Chrome and every Chromium-based build — see
 * docs/browser-extension.md.
 */
import type { BrowserPolicyJson } from '@rp/shared';

/**
 * The machine-wide file older versions wrote into each managed-policy directory. Installing a
 * per-user policy deletes it: the id and the port in it are one user's, so it never belonged to
 * everybody who uses that browser.
 */
export const LEGACY_BROWSER_POLICY_FILENAME = 'rpchat.json';

/**
 * File name the installer writes into each managed-policy directory: one per user, since the
 * extension id comes from that user's signing key and the port from their settings. The installer
 * leaves it root-owned and readable by that user alone (a POSIX ACL), so another user's browser
 * skips it and the user themselves cannot edit it. Mirrors `browser_policy_file` in
 * `native/rpchatd/install.sh`; a user name that is awkward in a file name falls back to the uid.
 */
export function browserPolicyFilename(user: string, uid: number): string {
  return /^[A-Za-z0-9._-]+$/.test(user) ? `rpchat-${user}.json` : `rpchat-uid-${uid}.json`;
}

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
 * a flat `{ "port": n }` as well. Nothing else belongs in here — the home page in particular is a
 * character's to set through `sdk.browser.setHomePage`, and lives in the extension's new-tab
 * override, not in a policy the user cannot undo.
 */
export function browserPolicy(extensionId: string, port: number, updateUrl: string = updateUrlFor(port)): BrowserPolicyJson {
  return {
    ExtensionInstallForcelist: [`${extensionId};${updateUrl}`],
    ExtensionInstallSources: [`http://127.0.0.1:${port}/*`],
    '3rdparty': { extensions: { [extensionId]: { policy: { port } } } },
  };
}

export function browserPolicyText(extensionId: string, port: number, updateUrl?: string): string {
  return `${JSON.stringify(browserPolicy(extensionId, port, updateUrl), null, 2)}\n`;
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
