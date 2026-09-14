/**
 * Development conveniences: `RP_MOCK_LLM=1` swaps every provider for a scripted
 * MockProvider (run_action showing a pack image, then a reply), and the Luna
 * example pack is installed on first run when nothing is installed yet.
 */
import { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MockProvider } from '@rp/llm';
import type { MockTurn } from '@rp/llm';
import type { Engine, Logger, ProviderFactory } from '@rp/core';
import type { BrowserBridgeEvent, HostEvent, LlmChatRequest, ProviderConfig } from '@rp/shared';
import type { LoopbackServer } from './loopback.js';

export const MOCK_PROVIDER_ID = 'mock-dev';

export function isMockLlm(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RP_MOCK_LLM === '1' || env.RP_MOCK_LLM === 'true';
}

const SHOW_IMAGE_CODE = `const images = await sdk.pack.listAssets("", "image");
const videos = await sdk.pack.listAssets("", "video");
const audios = await sdk.pack.listAssets("", "audio");
const pick = images.find(a => a.path.endsWith("teal-card.png")) ?? images[0];
const result = { shown: Boolean(pick), asset: pick ? pick.path : null, video: null, audio: null };
if (pick) {
  const h = await sdk.media.showImage(pick, { durationMs: 20000, position: "bottom-right", width: 320, caption: "hello from the mock model" });
  result.image = h.id;
  // The same picture inside a widget through an asset placeholder (the smoke checks its pixels).
  try {
    const w = await sdk.widgets.show({ id: "smoke-widget", title: "smoke widget", position: "top-left", width: 300, height: 240,
      html: '<body style="margin:0;background:#fff"><img src="{{asset:' + pick.path + '}}" style="display:block;width:280px;height:200px"></body>' });
    result.widget = w.id;
  } catch (err) {
    result.widget = "failed: " + (err && err.message ? err.message : String(err));
  }
}
if (videos[0]) {
  const v = await sdk.media.playVideo(videos[0], { position: "top-right", width: 320, muted: true, loop: true, closeOnEnd: false });
  result.video = v.id;
}
if (audios[0]) {
  const a = await sdk.media.playAudio(audios[0], { volume: 0.5 });
  result.audio = a.id;
}
return result;`;

/**
 * The smoke run's second turn: a question the user answers in a prompt window of its own. Sent
 * as a user message so the whole path is exercised (model → action → sdk.ui.confirm → window →
 * answer → action result).
 */
export const PROMPT_SMOKE_MESSAGE = 'ask me something';

const ASK_CODE = `const answered = await sdk.ui.confirm("Shall I keep the picture up a little longer?");
return { answered };`;

/**
 * The browser smoke's turn: "browse <url>" makes the mock model drive the browser extension
 * end to end (open a tab, read it, find/query, type, click a link, screenshot) and subscribe to
 * `browser-navigated`, whose handler writes what it saw into character state for the smoke to read.
 */
export const BROWSER_SMOKE_MESSAGE = 'browse';
export const BROWSER_SMOKE_STATE_KEY = 'smoke.navigated';

export function browseCodeFor(url: string): string {
  return `const status = await sdk.browser.status();
if (!status.connected) return { status };
if (!(await sdk.events.list()).some((s) => s.label === "smoke-nav")) {
  await sdk.events.on("browser-navigated", async (input) => {
    await sdk.state.set(${JSON.stringify(BROWSER_SMOKE_STATE_KEY)}, input.data);
  }, { filter: { url: "smoke" }, label: "smoke-nav" });
}
const tab = await sdk.browser.openTab(${JSON.stringify(url)});
const page = await sdk.browser.read(tab.id, { maxChars: 2000 });
const links = await sdk.browser.query(tab.id, "a", { limit: 5 });
const found = await sdk.browser.find(tab.id, "smoke page");
const typed = await sdk.browser.type(tab.id, "input#q", "hello smoke");
const scrolled = await sdk.browser.scroll(tab.id, { selector: "a#next" });
const shot = await sdk.browser.screenshot(tab.id);
const clicked = await sdk.browser.click(tab.id, "a#next");
const tabs = await sdk.browser.tabs();
return { status, tab: tab.id, url: page.url, title: page.title, text: page.text.slice(0, 160), links: links.map((l) => l.href), found: found.count, typed, scrolled: scrolled.height > 0, clicked, screenshot: shot.dataUrl.slice(0, 22), screenshotBytes: shot.dataUrl.length, tabs: tabs.length };`;
}

/**
 * The browser smoke's second turn: "exercise <smoke url> <blocked url> <home url>" runs the
 * capabilities added in `sdk.browser` 2.1: block a pattern and try to open it, unblock and open it
 * again, apply an image effect with a pack-asset replacement and read the style back, set the home
 * page, add/search/remove a bookmark, eval in both worlds, and read the history.
 */
export const EXERCISE_SMOKE_MESSAGE = 'exercise';
/** Host the smoke Chromium maps onto 127.0.0.1 (`--host-resolver-rules`) so a loopback page can be blocked (127.0.0.1 itself is protected). */
export const SMOKE_BLOCK_HOST = 'smoke.test';
export const SMOKE_BLOCK_PATTERN = `${SMOKE_BLOCK_HOST}/smoke/page2*`;
export const SMOKE_ASSET = 'media/smoke.png';

