import { describe, expect, it } from 'vitest';
import { createStandardRegistry } from '@rp/sdk';
import type { ActionContext, AuditEntry, CapabilityHandler, Json, LoadedPack } from '@rp/shared';
import { RpError } from '@rp/shared';
import { loadPack } from '@rp/pack';
import { CapabilityDispatcher } from './dispatcher.js';
import type { PermissionVerdict } from './services/permissions.js';
import { LUNA_DIR, LUNA_ID } from './test/helpers.js';

const context: ActionContext = {
  packId: 'com.example.p',
  characterId: 'c',
  sessionId: 's',
  packRoot: '/nowhere',
  trigger: { kind: 'llm', actionId: 'a', messageId: 'm' },
};

function setup(verdict: PermissionVerdict, handler?: CapabilityHandler, packs?: { tryGetLoaded(packId: string): LoadedPack | undefined }) {
  const audit: Array<Omit<AuditEntry, 'id' | 'at'>> = [];
  const dispatcher = new CapabilityDispatcher({
    registry: createStandardRegistry(),
    handlers: handler ? [handler] : [],
    ...(packs ? { packs } : {}),
    permissions: {
      isAllowed: async () => verdict,
      prompt: async () => 'deny',
      buildRequest: (ctx, module, method, args, callId) => ({
        requestId: 'r',
        call: { callId, module, method, args },
        context: { packId: ctx.packId, characterId: ctx.characterId, sessionId: ctx.sessionId },
        description: 'd',
        dangerous: false,
      }),
    },
    audit: { record: async (entry) => { audit.push(entry); return { id: 'x', at: 't', ...entry }; } },
  });
  return { dispatcher, audit };
}

