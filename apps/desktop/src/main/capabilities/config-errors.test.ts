/**
 * Configuration failure paths of the desktop handlers: every "not configured / tool missing /
 * service down" branch must fail with CAPABILITY_FAILED (or PERMISSION_DENIED for allowlists)
 * and a message that names what is missing and where the user fixes it — never a silent no-op.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActionContext, AppSettings, MonitorInfo } from '@rp/shared';
import { RpError } from '@rp/shared';
import { defaultSettings } from '@rp/core';
import { CalendarHandler } from './calendar.js';
import { CommandRunner, describeSpawnFailure } from './commands-runner.js';
import { DesktopHandler, HYPRLAND_REQUIRED_MESSAGE } from './desktop.js';
import { FilesHandler } from './files.js';
import { MessagingHandler } from './messaging.js';
import { ScreenHandler } from './screen.js';
import { SystemHandler } from './system.js';
import { NOTIFICATIONS_UNSUPPORTED_MESSAGE, UiHandler } from './ui.js';
import { VoiceHandler } from './voice.js';
import { WallpaperHandler } from './wallpaper.js';
import { PendingPrompts } from '../prompts.js';
import type { DisplayBackend, OverlayWindowLike } from '../display/backend.js';

vi.mock('electron', () => ({
  Notification: { isSupported: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined },
}));

const ctx: ActionContext = { packId: 'com.x.p', characterId: 'luna', sessionId: 's', packRoot: '/nowhere', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const monitors: MonitorInfo[] = [{ id: '1', name: 'DP-1', index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1, hasCursor: true }];
const MISSING = 'rp-definitely-missing-binary-9f3a';
/** Absolute path so the fake commands work with the empty PATH the runner uses (no platform defaults detected). */
const NODE = process.execPath;

/** A runner whose platform defaults find nothing on PATH, with optional user templates. */
function runner(templates: Partial<AppSettings['commandTemplates']> = {}): CommandRunner {
  const settings = async (): Promise<AppSettings> => ({ ...defaultSettings(), commandTemplates: { ...defaultSettings().commandTemplates, ...templates } });
  return new CommandRunner({ settings, logger, platform: 'linux', env: { PATH: '' } });
}

const backend = { name: 'fake', monitors: async () => monitors, info: () => ({ name: 'fake', supports: { layers: ['top'] } }) } as unknown as DisplayBackend;

function fakeAudioWindow(runScript: (() => Promise<unknown>) | undefined): OverlayWindowLike {
  return {
    id: 'audio',
    title: 'audio',
    whenReady: async () => undefined,
    send: () => undefined,
    onReport: () => () => undefined,
    onClosed: () => () => undefined,
    setBounds: () => undefined,
    getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    setAlwaysOnTop: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setOpacity: () => undefined,
    setFocusable: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    isDestroyed: () => false,
    ...(runScript ? { runScript } : {}),
  } as unknown as OverlayWindowLike;
}

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-config-errors-'));
  fs.mkdirSync(path.join(tmp, 'pack', 'media', 'images'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'pack', 'media', 'images', 'sky.png'), 'png');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('CommandRunner', () => {
  it('reports an unconfigured template with the SDK method and settings row', async () => {
    await expect(runner().run('screenshot', { file: 'x', monitor: '' })).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('No screenshot command is configured for sdk.screen.look; set one in Settings → Commands → Screenshot'),
    });
    await expect(runner().runQuiet('nowPlaying', {})).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: expect.stringContaining('sdk.presence.nowPlaying') });
  });

  it('turns a missing executable into an install hint with the settings row (real spawn)', async () => {
    const r = runner({ wallpaper: { command: `${MISSING} {file}` } });
    await expect(r.runChecked('wallpaper', { file: '/tmp/a.png', monitor: '' })).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: `The wallpaper command needs "${MISSING}", which is not installed or not on PATH; install it or set another command in Settings → Commands → Set wallpaper`,
      details: { file: MISSING, code: 'ENOENT', template: 'wallpaper' },
    });
  });

  it('describeSpawnFailure leaves non-template labels and other errors alone', () => {
    const enoent = new RpError('CAPABILITY_FAILED', 'Cannot run "x": it is not installed or not on PATH', { file: 'x', args: [], code: 'ENOENT' });
    expect(describeSpawnFailure(enoent, 'messaging:phone')).toBe(enoent);
    expect(describeSpawnFailure(enoent, 'test:wallpaper')).toBe(enoent);
    const other = new RpError('CAPABILITY_FAILED', 'Cannot run "x": EACCES', { file: 'x', args: [] });
    expect(describeSpawnFailure(other, 'wallpaper')).toBe(other);
    expect((describeSpawnFailure(enoent, 'tts') as RpError).message).toContain('Settings → Commands → Speak');
  });

  it('runChecked reports a non-zero exit with the command and settings row', async () => {
    const r = runner({ brightness: { command: `${NODE} -e "console.error('no backlight'); process.exit(3)" {level}` } });
    await expect(r.runChecked('brightness', { level: '40' })).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringMatching(/^Brightness command \(".*"\) exited with 3: no backlight; check it in Settings → Commands → Brightness$/),
    });
  });
});