export function exerciseCodeFor(smokeUrl: string, blockUrl: string, homeUrl: string): string {
  return `const out = {};
const block = await sdk.browser.block([${JSON.stringify(SMOKE_BLOCK_PATTERN)}], { durationMs: 120000, reason: "smoke test" });
out.block = { id: block.id, expiresAt: block.expiresAt };
const blockedTab = await sdk.browser.openTab(${JSON.stringify(blockUrl)});
out.blockedUrl = blockedTab.url;
out.blocksWhileBlocked = (await sdk.browser.blocks()).length;
out.unblocked = await sdk.browser.unblock(block.id);
out.blocksAfter = (await sdk.browser.blocks()).length;
out.reopenedUrl = (await sdk.browser.navigate(blockedTab.id, ${JSON.stringify(blockUrl)})).url;
await sdk.browser.close(blockedTab.id);
const tab = await sdk.browser.openTab(${JSON.stringify(smokeUrl)});
out.effect = await sdk.browser.imageEffect(tab.id, "grayscale", { replaceWith: ${JSON.stringify(SMOKE_ASSET)} });
const probe = "const img = document.querySelector('img#pic'); await new Promise((r) => { if (img.complete) r(); else { img.onload = r; img.onerror = r; setTimeout(r, 3000); } }); return { filter: getComputedStyle(img).filter, src: img.getAttribute('src'), original: img.getAttribute('data-rp-original-src'), loaded: img.complete && img.naturalWidth > 0 };";
out.styled = (await sdk.browser.eval(tab.id, probe)).value;
out.cleared = await sdk.browser.clearImageEffects(tab.id);
out.restored = (await sdk.browser.eval(tab.id, probe)).value;
out.home = await sdk.browser.setHomePage(${JSON.stringify(homeUrl)});
out.homeGet = await sdk.browser.homePage();
const bm = await sdk.browser.addBookmark(${JSON.stringify(smokeUrl)}, "rp-code smoke page", { folder: "rp-code smoke/Pages" });
out.bookmark = bm;
out.bookmarkFound = (await sdk.browser.searchBookmarks("rp-code smoke page")).map((b) => b.url);
out.bookmarkListed = (await sdk.browser.bookmarks({ folder: "rp-code smoke/Pages" })).map((b) => b.url);
out.bookmarkRemoved = await sdk.browser.removeBookmark(bm.id);
out.bookmarkLeft = (await sdk.browser.searchBookmarks("rp-code smoke page")).filter((b) => b.url).length;
out.evalIsolated = await sdk.browser.eval(tab.id, "return document.title");
out.evalMain = await sdk.browser.eval(tab.id, "return window.location.href", { world: "main" });
out.evalHasNewFunction = (await sdk.browser.eval(tab.id, "return typeof Function === 'function' && new Function('return 6 * 7')()")).value;
out.history = (await sdk.browser.history({ text: "smoke" })).map((h) => h.url);
out.visits = (await sdk.browser.historyVisits(${JSON.stringify(smokeUrl)})).length;
out.recent = (await sdk.browser.recentHistory(5)).length;
return out;`;
}

/** Last message carries a tool result → this is the second round of the turn. */
export function lastMessageHasToolResult(request: LlmChatRequest): boolean {
  const last = request.messages[request.messages.length - 1];
  return Boolean(last && last.role === 'user' && last.content.some((part) => part.type === 'tool_result'));
}

/** The scripted mock turn for a request (pure; exported for tests). */
export function mockTurnFor(request: LlmChatRequest): MockTurn {
  if (lastMessageHasToolResult(request)) {
    return { text: "There, that's me. (This reply comes from the built-in mock model: set RP_MOCK_LLM=0 and add a real provider in Settings to chat for real.)" };
  }
  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
  const text = lastUser?.content.find((p) => p.type === 'text');
  const full = text && text.type === 'text' ? text.text.trim() : '';
  const echo = full.slice(0, 80);
  const asking = echo.toLowerCase().startsWith(PROMPT_SMOKE_MESSAGE);
  const exercising = echo.toLowerCase().startsWith(EXERCISE_SMOKE_MESSAGE);
  const browsing = !exercising && echo.toLowerCase().startsWith(BROWSER_SMOKE_MESSAGE);
  const urls = full.match(/https?:\/\/\S+/g) ?? [];
  const browseUrl = browsing ? (urls[0] ?? 'https://example.com/') : '';
  const code = asking ? ASK_CODE : browsing ? browseCodeFor(browseUrl) : exercising ? exerciseCodeFor(urls[0] ?? 'https://example.com/', urls[1] ?? 'https://example.com/2', urls[2] ?? 'https://example.com/home') : SHOW_IMAGE_CODE;
  const purpose = asking ? 'ask the user a yes/no question' : browsing ? 'open and read a page in the browser' : exercising ? 'block, style, bookmark, script and look up pages in the browser' : 'show a picture from the pack';
  if (!request.tools || request.tools.length === 0) {
    return { text: `Mock reply${echo ? ` to "${echo}"` : ''}.\n\n\`\`\`action\n${code}\n\`\`\`` };
  }
  return {
    text: asking ? 'Let me ask you something.' : browsing ? 'Let me have a look at that page.' : exercising ? 'Let me try the rest of the browser.' : echo ? `You said "${echo}". Let me show you something.` : 'Let me show you something.',
    toolCalls: [{ name: 'run_action', input: { purpose, code } }],
  };
}

export function mockProviderFactory(): ProviderFactory {
  return (config: ProviderConfig) => new MockProvider({ ...config, kind: 'mock' }, { respond: mockTurnFor, chunks: 6 });
}

/** Make sure a default provider exists so `chat.send` works without configuration. */
export async function ensureMockProvider(engine: Engine, logger: Logger): Promise<void> {
  const settings = await engine.settings.get();
  if (settings.providers.some((p) => p.id === MOCK_PROVIDER_ID)) {
    if (settings.defaultProviderId !== MOCK_PROVIDER_ID) await engine.settings.update({ defaultProviderId: MOCK_PROVIDER_ID });
    return;
  }
  await engine.settings.update({
    providers: [...settings.providers, { id: MOCK_PROVIDER_ID, kind: 'mock', label: 'Mock model (dev)', model: 'mock-1' }],
    defaultProviderId: MOCK_PROVIDER_ID,
  });
  logger.info('[dev] RP_MOCK_LLM=1: registered the mock provider as default');
}

