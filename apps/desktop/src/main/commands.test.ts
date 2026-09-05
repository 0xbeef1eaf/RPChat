import { describe, expect, it } from 'vitest';
import { buildArgv, defaultTemplates, effectiveTemplate, runTemplate, shellQuote, substitute, tokenize } from './commands.js';

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
    expect(defaultTemplates('linux', hypr, () => true).inputLock.command).toBe('');
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
    expect(mac.inputLock.command).toBe('');
    expect(mac.inputUnlock.command).toBe('');
  });
});

describe('effectiveTemplate + buildArgv', () => {
  it('uses the user template when set, else the platform default', () => {
    const defaults = defaultTemplates('darwin', {} as NodeJS.ProcessEnv, () => true);
    const user = { wallpaper: { command: '' , timeoutMs: 5 }, browser: { command: 'firefox {url}' }, inputLock: { command: '' }, inputUnlock: { command: '' } };
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
    await expect(runTemplate({ command: 'definitely-not-a-program-xyz {file}' }, { file: 'a' })).rejects.toThrow(/Cannot run/);
  });
});
