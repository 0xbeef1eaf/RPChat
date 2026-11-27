#!/usr/bin/env node
/**
 * Launches Chromium with the unpacked rpchat browser extension for the browser smoke test
 * (scripts/browser-smoke.sh), points the extension at the app's bridge port and keeps the browser
 * open until SIGTERM/SIGINT. Uses playwright-core (a devDependency of @rp/desktop; run from
 * apps/desktop) with an explicit executable: RP_CHROMIUM_BIN, Playwright's registry, or a
 * chromium-* install under $PLAYWRIGHT_BROWSERS_PATH / ~/.cache/ms-playwright.
 *
 * Usage: node scripts/browser-smoke-chromium.mjs --port <n> --extension <dir> --user-data <dir> [--mode unpacked|policy --expect-id <id>]
 * `policy` mode launches without --load-extension and waits for the browser to force-install the
 * extension from the managed policy (scripts/browser-smoke.sh writes it), proving the CRX path.
 *
 * Both modes map the host `smoke.test` onto 127.0.0.1 (so the app can block a loopback page under
 * a name that is not protected) and, once the extension has stored a home page, open
 * chrome://newtab once and report where the new-tab override took it (`[chromium] newtab → <url>`).
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(process.cwd(), 'package.json'));
const { chromium } = require('playwright-core');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get('--port'));
const extensionDir = args.get('--extension');
const userDataDir = args.get('--user-data');
const mode = args.get('--mode') ?? 'unpacked';
const expectId = args.get('--expect-id');
if (!port || !extensionDir || !userDataDir || (mode !== 'unpacked' && mode !== 'policy') || (mode === 'policy' && !expectId)) {
  console.error('usage: browser-smoke-chromium.mjs --port <n> --extension <dir> --user-data <dir> [--mode unpacked|policy --expect-id <id>]');
  process.exit(64);
}

function findChromium() {
  if (process.env.RP_CHROMIUM_BIN && existsSync(process.env.RP_CHROMIUM_BIN)) return process.env.RP_CHROMIUM_BIN;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* not installed for this playwright version */
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', join(homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const bin = join(root, d, 'chrome-linux', 'chrome');
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

const executablePath = findChromium();
if (!executablePath) {
  console.error('[chromium] no Chromium found: set RP_CHROMIUM_BIN or run `pnpm --filter @rp/desktop exec playwright-core install chromium`');
  process.exit(1);
}
console.log(`[chromium] executable ${executablePath}`);
const headless = !process.env.DISPLAY;
// Policy mode must keep background networking (the force-install fetches the update manifest
// and the CRX from the app) and Playwright's default extension switches off.
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless,
  args: [
    '--host-resolver-rules=MAP smoke.test 127.0.0.1',
    ...(mode === 'unpacked'
      ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking']
      : ['--no-first-run', '--no-default-browser-check']),
  ],
  ignoreDefaultArgs: mode === 'unpacked' ? ['--disable-extensions'] : ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-background-networking'],
  viewport: { width: 1024, height: 700 },
});
console.log(`[chromium] launched (mode=${mode}, headless=${headless})`);
const wanted = (w) => mode === 'unpacked' || new URL(w.url()).host === expectId;
let worker = context.serviceWorkers().find(wanted);
const deadline = Date.now() + 60_000;
while (!worker && Date.now() < deadline) {
  try {
    const w = await context.waitForEvent('serviceworker', { timeout: 5000 });
    if (wanted(w)) worker = w;
  } catch {
    /* keep waiting: a force-install needs the policy poll and the CRX download first */
  }
}
if (!worker) {
  console.error(`[chromium] no extension service worker appeared within 60 s${mode === 'policy' ? ` (expected ${expectId} from the managed policy)` : ''}`);
  await context.close().catch(() => undefined);
  process.exit(1);
}
const extensionId = new URL(worker.url()).host;
console.log(`[chromium] extension ${extensionId} service worker ${worker.url()}${mode === 'policy' ? ' (force-installed by policy)' : ''}`);
// Keep one page open so the browser has a window to show tabs in (and so closing a temporary
// extension page during unpacked port setup never closes the browser).
if (context.pages().length === 0) await context.newPage();

const currentWorker = () => context.serviceWorkers().find(wanted) ?? worker;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

