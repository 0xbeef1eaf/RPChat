import type { RunLimits } from './action.js';
import type { ProviderConfig } from './llm.js';
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from './memory.js';

/**
 * Keeping a long conversation inside the context window: the oldest messages are replaced by a
 * rolling summary written in the background, and the code and results of past actions are dropped
 * from the transcript (they are still shown in the app and kept in storage).
 */
export interface HistorySettings {
  /** Master switch for background summarisation. Default true. */
  compress: boolean;
  /** Start summarising once the transcript is estimated above this many tokens. Default 6000. */
  compressAboveTokens: number;
  /** Messages at the end of the transcript that are never summarised. Default 16. */
  keepRecentMessages: number;
  /** Approximate token budget for the summary itself. Default 700. */
  summaryBudgetTokens: number;
  /**
   * How many of the most recent assistant messages keep the code and results of their actions.
   * Older ones keep only their visible text. Default 0: past tool calls are never re-sent (the
   * current turn's calls and results always are, inside the turn).
   */
  keepActionDetailFor: number;
}

export const DEFAULT_HISTORY_SETTINGS: HistorySettings = {
  compress: true,
  compressAboveTokens: 6_000,
  keepRecentMessages: 16,
  summaryBudgetTokens: 700,
  keepActionDetailFor: 0,
};
import type { MessagingChannel } from './senses.js';

/**
 * A user-editable external command. `command` is tokenised like a shell command line
 * (quotes respected) and executed WITHOUT a shell; placeholders such as `{file}`, `{url}`,
 * `{seconds}`, `{text}`, `{monitor}` are substituted inside tokens with the raw value
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

/**
 * External commands the app runs on the character's behalf. Input locking and injection
 * (`sdk.input`) are not here: they go through the rp-coded system daemon only.
 */
export interface CommandTemplates {
  /** Set the desktop wallpaper. Placeholders: {file} (absolute path), {monitor} (name or empty). */
  wallpaper: CommandTemplate;
  /** Open a browser window. Placeholders: {url}. */
  browser: CommandTemplate;
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
}

/** What a command template is for: which SDK methods run it and how the platform default is chosen. */
export interface CommandTemplateInfo {
  /** Label used in Settings → Commands and in error messages. */
  label: string;
  /** SDK methods that run this template, e.g. "sdk.wallpaper.set / restore". */
  usedBy: string;
  /** How the platform default is picked when the command is empty (what is probed for on PATH). */
  defaults: string;
}

/**
 * One entry per `CommandTemplates` key. Shared by the Settings UI (help text) and the host
 * handlers (error messages), so a "not configured" error names the same place the user sees.
 */