/** Locate `examples/packs/luna`: `RP_EXAMPLE_PACK`, else walk upward from the app root (dev checkout). */
export function findExamplePack(appRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (env.RP_EXAMPLE_PACK) candidates.push(env.RP_EXAMPLE_PACK);
  // Packaged builds ship the sample pack as an extra resource (see electron-builder `extraResources`).
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'packs', 'luna'));
  let dir = path.resolve(appRoot);
  for (let i = 0; i < 6; i += 1) {
    candidates.push(path.join(dir, 'examples', 'packs', 'luna'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((p) => fs.existsSync(path.join(p, 'pack.json')));
}

/** Install the example pack when no packs are installed (permissions are app-wide; nothing to grant). */
export async function ensureExamplePack(engine: Engine, appRoot: string, logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const installed = await engine.storage.packs.list();
  if (installed.length > 0) return;
  const source = findExamplePack(appRoot, env);
  if (!source) {
    logger.info('[dev] no packs installed and examples/packs/luna not found; skipping auto-install');
    return;
  }
  try {
    const view = await engine.packs.install(source);
    logger.info(`[dev] installed example pack ${view.packId}@${view.version} from ${source}`);
  } catch (err) {
    logger.warn(`[dev] auto-install of ${source} failed`, err);
  }
}

/** Locate `examples/plugins/clock`: `RP_EXAMPLE_PLUGIN`, else walk upward from the app root (dev checkout). */
export function findExamplePlugin(appRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (env.RP_EXAMPLE_PLUGIN) candidates.push(env.RP_EXAMPLE_PLUGIN);
  let dir = path.resolve(appRoot);
  for (let i = 0; i < 6; i += 1) {
    candidates.push(path.join(dir, 'examples', 'plugins', 'clock'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((p) => fs.existsSync(path.join(p, 'plugin.json')));
}

/** Smoke: install the example plugin (when available) and log its state so CI proves plugin loading. */
export async function smokeLoadPlugin(plugins: { install(dir?: string): Promise<{ state: string; error?: string } | null>; list(): Array<{ id: string; state: string; error?: string }> }, appRoot: string, logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const source = findExamplePlugin(appRoot, env);
  if (!source) {
    logger.info('[smoke] plugin clock: skipped (examples/plugins/clock not found)');
    return;
  }
  try {
    const info = plugins.list().find((p) => p.id === 'dev.rp-code.clock') ?? (await plugins.install(source));
    if (!info) logger.warn('[smoke] plugin clock: install returned nothing');
    else logger[info.state === 'active' ? 'info' : 'error'](`[smoke] plugin clock: ${info.state}${info.error ? ` (${info.error})` : ''}`);
  } catch (err) {
    logger.error(`[smoke] plugin clock: error (${(err as Error).message})`);
  }
}

/**
 * Smoke runs capture model traffic (Settings → General → Debug in a real run) so the tour can open
 * the Model traffic drawer. Must run before the main window loads: the renderer reads settings once at boot.
 */
export async function smokeEnableModelTraffic(engine: Engine): Promise<void> {
  await engine.settings.update({ debug: { showModelTraffic: true } });
}

export function isSmokeRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RP_SMOKE === '1';
}

/** `RP_SMOKE_BROWSER=1`: the smoke run drives the browser extension instead of the media tour. */
export function isBrowserSmokeRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSmokeRun(env) && env.RP_SMOKE_BROWSER === '1';
}

export const SMOKE_PAGE_PATH = '/smoke/page.html';
export const SMOKE_PAGE2_PATH = '/smoke/page2.html';
export const SMOKE_HOME_PATH = '/smoke/home.html';
export const SMOKE_IMAGE_PATH = '/smoke/dot.png';
export const SMOKE_PAGE_TEXT = 'Hello from the rp-code smoke page';

/** A 1×1 red PNG: the smoke page's picture and the pack asset `imageEffect` swaps in. */
export const SMOKE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

/** The tiny pages the browser smoke opens (served by the loopback server, any origin). */
export function smokePage(which: 1 | 2 | 3): string {
  if (which === 2) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>rp-code smoke page 2</title></head><body><h1>Second smoke page</h1><p>You followed the link.</p></body></html>`;
  }
  if (which === 3) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>rp-code smoke home</title></head><body><h1>Smoke home page</h1><p>Opened by the new-tab override.</p></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>rp-code smoke page</title></head><body style="font:16px sans-serif">
<h1>${SMOKE_PAGE_TEXT}</h1>
<p>This page exists so the browser extension can be exercised end to end.</p>
<p><img id="pic" src="${SMOKE_IMAGE_PATH}" width="48" height="48" alt="smoke dot"></p>
<form onsubmit="return false"><label>Query <input id="q" name="q" type="text"></label></form>
<p style="margin-top:1400px"><a id="next" href="${SMOKE_PAGE2_PATH}">Next page</a></p>
</body></html>`;
}

export function registerSmokePages(loopback: LoopbackServer): void {
  loopback.route('/smoke', (_req, res, url) => {
    if (url.pathname === SMOKE_IMAGE_PATH) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(SMOKE_PNG.length) });
      res.end(SMOKE_PNG);
      return;
    }
    const which = url.pathname === SMOKE_PAGE2_PATH ? 2 : url.pathname === SMOKE_PAGE_PATH ? 1 : url.pathname === SMOKE_HOME_PATH ? 3 : 0;
    if (which === 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(smokePage(which));
  });
}

/** A minimal pack whose character has the `browser` capability, written under `dir`. */
export async function writeBrowserSmokePack(dir: string): Promise<{ packId: string; characterRef: string }> {
  const packId = 'dev.rp-code.browser-smoke';
  const characterDir = path.join(dir, 'characters', 'smokey');
  await fs.promises.mkdir(characterDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, 'pack.json'),
    JSON.stringify({ formatVersion: 1, id: packId, name: 'Browser smoke', version: '1.0.0', description: 'Exercises the browser extension in smoke runs.', characters: ['characters/smokey'] }, null, 2),
  );
  await fs.promises.writeFile(path.join(characterDir, 'character.json'), JSON.stringify({ id: 'smokey', name: 'Smokey', persona: 'persona.md', greeting: 'Ready to browse.' }, null, 2));
  await fs.promises.writeFile(path.join(characterDir, 'persona.md'), 'Smokey is a test character that drives the browser extension.\n');
  await fs.promises.mkdir(path.join(dir, 'media'), { recursive: true });
  await fs.promises.writeFile(path.join(dir, SMOKE_ASSET), SMOKE_PNG);
  return { packId, characterRef: `${packId}/smokey` };
}

