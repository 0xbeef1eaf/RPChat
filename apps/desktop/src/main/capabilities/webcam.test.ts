/**
 * `sdk.webcam`: captures land in the character home as `webcam/<timestamp>-<id>.<ext>`, come back
 * as a `source: 'home'` AssetRef, and every failure path leaves no half-written file behind.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionContext, AppSettings } from '@rp/shared';
import { defaultSettings } from '@rp/core';
import { CommandRunner } from './commands-runner.js';
import { characterHomeDir } from './files.js';
import { WEBCAM_VIDEO_MAX_SECONDS, WebcamHandler, captureName, validateSeconds } from './webcam.js';

const ctx: ActionContext = { packId: 'com.x.p', characterId: 'luna', sessionId: 's', packRoot: '/nowhere', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

let userData: string;
const home = (): string => characterHomeDir(userData, 'com.x.p/luna');

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-webcam-'));
  runOpts.length = 0;
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

/** Per-run options the fake command saw, so the timeout the handler asks for can be asserted. */
const runOpts: Array<{ timeoutMs?: number }> = [];

/**
 * A runner with no platform defaults (empty PATH) and the given user templates. `run` is faked so
 * the tests never touch a real camera: `write` decides what the "command" leaves at {file}.
 */
function handlerWith(templates: Partial<AppSettings['commandTemplates']>, write?: (vars: Record<string, string>) => void, code = 0): WebcamHandler {
  const settings = async (): Promise<AppSettings> => ({ ...defaultSettings(), commandTemplates: { ...defaultSettings().commandTemplates, ...templates } });
  const commands = new CommandRunner({
    settings,
    logger,
    platform: 'linux',
    env: { PATH: '' },
    run: async (_tpl, vars, opts) => {
      runOpts.push({ ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      write?.(vars);
      return { code, stdout: '', stderr: code === 0 ? '' : 'camera busy' };
    },
  });
  return new WebcamHandler({ commands, userData });
}

const configured = { webcamImage: { command: 'fake-cam {file}' }, webcamVideo: { command: 'fake-cam -t {seconds} {file}' } };
const writeBytes = (bytes: string) => (vars: Record<string, string>) => {
  fs.mkdirSync(path.dirname(vars.file!), { recursive: true });
  fs.writeFileSync(vars.file!, bytes);
};

describe('captureName', () => {
  it('is a sortable, collision-free path under webcam/', () => {
    const name = captureName('jpg', new Date('2026-09-15T12:30:00.123Z'), 'abcdef01-2345-6789-abcd-ef0123456789');
    expect(name).toBe('webcam/2026-09-15T12-30-00-123Z-abcdef01.jpg');
    // No ":" or "." in the basename beyond the extension: the path guard and Windows both object.
    expect(path.basename(name).split('.')).toHaveLength(2);
    expect(captureName('jpg')).not.toBe(captureName('jpg'));
  });
});

describe('validateSeconds', () => {
  it('accepts 1..60 and rounds, rejects anything else', () => {
    expect(validateSeconds(5)).toBe(5);
    expect(validateSeconds(4.6)).toBe(5);
    expect(validateSeconds(WEBCAM_VIDEO_MAX_SECONDS)).toBe(WEBCAM_VIDEO_MAX_SECONDS);
    for (const bad of [0, -1, 61, Number.NaN, 'soon', null]) {
      expect(() => validateSeconds(bad), String(bad)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });
});

describe('WebcamHandler', () => {
  it('takeImage: writes into the character home and returns a home AssetRef', async () => {
    const handler = handlerWith(configured, writeBytes('jpeg-bytes'));
    const ref = (await handler.invoke('takeImage', [], ctx)) as { source: string; path: string; kind: string; mime: string; bytes: number; tags: string[] };

    expect(ref.source).toBe('home');
    expect(ref.path).toMatch(/^webcam\/[\dTZ-]+-[0-9a-f]{8}\.jpg$/);
    expect(ref).toMatchObject({ kind: 'image', mime: 'image/jpeg', bytes: 10, tags: ['webcam'] });
    // The path is relative to the character home, and that is where the file actually is.
    expect(fs.readFileSync(path.join(home(), ref.path), 'utf8')).toBe('jpeg-bytes');
  });

  it('takeVideo: passes {seconds} to the command and returns an mp4 ref', async () => {
    const seen: Record<string, string>[] = [];
    const handler = handlerWith(configured, (vars) => {
      seen.push(vars);
      writeBytes('mp4-bytes')(vars);
    });
    const ref = (await handler.invoke('takeVideo', [3], ctx)) as { path: string; kind: string; mime: string };

    expect(seen[0]?.seconds).toBe('3');
    expect(seen[0]?.file).toBe(path.join(home(), ref.path));
    expect(ref).toMatchObject({ kind: 'video', mime: 'video/mp4' });
    expect(ref.path.endsWith('.mp4')).toBe(true);
  });

  it('a clip outlives the 30 s default command timeout; a photo keeps it', async () => {
    const handler = handlerWith(configured, writeBytes('x'));
    await handler.invoke('takeVideo', [45], ctx);
    // 45 s of recording plus start-up room, or the runner would kill the command mid-clip.
    expect(runOpts[0]?.timeoutMs).toBe(45_000 + 30_000);

    await handler.invoke('takeImage', [], ctx);
    expect(runOpts[1]?.timeoutMs).toBeUndefined();
  });

  it('each capture is a separate file; nothing is overwritten', async () => {
    const handler = handlerWith(configured, writeBytes('x'));
    const first = (await handler.invoke('takeImage', [], ctx)) as { path: string };
    const second = (await handler.invoke('takeImage', [], ctx)) as { path: string };

    expect(first.path).not.toBe(second.path);
    expect(fs.readdirSync(path.join(home(), 'webcam'))).toHaveLength(2);
  });

  it('captures of different characters do not mix', async () => {
    const handler = handlerWith(configured, writeBytes('x'));
    await handler.invoke('takeImage', [], ctx);
    await handler.invoke('takeImage', [], { ...ctx, characterId: 'makima' });

    expect(fs.readdirSync(path.join(characterHomeDir(userData, 'com.x.p/luna'), 'webcam'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(characterHomeDir(userData, 'com.x.p/makima'), 'webcam'))).toHaveLength(1);
  });

  it('no command configured: CAPABILITY_FAILED naming the command and where to set it', async () => {
    const handler = handlerWith({});
    for (const [method, args, label] of [['takeImage', [], 'camera photo'], ['takeVideo', [2], 'camera video']] as const) {
      await expect(handler.invoke(method, [...args], ctx)).rejects.toMatchObject({
        code: 'CAPABILITY_FAILED',
        message: expect.stringContaining(`No ${label} command is configured for sdk.webcam.${method}`),
      });
    }
    expect(fs.existsSync(path.join(home(), 'webcam'))).toBe(false);
  });

  it('command exits 0 but writes nothing: CAPABILITY_FAILED, and no empty file is left behind', async () => {
    const handler = handlerWith(configured);
    await expect(handler.invoke('takeImage', [], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('exited 0 but wrote no file'),
    });
    expect(fs.readdirSync(path.join(home(), 'webcam'))).toEqual([]);
  });

  it('command writes an empty file: treated as a failure and cleaned up', async () => {
    const handler = handlerWith(configured, writeBytes(''));
    await expect(handler.invoke('takeImage', [], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' });
    expect(fs.readdirSync(path.join(home(), 'webcam'))).toEqual([]);
  });

  it('command exits non-zero: the error names the command, and the partial file is removed', async () => {
    const handler = handlerWith(configured, writeBytes('half-a-frame'), 1);
    await expect(handler.invoke('takeImage', [], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' });
    expect(fs.readdirSync(path.join(home(), 'webcam'))).toEqual([]);
  });

  it('rejects an unknown method', async () => {
    await expect(handlerWith(configured).invoke('stream', [], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' });
  });
});
