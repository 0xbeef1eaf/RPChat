import { describe, expect, it } from 'vitest';
import { IPC_EVENT_CHANNELS } from '@rp/shared';
import { INVOKE_METHODS, buildApi, invokeChannels } from './api.js';
import type { IpcRendererLike } from './api.js';

class FakeIpcRenderer implements IpcRendererLike {
  readonly invoked: Array<{ channel: string; args: unknown[] }> = [];
  readonly listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invoked.push({ channel, args });
    return `result of ${channel}`;
  }

  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(listener);
  }

  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
    this.listeners.get(channel)?.delete(listener);
  }

  emit(channel: string, payload: unknown): void {
    for (const l of this.listeners.get(channel) ?? []) l({ sender: 'main' }, payload);
  }
}

describe('buildApi', () => {
  it('maps every namespace/method to an invoke on "<ns>:<method>"', async () => {
    const ipc = new FakeIpcRenderer();
    const api = buildApi(ipc);
    expect(await api.app.version()).toBe('result of app:version');
    expect(await api.chat.send('s1', 'hello')).toBe('result of chat:send');
    expect(await api.settings.testCommand('browser', { command: 'x' })).toBe('result of settings:testCommand');
    expect(await api.memories.add('com.x/luna', 'likes tea', { importance: 4 })).toBe('result of memories:add');
    expect(ipc.invoked).toEqual([
      { channel: 'app:version', args: [] },
      { channel: 'chat:send', args: ['s1', 'hello'] },
      { channel: 'settings:testCommand', args: ['browser', { command: 'x' }] },
      { channel: 'memories:add', args: ['com.x/luna', 'likes tea', { importance: 4 }] },
    ]);
    for (const [ns, methods] of Object.entries(INVOKE_METHODS)) {
      for (const m of methods) expect(typeof (api as unknown as Record<string, Record<string, unknown>>)[ns]?.[m], `${ns}.${m}`).toBe('function');
    }
    expect(invokeChannels()).toContain('display:monitors');
    expect(invokeChannels()).toContain('memories:consolidate');
    expect(invokeChannels()).toContain('updates:setToken');
    expect(invokeChannels()).toContain('system:createPolicy');
    expect(invokeChannels()).toContain('system:policyTemplate');
    expect(await api.system.createPolicy('{"version":1}')).toBe('result of system:createPolicy');
    expect(ipc.invoked.at(-1)).toEqual({ channel: 'system:createPolicy', args: ['{"version":1}'] });
  });

  it('wires push events with unsubscribe', () => {
    const ipc = new FakeIpcRenderer();
    const api = buildApi(ipc);
    const got: unknown[] = [];
    const off = api.chat.onEvent((ev) => got.push(ev));
    const offPerm = api.permissions.onRequest((r) => got.push(r));
    api.ui.onPrompt((p) => got.push(p));
    api.media.onCommand((c) => got.push(c));
    api.updates.onStatus((s) => got.push(s));
    ipc.emit(IPC_EVENT_CHANNELS.chatEvent, { type: 'status' });
    ipc.emit(IPC_EVENT_CHANNELS.permissionRequest, { requestId: 'r' });
    ipc.emit(IPC_EVENT_CHANNELS.uiPrompt, { promptId: 'p' });
    ipc.emit(IPC_EVENT_CHANNELS.mediaCommand, { type: 'close-all' });
    ipc.emit(IPC_EVENT_CHANNELS.updateStatus, { state: 'ready' });
    expect(got).toEqual([{ type: 'status' }, { requestId: 'r' }, { promptId: 'p' }, { type: 'close-all' }, { state: 'ready' }]);
    off();
    offPerm();
    ipc.emit(IPC_EVENT_CHANNELS.chatEvent, { type: 'again' });
    expect(got).toHaveLength(5);
    expect(ipc.listeners.get(IPC_EVENT_CHANNELS.chatEvent)?.size).toBe(0);
  });
});