export interface BrowserSmokeServices {
  engine: Engine;
  loopback: LoopbackServer;
  browser: { readonly connected: boolean; onEvent(listener: (event: BrowserBridgeEvent) => void): () => void; status(): Promise<{ connected: boolean; browser?: string; extensionId?: string; port: number }> };
  senses: { provider: { subscribe(listener: (event: HostEvent) => void): () => void } };
  userData: string;
}

/**
 * `RP_SMOKE_BROWSER=1`: serve the smoke pages, wait for the extension (the smoke script launches
 * Chromium with it once the port line below is logged), then run one mock turn that drives the
 * browser through `sdk.browser` and prove that the `browser-navigated` host event reached both a
 * host-level subscriber and the character's own `sdk.events` handler.
 */
export async function runBrowserSmoke(services: BrowserSmokeServices, logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { engine, loopback } = services;
  registerSmokePages(loopback);
  logger.info(`[smoke] browser bridge listening on port ${loopback.listeningPort}`);
  const navigated: string[] = [];
  const bridgeEvents: string[] = [];
  const offBridge = services.browser.onEvent((ev) => bridgeEvents.push(`${ev.event}:${ev.data.status ?? ''}`));
  const offHost = services.senses.provider.subscribe((ev) => {
    if (ev.name === 'browser-navigated') {
      const data = ev.data as { url?: string } | null;
      navigated.push(String(data?.url ?? ''));
    }
  });
  const actionResults: unknown[] = [];
  const errors: string[] = [];
  const offChat = engine.events.on('chat', (ev) => {
    if (ev.type === 'action-finished') {
      actionResults.push(ev.action.result?.ok ? ev.action.result.returnValue : { error: ev.action.result?.error });
      logger.info(`[smoke] browser action ${ev.action.result?.ok ? 'ok' : 'failed'}: ${JSON.stringify(ev.action.result?.returnValue ?? ev.action.result?.error ?? null).slice(0, 900)} calls=${JSON.stringify((ev.action.result?.calls ?? []).map((c) => `${c.module}.${c.method}:${c.ok ? 'ok' : c.error?.code}`))}`);
    }
    if (ev.type === 'error') errors.push(`${ev.error.code}: ${ev.error.message}`);
  });
  try {
    const waitMs = Number(env.RP_SMOKE_BROWSER_WAIT_MS) || 90_000;
    const started = Date.now();
    while (!services.browser.connected && Date.now() - started < waitMs) await new Promise((r) => setTimeout(r, 250));
    const status = await services.browser.status();
    if (!status.connected) {
      logger.error(`[smoke] verify browser: FAIL (no extension connected within ${Math.round(waitMs / 1000)} s; port ${status.port})`);
      return;
    }
    logger.info(`[smoke] browser extension connected: ${status.extensionId} (${status.browser})`);

    const packDir = path.join(services.userData, 'smoke-browser-pack');
    const { packId, characterRef } = await writeBrowserSmokePack(packDir);
    if (!engine.packs.tryGetLoaded(packId)) {
      await engine.packs.install(packDir);
    }
    const session = await engine.sessions.create({ characterRef, title: 'browser smoke' });
    const url = `http://127.0.0.1:${loopback.listeningPort}${SMOKE_PAGE_PATH}`;
    await engine.chat.send(session.id, `${BROWSER_SMOKE_MESSAGE} ${url}`);
    const result = actionResults.find((r) => r && typeof r === 'object' && 'tab' in (r as object)) as Record<string, unknown> | undefined;
    const problems: string[] = [];
    if (!result) problems.push(`no browser action result (errors: ${errors.join('; ') || 'none'})`);
    else {
      if (typeof result['text'] !== 'string' || !result['text'].includes(SMOKE_PAGE_TEXT)) problems.push(`read text: ${JSON.stringify(result['text'])}`);
      if (result['title'] !== 'rp-code smoke page') problems.push(`title: ${JSON.stringify(result['title'])}`);
      if (!Array.isArray(result['links']) || !result['links'].some((l) => typeof l === 'string' && l.endsWith(SMOKE_PAGE2_PATH))) problems.push(`query links: ${JSON.stringify(result['links'])}`);
      if (result['found'] !== 1) problems.push(`find count: ${JSON.stringify(result['found'])}`);
      if (!(result['typed'] && typeof result['typed'] === 'object' && (result['typed'] as { typed?: unknown }).typed === true)) problems.push(`type: ${JSON.stringify(result['typed'])}`);
      if (!(result['clicked'] && typeof result['clicked'] === 'object' && (result['clicked'] as { clicked?: unknown }).clicked === true)) problems.push(`click: ${JSON.stringify(result['clicked'])}`);
      if (result['screenshot'] !== 'data:image/png;base64,' || Number(result['screenshotBytes']) < 1000) problems.push(`screenshot: ${JSON.stringify(result['screenshot'])} (${String(result['screenshotBytes'])} bytes)`);
      if (result['scrolled'] !== true) problems.push('scroll');
    }
    // The click navigates to page 2: the host event must reach the host subscriber and the character's handler.
    const deadline = Date.now() + 20_000;
    const stateScope = `char:${characterRef}`;
    let handlerSaw: unknown;
    while (Date.now() < deadline) {
      handlerSaw = await engine.storage.state.get(stateScope, BROWSER_SMOKE_STATE_KEY);
      if (navigated.some((u) => u.endsWith(SMOKE_PAGE2_PATH)) && handlerSaw) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!navigated.some((u) => u.endsWith(SMOKE_PAGE2_PATH))) problems.push(`browser-navigated host event for page 2 not seen (saw: ${JSON.stringify(navigated)}; bridge events: ${bridgeEvents.slice(-6).join(', ')})`);
    const handlerUrl = handlerSaw && typeof handlerSaw === 'object' ? (handlerSaw as { url?: unknown }).url : undefined;
    if (typeof handlerUrl !== 'string' || !handlerUrl.includes('/smoke/')) problems.push(`sdk.events handler did not record a navigation (state: ${JSON.stringify(handlerSaw)})`);
    const ok = problems.length === 0;
    logger[ok ? 'info' : 'error'](`[smoke] verify browser: ${ok ? 'PASS' : 'FAIL'} (${ok ? `extension ${status.extensionId}, read ${String((result?.['text'] as string | undefined)?.length ?? 0)} chars, ${String((result?.['links'] as unknown[] | undefined)?.length ?? 0)} link(s), screenshot ${String(result?.['screenshotBytes'])} bytes, navigated ${navigated.length} event(s), handler saw ${String(handlerUrl)}` : problems.join(' | ')})`);

    // Second turn: the 2.1 capabilities (block, image effect, home page, bookmarks, eval, history).
    const port = loopback.listeningPort;
    const blockUrl = `http://${SMOKE_BLOCK_HOST}:${port}${SMOKE_PAGE2_PATH}`;
    const homeUrl = `http://127.0.0.1:${port}${SMOKE_HOME_PATH}`;
    await engine.chat.send(session.id, `${EXERCISE_SMOKE_MESSAGE} ${url} ${blockUrl} ${homeUrl}`);
    const ex = actionResults.find((r) => r && typeof r === 'object' && 'evalIsolated' in (r as object)) as Record<string, unknown> | undefined;
    const caps: string[] = [];
    const bad: string[] = [];
    const check = (name: string, good: boolean, detail: string): void => {
      (good ? caps : bad).push(`${name}: ${detail}`);
    };
    if (!ex) bad.push(`no exercise action result (errors: ${errors.join('; ') || 'none'}; last result: ${JSON.stringify(actionResults.at(-1)).slice(0, 400)})`);
    else {
      const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
      const blockedUrl = String(ex['blockedUrl'] ?? '');
      const reopened = String(ex['reopenedUrl'] ?? '');
      check(
        'block',
        blockedUrl !== blockUrl && (blockedUrl.startsWith('chrome-extension://') || blockedUrl === '') && ex['blocksWhileBlocked'] === 1 && obj(ex['unblocked'])['removed'] === true && ex['blocksAfter'] === 0 && reopened === blockUrl,
        `opening ${blockUrl} landed on ${JSON.stringify(blockedUrl) || 'the blocked page'} while blocked, blocks=${String(ex['blocksWhileBlocked'])}→${String(ex['blocksAfter'])}, reopened ${reopened === blockUrl ? 'fine' : JSON.stringify(reopened)} after unblock`,
      );
      const styled = obj(ex['styled']);
      const restored = obj(ex['restored']);
      const assetPath = `/asset/${packId}/${SMOKE_ASSET}`;
      check(
        'imageEffect',
        obj(ex['effect'])['replaced'] === 1 && styled['filter'] === 'grayscale(1)' && String(styled['src']).includes(assetPath) && String(styled['original']).endsWith(SMOKE_IMAGE_PATH) && styled['loaded'] === true && obj(ex['cleared'])['restored'] === 1 && restored['filter'] === 'none' && String(restored['src']).endsWith(SMOKE_IMAGE_PATH),
        `filter ${String(styled['filter'])}, src ${String(styled['src']).includes(assetPath) ? 'pack asset' : JSON.stringify(styled['src'])} (loaded=${String(styled['loaded'])}), restored → ${String(restored['filter'])} ${String(restored['src'])}`,
      );
      check('homePage', obj(ex['home'])['url'] === homeUrl && obj(ex['homeGet'])['url'] === homeUrl, `set ${String(obj(ex['home'])['url'])}`);
      const bm = obj(ex['bookmark']);
      check(
        'bookmarks',
        bm['url'] === url && bm['path'] === 'Other bookmarks/rp-code smoke/Pages' && Array.isArray(ex['bookmarkFound']) && ex['bookmarkFound'].includes(url) && Array.isArray(ex['bookmarkListed']) && ex['bookmarkListed'].includes(url) && obj(ex['bookmarkRemoved'])['removed'] === 1 && ex['bookmarkLeft'] === 0,
        `added in ${String(bm['path'])}, found ${String((ex['bookmarkFound'] as unknown[] | undefined)?.length)}, listed ${String((ex['bookmarkListed'] as unknown[] | undefined)?.length)}, removed ${String(obj(ex['bookmarkRemoved'])['removed'])}, left ${String(ex['bookmarkLeft'])}`,
      );
      const iso = obj(ex['evalIsolated']);
      const main = obj(ex['evalMain']);
      // The isolated world refuses `new Function` (extension CSP); the extension falls back to the main world and says so.
      check(
        'eval',
        iso['value'] === 'rp-code smoke page' && (iso['world'] === 'isolated' || (iso['world'] === 'main' && typeof iso['fallback'] === 'string')) && main['value'] === url && main['world'] === 'main' && ex['evalHasNewFunction'] === 42,
        `isolated request → ${JSON.stringify(iso['value'])} in the ${String(iso['world'])} world${iso['fallback'] ? ' (fallback: isolated world refuses eval, extension CSP)' : ''}, main → ${JSON.stringify(main['value'])}, new Function → ${String(ex['evalHasNewFunction'])}`,
      );
      check(
        'history',
        Array.isArray(ex['history']) && ex['history'].includes(url) && Number(ex['visits']) >= 1 && Number(ex['recent']) >= 1,
        `${String((ex['history'] as unknown[] | undefined)?.length)} entries for "smoke" (smoke page ${Array.isArray(ex['history']) && ex['history'].includes(url) ? 'included' : 'missing'}), ${String(ex['visits'])} visit(s), ${String(ex['recent'])} recent`,
      );
    }
    // The launcher opens chrome://newtab once the extension stored the home page; the override must land on it.
    const homeDeadline = Date.now() + 25_000;
    while (Date.now() < homeDeadline && !navigated.includes(homeUrl)) await new Promise((r) => setTimeout(r, 250));
    check('newtab', navigated.includes(homeUrl), navigated.includes(homeUrl) ? `a new tab navigated to ${homeUrl}` : `no browser-navigated event for ${homeUrl} (saw ${JSON.stringify(navigated.slice(-5))})`);
    const capsOk = bad.length === 0;
    logger[capsOk ? 'info' : 'error'](`[smoke] verify browser capabilities: ${capsOk ? 'PASS' : 'FAIL'} (${[...caps, ...bad.map((b) => `FAILED ${b}`)].join(' | ')})`);
  } catch (err) {
    logger.error('[smoke] verify browser: FAIL', err);
  } finally {
    offChat();
    offBridge();
    offHost();
    logger.info('[smoke] browser smoke done');
  }
}

