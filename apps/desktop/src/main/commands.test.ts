import { describe, expect, it } from 'vitest';
import { COMMAND_TEMPLATE_INFO } from '@rp/shared';
import { buildArgv, defaultTemplates, effectiveTemplate, runTemplate, shellQuote, substitute, tokenize, commandFailed, isMissingExecutable, notConfigured, templateLocation } from './commands.js';

describe('tokenize', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenize('swww img {file}')).toEqual(['swww', 'img', '{file}']);
    expect(tokenize(`hyprctl hyprpaper wallpaper "{monitor},{file}"`)).toEqual(['hyprctl', 'hyprpaper', 'wallpaper', '{monitor},{file}']);
    expect(tokenize(`osascript -e 'tell application "System Events" to set picture to "{file}"'`)).toEqual([
      'osascript',
      '-e',
      'tell application "System Events" to set picture to "{file}"',
    ]);
  });

  it('handles escapes, empty arguments and mixed quoting', () => {
    expect(tokenize('a\\ b c')).toEqual(['a b', 'c']);
    expect(tokenize('cmd /c start "" {url}')).toEqual(['cmd', '/c', 'start', '', '{url}']);
    expect(tokenize(`x "a\\"b" 'c\\d'`)).toEqual(['x', 'a"b', 'c\\d']);
    expect(tokenize('  ')).toEqual([]);
  });

  it('rejects unterminated quotes', () => {
    expect(() => tokenize('echo "oops')).toThrow(/Unterminated double quote/);
  });
});

describe('substitute', () => {
  it('replaces placeholders inside tokens without re-tokenising', () => {
    const out = substitute(['show', '{file}', 'x={monitor},{file}', '{unknown}'], { file: '/tmp/a b.png', monitor: 'DP-1' });
    expect(out).toEqual(['show', '/tmp/a b.png', 'x=DP-1,/tmp/a b.png', '']);
  });
});

describe('shellQuote', () => {
  it('quotes for sh and cmd', () => {
    expect(shellQuote('plain.png', 'linux')).toBe('plain.png');
    expect(shellQuote("it's here", 'linux')).toBe(`'it'\\''s here'`);
    expect(shellQuote('', 'linux')).toBe("''");
    expect(shellQuote('C:\\a b\\x.png', 'win32')).toBe('"C:\\a b\\x.png"');
    expect(shellQuote('say "hi" 100%', 'win32')).toBe('"say ""hi"" 100%%"');
  });
});

