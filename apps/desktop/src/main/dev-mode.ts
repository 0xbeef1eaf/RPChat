/**
 * Development conveniences: `RP_MOCK_LLM=1` swaps every provider for a scripted
 * MockProvider (run_action showing a pack image, then a reply), and the Luna
 * example pack is installed on first run when nothing is installed yet.
 */
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
const pick = images[0];
if (pick) {
  await sdk.media.showImage(pick, { durationMs: 8000, position: "bottom-right", caption: "hello from the mock model" });
}
return { shown: Boolean(pick), asset: pick ? pick.path : null };`;

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
  if (!request.tools || request.tools.length === 0) {
    return { text: `Mock reply${echo ? ` to "${echo}"` : ''}.\n\n\`\`\`action\n${SHOW_IMAGE_CODE}\n\`\`\`` };
  }
  return {
    text: echo ? `You said "${echo}". Let me show you something.` : 'Let me show you something.',
    toolCalls: [{ name: 'run_action', input: { purpose: 'show a picture from the pack', code: SHOW_IMAGE_CODE } }],
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

export function isSmokeRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RP_SMOKE === '1';
}

/**
 * `RP_SMOKE=1`: drive one mock turn through the engine (session → message → run_action →
 * media overlay) and log what happened, so a headless run can prove the whole path.
 */
export async function runSmokeTurn(engine: Engine, logger: Logger, mediaList: () => unknown[]): Promise<void> {
  const character = engine.packs.characters()[0];
  if (!character) {
    logger.warn('[smoke] no character available');
    return;
  }
  const events: string[] = [];
  const off = engine.events.on('chat', (ev) => {
    events.push(ev.type === 'error' ? `error(${ev.error.code}: ${ev.error.message})` : ev.type);
    if (ev.type === 'action-finished') logger.info(`[smoke] action ${ev.action.result?.ok ? 'ok' : 'failed'}: ${JSON.stringify(ev.action.result?.returnValue ?? ev.action.result?.error ?? null)} calls=${JSON.stringify((ev.action.result?.calls ?? []).map((c) => `${c.module}.${c.method}:${c.ok ? 'ok' : c.error?.code}`))}`);
  });
  try {
    const session = await engine.sessions.create({ characterRef: character.ref, title: 'smoke' });
    logger.info(`[smoke] session ${session.id} with ${character.ref}`);
    await engine.chat.send(session.id, 'hi there, show me something');
    logger.info(`[smoke] chat events: ${events.join(' → ')}`);
    await new Promise((r) => setTimeout(r, 1500));
    logger.info(`[smoke] open media items: ${JSON.stringify(mediaList())}`);
    const messages = await engine.sessions.messages(session.id);
    logger.info(`[smoke] transcript: ${messages.map((m) => `${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 60)}`).join(' | ')}`);
  } catch (err) {
    logger.error('[smoke] turn failed', err);
  } finally {
    off();
  }
}