/**
 * `RP_SMOKE=1`: drive one mock turn through the engine (session → message → run_action →
 * media overlay) and log what happened, so a headless run can prove the whole path.
 */
export async function runSmokeTurn(engine: Engine, logger: Logger, mediaList: () => unknown[], prepareTour?: () => Promise<void>): Promise<void> {
  const character = engine.packs.characters()[0];
  if (!character) {
    logger.warn('[smoke] no character available');
    return;
  }
  const events: string[] = [];
  let exchanges = 0;
  const off = engine.events.on('chat', (ev) => {
    events.push(ev.type === 'error' ? `error(${ev.error.code}: ${ev.error.message})` : ev.type);
    if (ev.type === 'model-exchange') exchanges += 1;
    if (ev.type === 'action-finished') logger.info(`[smoke] action ${ev.action.result?.ok ? 'ok' : 'failed'}: ${JSON.stringify(ev.action.result?.returnValue ?? ev.action.result?.error ?? null)} calls=${JSON.stringify((ev.action.result?.calls ?? []).map((c) => `${c.module}.${c.method}:${c.ok ? 'ok' : c.error?.code}`))}`);
  });
  try {
    const session = await engine.sessions.create({ characterRef: character.ref, title: 'smoke' });
    logger.info(`[smoke] session ${session.id} with ${character.ref}`);
    await engine.chat.send(session.id, 'hi there, show me something');
    logger.info(`[smoke] chat events: ${events.join(' → ')}`);
    logger.info(`[smoke] model exchanges: ${exchanges}`);
    await new Promise((r) => setTimeout(r, 1500));
    logger.info(`[smoke] open media items: ${JSON.stringify(mediaList())}`);
    const messages = await engine.sessions.messages(session.id);
    logger.info(`[smoke] transcript: ${messages.map((m) => `${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 60)}`).join(' | ')}`);
    if (prepareTour) await prepareTour().catch((err: unknown) => logger.warn('[smoke] tour preparation failed', err));
    // The media checks come first and on their own clock: the mock turn's image closes itself
    // after 20 s, so nothing slower may run before the tour and the compositor captures.
    await captureWindows(logger, mediaList);
    await verifyPromptWindow(engine, session.id, logger);
    logger.info('[smoke] smoke done');
  } catch (err) {
    logger.error('[smoke] turn failed', err);
  } finally {
    off();
  }
}

