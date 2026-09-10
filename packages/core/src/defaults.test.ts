import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@rp/shared';
import { defaultSettings, mergeSettings } from './defaults.js';

describe('mergeSettings commandTemplates', () => {
  it('keeps known templates per key and drops names from older versions', () => {
    const stored = {
      commandTemplates: {
        browser: { command: 'firefox {url}' },
        inputLock: { command: 'my-lock {seconds}' },
        inputType: { command: 'ydotool type -- "{text}"' },
        bogus: { command: 'x' },
      },
    } as unknown as Partial<AppSettings>;
    const merged = mergeSettings(stored);
    expect(merged.commandTemplates.browser).toEqual({ command: 'firefox {url}' });
    expect(merged.commandTemplates.wallpaper).toEqual({ command: '' });
    expect(Object.keys(merged.commandTemplates).sort()).toEqual(Object.keys(defaultSettings().commandTemplates).sort());
    expect(merged.commandTemplates).not.toHaveProperty('inputLock');
    expect(merged.commandTemplates).not.toHaveProperty('inputType');
    expect(merged.commandTemplates).not.toHaveProperty('bogus');
  });

  it('ignores non-object entries and leaves the defaults intact', () => {
    const stored = { commandTemplates: { browser: 'firefox', tts: null } } as unknown as Partial<AppSettings>;
    const merged = mergeSettings(stored);
    expect(merged.commandTemplates.browser).toEqual({ command: '' });
    expect(merged.commandTemplates.tts).toEqual({ command: '' });
    expect(defaultSettings().commandTemplates.browser).toEqual({ command: '' });
  });
});

describe('mergeSettings nested defaults', () => {
  it('fills debug from the defaults and merges a stored partial onto it', () => {
    expect(mergeSettings({}).debug).toEqual({ showModelTraffic: false });
    expect(mergeSettings({ debug: { showModelTraffic: true } }).debug).toEqual({ showModelTraffic: true });
    expect(mergeSettings({ debug: {} as AppSettings['debug'] }).debug).toEqual({ showModelTraffic: false });
  });
});

describe('mergeSettings budget migration', () => {
  it('moves the legacy 24k context budget to the current default and keeps other values', async () => {
    const { LEGACY_CONTEXT_TOKEN_BUDGET, mergeSettings } = await import('./defaults.js');
    expect(mergeSettings({ contextTokenBudget: LEGACY_CONTEXT_TOKEN_BUDGET }).contextTokenBudget).toBe(64_000);
    expect(mergeSettings({ contextTokenBudget: 30_000 }).contextTokenBudget).toBe(30_000);
    expect(mergeSettings({ history: { keepActionDetailFor: 2 } as never }).history.keepActionDetailFor).toBe(0);
    expect(mergeSettings({ history: { keepActionDetailFor: 3 } as never }).history.keepActionDetailFor).toBe(3);
  });
});
