/**
 * User-editable command templates for the `wallpaper`, `browser` and `input`
 * modules (docs/spec/overlay.md §2). Everything here is pure except
 * `runTemplate`, which spawns the process.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandTemplate, CommandTemplates } from '@rp/shared';
import { RpError } from '@rp/shared';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const COMMAND_OUTPUT_CAP = 64 * 1024;
export const COMMAND_DEFAULT_TIMEOUT_MS = 30_000;

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * POSIX-ish tokenizer: whitespace separates arguments, `'…'` keeps everything
 * literal, `"…"` allows backslash escapes, a backslash outside single quotes
 * escapes the next character. `""` produces an empty argument.
 */
export function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < commandLine.length) {
      const next = commandLine[i + 1] as string;
      if (quote === '"' && !['"', '\\', '$', '`'].includes(next)) {
        current += ch;
      } else {
        current += next;
        i += 1;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken || current.length > 0) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote !== null) throw new RpError('INVALID_ARGUMENT', `Unterminated ${quote === '"' ? 'double' : 'single'} quote in command`);
  if (hasToken || current.length > 0) tokens.push(current);
  return tokens;
}

/** Replace `{name}` placeholders inside each token. Unknown names become ''. Never re-tokenises. */
export function substitute(tokens: string[], vars: Record<string, string>): string[] {
  return tokens.map((token) => token.replace(PLACEHOLDER, (_m, name: string) => vars[name] ?? ''));
}

/** Quote a value for the platform shell (`sh` or `cmd.exe`). */
export function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // cmd.exe: wrap in double quotes; a literal quote is doubled inside; `%` is neutralised so no env var expands.
    return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`;
  }
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_\/.:=@+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `true` when `name` resolves to an executable on `PATH` (or is an existing absolute path). */
export function hasExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (!name) return false;
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const isExec = (file: string): boolean => {
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return false;
      if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (path.isAbsolute(name)) return exts.some((ext) => isExec(name + ext)) || isExec(name);
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) if (isExec(path.join(dir, name + ext))) return true;
    if (platform === 'win32' && isExec(path.join(dir, name))) return true;
  }
  return false;
}

export type ExecutableProbe = (name: string) => boolean;

const WINDOWS_WALLPAPER_SCRIPT =
  'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public class RpWallpaper { [DllImport("user32.dll", SetLastError = true)] public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni); }\'; ' +
  "[RpWallpaper]::SystemParametersInfo(20, 0, '{file}', 3) | Out-Null";

/**
 * Platform defaults used when a template's `command` is empty. Executable
 * probing is injectable so the table is unit-testable.
 */
export function defaultTemplates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  probe: ExecutableProbe = (name) => hasExecutable(name, env, platform),
): CommandTemplates {
  const empty: CommandTemplate = { command: '' };
  const hyprland = Boolean(env.HYPRLAND_INSTANCE_SIGNATURE);
  let wallpaper: CommandTemplate = empty;
  let browser: CommandTemplate = empty;
  if (platform === 'linux' || (platform !== 'win32' && platform !== 'darwin')) {
    browser = { command: 'xdg-open {url}' };
    if (hyprland) {
      if (probe('swww')) wallpaper = { command: 'swww img {file}' };
      else if (probe('hyprpaper')) wallpaper = { command: 'hyprctl hyprpaper wallpaper "{monitor},{file}"' };
    } else if (probe('gsettings')) {
      wallpaper = { command: 'gsettings set org.gnome.desktop.background picture-uri "file://{file}"' };
    } else if (probe('feh')) {
      wallpaper = { command: 'feh --bg-fill {file}' };
    }
  } else if (platform === 'win32') {
    // PowerShell one-liner. Passed as a single argv token (no cmd.exe in between) so the
    // script survives intact; `{file}` is substituted inside the token.
    wallpaper = { command: `powershell -NoProfile -NonInteractive -Command "${WINDOWS_WALLPAPER_SCRIPT.replace(/"/g, '\\"')}"` };
    browser = { command: 'cmd /c start "" {url}', shell: true };
  } else if (platform === 'darwin') {
    wallpaper = { command: `osascript -e 'tell application "System Events" to set picture of every desktop to "{file}"'` };
    browser = { command: 'open {url}' };
  }
  // ---- phase 2 templates (docs/spec/living.md §4) ----------------------------------
  const linux = platform === 'linux' || (platform !== 'win32' && platform !== 'darwin');
  const pick = (...candidates: Array<[string, string]>): CommandTemplate => {
    for (const [bin, command] of candidates) if (probe(bin)) return { command };
    return empty;
  };
  const nowPlaying = probe('playerctl')
    ? { command: `playerctl metadata --format '{"title":"{{title}}","artist":"{{artist}}","album":"{{album}}","app":"{{playerName}}","status":"{{status}}"}'` }
    : empty;
  let screenshot: CommandTemplate = empty;
  let tts: CommandTemplate = empty;
  let volumeSet: CommandTemplate = empty;
  let volumeGet: CommandTemplate = empty;
  let brightness: CommandTemplate = empty;
  let doNotDisturb: CommandTemplate = empty;
  let theme: CommandTemplate = empty;
  if (linux) {
    if (hyprland) screenshot = pick(['grim', 'grim -o {monitor} {file}']);
    else screenshot = pick(['grim', 'grim {file}'], ['scrot', 'scrot -o {file}'], ['import', 'import -window root {file}']);
    tts = pick(['espeak-ng', 'espeak-ng "{text}"'], ['espeak', 'espeak "{text}"'], ['spd-say', 'spd-say -w "{text}"']);
    volumeSet = pick(['wpctl', 'wpctl set-volume @DEFAULT_AUDIO_SINK@ {level}%'], ['pactl', 'pactl set-sink-volume @DEFAULT_SINK@ {level}%']);
    volumeGet = pick(['wpctl', 'wpctl get-volume @DEFAULT_AUDIO_SINK@'], ['pactl', 'pactl get-sink-volume @DEFAULT_SINK@']);
    brightness = pick(['brightnessctl', 'brightnessctl set {level}%']);
    doNotDisturb = pick(['makoctl', 'makoctl mode -t do-not-disturb'], ['dunstctl', 'dunstctl set-paused {on}']);
    theme = pick(['gsettings', 'gsettings set org.gnome.desktop.interface color-scheme prefer-{theme}']);
  } else if (platform === 'darwin') {
    screenshot = { command: 'screencapture -x {file}' };
    tts = { command: 'say "{text}"' };
    volumeSet = { command: `osascript -e 'set volume output volume {level}'` };
    volumeGet = { command: `osascript -e 'output volume of (get volume settings)'` };
    theme = { command: `osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to {darkMode}'` };
  } else if (platform === 'win32') {
    tts = {
      command:
        'powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak(\'{text}\')"',
    };
  }
  return {
    wallpaper,
    browser,
    activeWindow: empty,
    nowPlaying,
    screenshot,
    tts,
    stt: empty,
    launch: empty,
    volumeSet,
    volumeGet,
    brightness,
    doNotDisturb,
    theme,
  };
}