/** The window a `sdk.ui` question or a permission request opened (`prompt.html`). */
function promptWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && (w.getTitle().endsWith(' asks') || w.getTitle().endsWith(' needs permission')));
}

/** Never let a smoke step hang on a turn that is waiting for an answer nobody will give. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Prove a character's question reaches the user in a window of its own and that answering it
 * there gets back into the action: send a message the mock model answers with `sdk.ui.confirm`,
 * wait for the window, screenshot it, click Yes in it, and check what the action returned.
 * The turn is deliberately not awaited first — it cannot finish until the question is answered.
 */
export async function verifyPromptWindow(engine: Engine, sessionId: string, logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let returned: unknown = null;
  const off = engine.events.on('chat', (ev) => {
    if (ev.type === 'action-finished') returned = ev.action.result?.returnValue ?? null;
  });
  const turn = engine.chat.send(sessionId, PROMPT_SMOKE_MESSAGE).catch((err: unknown) => logger.warn('[smoke] prompt turn failed', err));
  try {
    // Wait for the window to be on screen, not merely constructed: a compositor that has not
    // mapped it yet refuses to capture it.
    let win: BrowserWindow | undefined;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      win = promptWindow();
      if (win?.isVisible()) break;
    }
    if (!win) {
      logger.error('[smoke] verify prompt: FAIL (no prompt window opened for sdk.ui.confirm)');
      return;
    }
    const bounds = win.getBounds();
    logger.info(`[smoke] prompt window "${win.getTitle()}" ${bounds.width}x${bounds.height} visible=${win.isVisible()} focused=${win.isFocused()} onTop=${win.isAlwaysOnTop()}`);
    const dir = env.RP_SCREENSHOT_DIR;
    if (dir) {
      // Diagnostics: a capture the compositor refuses must not cost us the check itself.
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, '00-prompt-window.png');
        await fs.promises.writeFile(file, (await win.webContents.capturePage()).toPNG());
        logger.info(`[smoke] screenshot ${file}`);
      } catch (err) {
        logger.warn('[smoke] prompt window capture failed', err);
      }
    }
    const question = String(await win.webContents.executeJavaScript(`(() => document.querySelector('.prompt-card p')?.textContent ?? '')()`, true));
    // Answering destroys the window, which can leave this call's reply promise pending for
    // good — so bound it and judge the click by what the action got back, not by its result.
    const clicked = await settledWithin(
      win.webContents
        .executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Yes'); b?.click(); return Boolean(b); })()`, true)
        .catch(() => undefined),
      3_000,
    );
    await settledWithin(turn, 10_000);
    const answered = Boolean(returned && typeof returned === 'object' && (returned as { answered?: unknown }).answered === true);
    const ok = answered && question.length > 0;
    logger[ok ? 'info' : 'error'](
      `[smoke] verify prompt: ${ok ? 'PASS' : 'FAIL'} (question="${question.slice(0, 60)}", clickedYes=${clicked ?? 'window closed before it replied'}, actionReturned=${JSON.stringify(returned)})`,
    );
  } catch (err) {
    logger.error('[smoke] verify prompt: FAIL', err);
  } finally {
    off();
    // An unanswered question would otherwise hold this for the host-call timeout (10 minutes).
    await settledWithin(turn, 10_000);
  }
}

