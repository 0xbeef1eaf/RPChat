/**
 * What the voice panel is told, which is the only thing standing between a click and a dead button.
 *
 * Both cases here were live bugs: the panel offered to download a model that was already on disk,
 * and clicking Download answered with the state from *before* the click, so nothing appeared to
 * happen and the poll that would have caught up never started — it only runs while something is
 * downloading.
 */
import { describe, expect, it } from 'vitest';
import type { AssetInstallStatus } from '@rp/shared';
import { VoiceStudio } from './voice-studio.js';
import type { VoiceStudioDeps } from './voice-studio.js';
import type { VoiceModel } from './voice-models.js';

const QWEN_MODEL: VoiceModel = {
  name: 'qwen3-tts-0.6b',
  dir: '/v/qwen3-tts-0.6b',
  engine: 'qwen',
  label: 'Qwen3-TTS',
  clones: true,
  files: {},
};

/** The installer as the studio sees it, with the real one's ordering: begin() is synchronous. */
function fakeInstaller(onDisk: boolean) {
  let state: AssetInstallStatus = { state: 'absent', version: 'qwen3-tts-0.6b' };
  let ensured = 0;
  return {
    ensured: () => ensured,
    begin: () => {
      if (state.state === 'ready' || state.state === 'downloading') return;
      state = { state: 'downloading', version: 'qwen3-tts-0.6b', received: 0, total: 2_500_000_000 };
    },
    // Async on purpose: the real one stats eleven files before it can say anything.
    currentStatus: async () => {
      if (state.state === 'downloading' || state.state === 'failed') return state;
      if (onDisk) state = { state: 'ready', version: 'qwen3-tts-0.6b', path: '/v/qwen3-tts-0.6b' };
      return state;
    },
    ensure: async () => {
      ensured += 1;
      return onDisk ? '/v/qwen3-tts-0.6b' : undefined;
    },
  };
}

function studioWith(installer: ReturnType<typeof fakeInstaller>, models: VoiceModel[] = []) {
  const deps: VoiceStudioDeps = {
    dir: '/tmp/previews',
    models: async () => models,
    engine: { available: () => true } as unknown as VoiceStudioDeps['engine'],
    qwen: { available: () => true } as unknown as VoiceStudioDeps['qwen'],
    qwenModel: installer,
    numThreads: async () => 4,
    logger: { warn: () => {}, debug: () => {} },
  };
  return new VoiceStudio(deps);
}

describe('the Qwen download offer', () => {
  it('does not offer a model that is already on disk', async () => {
    // Nothing has called ensure(), so an in-memory status would still read "absent" here and the
    // panel would show a Download button for 2.5 GB the user already has.
    const studio = studioWith(fakeInstaller(true), [QWEN_MODEL]);
    expect((await studio.state()).qwen?.state).toBe('ready');
  });

  it('offers it when it is genuinely missing', async () => {
    const studio = studioWith(fakeInstaller(false));
    expect((await studio.state()).qwen?.state).toBe('absent');
  });

  it('reports downloading the moment the download is asked for', async () => {
    const installer = fakeInstaller(false);
    const studio = studioWith(installer);
    await studio.installQwenModel();
    // Read back exactly as the editor does, without waiting for the fetch.
    const after = await studio.state();
    expect(after.qwen?.state).toBe('downloading');
    expect(after.qwen).toMatchObject({ received: 0 });
    expect(installer.ensured()).toBe(1);
  });

  it('says nothing about Qwen when the engine cannot run here', async () => {
    const deps: VoiceStudioDeps = {
      dir: '/tmp/previews',
      models: async () => [],
      engine: { available: () => true } as unknown as VoiceStudioDeps['engine'],
      qwen: { available: () => false } as unknown as VoiceStudioDeps['qwen'],
      qwenModel: fakeInstaller(false),
      numThreads: async () => 4,
      logger: { warn: () => {}, debug: () => {} },
    };
    expect((await new VoiceStudio(deps).state()).qwen).toBeUndefined();
  });
});
