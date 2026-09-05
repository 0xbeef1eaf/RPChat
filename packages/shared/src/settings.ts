import type { RunLimits } from './action.js';
import type { ProviderConfig } from './llm.js';

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
  /** Lock keyboard/mouse input. Placeholders: {seconds}, {durationMs}. */
  inputLock: CommandTemplate;
  /** Unlock input early (optional; leave empty if the lock command unlocks itself after the duration). */
  inputUnlock: CommandTemplate;
}

export interface AppSettings {
  providers: ProviderConfig[];
  /** Id of the provider used when a session has no override. */
  defaultProviderId?: string;
  /** Max LLM ⇄ action rounds per user message. Default 4. */
  maxActionRounds: number;
  /** Approximate token budget for the transcript window. Default 24_000. */
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
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'runLimits'> & { runLimits?: RunLimits } = {
  providers: [],
  maxActionRounds: 4,
  contextTokenBudget: 24_000,
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
  },
  maxInputLockMs: 5 * 60_000,
  wallpaperRestoreFile: '',
};
