import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionContext, AppSettings, CommandTemplate, LoadedPack } from '@rp/shared';
import { defaultSettings } from '@rp/core';
import type { DisplayBackend } from '../display/backend.js';
import { CommandRunner } from './commands-runner.js';
import { WallpaperHandler, parseWallpaperPath } from './wallpaper.js';

const logger = { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined };

describe('parseWallpaperPath', () => {
  it('takes the first non-empty line, strips quotes and file://, rejects non-paths', () => {
    expect(parseWallpaperPath('/home/w/pics/a.png\n')).toBe('/home/w/pics/a.png');
    expect(parseWallpaperPath("'file:///home/w/my%20pic.jpg'\n")).toBe('/home/w/my pic.jpg');
    expect(parseWallpaperPath('\n  /x/y.png  \n')).toBe('/x/y.png');
    expect(parseWallpaperPath('color:#112233\n')).toBeNull();
    expect(parseWallpaperPath('error: unknown command\n')).toBeNull();
    expect(parseWallpaperPath('')).toBeNull();
  });
});

describe('WallpaperHandler restore capture', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-wp-'));
    fs.writeFileSync(path.join(tmp, 'before.png'), 'png');
    fs.mkdirSync(path.join(tmp, 'pack', 'images'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pack', 'images', 'new.png'), 'png');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function harness(input: { restoreFile: string; getOutput?: string; getCode?: number; withGet?: boolean }) {
    const runs: Array<{ command: string; vars: Record<string, string> }> = [];
    const settings: AppSettings = {
      ...defaultSettings(),
      wallpaperRestoreFile: input.restoreFile,
      commandTemplates: {
        ...defaultSettings().commandTemplates,
        wallpaper: { command: 'set-wp {monitor} {file}' },
        wallpaperGet: { command: input.withGet === false ? '' : 'get-wp {monitor}' },
      },
    };
    const commands = new CommandRunner({
      settings: async () => settings,
      logger,
      platform: 'linux',
      env: {},
      run: async (tpl: CommandTemplate, vars) => {
        runs.push({ command: tpl.command, vars });
        if (tpl.command.startsWith('get-wp')) return { code: input.getCode ?? 0, stdout: input.getOutput ?? `${path.join(tmp, 'before.png')}\n`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const remembered: string[] = [];
    const handler = new WallpaperHandler({
      commands,
      packs: { getLoaded: () => ({ root: path.join(tmp, 'pack') }) as LoadedPack },
      backend: () => ({ monitors: async () => [{ name: 'DP-1', primary: true, x: 0, y: 0, width: 10, height: 10, scale: 1 }] }) as unknown as DisplayBackend,
      restoreFile: async () => settings.wallpaperRestoreFile,
      remember: async (file) => {
        remembered.push(file);
        settings.wallpaperRestoreFile = file;
      },
      logger,
    });
    const ctx: ActionContext = { packId: 'p', characterId: 'c', sessionId: 's', packRoot: path.join(tmp, 'pack'), trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
    return { handler, runs, remembered, ctx, settings };
  }

  it('reads the current wallpaper once before the first set, persists it and restores it', async () => {
    const h = harness({ restoreFile: '' });
    expect(await h.handler.invoke('set', ['images/new.png', { monitor: 'primary' }], h.ctx)).toEqual({ asset: 'images/new.png' });
    expect(h.runs.map((r) => r.command)).toEqual(['get-wp {monitor}', 'set-wp {monitor} {file}']);
    expect(h.runs[0]!.vars).toEqual({ monitor: 'DP-1' });
    expect(h.remembered).toEqual([path.join(tmp, 'before.png')]);
    expect(h.handler.restoreCandidate).toBe(path.join(tmp, 'before.png'));
    // A second set does not probe again.
    await h.handler.invoke('set', ['images/new.png'], h.ctx);
    expect(h.runs.filter((r) => r.command.startsWith('get-wp'))).toHaveLength(1);
    expect(await h.handler.invoke('restore', [], h.ctx)).toBe(true);
    expect(h.runs.at(-1)).toEqual({ command: 'set-wp {monitor} {file}', vars: { file: path.join(tmp, 'before.png'), monitor: '' } });
    expect(await h.handler.invoke('current', [], h.ctx)).toEqual({ asset: null });
  });

  it('skips the probe when a restore file is configured or no read template exists, and ignores unusable output', async () => {
    const configured = harness({ restoreFile: path.join(tmp, 'before.png') });
    await configured.handler.invoke('set', ['images/new.png'], configured.ctx);
    expect(configured.runs.map((r) => r.command)).toEqual(['set-wp {monitor} {file}']);
    expect(configured.remembered).toEqual([]);
    const none = harness({ restoreFile: '', withGet: false });
    await none.handler.invoke('set', ['images/new.png'], none.ctx);
    expect(none.runs).toHaveLength(1);
    expect(await none.handler.invoke('restore', [], none.ctx)).toBe(false);
    const colour = harness({ restoreFile: '', getOutput: 'color:#112233\n' });
    await colour.handler.invoke('set', ['images/new.png'], colour.ctx);
    expect(colour.remembered).toEqual([]);
    expect(colour.handler.restoreCandidate).toBeNull();
    const missing = harness({ restoreFile: '', getOutput: '/nonexistent/x.png\n' });
    await missing.handler.invoke('set', ['images/new.png'], missing.ctx);
    expect(missing.remembered).toEqual([]);
    const failed = harness({ restoreFile: '', getCode: 1 });
    await failed.handler.invoke('set', ['images/new.png'], failed.ctx);
    expect(failed.remembered).toEqual([]);
    expect(await failed.handler.invoke('restore', [], failed.ctx)).toBe(false);
  });
});