/**
 * `RP_SCREENSHOT_DIR=<dir>`: after the smoke turn, capture every BrowserWindow (main UI and
 * overlays) to `<dir>/<n>-<kind>.png` via Electron, so a headful run under Xvfb can be inspected.
 */
export async function captureWindows(logger: Logger, mediaList: () => unknown[] = () => [], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = env.RP_SCREENSHOT_DIR;
  if (!dir) return;
  logger.debug(`[smoke] capture: start (dir ${dir})`);
  await fs.promises.mkdir(dir, { recursive: true });
  await new Promise((r) => setTimeout(r, 800));
  let n = 0;
  const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === 'rp-code');
  logger.debug(`[smoke] capture: windows=${BrowserWindow.getAllWindows().map((w) => w.getTitle()).join(', ')} main=${Boolean(main)}`);
  // Tour the main UI: open the smoke session (chat with the action card), then Packs and Settings.
  const tour: Array<[string, string]> = [
    ['chat-session', "document.querySelector('.session-item')?.click()"],
    ['chat-model-traffic', "[...document.querySelectorAll('.chat-header button')].find(b => b.textContent.trim().startsWith('Model traffic'))?.click()"],
    ['chat-model-traffic-open', "document.querySelector('.traffic-summary')?.click(); document.querySelector('.traffic-summary')?.scrollIntoView()"],
    ['chat-model-traffic-close', "[...document.querySelectorAll('.session-panel .btn')].find(b => b.textContent.trim() === 'Close')?.click()"],
    ['packs', "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim().startsWith('Packs'))?.click()"],
    ['settings', "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim().startsWith('Settings'))?.click()"],
    ['settings-updates', "[...document.querySelectorAll('.tabs .tab')].find(b => b.textContent.trim() === 'Updates')?.click()"],
    ['settings-browser', "[...document.querySelectorAll('.tabs .tab')].find(b => b.textContent.trim() === 'Browser')?.click()"],
    ['settings-system', "[...document.querySelectorAll('.tabs .tab')].find(b => b.textContent.trim() === 'System')?.click()"],
    ['sdk-reference', "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim().startsWith('SDK'))?.click()"],
    ['editor-projects', "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim().startsWith('Pack editor'))?.click()"],
    ['editor-pack', "document.querySelector('.project-card .btn-primary')?.click()"],
    ['editor-character', "[...document.querySelectorAll('.editor-rail button')].find(b => /luna/i.test(b.textContent))?.click()"],
    ['editor-scripts', "[...document.querySelectorAll('.editor-rail button')].find(b => b.textContent.trim().startsWith('Scripts'))?.click()"],
    ['editor-media', "[...document.querySelectorAll('.editor-rail button')].find(b => b.textContent.trim().startsWith('Media'))?.click()"],
    ['editor-publish', "[...document.querySelectorAll('.editor-rail button')].find(b => /Check/.test(b.textContent))?.click()"],
  ];
  if (main) {
    for (const [name, script] of tour) {
      try {
        logger.debug(`[smoke] capture: tour step ${name}`);
        await main.webContents.executeJavaScript(`(() => { ${script}; return true; })()`, true);
        await new Promise((r) => setTimeout(r, 700));
        const image = await main.webContents.capturePage();
        const file = path.join(dir, `${String(++n).padStart(2, '0')}-main-${name}.png`);
        await fs.promises.writeFile(file, image.toPNG());
        logger.info(`[smoke] screenshot ${file}`);
      } catch (err) {
        logger.warn(`[smoke] tour step ${name} failed`, err);
      }
    }
  }
  await verifyMedia(logger, mediaList);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const title = (win.getTitle() || 'window').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60);
    const bounds = win.getBounds();
    try {
      const image = await win.webContents.capturePage();
      const file = path.join(dir, `${String(++n).padStart(2, '0')}-${title}.png`);
      await fs.promises.writeFile(file, image.toPNG());
      logger.info(`[smoke] screenshot ${file} (${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}, visible=${win.isVisible()})`);
    } catch (err) {
      logger.warn(`[smoke] screenshot of ${title} failed`, err);
    }
  }
  logger.info(`[smoke] screenshots done (${n} files in ${dir})`);
}