describe('CapabilityDispatcher', () => {
  it('cleans results to JSON and turns undefined into null', async () => {
    const handler: CapabilityHandler = { moduleId: 'ui', invoke: async (method) => (method === 'notify' ? undefined : ({ a: undefined, b: 1, d: new Date(0) } as unknown as Json)) };
    const { dispatcher, audit } = setup('allow', handler);
    expect(await dispatcher.invoke({ callId: '1', module: 'ui', method: 'notify', args: ['t'], context })).toEqual({ ok: true, value: null });
    expect(await dispatcher.invoke({ callId: '2', module: 'ui', method: 'confirm', args: ['q'], context })).toEqual({ ok: true, value: { b: 1, d: '1970-01-01T00:00:00.000Z' } });
    expect(audit.map((a) => a.outcome)).toEqual(['allowed', 'allowed']);
    expect(audit[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('wraps handler failures and reports unknown modules/methods', async () => {
    const handler: CapabilityHandler = {
      moduleId: 'ui',
      invoke: async (method) => {
        if (method === 'notify') throw new Error('boom');
        throw new RpError('NOT_FOUND', 'nope');
      },
    };
    const { dispatcher, audit } = setup('allow', handler);
    expect(await dispatcher.invoke({ callId: '1', module: 'ui', method: 'notify', args: [], context })).toMatchObject({ ok: false, error: { code: 'CAPABILITY_FAILED', message: 'boom' } });
    expect(await dispatcher.invoke({ callId: '2', module: 'ui', method: 'confirm', args: [], context })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await dispatcher.invoke({ callId: '3', module: 'nope', method: 'x', args: [], context })).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNKNOWN' } });
    expect(await dispatcher.invoke({ callId: '4', module: 'media', method: 'list', args: [], context })).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNKNOWN' } });
    expect(audit.map((a) => a.outcome)).toEqual(['failed', 'failed', 'denied', 'denied']);
  });

  it('rejects prompt-level calls the user declines', async () => {
    const calls: string[] = [];
    const { dispatcher, audit } = setup('prompt', { moduleId: 'system', invoke: async (m) => { calls.push(m); return null; } });
    expect(await dispatcher.invoke({ callId: '1', module: 'system', method: 'exec', args: ['rm'], context })).toMatchObject({ ok: false, error: { code: 'PERMISSION_PROMPT_REJECTED' } });
    expect(calls).toEqual([]);
    expect(audit[0]).toMatchObject({ outcome: 'denied', module: 'system', method: 'exec', args: ['rm'] });
  });

  it('shortens huge string arguments in the audit log', async () => {
    const { dispatcher, audit } = setup('allow', { moduleId: 'system', invoke: async () => null });
    await dispatcher.invoke({ callId: '1', module: 'system', method: 'writeFile', args: ['/f', 'x'.repeat(5000)], context });
    expect((audit[0]!.args[1] as string).length).toBeLessThan(1100);
  });

  it('normalises wallpaper.set assets like media.showImage', async () => {
    const luna = await loadPack(LUNA_DIR);
    const packs = { tryGetLoaded: (id: string) => (id === LUNA_ID ? luna : undefined) };
    const calls: Json[][] = [];
    const { dispatcher, audit } = setup('allow', { moduleId: 'wallpaper', invoke: async (_m, args) => { calls.push(args); return { asset: args[0] }; } }, packs);
    const ctx = { ...context, packId: LUNA_ID, packRoot: luna.root };

    expect(await dispatcher.invoke({ callId: '1', module: 'wallpaper', method: 'set', args: ['images/luna-wave.png', { monitor: 'primary' }], context: ctx })).toEqual({ ok: true, value: { asset: 'media/images/luna-wave.png' } });
    expect(calls[0]).toEqual(['media/images/luna-wave.png', { monitor: 'primary' }]);
    expect(await dispatcher.invoke({ callId: '2', module: 'wallpaper', method: 'set', args: [{ path: 'media/images/luna-smile.png', kind: 'image', mime: 'image/png', bytes: 1 }], context: ctx })).toMatchObject({ ok: true });
    expect(calls[1]).toEqual(['media/images/luna-smile.png']);
    expect(await dispatcher.invoke({ callId: '3', module: 'wallpaper', method: 'set', args: ['audio/chime.wav'], context: ctx })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await dispatcher.invoke({ callId: '4', module: 'wallpaper', method: 'set', args: ['../outside.png'], context: ctx })).toMatchObject({ ok: false, error: { code: 'PATH_ESCAPE' } });
    expect(await dispatcher.invoke({ callId: '5', module: 'wallpaper', method: 'set', args: ['images/missing.png'], context: ctx })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // restore/current take no asset and pass through untouched
    expect(await dispatcher.invoke({ callId: '6', module: 'wallpaper', method: 'restore', args: [], context: ctx })).toMatchObject({ ok: true });
    expect(calls).toHaveLength(3);
    expect(audit.map((a) => a.outcome)).toEqual(['allowed', 'allowed', 'failed', 'failed', 'failed', 'allowed']);
    expect(audit[0]!.args).toEqual(['media/images/luna-wave.png', { monitor: 'primary' }]);
  });

  it('lets media.overlay take an image or a video, but not audio', async () => {
    const luna = await loadPack(LUNA_DIR);
    const packs = { tryGetLoaded: (id: string) => (id === LUNA_ID ? luna : undefined) };
    const calls: Json[][] = [];
    const { dispatcher } = setup('allow', { moduleId: 'media', invoke: async (_m, args) => { calls.push(args); return null; } }, packs);
    const ctx = { ...context, packId: LUNA_ID, packRoot: luna.root };

    expect(await dispatcher.invoke({ callId: '1', module: 'media', method: 'overlay', args: ['images/luna-wave.png', { opacity: 0.2 }], context: ctx })).toMatchObject({ ok: true });
    expect(await dispatcher.invoke({ callId: '2', module: 'media', method: 'overlay', args: ['video/testcard.webm'], context: ctx })).toMatchObject({ ok: true });
    expect(calls).toEqual([['media/images/luna-wave.png', { opacity: 0.2 }], ['media/video/testcard.webm']]);
    const audio = await dispatcher.invoke({ callId: '3', module: 'media', method: 'overlay', args: ['audio/chime.wav'], context: ctx });
    expect(audio).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('needs an image or video asset') } });
    // The single-kind methods still name the one kind they take.
    const wrong = await dispatcher.invoke({ callId: '4', module: 'media', method: 'playVideo', args: ['images/luna-wave.png'], context: ctx });
    expect(wrong).toMatchObject({ ok: false, error: { message: expect.stringContaining('needs a video asset') } });
    expect(calls).toHaveLength(2);
  });

  it('passes a character-home ref (an sdk.webcam capture) to sdk.media as a home: path, by ref or by string', async () => {
    const luna = await loadPack(LUNA_DIR);
    const packs = { tryGetLoaded: (id: string) => (id === LUNA_ID ? luna : undefined) };
    const calls: Json[][] = [];
    const { dispatcher } = setup('allow', { moduleId: 'media', invoke: async (_m, args) => { calls.push(args); return null; } }, packs);
    const ctx = { ...context, packId: LUNA_ID, packRoot: luna.root };
    const shot = { source: 'home', path: 'webcam/2026-09-15T12-30-00-123Z-abcdef01.jpg', kind: 'image', mime: 'image/jpeg', bytes: 10 };

    expect(await dispatcher.invoke({ callId: '1', module: 'media', method: 'showImage', args: [shot as unknown as Json], context: ctx })).toMatchObject({ ok: true });
    expect(await dispatcher.invoke({ callId: '2', module: 'media', method: 'playAudio', args: ['home:clips/hello.mp3'], context: ctx })).toMatchObject({ ok: true });
    // The handler is told where the file lives; the pack is never consulted for it.
    expect(calls).toEqual([[`home:${shot.path}`], ['home:clips/hello.mp3']]);
    // The kind still has to match the method, and it comes from the extension.
    const wrong = await dispatcher.invoke({ callId: '3', module: 'media', method: 'playVideo', args: [shot as unknown as Json], context: ctx });
    expect(wrong).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('needs a video asset') } });
    // ".." never leaves the home either.
    const escape = await dispatcher.invoke({ callId: '4', module: 'media', method: 'showImage', args: ['home:../../secrets.png'], context: ctx });
    expect(escape).toMatchObject({ ok: false, error: { code: 'PATH_ESCAPE' } });
    expect(calls).toHaveLength(2);
  });

  it('refuses a character-home ref for sdk.wallpaper.set, which takes pack assets only', async () => {
    const luna = await loadPack(LUNA_DIR);
    const packs = { tryGetLoaded: (id: string) => (id === LUNA_ID ? luna : undefined) };
    const calls: Json[][] = [];
    const { dispatcher } = setup('allow', { moduleId: 'wallpaper', invoke: async (_m, args) => { calls.push(args); return null; } }, packs);
    const ctx = { ...context, packId: LUNA_ID, packRoot: luna.root };
    const shot = { source: 'home', path: 'webcam/2026-09-15T12-30-00-123Z-abcdef01.jpg', kind: 'image', mime: 'image/jpeg', bytes: 10 };

    const result = await dispatcher.invoke({ callId: '1', module: 'wallpaper', method: 'set', args: [shot as unknown as Json], context: ctx });
    // Named for what it is, rather than reported as a pack file that does not exist.
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('is a file in the character home') } });
    expect(calls).toEqual([]);
  });

  it('unwraps MediaHandle objects to ids for media.update and media.close, passing the changes through', async () => {
    const calls: Array<[string, Json[]]> = [];
    const { dispatcher } = setup('allow', { moduleId: 'media', invoke: async (m, args) => { calls.push([m, args]); return null; } });
    const handle = { id: 'm42', kind: 'image', asset: 'media/images/x.png' };
    const changes = { monitor: 'cursor', layer: 'background', opacity: 0.5, x: 0.1, y: 0.2 };
    expect(await dispatcher.invoke({ callId: '1', module: 'media', method: 'update', args: [handle, changes], context })).toEqual({ ok: true, value: null });
    expect(await dispatcher.invoke({ callId: '2', module: 'media', method: 'update', args: ['m43', changes], context })).toEqual({ ok: true, value: null });
    expect(await dispatcher.invoke({ callId: '3', module: 'media', method: 'close', args: [handle], context })).toEqual({ ok: true, value: null });
    expect(calls).toEqual([
      ['update', ['m42', changes]],
      ['update', ['m43', changes]],
      ['close', ['m42']],
    ]);
    expect(await dispatcher.invoke({ callId: '4', module: 'media', method: 'update', args: [{ kind: 'image' }, changes], context })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await dispatcher.invoke({ callId: '5', module: 'media', method: 'close', args: [7], context })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(calls).toHaveLength(3);
  });
});
