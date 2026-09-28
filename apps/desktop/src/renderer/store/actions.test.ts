/**
 * The side of `actions.ts` that has no window behind it: what the UI does with a policy that
 * changed while the app was running, and with a pack that did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, IpcApi, PolicySnapshot } from '@rp/shared';
import { DEFAULT_APP_RESTRICTIONS } from '@rp/shared';
import { applyPackChange, applyPolicySnapshot } from './actions';
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

describe('applyPackChange', () => {
  beforeEach(() => {
    fakeApi();
    appStore.setState(initialState());
  });

  it('re-reads the packs, the characters and the sessions an update may have re-pointed', async () => {
    const packs = [{ packId: 'com.example.luna', manifest: { name: 'Luna Deluxe' } }];
    const characters = [{ ref: 'com.example.luna/selene', name: 'Selene' }];
    const sessions = [{ id: 's1', characterRef: 'com.example.luna/selene', title: 'Selene (Luna Deluxe)', updatedAt: '2026-01-01T00:00:00.000Z' }];
    (globalThis as { rp?: Partial<IpcApi> }).rp = {
      ...(globalThis as { rp?: Partial<IpcApi> }).rp,
      packs: { list: async () => packs } as unknown as IpcApi['packs'],
      characters: { list: async () => characters } as unknown as IpcApi['characters'],
      sessions: { list: async () => sessions } as unknown as IpcApi['sessions'],
    };

    await applyPackChange();

    const state = appStore.getState();
    expect(state.packs).toEqual(packs);
    expect(state.characters).toEqual(characters);
    expect(state.sessions.map((s) => s.characterRef)).toEqual(['com.example.luna/selene']);
  });
});

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
