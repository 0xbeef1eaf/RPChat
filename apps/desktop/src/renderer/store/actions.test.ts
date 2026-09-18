/**
 * The side of `actions.ts` that has no window behind it: what the UI does with a policy that
 * changed while the app was running.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, IpcApi, PolicySnapshot } from '@rp/shared';
import { DEFAULT_APP_RESTRICTIONS } from '@rp/shared';
import { applyPolicySnapshot } from './actions';
import { initialState } from './state';
import { appStore } from './store';

const SETTINGS = { theme: 'system' } as AppSettings;

function fakeApi(): void {
  (globalThis as { rp?: Partial<IpcApi> }).rp = {
    settings: { get: async () => SETTINGS, managed: async () => [] } as unknown as IpcApi['settings'],
  };
  // `applyTheme` runs against the document; the test environment has none.
  (globalThis as { document?: unknown }).document = { documentElement: { setAttribute: vi.fn(), removeAttribute: vi.fn() } };
  (globalThis as { window?: unknown }).window = { setTimeout: vi.fn(), clearTimeout: vi.fn() };
}

function snapshot(patch: Partial<PolicySnapshot['restrictions']>, managed: string[] = []): PolicySnapshot {
  return { restrictions: { ...DEFAULT_APP_RESTRICTIONS, ...patch }, managed };
}

describe('applyPolicySnapshot', () => {
  beforeEach(() => {
    fakeApi();
    appStore.setState(initialState());
  });

  it('adopts the new restrictions and managed settings without a restart', () => {
    applyPolicySnapshot(snapshot({ allowPackEditor: false }, ['memory.enabled']));
    expect(appStore.getState().restrictions.allowPackEditor).toBe(false);
    expect(appStore.getState().managed).toEqual(['memory.enabled']);
  });

  it('leaves a view the policy just withdrew, and stays put otherwise', () => {
    appStore.setState((s) => ({ ...s, route: 'editor' }));
    applyPolicySnapshot(snapshot({ allowPackEditor: false }));
    expect(appStore.getState().route).toBe('chat');

    appStore.setState((s) => ({ ...s, route: 'packs' }));
    applyPolicySnapshot(snapshot({ allowPackEditor: false }));
    expect(appStore.getState().route).toBe('packs');
  });

  it('keeps the view when the policy gives it back', () => {
    appStore.setState((s) => ({ ...s, route: 'sandbox' }));
    applyPolicySnapshot(snapshot({ allowSandbox: true }));
    expect(appStore.getState().route).toBe('sandbox');
  });
});