describe('wallpaper', () => {
  const handler = (commands: CommandRunner, restoreFile = '') =>
    new WallpaperHandler({ commands, packs: { getLoaded: () => ({ root: path.join(tmp, 'pack') }) as never }, backend: () => backend, restoreFile: async () => restoreFile });

  it('set: not configured → names sdk.wallpaper.set and the settings row', async () => {
    await expect(handler(runner()).invoke('set', ['media/images/sky.png'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('No set wallpaper command is configured for sdk.wallpaper.set / restore; set one in Settings → Commands → Set wallpaper'),
    });
  });

  it('set: non-zero exit and missing binary are reported, success remembers the asset', async () => {
    await expect(handler(runner({ wallpaper: { command: `${MISSING} {file}` } })).invoke('set', ['media/images/sky.png'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining(`needs "${MISSING}", which is not installed`),
    });
    await expect(handler(runner({ wallpaper: { command: `${NODE} -e "process.exit(1)" {file}` } })).invoke('set', ['media/images/sky.png'], ctx)).rejects.toMatchObject({
      message: expect.stringContaining('exited with 1; check it in Settings → Commands → Set wallpaper'),
    });
    const ok = handler(runner({ wallpaper: { command: `${NODE} -e "" {file}` } }));
    expect(await ok.invoke('set', ['media/images/sky.png'], ctx)).toEqual({ asset: 'media/images/sky.png' });
    expect(await ok.invoke('current', [], ctx)).toEqual({ asset: 'media/images/sky.png' });
  });

  it('restore: false without a restore file (documented), a clear error for a missing one', async () => {
    expect(await handler(runner()).invoke('restore', [], ctx)).toBe(false);
    await expect(handler(runner({ wallpaper: { command: `${NODE} -e "" {file}` } }), path.join(tmp, 'gone.jpg')).invoke('restore', [], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('Wallpaper to restore'),
    });
  });
});

describe('screen.look', () => {
  it('fails with the screenshot template hint on Wayland without a command', async () => {
    const screen = new ScreenHandler({
      backend: () => backend,
      commands: runner(),
      capturer: { downscale: async (png) => ({ png, width: 1, height: 1 }) },
      preferTemplate: () => true,
      tmpDir: path.join(tmp, 'shots'),
      describeImage: async () => 'desc',
      logger,
    });
    await expect(screen.invoke('look', [{}], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('No screenshot command is configured for sdk.screen.look; set one in Settings → Commands → Screenshot (platform default: grim'),
    });
  });

  it('reports a command that exits 0 without writing the file', async () => {
    const screen = new ScreenHandler({
      backend: () => backend,
      commands: runner({ screenshot: { command: `${NODE} -e "" {file}` } }),
      capturer: { downscale: async (png) => ({ png, width: 1, height: 1 }) },
      preferTemplate: () => true,
      tmpDir: path.join(tmp, 'shots'),
      describeImage: async () => 'desc',
      logger,
    });
    await expect(screen.invoke('look', [{}], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringMatching(/exited 0 but did not write .*; it must save a PNG to \{file\} — check it in Settings → Commands → Screenshot/),
    });
  });
});

describe('desktop', () => {
  it('template-backed methods name the missing command; getVolume stays null (documented)', async () => {
    const desktop = new DesktopHandler({ commands: runner(), launchAllowlist: async () => [], logger });
    await expect(desktop.invoke('setVolume', [50], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining('No set volume command is configured for sdk.desktop.setVolume; set one in Settings → Commands → Set volume (platform default: wpctl or pactl'),
    });
    await expect(desktop.invoke('setBrightness', [50], ctx)).rejects.toMatchObject({ message: expect.stringContaining('Settings → Commands → Brightness') });
    expect(await desktop.invoke('getVolume', [], ctx)).toBeNull();
  });

  it('launch: PERMISSION_DENIED outside the allowlist, install hint for a missing app', async () => {
    const restricted = new DesktopHandler({ commands: runner(), launchAllowlist: async () => ['firefox'], logger });
    await expect(restricted.invoke('launch', ['vlc'], ctx)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: '"vlc" is not on the user\'s launch allowlist; they can add it under Settings → Integrations → Desktop launch allowlist',
      details: { app: 'vlc', allowlist: ['firefox'] },
    });
    const open = new DesktopHandler({ commands: runner(), launchAllowlist: async () => [], logger });
    await expect(open.invoke('launch', [MISSING], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: `Cannot launch "${MISSING}": it is not installed or not on PATH`,
      details: { code: 'ENOENT' },
    });
  });

  it('window management outside Hyprland says so instead of pointing at settings', async () => {
    const desktop = new DesktopHandler({ commands: runner(), launchAllowlist: async () => [], logger });
    for (const method of ['listWindows', 'currentWorkspace']) {
      await expect(desktop.invoke(method, [], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: HYPRLAND_REQUIRED_MESSAGE });
    }
    await expect(desktop.invoke('workspace', [2], ctx)).rejects.toMatchObject({ message: HYPRLAND_REQUIRED_MESSAGE });
    expect(HYPRLAND_REQUIRED_MESSAGE).toContain('nothing to configure');
  });
});

describe('voice', () => {
  const voice = (commands: CommandRunner, runScript?: () => Promise<unknown>) =>
    new VoiceHandler({ commands, audioWindow: () => fakeAudioWindow(runScript), ttsDir: path.join(tmp, 'tts'), logger, startGraceMs: 100 });

  it('listen: no stt command and no platform default', async () => {
    await expect(voice(runner()).invoke('listen', [{}], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: 'No listen command is configured for sdk.voice.listen; set one in Settings → Commands → Listen (platform default: none (no platform default; a recorder/transcriber command is required))',
    });
  });

  it('speak: no tts command and no built-in voice', async () => {
    await expect(voice(runner(), async () => false).invoke('speak', ['hi'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringMatching(/^No speak command is configured for sdk\.voice\.speak; set one in Settings → Commands → Speak \(platform default: .*\); the built-in speech synthesis is unavailable here too$/),
    });
    await expect(voice(runner(), undefined).invoke('speak', ['hi'], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED' });
  });

  it('speak: a fire-and-forget command that cannot start is still reported', async () => {
    await expect(voice(runner({ tts: { command: `${MISSING} {text}` } })).invoke('speak', ['hi'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringContaining(`The tts command needs "${MISSING}", which is not installed or not on PATH; install it or set another command in Settings → Commands → Speak`),
    });
    await expect(voice(runner({ tts: { command: `${NODE} -e "process.exit(2)" {text}` } })).invoke('speak', ['hi'], ctx)).rejects.toMatchObject({
      message: expect.stringContaining('exited with 2; check it in Settings → Commands → Speak'),
    });
    // A slow but healthy command resolves once playback started.
    await expect(voice(runner({ tts: { command: `${NODE} -e "setTimeout(()=>{},400)" {text}` } })).invoke('speak', ['hi'], ctx)).resolves.toBeUndefined();
  });
});

describe('calendar', () => {
  it('no sources → [] (documented); unreadable sources → CAPABILITY_FAILED naming them', async () => {
    const none = new CalendarHandler({ sources: async () => [], logger });
    expect(await none.invoke('today', [], ctx)).toEqual([]);
    const missing = path.join(tmp, 'nope.ics');
    const bad = new CalendarHandler({ sources: async () => [missing, 'https://calendar.example/x.ics'], logger, fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch });
    await expect(bad.invoke('upcoming', [24], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: expect.stringMatching(/^None of the user's calendar sources could be read \(.*nope\.ics: .*; https:\/\/calendar\.example\/x\.ics: HTTP 404\); they can fix them under Settings → Senses → Calendar sources$/),
      details: { failures: expect.arrayContaining([expect.stringContaining('HTTP 404')]) },
    });
  });

  it('one readable source is enough (the failed one is only logged)', async () => {
    const good = path.join(tmp, 'good.ics');
    fs.writeFileSync(good, 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:Standup\nDTSTART:20260910T090000Z\nDTEND:20260910T091500Z\nEND:VEVENT\nEND:VCALENDAR\n');
    const cal = new CalendarHandler({ sources: async () => [path.join(tmp, 'nope.ics'), good], logger, now: () => new Date('2026-09-10T08:00:00Z') });
    expect(await cal.invoke('upcoming', [3], ctx)).toMatchObject([{ title: 'Standup' }]);
  });
});

describe('messaging', () => {
  const messaging = (channels: AppSettings['messaging']['channels']) =>
    new MessagingHandler({ channels: async () => channels, runCommand: async () => ({ code: 0, stdout: '', stderr: '' }) });

  it('send: no channels / unknown channel / misconfigured channel', async () => {
    await expect(messaging([]).invoke('send', ['phone', 'hi'], ctx)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'No messaging channels are configured; the user can add one under Settings → Integrations → Messaging channels',
    });
    await expect(messaging([{ name: 'discord', kind: 'discord', url: 'https://discord.com/api/webhooks/1/x' }]).invoke('send', ['phone', 'hi'], ctx)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('No messaging channel named "phone" (configured: discord)'),
    });
    await expect(messaging([{ name: 'cmd', kind: 'command', command: { command: '  ' } }]).invoke('send', ['cmd', 'hi'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: 'Messaging channel "cmd" has no command; edit it under Settings → Integrations → Messaging channels',
    });
    await expect(messaging([{ name: 'hook', kind: 'slack' }]).invoke('send', ['hook', 'hi'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: 'Messaging channel "hook" (slack) has no valid http(s) webhook URL; edit it under Settings → Integrations → Messaging channels',
    });
  });
});

describe('files.open', () => {
  it('reports the opener error with the file', async () => {
    const files = new FilesHandler({ userData: path.join(tmp, 'ud'), openPath: async () => 'No application is registered for this file type' });
    await files.invoke('write', ['poem.txt', 'roses'], ctx);
    await expect(files.invoke('open', ['poem.txt'], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: "Cannot open poem.txt with the user's default application: No application is registered for this file type",
    });
    await expect(files.invoke('open', ['missing.txt'], ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ui.notify', () => {
  it('throws instead of silently logging when the OS has no notification service', async () => {
    const ui = new UiHandler({ prompts: new PendingPrompts({ fallback: null }), deliver: () => false, characterName: () => 'Luna', logger });
    await expect(ui.invoke('notify', ['Luna', 'tea'], ctx)).rejects.toMatchObject({ code: 'CAPABILITY_FAILED', message: NOTIFICATIONS_UNSUPPORTED_MESSAGE });
    // Prompts with no window fall back to the documented "dismissed" answers.
    expect(await ui.invoke('confirm', ['ok?'], ctx)).toBe(false);
    expect(await ui.invoke('choose', ['pick', ['a', 'b']], ctx)).toBeNull();
  });
});

describe('system.exec', () => {
  it('says when the program is not installed', async () => {
    const system = new SystemHandler({ home: tmp });
    await expect(system.invoke('exec', [MISSING, []], ctx)).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: `Cannot run "${MISSING}": it is not installed or not on PATH`,
      details: { command: MISSING, code: 'ENOENT' },
    });
  });
});
