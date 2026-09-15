/**
 * Which engine `sdk.voice.speak` actually uses. The order is load-bearing: a command the user typed
 * must never be overridden by an installed model, and an installed model must never be silently
 * skipped in favour of espeak-ng — a character speaking in the wrong voice is a bug that looks like
 * a preference.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext, AppSettings, LoadedPack } from '@rp/shared';
import { defaultSettings } from '@rp/core';
import { CommandRunner } from './commands-runner.js';
import { VoiceHandler } from './voice.js';
import type { OverlayWindowLike } from '../display/backend.js';

const logger = { warn: () => undefined, debug: () => undefined };
const ctx: ActionContext = { packId: 'com.x.p', characterId: 'luna', sessionId: 's', packRoot: '', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
const tmpRoot = fs.mkdtemp(path.join(os.tmpdir(), 'rp-voice-'));
let tmp = '';
let voicesDir = '';
let packRoot = '';

/** The seven files a Pocket TTS directory needs to be recognised. */
const POCKET_FILES = ['lm_flow.int8.onnx', 'lm_main.int8.onnx', 'encoder.onnx', 'decoder.int8.onnx', 'text_conditioner.onnx', 'vocab.json', 'token_scores.json'];

async function installModel(name: string, files: string[] = POCKET_FILES): Promise<void> {
  const dir = path.join(voicesDir, name);
  await fs.mkdir(path.join(dir, 'test_wavs'), { recursive: true });
  for (const f of files) await fs.writeFile(path.join(dir, f), 'x');
  await fs.writeFile(path.join(dir, 'test_wavs', 'bria.wav'), 'x');
}

function fakeAudioWindow(): OverlayWindowLike {
  return {
    id: 'audio', title: 'audio',
    whenReady: async () => undefined,
    send: () => undefined,
    onReport: () => () => undefined,
    onClosed: () => () => undefined,
    setBounds: () => undefined,
    getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    setAlwaysOnTop: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    isDestroyed: () => false,
    close: () => undefined,
    runScript: async () => true,
  } as unknown as OverlayWindowLike;
}

/** A runner that finds nothing on PATH, so the only platform default is whatever we pass in. */
function runner(templates: Partial<AppSettings['commandTemplates']> = {}, platformDefault?: string): CommandRunner {
  const settings = async (): Promise<AppSettings> => ({ ...defaultSettings(), commandTemplates: { ...defaultSettings().commandTemplates, ...templates } });
  const r = new CommandRunner({ settings, logger: { ...logger, info: () => undefined, error: () => undefined } as never, platform: 'linux', env: { PATH: '' } });
  if (platformDefault !== undefined) {
    // Stand in for espeak-ng being on PATH without depending on the host having it.
    vi.spyOn(r, 'defaults').mockReturnValue({ ...defaultSettings().commandTemplates, tts: { command: platformDefault } });
  }
  return r;
}

function pack(voice?: LoadedPack['character']['definition']['voice']): { getLoaded(): LoadedPack } {
  return {
    getLoaded: () =>
      ({ root: packRoot, character: { dir: 'characters/luna', definition: { id: 'luna', name: 'Luna', persona: 'p.md', ...(voice ? { voice } : {}) } } }) as unknown as LoadedPack,
  };
}

interface HandlerOpts {
  templates?: Partial<AppSettings['commandTemplates']>;
  platformDefault?: string;
  voice?: LoadedPack['character']['definition']['voice'];
  findSherpa?: () => string | undefined;
  settings?: Partial<AppSettings['voice']>;
  spawn?: ReturnType<typeof vi.fn>;
}

function handler(o: HandlerOpts = {}) {
  const spawn = o.spawn ?? vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  const commands = runner(o.templates, o.platformDefault);
  vi.spyOn(commands, 'runTemplate').mockImplementation(run as never);
  const h = new VoiceHandler({
    commands,
    audioWindow: fakeAudioWindow,
    ttsDir: path.join(tmp, 'tts'),
    voicesDir,
    packs: pack(o.voice),
    findSherpa: o.findSherpa ?? (() => '/bin/sherpa'),
    voiceSettings: async () => ({ ...defaultSettings().voice, ...(o.settings ?? {}) }),
    spawn: spawn as never,
    logger,
    startGraceMs: 10,
  });
  return { h, spawn, run };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(await tmpRoot, 'case-'));
  voicesDir = path.join(tmp, 'voices');
  packRoot = path.join(tmp, 'pack');
  await fs.mkdir(path.join(packRoot, 'characters', 'luna'), { recursive: true });
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(await tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

/** The `--flag=value` pairs of a sherpa invocation. */
const flags = (args: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m?.[1]) out[m[1]] = m[2] ?? '';
  }
  return out;
};

