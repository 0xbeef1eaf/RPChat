import type { RunLimits } from './action.js';
import type { ProviderConfig } from './llm.js';
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from './memory.js';
import type { MessagingChannel } from './senses.js';

/**
 * A user-editable external command. `command` is tokenised like a shell command line
 * (quotes respected) and executed WITHOUT a shell; placeholders such as `{file}`, `{url}`,
 * `{seconds}`, `{durationMs}`, `{monitor}` are substituted inside tokens with the raw value
 * (never re-tokenised, so values cannot inject extra arguments). Set `shell: true` to run
 * the substituted line through the platform shell instead (values are then shell-quoted).
 * An empty `command` means "use the platform default" or, when there is none, "not configured".
 */
export interface CommandTemplate {
  command: string;
  shell?: boolean;
  /** Working directory; defaults to the user's home. */
  cwd?: string;
  /** Kill the process after this many ms. Default 30_000. */
  timeoutMs?: number;
}

export interface CommandTemplates {
  /** Set the desktop wallpaper. Placeholders: {file} (absolute path), {monitor} (name or empty). */
  wallpaper: CommandTemplate;
  /** Open a browser window. Placeholders: {url}. */
  browser: CommandTemplate;
  /** Lock keyboard/mouse input. Placeholders: {seconds}, {durationMs}, {devices} (keyboard|mouse|both). */
  inputLock: CommandTemplate;
  /** Unlock input early (optional; leave empty if the lock command unlocks itself after the duration). */
  inputUnlock: CommandTemplate;
  /** Print the active window as JSON `{title, app, class?}` or `title\tapp` on stdout. Not needed on Hyprland. */
  activeWindow: CommandTemplate;
  /** Print now-playing info as JSON `{title, artist, album, app, status}` (default: playerctl). */
  nowPlaying: CommandTemplate;
  /** Screenshot to `{file}` (png). Hyprland default: grim. Optional `{monitor}`. */
  screenshot: CommandTemplate;
  /** Text to speech. `{text}`; may write audio to `{file}` (wav) instead of playing. */
  tts: CommandTemplate;
  /** Speech to text: record for `{seconds}` and print the transcript on stdout. */
  stt: CommandTemplate;
  /** Launch an application: `{app}` `{args}`. Default: direct spawn. */
  launch: CommandTemplate;
  /** Set output volume 0..100: `{level}`. */
  volumeSet: CommandTemplate;
  /** Print output volume 0..100. */
  volumeGet: CommandTemplate;
  /** Set screen brightness 0..100: `{level}`. */
  brightness: CommandTemplate;
  /** Do-not-disturb on/off: `{on}` (1/0). */
  doNotDisturb: CommandTemplate;
  /** Switch theme: `{theme}` (dark/light). */
  theme: CommandTemplate;
  /** Type text: `{text}`. */
  inputType: CommandTemplate;
  /** Press a key combo: `{combo}` (e.g. ctrl+s). */
  inputKey: CommandTemplate;
  /** Click at `{x}` `{y}` with `{button}` (left/right/middle). */
  inputClick: CommandTemplate;
  /** Move the pointer to `{x}` `{y}`. */
  inputMove: CommandTemplate;
}