/** The template to run: the user's when it has a command, otherwise the platform default (may still be empty). */
export function effectiveTemplate(name: keyof CommandTemplates, templates: CommandTemplates, defaults: CommandTemplates): CommandTemplate {
  const user = templates[name];
  if (user && typeof user.command === 'string' && user.command.trim().length > 0) return user;
  const fallback = defaults[name];
  const merged: CommandTemplate = { ...fallback };
  if (user?.timeoutMs !== undefined) merged.timeoutMs = user.timeoutMs;
  if (user?.cwd) merged.cwd = user.cwd;
  return merged;
}

export function isConfigured(tpl: CommandTemplate | undefined): boolean {
  return Boolean(tpl && typeof tpl.command === 'string' && tpl.command.trim().length > 0);
}

/** Error thrown by handlers when a template is empty after defaults. */
export function notConfigured(what: string): RpError {
  return new RpError('CAPABILITY_FAILED', `No ${what} command configured; set one in Settings → Commands`);
}

export interface RunTemplateOptions {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Kills the process when aborted (result code -1). */
  signal?: AbortSignal;
}

/** Build the argv for a template without running it (exposed for tests and the settings "Test" preview). */
export function buildArgv(tpl: CommandTemplate, vars: Record<string, string>, platform: NodeJS.Platform): { file: string; args: string[]; verbatim: boolean } {
  if (!isConfigured(tpl)) throw notConfigured('matching');
  if (tpl.shell) {
    const quoted: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) quoted[k] = shellQuote(v, platform);
    const line = substitute([tpl.command], quoted)[0] ?? '';
    if (platform === 'win32') return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
    return { file: 'sh', args: ['-c', line], verbatim: false };
  }
  const argv = substitute(tokenize(tpl.command), vars);
  const file = argv[0];
  if (!file) throw new RpError('INVALID_ARGUMENT', 'Command template is empty after substitution');
  return { file, args: argv.slice(1), verbatim: false };
}

/** Run a command template with placeholder values. Rejects only when the process cannot be started. */
export function runTemplate(tpl: CommandTemplate, vars: Record<string, string>, opts: RunTemplateOptions = {}): Promise<CommandResult> {
  const platform = opts.platform ?? process.platform;
  const { file, args, verbatim } = buildArgv(tpl, vars, platform);
  const timeoutMs = Math.max(100, opts.timeoutMs ?? tpl.timeoutMs ?? COMMAND_DEFAULT_TIMEOUT_MS);
  const cwd = tpl.cwd && tpl.cwd.trim().length > 0 ? expandHome(tpl.cwd) : os.homedir();
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(file, args, {
      cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const append = (current: string, chunk: Buffer): string =>
      current.length >= COMMAND_OUTPUT_CAP ? current : (current + chunk.toString('utf8')).slice(0, COMMAND_OUTPUT_CAP);
    child.stdout?.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr?.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new RpError('CAPABILITY_FAILED', `Cannot run "${file}": ${err.message}`, { file, args }, { cause: err }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (timedOut) stderr = `${stderr}${stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n'}[rp] command timed out after ${timeoutMs} ms`;
      resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

/** `~` and `~/x` → the user's home directory. */
export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}