describe('defaultTemplates', () => {
  const noEnv = {} as NodeJS.ProcessEnv;
  it('linux under Hyprland prefers swww, then hyprpaper, else empty', () => {
    const hypr = { HYPRLAND_INSTANCE_SIGNATURE: 'abc' } as NodeJS.ProcessEnv;
    expect(defaultTemplates('linux', hypr, (n) => n === 'swww').wallpaper.command).toBe('swww img {file}');
    expect(defaultTemplates('linux', hypr, (n) => n === 'hyprpaper').wallpaper.command).toBe('hyprctl hyprpaper wallpaper "{monitor},{file}"');
    expect(defaultTemplates('linux', hypr, () => false).wallpaper.command).toBe('');
    expect(defaultTemplates('linux', hypr, () => false).browser.command).toBe('xdg-open {url}');
    expect(defaultTemplates('linux', hypr, () => true)).not.toHaveProperty('inputLock');
  });

  it('linux on Wayland prefers noctalia (set and read templates), also under Hyprland', () => {
    const wl = { WAYLAND_DISPLAY: 'wayland-1' } as NodeJS.ProcessEnv;
    const t = defaultTemplates('linux', wl, (n) => n === 'noctalia' || n === 'swww');
    expect(t.wallpaper.command).toBe('noctalia msg wallpaper-set {monitor} {file}');
    expect(t.wallpaperGet.command).toBe('noctalia msg wallpaper-get {monitor}');
    expect(defaultTemplates('linux', { HYPRLAND_INSTANCE_SIGNATURE: 'x' } as NodeJS.ProcessEnv, (n) => n === 'noctalia' || n === 'hyprpaper').wallpaper.command).toBe('noctalia msg wallpaper-set {monitor} {file}');
    // Not on Wayland: noctalia is ignored; gsettings brings a read template, feh none.
    expect(defaultTemplates('linux', {} as NodeJS.ProcessEnv, (n) => n === 'noctalia').wallpaper.command).toBe('');
    expect(defaultTemplates('linux', {} as NodeJS.ProcessEnv, (n) => n === 'gsettings').wallpaperGet.command).toBe('gsettings get org.gnome.desktop.background picture-uri');
    expect(defaultTemplates('linux', {} as NodeJS.ProcessEnv, (n) => n === 'feh').wallpaperGet.command).toBe('');
    expect(defaultTemplates('linux', wl, (n) => n === 'swww').wallpaper.command).toBe('');
    // A lone empty {monitor} token is dropped, so the single template serves both forms.
    expect(buildArgv(t.wallpaper, { monitor: '', file: '/p/w.png' }, 'linux')).toEqual({ file: 'noctalia', args: ['msg', 'wallpaper-set', '/p/w.png'], verbatim: false });
    expect(buildArgv(t.wallpaper, { monitor: 'DP-1', file: '/p/w.png' }, 'linux')).toEqual({ file: 'noctalia', args: ['msg', 'wallpaper-set', 'DP-1', '/p/w.png'], verbatim: false });
    expect(buildArgv(t.wallpaperGet, { monitor: '' }, 'linux').args).toEqual(['msg', 'wallpaper-get']);
    // Embedded placeholders and literal empty arguments are untouched.
    expect(buildArgv({ command: 'hyprctl hyprpaper wallpaper "{monitor},{file}"' }, { monitor: '', file: '/p' }, 'linux').args).toEqual(['hyprpaper', 'wallpaper', ',/p']);
    expect(buildArgv({ command: 'x "" {file}' }, { file: '/p' }, 'linux').args).toEqual(['', '/p']);
  });

  it('linux without Hyprland uses gsettings then feh', () => {
    expect(defaultTemplates('linux', noEnv, (n) => n === 'gsettings').wallpaper.command).toContain('gsettings set org.gnome.desktop.background picture-uri');
    expect(defaultTemplates('linux', noEnv, (n) => n === 'feh').wallpaper.command).toBe('feh --bg-fill {file}');
  });

  it('win32 and darwin defaults', () => {
    const win = defaultTemplates('win32', noEnv, () => true);
    expect(win.wallpaper.command).toMatch(/^powershell .*SystemParametersInfo/);
    expect(tokenize(win.wallpaper.command)).toHaveLength(5);
    expect(win.browser).toEqual({ command: 'cmd /c start "" {url}', shell: true });
    const mac = defaultTemplates('darwin', noEnv, () => true);
    expect(mac.wallpaper.command).toContain('osascript');
    expect(mac.browser.command).toBe('open {url}');
    expect(Object.keys(mac)).not.toContain('inputType');
  });
});

describe('effectiveTemplate + buildArgv', () => {
  it('uses the user template when set, else the platform default', () => {
    const defaults = defaultTemplates('darwin', {} as NodeJS.ProcessEnv, () => true);
    const user = { wallpaper: { command: '' , timeoutMs: 5 }, browser: { command: 'firefox {url}' } };
    expect(effectiveTemplate('browser', user, defaults).command).toBe('firefox {url}');
    expect(effectiveTemplate('wallpaper', user, defaults)).toEqual({ ...defaults.wallpaper, timeoutMs: 5 });
  });

  it('builds argv without a shell, and a shell line with quoted values', () => {
    expect(buildArgv({ command: 'xdg-open {url}' }, { url: 'https://x.y/?a=1 2' }, 'linux')).toEqual({ file: 'xdg-open', args: ['https://x.y/?a=1 2'], verbatim: false });
    expect(buildArgv({ command: 'open {url}', shell: true }, { url: "https://x.y/it's" }, 'linux')).toEqual({ file: 'sh', args: ['-c', `open 'https://x.y/it'\\''s'`], verbatim: false });
    expect(buildArgv({ command: 'cmd /c start "" {url}', shell: true }, { url: 'https://x' }, 'win32')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '"cmd /c start "" "https://x""'],
      verbatim: true,
    });
    expect(() => buildArgv({ command: '   ' }, {}, 'linux')).toThrow(/No matching command configured/);
  });
});

