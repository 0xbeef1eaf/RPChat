import type { CapabilityGrant, PermissionDecision, PermissionRequest } from './capability.js';
import type { AuditEntry, ChatEvent, ChatMessage, CreateSessionInput, Session } from './chat.js';
import type { ModelInfo, ProviderConfig } from './llm.js';
import type { MediaCommand, MediaWindowEvent } from './media.js';
import type { CharacterSummary, InstalledPackRecord, PackManifest } from './pack.js';
import type { AppSettings } from './settings.js';

export type Unsubscribe = () => void;

export interface CapabilityInfo {
  id: string;
  title: string;
  summary: string;
  permission: 'trusted' | 'pack' | 'prompt';
  methods: Array<{ name: string; description: string; dangerous: boolean }>;
}

export interface InstalledPackView extends InstalledPackRecord {
  manifest: PackManifest;
  grants: CapabilityGrant[];
  readme?: string;
  characters: CharacterSummary[];
}

/**
 * The API exposed to renderer windows as `window.rp` by the preload script.
 * Main implements each method as an `ipcMain.handle` on the channel
 * `${namespace}:${method}`; event subscriptions use `ipcRenderer.on`.
 */
export interface IpcApi {
  app: {
    version(): Promise<string>;
    /** Which window this renderer is: main UI or a media overlay. */
    windowKind(): Promise<'main' | 'media'>;
    openPath(path: string): Promise<void>;
  };
  packs: {
    list(): Promise<InstalledPackView[]>;
    /** Opens a native file/directory picker, returns the chosen path or null. */
    pickInstallSource(kind: 'file' | 'directory'): Promise<string | null>;
    install(sourcePath: string): Promise<InstalledPackView>;
    uninstall(packId: string): Promise<void>;
    setGrant(packId: string, module: string, granted: boolean): Promise<void>;
    exportPack(packId: string, destinationFile: string): Promise<void>;
  };
  capabilities: {
    list(): Promise<CapabilityInfo[]>;
    /** Full generated `sdk.d.ts` (for the "what can characters do" help view). */
    typings(): Promise<string>;
  };
  characters: {
    list(): Promise<CharacterSummary[]>;
  };
  sessions: {
    list(): Promise<Session[]>;
    create(input: CreateSessionInput): Promise<Session>;
    get(sessionId: string): Promise<Session | undefined>;
    update(session: Session): Promise<Session>;
    remove(sessionId: string): Promise<void>;
    messages(sessionId: string): Promise<ChatMessage[]>;
  };
  chat: {
    send(sessionId: string, text: string): Promise<void>;
    abort(sessionId: string): Promise<void>;
    onEvent(listener: (event: ChatEvent) => void): Unsubscribe;
  };
  permissions: {
    respond(requestId: string, decision: PermissionDecision): Promise<void>;
    onRequest(listener: (request: PermissionRequest) => void): Unsubscribe;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
    testProvider(config: ProviderConfig): Promise<{ ok: boolean; message?: string }>;
    listModels(config: ProviderConfig): Promise<ModelInfo[]>;
  };
  audit: {
    list(options?: { sessionId?: string; limit?: number }): Promise<AuditEntry[]>;
  };
  media: {
    /** Media windows subscribe to commands here. */
    onCommand(listener: (command: MediaCommand) => void): Unsubscribe;
    /** Media windows report playback events. */
    report(event: MediaWindowEvent): Promise<void>;
    /** Main UI: close every open media item. */
    closeAll(): Promise<void>;
  };
}

/** Channel names. Request/response calls use `${ns}:${method}`; push events use these constants. */
export const IPC_EVENT_CHANNELS = {
  chatEvent: 'chat:event',
  permissionRequest: 'permissions:request',
  mediaCommand: 'media:command',
} as const;

declare global {
  interface Window {
    rp: IpcApi;
  }
}