describe('speak: which engine runs', () => {
  it('uses an installed model in preference to the platform default', async () => {
    await installModel('pocket-a');
    const { h, spawn, run } = handler({ platformDefault: 'espeak-ng "{text}"' });
    await h.invoke('speak', ['hello'], ctx);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('lets a command the user typed win over an installed model', async () => {
    await installModel('pocket-a');
    const { h, spawn, run } = handler({ templates: { tts: { command: 'my-tts {text}' } } });
    await h.invoke('speak', ['hello'], ctx);
    expect(run).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls back to the platform default when no model is installed', async () => {
    const { h, spawn, run } = handler({ platformDefault: 'espeak-ng "{text}"' });
    await h.invoke('speak', ['hello'], ctx);
    expect(run).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('stands aside entirely when the neural path is switched off', async () => {
    await installModel('pocket-a');
    const { h, spawn, run } = handler({ platformDefault: 'espeak-ng "{text}"', settings: { disabled: true } });
    await h.invoke('speak', ['hello'], ctx);
    expect(run).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses the only installed model when nothing names one', async () => {
    await installModel('the-only-one');
    const { h, spawn } = handler();
    await h.invoke('speak', ['hello'], ctx);
    expect(flags(spawn.mock.calls[0]?.[1] as string[])['pocket-vocab-json']).toContain('the-only-one');
  });

  it('does not guess when several are installed and none is named', async () => {
    await installModel('pocket-a');
    await installModel('pocket-b');
    const { h, spawn, run } = handler({ platformDefault: 'espeak-ng "{text}"' });
    await h.invoke('speak', ['hello'], ctx);
    expect(spawn).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('speak: choosing the model', () => {
  it('takes the character’s model over the app default', async () => {
    await installModel('pocket-a');
    await installModel('pocket-b');
    const { h, spawn } = handler({ voice: { model: 'pocket-b' }, settings: { defaultModel: 'pocket-a' } });
    await h.invoke('speak', ['hello'], ctx);
    expect(flags(spawn.mock.calls[0]?.[1] as string[])['pocket-vocab-json']).toContain('pocket-b');
  });

  it('takes the app default when the character names none', async () => {
    await installModel('pocket-a');
    await installModel('pocket-b');
    const { h, spawn } = handler({ settings: { defaultModel: 'pocket-a' } });
    await h.invoke('speak', ['hello'], ctx);
    expect(flags(spawn.mock.calls[0]?.[1] as string[])['pocket-vocab-json']).toContain('pocket-a');
  });

  it('lets speak({ voice }) override both', async () => {
    await installModel('pocket-a');
    await installModel('pocket-b');
    const { h, spawn } = handler({ voice: { model: 'pocket-a' }, settings: { defaultModel: 'pocket-a' } });
    await h.invoke('speak', ['hello', { voice: 'pocket-b' }], ctx);
    expect(flags(spawn.mock.calls[0]?.[1] as string[])['pocket-vocab-json']).toContain('pocket-b');
  });

  it('says so when a named model is not installed, rather than quietly using espeak', async () => {
    await installModel('pocket-a');
    const { h } = handler({ voice: { model: 'missing-model' }, platformDefault: 'espeak-ng "{text}"' });
    await expect(h.invoke('speak', ['hello'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('Voice model "missing-model" is not installed'),
    });
  });

  it('says so when a model is installed but the binary is missing', async () => {
    await installModel('pocket-a');
    const { h } = handler({ findSherpa: () => undefined, platformDefault: 'espeak-ng "{text}"' });
    await expect(h.invoke('speak', ['hello'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('sherpa-onnx-offline-tts was not found'),
    });
  });
});

describe('speak: the character’s own voice', () => {
  it('clones from the character’s reference clip', async () => {
    await installModel('pocket-a');
    await fs.writeFile(path.join(packRoot, 'characters', 'luna', 'voice.wav'), 'x');
    const { h, spawn } = handler({ voice: { reference: 'voice.wav' } });
    await h.invoke('speak', ['hello'], { ...ctx, packRoot });
    expect(flags(spawn.mock.calls[0]?.[1] as string[])['reference-audio']).toBe(path.join(packRoot, 'characters', 'luna', 'voice.wav'));
  });

  it('falls back to the model’s own sample when the character has no clip', async () => {
    await installModel('pocket-a');
    const { h, spawn } = handler();
    await h.invoke('speak', ['hello'], ctx);
    expect(flags(spawn.mock.calls[0]?.[1] as string[])['reference-audio']).toBe(path.join(voicesDir, 'pocket-a', 'test_wavs', 'bria.wav'));
  });

  it('ignores a reference that tries to escape the pack', async () => {
    await installModel('pocket-a');
    const { h, spawn } = handler({ voice: { reference: '../../../etc/passwd' } });
    await h.invoke('speak', ['hello'], { ...ctx, packRoot });
    // Falls back to the model sample rather than reading outside the pack.
    expect(flags(spawn.mock.calls[0]?.[1] as string[])['reference-audio']).toContain('test_wavs');
  });

  it('applies the character’s speed and steps, and lets the call override the speed', async () => {
    await installModel('pocket-a');
    const { h, spawn } = handler({ voice: { rate: 0.9, steps: 12 } });
    await h.invoke('speak', ['hello'], ctx);
    expect(flags(spawn.mock.calls[0]?.[1] as string[])).toMatchObject({ speed: '0.9', 'num-steps': '12' });

    const second = handler({ voice: { rate: 0.9, steps: 12 } });
    await installModel('pocket-a');
    await second.h.invoke('speak', ['hello', { rate: 1.5 }], ctx);
    expect(flags(second.spawn.mock.calls[0]?.[1] as string[])['speed']).toBe('1.5');
  });

  it('reports a synthesis failure with what sherpa said', async () => {
    await installModel('pocket-a');
    const spawn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'decoder.onnx does not exist' }));
    const { h } = handler({ spawn });
    await expect(h.invoke('speak', ['hello'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('decoder.onnx does not exist'),
    });
  });

  it('passes the spoken text as the positional argument, untouched', async () => {
    await installModel('pocket-a');
    const { h, spawn } = handler();
    await h.invoke('speak', ['She said "no", and left.'], ctx);
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args[args.length - 1]).toBe('She said "no", and left.');
  });
});