describe('runTemplate', () => {
  it('runs a program and captures output', async () => {
    const r = await runTemplate({ command: 'node -e "console.log(process.argv[1]); console.error(\'err\')" {file}' }, { file: '/tmp/x y.png' });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('/tmp/x y.png');
    expect(r.stderr.trim()).toBe('err');
  });

  it('kills on timeout and rejects when the program does not exist', async () => {
    const r = await runTemplate({ command: 'node -e "setTimeout(()=>{},5000)"', timeoutMs: 200 }, {});
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('timed out');
    await expect(runTemplate({ command: 'definitely-not-a-program-xyz {file}' }, { file: 'a' })).rejects.toMatchObject({
      code: 'CAPABILITY_FAILED',
      message: 'Cannot run "definitely-not-a-program-xyz": it is not installed or not on PATH',
      details: { file: 'definitely-not-a-program-xyz', code: 'ENOENT' },
    });
  });
});

describe('configuration errors', () => {
  it('notConfigured names the SDK method, the settings row and the platform default for known templates', () => {
    const err = notConfigured('screenshot');
    expect(err.code).toBe('CAPABILITY_FAILED');
    expect(err.message).toBe(
      'No screenshot command is configured for sdk.screen.look; set one in Settings → Commands → Screenshot (platform default: grim on Hyprland/Wayland, grim/scrot/import on other Linux desktops, screencapture on macOS; not needed where Electron can capture the screen)',
    );
    expect(err.details).toEqual({ template: 'screenshot', usedBy: 'sdk.screen.look' });
    expect(notConfigured('stt').message).toContain('sdk.voice.listen');
    expect(notConfigured('stt').message).toContain('Settings → Commands → Listen');
    expect(notConfigured('wallpaper').message).toContain('swww or hyprpaper on Hyprland');
    // Unknown names keep the generic wording (used by buildArgv).
    expect(notConfigured('matching').message).toBe('No matching command configured; set one in Settings → Commands');
    expect(templateLocation('volumeSet')).toBe('Settings → Commands → Set volume');
    expect(templateLocation('nope')).toBe('Settings → Commands');
  });

  it('every template has an info entry so errors and the Settings page agree', () => {
    const names = Object.keys(defaultTemplates('linux', { PATH: '' }, () => false)).sort();
    expect(Object.keys(COMMAND_TEMPLATE_INFO).sort()).toEqual(names);
    for (const name of names) {
      const info = COMMAND_TEMPLATE_INFO[name as keyof typeof COMMAND_TEMPLATE_INFO];
      expect(info.usedBy, name).toMatch(/^sdk\./);
      expect(info.label.length, name).toBeGreaterThan(0);
      expect(info.defaults.length, name).toBeGreaterThan(0);
    }
  });

  it('commandFailed quotes the command, exit code, output and the settings row', () => {
    const err = commandFailed('wallpaper', { command: 'swww img {file}' }, { code: 2, stdout: '', stderr: 'no daemon running\n' });
    expect(err.code).toBe('CAPABILITY_FAILED');
    expect(err.message).toBe('Set wallpaper command ("swww img {file}") exited with 2: no daemon running; check it in Settings → Commands → Set wallpaper');
    expect(err.details).toMatchObject({ template: 'wallpaper', code: 2 });
    expect(commandFailed('tts', { command: 'say {text}' }, { code: 1, stdout: 'out', stderr: '' }).message).toContain('exited with 1: out;');
    expect(commandFailed('tts', { command: 'say {text}' }, { code: 1, stdout: '', stderr: '' }).message).toContain('exited with 1; check it');
  });

  it('isMissingExecutable recognises spawn ENOENT only', () => {
    expect(isMissingExecutable(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }))).toBe(true);
    expect(isMissingExecutable(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(false);
    expect(isMissingExecutable(new Error('x'))).toBe(false);
    expect(isMissingExecutable(undefined)).toBe(false);
  });
});