if (mode === 'unpacked') {
  // MV3 service workers can still be settling or restart right after `serviceworker` fires,
  // causing a bare `worker.evaluate` to throw or hang. Retry and fall back to an extension page
  // (`popup.html`), which shares `chrome.storage.local` and wakes the worker via `reconnect`.
  let portSet = false;
  let lastErr = '';
  for (let attempt = 1; attempt <= 6 && !portSet; attempt++) {
    try {
      const stored = await withTimeout(
        currentWorker().evaluate(async (p) => {
          await chrome.storage.local.set({ port: p });
          return (await chrome.storage.local.get('port')).port;
        }, port),
        5_000,
        'worker.evaluate(storage.set)',
      );
      if (stored === port) {
        portSet = true;
        console.log(`[chromium] bridge port set to ${port}`);
        break;
      }
      lastErr = `unexpected stored port ${JSON.stringify(stored)}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.log(`[chromium] bridge port set attempt ${attempt} via worker failed (${lastErr}); trying extension page`);
      const extPage = await context.newPage().catch(() => undefined);
      if (extPage) {
        try {
          await extPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
          const stored = await withTimeout(
            extPage.evaluate(async (p) => {
              await chrome.storage.local.set({ port: p });
              await Promise.race([
                chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => undefined),
                new Promise((r) => setTimeout(r, 1000)),
              ]);
              return (await chrome.storage.local.get('port')).port;
            }, port),
            5_000,
            'popup.evaluate(storage.set)',
          );
          if (stored === port) {
            portSet = true;
            console.log(`[chromium] bridge port set to ${port} (via extension page)`);
            break;
          }
          lastErr = `unexpected stored port via popup ${JSON.stringify(stored)}`;
        } catch (popupErr) {
          lastErr = popupErr instanceof Error ? popupErr.message : String(popupErr);
          console.log(`[chromium] bridge port set attempt ${attempt} via extension page failed (${lastErr})`);
        } finally {
          await extPage.close().catch(() => undefined);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!portSet) {
    console.error(`[chromium] failed to set bridge port ${port}: ${lastErr}`);
    await context.close().catch(() => undefined);
    process.exit(1);
  }
} else {
  // The policy's 3rdparty block delivers the port; report what managed storage holds once it lands.
  for (let i = 0; i < 20; i++) {
    const managed = await currentWorker().evaluate(() => chrome.storage.managed.get(null)).catch(() => ({}));
    if (managed && Object.keys(managed).length > 0) {
      console.log(`[chromium] managed storage ${JSON.stringify(managed)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Home page check: when the app has set one (sdk.browser.setHomePage → chrome.storage.local.homePage),
// open a new tab once; the extension's newtab override must take it to that URL.
let newtabChecked = false;
const newtabTimer = setInterval(() => {
  if (newtabChecked) return;
  void (async () => {
    const stored = await currentWorker().evaluate(() => chrome.storage.local.get('homePage')).catch(() => ({}));
    const home = stored && typeof stored.homePage === 'string' ? stored.homePage : undefined;
    if (!home || newtabChecked) return;
    newtabChecked = true;
    console.log(`[chromium] home page stored: ${home}`);
    // A real new tab (no URL → the new-tab page → the extension's override → the home page). The
    // tab is watched through chrome.tabs rather than a Playwright page handle, which the
    // chrome:// → chrome-extension:// → http redirect chain can leave behind.
    const before = new Set((await currentWorker().evaluate(() => chrome.tabs.query({}))).map((t) => t.id));
    const created = await currentWorker().evaluate(() => chrome.tabs.create({}).then((t) => t.id)).catch((err) => {
      console.log(`[chromium] chrome.tabs.create failed (${err.message}); falling back to a Playwright page`);
      return context.newPage().then((p) => p.goto('chrome://newtab/', { waitUntil: 'commit', timeout: 10_000 }).catch(() => undefined)).then(() => undefined);
    });
    const deadline = Date.now() + 15_000;
    let url = '';
    while (Date.now() < deadline) {
      const tabs = await currentWorker().evaluate(() => chrome.tabs.query({})).catch(() => []);
      const tab = tabs.find((t) => (created !== undefined ? t.id === created : !before.has(t.id)));
      url = tab?.url ?? tab?.pendingUrl ?? '';
      if (/^https?:/.test(url)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`[chromium] newtab → ${url || '(no http URL within 15 s)'}${url === home ? ' (home page)' : ''}`);
  })().catch((err) => console.log(`[chromium] newtab check failed: ${err.message}`));
}, 500);

const shutdown = async () => {
  clearInterval(newtabTimer);
  console.log('[chromium] closing');
  await context.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
setInterval(() => undefined, 60_000);