export const COMMAND_TEMPLATE_INFO: Record<keyof CommandTemplates, CommandTemplateInfo> = {
  wallpaper: { label: 'Set wallpaper', usedBy: 'sdk.wallpaper.set / restore', defaults: 'swww or hyprpaper on Hyprland, gsettings or feh on other Linux desktops, built in on Windows and macOS' },
  browser: { label: 'Open browser', usedBy: 'sdk.browser.open', defaults: 'xdg-open on Linux, the system default browser on Windows and macOS' },
  activeWindow: { label: 'Active window', usedBy: 'sdk.presence.activeWindow / status and the <senses> prompt line', defaults: 'none (Hyprland IPC is used directly; elsewhere the window is unknown until you set a command)' },
  nowPlaying: { label: 'Now playing', usedBy: 'sdk.presence.nowPlaying / status and the <senses> prompt line', defaults: 'playerctl when installed' },
  screenshot: { label: 'Screenshot', usedBy: 'sdk.screen.look', defaults: 'grim on Hyprland/Wayland, grim/scrot/import on other Linux desktops, screencapture on macOS; not needed where Electron can capture the screen' },
  tts: { label: 'Speak', usedBy: 'sdk.voice.speak', defaults: 'espeak-ng, espeak or spd-say on Linux, say on macOS, PowerShell speech on Windows; otherwise the built-in speech synthesis' },
  stt: { label: 'Listen', usedBy: 'sdk.voice.listen', defaults: 'none (no platform default; a recorder/transcriber command is required)' },
  launch: { label: 'Launch app', usedBy: 'sdk.desktop.launch', defaults: 'none needed: the app is spawned directly when empty' },
  volumeSet: { label: 'Set volume', usedBy: 'sdk.desktop.setVolume', defaults: 'wpctl or pactl on Linux, osascript on macOS' },
  volumeGet: { label: 'Get volume', usedBy: 'sdk.desktop.getVolume', defaults: 'wpctl or pactl on Linux, osascript on macOS' },
  brightness: { label: 'Brightness', usedBy: 'sdk.desktop.setBrightness', defaults: 'brightnessctl on Linux' },
  doNotDisturb: { label: 'Do not disturb', usedBy: 'sdk.desktop.doNotDisturb', defaults: 'makoctl or dunstctl on Linux' },
  theme: { label: 'Switch theme', usedBy: 'sdk.desktop.setTheme', defaults: 'gsettings on Linux, osascript on macOS' },
};

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
  /**
   * Text scale of the chat transcript and composer; 1 = 100%. Clamped to
   * [`CHAT_ZOOM_MIN`, `CHAT_ZOOM_MAX`] on save. Nothing else in the app scales with it.
   */
  chatZoom: number;
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
  history: HistorySettings;
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
    /** Keep the Settings → Senses "Live snapshot" card refreshing itself. Default false. */
    liveSnapshotAutoRefresh: boolean;
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
  /** In-place application updates (docs: README "Updating"). */
  updates: {
    /** Check the release feed on a schedule and download AppImage updates in the background. Default true. */
    automatic: boolean;
    /** Hours between automatic checks. Default 6. */
    checkIntervalHours: number;
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
    /**
     * Shortest delay for sdk.timers.schedule / runLater and a delayed sdk.llm.wake, ms. Shorter
     * values are raised to this (never rejected), so a character cannot pepper the user with
     * near-instant follow-ups. Default 30_000.
     */
    minDelayMs: number;
  };
  /** Developer toggles; nothing here changes what the character can do. */
  debug: {
    /**
     * Capture every request sent to the model for a chat session (turn rounds, `sdk.llm.ask`,
     * memory extraction) and the response or error, as `model-exchange` chat events. Kept in
     * memory by the app only (never persisted). Default false.
     */
    showModelTraffic: boolean;
  };
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'runLimits'> & { runLimits?: RunLimits } = {
  providers: [],
  maxActionRounds: 4,
  contextTokenBudget: 64_000,
  useToolCalling: true,
  userDisplayName: 'You',
  theme: 'system',
  chatZoom: 1,
  mediaAlwaysOnTop: true,
  displayBackend: 'auto',
  commandTemplates: {
    wallpaper: { command: '' },
    browser: { command: '' },
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
  },
  senses: { includeInPrompt: true, pollMs: 5000, idleThresholdMs: 120_000, calendarSources: [], watchDirs: [], liveSnapshotAutoRefresh: false },
  web: { allowlist: [], maxBytes: 512 * 1024 },
  desktop: { launchAllowlist: [] },
  messaging: { channels: [] },
  permissions: { moduleAllow: {} },
  maxInputLockMs: 5 * 60_000,
  wallpaperRestoreFile: '',
  memory: DEFAULT_MEMORY_SETTINGS,
  history: DEFAULT_HISTORY_SETTINGS,
  updates: { automatic: true, checkIntervalHours: 6 },
  autonomy: {
    maxSelfWakesPerHour: 30,
    maxConsecutiveSelfWakes: 10,
    maxTimersPerSession: 20,
    minRepeatIntervalMs: 60_000,
    minDelayMs: 30_000,
  },
  debug: { showModelTraffic: false },
};

/** Smallest chat text scale offered (80%). */
export const CHAT_ZOOM_MIN = 0.8;
/** Largest chat text scale offered (200%). */
export const CHAT_ZOOM_MAX = 2;
/** One press of "bigger"/"smaller". */
export const CHAT_ZOOM_STEP = 0.1;

/**
 * Round a chat zoom to whole percents and hold it inside the offered range, so a stored value
 * from an older build, a hand-edited settings file or a long chain of steps can never leave the
 * chat unreadable. Anything that is not a finite number falls back to 1 (100%).
 */
export function clampChatZoom(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.round(Math.min(CHAT_ZOOM_MAX, Math.max(CHAT_ZOOM_MIN, n)) * 100) / 100;
}
