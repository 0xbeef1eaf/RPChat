import { describe, expect, it } from 'vitest';
import { CHAT_ZOOM_MAX, CHAT_ZOOM_MIN } from '@rp/shared';
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
  it('fills the browser toggles and caps from the defaults and keeps stored values', () => {
    expect(mergeSettings({}).browser).toEqual({ bridgePort: 47821, trustedExtensionIds: [], allowBlocking: true, allowEval: true, allowHistory: true, homePage: '', extraPolicyDirs: [] });
    // A settings file from before these keys existed keeps its port and ids and gains the defaults.
    const older = mergeSettings({ browser: { bridgePort: 5000, trustedExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'] } as AppSettings['browser'] }).browser;
    expect(older).toEqual({ bridgePort: 5000, trustedExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'], allowBlocking: true, allowEval: true, allowHistory: true, homePage: '', extraPolicyDirs: [] });
    expect(mergeSettings({ browser: { allowEval: false, homePage: 'https://home.test/' } as AppSettings['browser'] }).browser).toMatchObject({ allowEval: false, homePage: 'https://home.test/', allowBlocking: true });
  });

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

  it('moves the legacy fixed compression threshold back to auto and keeps a chosen one', async () => {
    const { LEGACY_COMPRESS_ABOVE_TOKENS, mergeSettings } = await import('./defaults.js');
    expect(mergeSettings({ history: { compressAboveTokens: LEGACY_COMPRESS_ABOVE_TOKENS } as never }).history.compressAboveTokens).toBe(0);
    expect(mergeSettings({ history: { compressAboveTokens: 20_000 } as never }).history.compressAboveTokens).toBe(20_000);
  });
});

describe('mergeSettings chatZoom', () => {
  it('defaults to 100% and holds a stored value inside the offered range', () => {
    expect(mergeSettings({}).chatZoom).toBe(1);
    expect(mergeSettings({ chatZoom: 1.5 }).chatZoom).toBe(1.5);
    // A hand-edited file or an older build must not leave the chat unreadable.
    expect(mergeSettings({ chatZoom: 12 }).chatZoom).toBe(CHAT_ZOOM_MAX);
    expect(mergeSettings({ chatZoom: 0.05 }).chatZoom).toBe(CHAT_ZOOM_MIN);
    expect(mergeSettings({ chatZoom: Number.NaN }).chatZoom).toBe(1);
    expect(mergeSettings({ chatZoom: 'big' } as unknown as Partial<AppSettings>).chatZoom).toBe(1);
    // Steps accumulate in floating point; the stored value stays a whole percent.
    expect(mergeSettings({ chatZoom: 0.1 + 0.2 + 0.8 }).chatZoom).toBe(1.1);
  });
});