interface PixelStats {
  width: number;
  height: number;
  opaque: number;
  /** Fraction of opaque pixels within `tolerance` of `target` (when given). */
  match: number;
  /** Distinct colours among sampled opaque pixels (quantised to 4 bits per channel). */
  distinct: number;
  /** Mean RGB of opaque pixels. */
  mean: [number, number, number];
}

/** Pixel statistics from a window capture (BGRA bitmap). Pure enough for the checks below. */
export function pixelStats(bitmap: Buffer, width: number, height: number, target?: [number, number, number], tolerance = 40): PixelStats {
  let opaque = 0;
  let matched = 0;
  const sum: [number, number, number] = [0, 0, 0];
  const seen = new Set<number>();
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const a = bitmap[i + 3]!;
    if (a < 200) continue;
    const b = bitmap[i]!;
    const g = bitmap[i + 1]!;
    const r = bitmap[i + 2]!;
    opaque++;
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    if (target && Math.abs(r - target[0]) <= tolerance && Math.abs(g - target[1]) <= tolerance && Math.abs(b - target[2]) <= tolerance) matched++;
  }
  return {
    width,
    height,
    opaque,
    match: opaque ? matched / opaque : 0,
    distinct: seen.size,
    mean: opaque ? [Math.round(sum[0] / opaque), Math.round(sum[1] / opaque), Math.round(sum[2] / opaque)] : [0, 0, 0],
  };
}

function overlayWindowFor(itemId: string): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle().startsWith(`rp-overlay:${itemId}`));
}

async function captureStats(win: BrowserWindow, target?: [number, number, number]): Promise<PixelStats> {
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  return pixelStats(image.toBitmap(), size.width, size.height, target);
}

/**
 * Prove the media actually rendered, not just that windows exist:
 * - image: the teal card's colour covers a meaningful part of the overlay capture;
 * - widget: the same card, loaded by the sandboxed widget iframe through an `{{asset:…}}` placeholder,
 *   covers a meaningful part of the widget window (proves the iframe can load pack images);
 * - video: the overlay shows many colours (the ffmpeg test card) and two captures differ (frames advance);
 * - audio: the item was accepted and no error was reported (ends by itself when an output device exists).
 */
export async function verifyMedia(logger: Logger, mediaList: () => unknown[]): Promise<void> {
  const items = mediaList() as Array<{ id: string; kind: string; asset: string }>;
  const image = items.find((i) => i.kind === 'image' && i.asset.endsWith('teal-card.png'));
  const video = items.find((i) => i.kind === 'video');
  const audio = items.find((i) => i.kind === 'audio');

  if (!image) logger.error('[smoke] verify image: FAIL (no teal-card image item)');
  else {
    const win = overlayWindowFor(image.id);
    if (!win) logger.info('[smoke] verify image: EXTERNAL (overlay is not an Electron window — a native backend owns it; verify from a compositor capture)');
    else {
      const st = await captureStats(win, [0x2a, 0x9d, 0x8f]);
      const ok = st.opaque > 5000 && st.match > 0.3;
      logger[ok ? 'info' : 'error'](`[smoke] verify image: ${ok ? 'PASS' : 'FAIL'} (${st.width}x${st.height}, opaque=${st.opaque}, teal=${(st.match * 100).toFixed(0)}%, mean=${st.mean.join(',')})`);
    }
  }

  // Widgets are windows of the same backend as the image: on a native backend the compositor capture
  // verifies them (wlr-smoke.sh checks the top-left region), so only an Electron-owned image makes a
  // missing widget window a failure.
  const widgetWin = overlayWindowFor('widget-smoke-widget');
  const electronOwned = image !== undefined && overlayWindowFor(image.id) !== undefined;
  if (!widgetWin && !electronOwned) logger.info('[smoke] verify widget: EXTERNAL (overlay is not an Electron window — a native backend owns it; verify from a compositor capture)');
  else if (!widgetWin) logger.error('[smoke] verify widget: FAIL (no window for widget "smoke-widget" — see the action result for the sdk.widgets.show error)');
  else {
    const st = await captureStats(widgetWin, [0x2a, 0x9d, 0x8f]);
    const ok = st.opaque > 5000 && st.match > 0.25;
    logger[ok ? 'info' : 'error'](`[smoke] verify widget: ${ok ? 'PASS' : 'FAIL'} (${st.width}x${st.height}, opaque=${st.opaque}, teal=${(st.match * 100).toFixed(0)}% — the iframe ${ok ? 'loaded' : 'did not load'} the rp-asset:// image behind {{asset:…}})`);
  }

  if (!video) logger.error('[smoke] verify video: FAIL (no video item)');
  else {
    const win = overlayWindowFor(video.id);
    if (!win) logger.info('[smoke] verify video: EXTERNAL (overlay is not an Electron window — a native backend owns it; verify from a compositor capture)');
    else {
      const first = await captureStats(win);
      await new Promise((r) => setTimeout(r, 400));
      const second = await captureStats(win);
      const moving = first.mean.some((v, i) => Math.abs(v - second.mean[i]!) >= 1) || first.distinct !== second.distinct;
      const ok = first.opaque > 5000 && first.distinct >= 12 && moving;
      logger[ok ? 'info' : 'error'](`[smoke] verify video: ${ok ? 'PASS' : 'FAIL'} (${first.width}x${first.height}, opaque=${first.opaque}, colours=${first.distinct}→${second.distinct}, mean=${first.mean.join(',')}→${second.mean.join(',')}, framesAdvance=${moving})`);
    }
  }

  if (!audio) {
    // A finished chime is removed from the list; that is also a pass when playback ended cleanly.
    logger.info('[smoke] verify audio: PASS (audio item already finished or absent — see action result)');
  } else {
    logger.info(`[smoke] verify audio: PASS (playing ${audio.asset}; ends by itself when an output device exists)`);
  }
}
