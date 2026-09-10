/**
 * Builds the `IpcApi` object exposed to renderer windows generically: every
 * namespace/method becomes `ipcRenderer.invoke('<ns>:<method>', ...args)` and
 * every `on*` subscription an `ipcRenderer.on(channel)` with an unsubscribe.
 * Pure over an `IpcRendererLike`, so it can be unit-tested with a fake.
 */
import type { IpcApi } from '@rp/shared';
import { IPC_EVENT_CHANNELS } from '@rp/shared';

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

type Namespaces = keyof IpcApi;

/** Every request/response method, per namespace (event subscriptions are listed in `EVENT_METHODS`). */
export const INVOKE_METHODS: { [K in Namespaces]: ReadonlyArray<keyof IpcApi[K] & string> } = {
  app: ['version', 'windowKind', 'openPath'],
  packs: ['list', 'pickInstallSource', 'inspect', 'install', 'uninstall', 'setGrant', 'exportPack'],
  capabilities: ['list', 'typings'],
  characters: ['list', 'status'],
  events: ['list', 'remove'],
  senses: ['snapshot'],
  sessions: ['list', 'create', 'get', 'update', 'remove', 'messages', 'removeMessage', 'clearMessages'],
  chat: ['send', 'abort'],
  permissions: ['respond'],
  settings: ['get', 'managed', 'update', 'testProvider', 'listModels', 'testCommand', 'defaultCommands'],
  audit: ['list'],
  memories: ['list', 'add', 'update', 'remove', 'consolidate'],
  ui: ['respondPrompt'],
  system: ['status', 'install', 'setAutostart', 'installerPath', 'createPolicy', 'policyTemplate'],
  updates: ['status', 'check', 'download', 'install', 'setToken'],
  plugins: ['pluginsDir', 'list', 'install', 'remove', 'setEnabled', 'reload', 'openFolder'],
  editor: [
    'workspaceDir', 'listProjects', 'create', 'open', 'importInstalled', 'forget', 'read', 'saveManifest', 'addCharacter', 'saveCharacter', 'removeCharacter',
    'pickAvatar', 'pickExpression', 'addMedia', 'addMediaFiles', 'removeMedia', 'saveMediaManifest', 'saveReadme', 'validate', 'exportPack', 'installToApp',
    'revealInFolder', 'behaviourTemplates',
  ],
  media: ['report', 'closeAll'],
  display: ['backend', 'monitors'],
};

/** `namespace.method` → push channel. */
export const EVENT_METHODS: { [K in Namespaces]?: Partial<Record<keyof IpcApi[K] & string, string>> } = {
  chat: { onEvent: IPC_EVENT_CHANNELS.chatEvent },
  permissions: { onRequest: IPC_EVENT_CHANNELS.permissionRequest },
  ui: { onPrompt: IPC_EVENT_CHANNELS.uiPrompt },
  media: { onCommand: IPC_EVENT_CHANNELS.mediaCommand },
  updates: { onStatus: IPC_EVENT_CHANNELS.updateStatus },
};

export function channelFor(namespace: string, method: string): string {
  return `${namespace}:${method}`;
}

/** Every invoke channel main must handle, e.g. `['app:version', …]`. */
export function invokeChannels(): string[] {
  const out: string[] = [];
  for (const [ns, methods] of Object.entries(INVOKE_METHODS)) for (const m of methods) out.push(channelFor(ns, m));
  return out;
}

export function buildApi(ipc: IpcRendererLike): IpcApi {
  const api: Record<string, Record<string, unknown>> = {};
  for (const [ns, methods] of Object.entries(INVOKE_METHODS)) {
    const target: Record<string, unknown> = {};
    for (const method of methods) {
      const channel = channelFor(ns, method);
      target[method] = (...args: unknown[]): Promise<unknown> => ipc.invoke(channel, ...args);
    }
    api[ns] = target;
  }
  for (const [ns, events] of Object.entries(EVENT_METHODS)) {
    const target = api[ns] ?? (api[ns] = {});
    for (const [method, channel] of Object.entries(events ?? {})) {
      if (!channel) continue;
      target[method] = (listener: (payload: unknown) => void): (() => void) => {
        const wrapped = (_event: unknown, payload: unknown): void => {
          listener(payload);
        };
        ipc.on(channel, wrapped);
        return () => {
          ipc.removeListener(channel, wrapped);
        };
      };
    }
  }
  return api as unknown as IpcApi;
}