export interface AppSettings {
  providers: ProviderConfig[];
  /** Id of the provider used when a session has no override. */
  defaultProviderId?: string;
  /** Max LLM ⇄ action rounds per user message. Default 4. */
  maxActionRounds: number;
  /** Approximate token budget for the whole request (system prompt + transcript window). Default 64_000. */
  contextTokenBudget: number;
  runLimits: RunLimits;
  /** Prefer native tool calling when the provider supports it. Default true. */
  useToolCalling: boolean;
  userDisplayName: string;
  theme: 'system' | 'light' | 'dark';
  /** Whether media windows stay above other windows (used as the default layer: true → `top`, false → `bottom`). */
  mediaAlwaysOnTop: boolean;
  /** Display backend: `auto` picks `hyprland` when running under Hyprland, else `electron`. */
  displayBackend: 'auto' | 'electron' | 'hyprland';
  commandTemplates: CommandTemplates;
  /** Hard cap for `sdk.input.lock` durations. Default 5 minutes. */
  maxInputLockMs: number;
  /** Wallpaper file to restore with `sdk.wallpaper.restore()`; empty = unknown. */
  wallpaperRestoreFile: string;
  memory: MemorySettings;
  senses: {
    /** Add a one-line presence summary (idle, active window, now playing, battery) to every prompt when the pack has `presence`. Default true. */
    includeInPrompt: boolean;
    /** How often the host samples presence, ms. Default 5000. */
    pollMs: number;
    /** idleMs at or above which the user counts as away. Default 120_000. */
    idleThresholdMs: number;
    /** ICS files or http(s) URLs read by `sdk.calendar`. */
    calendarSources: string[];
    /** Directories watched for `file-added` events (e.g. ~/Downloads). */
    watchDirs: string[];
  };
  web: {
    /** Hostname patterns (`example.com`, `*.example.com`) `sdk.web` may fetch. Empty = any http(s) host. */
    allowlist: string[];
    /** Max response bytes. Default 512 KiB. */
    maxBytes: number;
  };
  desktop: {
    /** Apps `sdk.desktop.launch` may start (executable names). Empty = any app. */
    launchAllowlist: string[];
  };
  messaging: {
    channels: MessagingChannel[];
  };
  /**
   * Global permission policy. A pack's effective capabilities are the intersection of what its
   * manifest requests, what this policy allows, and the per-pack toggle. Modules missing from
   * `moduleAllow` count as allowed (so newly added modules are on by default); `trusted` modules
   * are never listed here.
   */
  permissions: {
    moduleAllow: Record<string, boolean>;
  };
  /**
   * Limits on autonomous activity (self-wakes, code timers, prompt timers) so a character
   * cannot run away. Consecutive = turns not separated by a user message.
   */
  autonomy: {
    /** Max self-triggered LLM turns per session per hour. Default 30. */
    maxSelfWakesPerHour: number;
    /** Max consecutive self-triggered turns without a user message. Default 10. */
    maxConsecutiveSelfWakes: number;
    /** Max pending timers per session. Default 20. */
    maxTimersPerSession: number;
    /** Shortest repeat interval for repeating timers, ms. Default 60_000. */
    minRepeatIntervalMs: number;
  };
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'runLimits'> & { runLimits?: RunLimits } = {
  providers: [],
  maxActionRounds: 4,
  contextTokenBudget: 64_000,
  useToolCalling: true,
  userDisplayName: 'You',
  theme: 'system',
  mediaAlwaysOnTop: true,
  displayBackend: 'auto',
  commandTemplates: {
    wallpaper: { command: '' },
    browser: { command: '' },
    inputLock: { command: '' },
    inputUnlock: { command: '' },
    activeWindow: { command: '' },
    nowPlaying: { command: '' },
    screenshot: { command: '' },
    tts: { command: '' },
    stt: { command: '' },
    launch: { command: '' },
    volumeSet: { command: '' },
    volumeGet: { command: '' },
    brightness: { command: '' },
    doNotDisturb: { command: '' },
    theme: { command: '' },
    inputType: { command: '' },
    inputKey: { command: '' },
    inputClick: { command: '' },
    inputMove: { command: '' },
  },
  senses: { includeInPrompt: true, pollMs: 5000, idleThresholdMs: 120_000, calendarSources: [], watchDirs: [] },
  web: { allowlist: [], maxBytes: 512 * 1024 },
  desktop: { launchAllowlist: [] },
  messaging: { channels: [] },
  permissions: { moduleAllow: {} },
  maxInputLockMs: 5 * 60_000,
  wallpaperRestoreFile: '',
  memory: DEFAULT_MEMORY_SETTINGS,
  autonomy: {
    maxSelfWakesPerHour: 30,
    maxConsecutiveSelfWakes: 10,
    maxTimersPerSession: 20,
    minRepeatIntervalMs: 60_000,
  },
};
