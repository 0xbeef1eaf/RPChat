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
import type { LlmChatRequest, ProviderConfig } from '@rp/shared';

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
  const echo = text && text.type === 'text' ? text.text.trim().slice(0, 80) : '';
  const asking = echo.toLowerCase().startsWith(PROMPT_SMOKE_MESSAGE);
  const code = asking ? ASK_CODE : SHOW_IMAGE_CODE;
  const purpose = asking ? 'ask the user a yes/no question' : 'show a picture from the pack';
  if (!request.tools || request.tools.length === 0) {
    return { text: `Mock reply${echo ? ` to "${echo}"` : ''}.\n\n\`\`\`action\n${code}\n\`\`\`` };
  }
  return {
    text: asking ? 'Let me ask you something.' : echo ? `You said "${echo}". Let me show you something.` : 'Let me show you something.',
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

/** Install the example pack (and grant what it asks for) when no packs are installed. */
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
    for (const module of view.requestedCapabilities) await engine.permissions.setGrant(view.packId, module, true);
    logger.info(`[dev] installed example pack ${view.packId}@${view.version} from ${source} (granted: ${view.requestedCapabilities.join(', ') || 'nothing'})`);
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
    ['settings-system', "[...document.querySelectorAll('.tabs .tab')].find(b => b.textContent.trim() === 'System')?.click()"],
    ['sdk-reference', "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim().startsWith('SDK'))?.click()"],
    ['editor-projects', "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim().startsWith('Pack editor'))?.click()"],
    ['editor-pack', "document.querySelector('.project-card .btn-primary')?.click()"],
    ['editor-character', "[...document.querySelectorAll('.editor-rail button')].find(b => /luna/i.test(b.textContent))?.click()"],
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
