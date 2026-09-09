import type { CapabilityGrant, PermissionDecision, PermissionRequest } from './capability.js';
import type { AuditEntry, ChatEvent, ChatMessage, CreateSessionInput, Session } from './chat.js';
import type { ModelInfo, ProviderConfig } from './llm.js';
import type { DisplayBackendInfo, MediaCommand, MediaWindowEvent, MonitorInfo } from './media.js';
import type { CharacterSummary, InstalledPackRecord, MediaManifest, PackManifest, TagSummary } from './pack.js';
import type { AppSettings, CommandTemplate, CommandTemplates } from './settings.js';
import type { MemoryEntry, MemoryImportance } from './memory.js';
import type { EventSubscription, MoodState, PresenceSnapshot, RoutineEntry, RoutineStatus } from './senses.js';
import type { BehaviourTemplate, CreateProjectInput, EditorProject, EditorProjectSummary, EditorValidation, SaveCharacterInput } from './editor.js';
import type { PluginInfo } from './plugin.js';
import type { ManagedSettingsPaths, SystemIntegrationStatus } from './system.js';
import type { UpdateStatus } from './updates.js';

export type Unsubscribe = () => void;

/** A question raised by `sdk.ui.confirm` / `sdk.ui.choose`, answered by the user in the main window. */
export interface UiPromptRequest {
  promptId: string;
  sessionId: string;
  characterName: string;
  kind: 'confirm' | 'choose' | 'text';
  question: string;
  options?: string[];
  /** `text` prompts. */
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
}

export type UiPromptAnswer = boolean | string | null;

/** Options for adding media through the editor. */
export interface AddMediaOptions {
  /** Sub-folder under `media/<kind>/`, e.g. `wallpapers` (its name becomes a tag). */
  subfolder?: string;
  /** Restrict the picker to these kinds (default: all media). */
  kinds?: Array<'image' | 'video' | 'audio'>;
  /** Picker title. */
  title?: string;
}

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
  /** requested ∩ global policy ∩ per-pack grant. */
  effectiveCapabilities: string[];
  /** Requested modules the global policy denies (the per-pack toggle cannot override these). */
  blockedByPolicy: string[];
  /** Tags used across the pack's media, most common first. */
  assetTags: TagSummary[];
  assetCounts: Record<string, number>;
}

/** What a pack asks for, computed before installing it (for browsing/comparing packs). */
export interface PackInspection {
  manifest: PackManifest;
  characters: Array<{ id: string; name: string; tagline?: string }>;
  requestedCapabilities: string[];
  /** requestedCapabilities ∩ global policy. */
  allowedByPolicy: string[];
  blockedByPolicy: string[];
  /** Requested modules this app does not know. */
  unknownCapabilities: string[];
  readme?: string;
  assetCounts: Record<string, number>;
  assetTags: TagSummary[];
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
    /** Read a pack directory or .rppack without installing it. */
    inspect(sourcePath: string): Promise<PackInspection>;
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
    /** Live mood and routine state of a character. */
    status(characterRef: string): Promise<{ mood: MoodState; routine: RoutineStatus; routineEntries: RoutineEntry[] }>;
  };
  events: {
    list(sessionId?: string): Promise<EventSubscription[]>;
    remove(id: string): Promise<void>;
  };
  senses: {
    /** Current presence snapshot as the host sees it (for the settings/debug view). */
    snapshot(): Promise<PresenceSnapshot>;
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
    /** Settings paths forced by the system policy file; the UI shows these as managed (read-only). */
    managed(): Promise<ManagedSettingsPaths>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
    testProvider(config: ProviderConfig): Promise<{ ok: boolean; message?: string }>;
    listModels(config: ProviderConfig): Promise<ModelInfo[]>;
    /** Run a command template with sample values so the user can verify it. */
    testCommand(name: keyof CommandTemplates, template: CommandTemplate): Promise<{ code: number; stdout: string; stderr: string }>;
    /** Platform defaults used when a template is left empty (for display in the UI). */
    defaultCommands(): Promise<CommandTemplates>;
  };
  audit: {
    list(options?: { sessionId?: string; limit?: number }): Promise<AuditEntry[]>;
  };
  memories: {
    list(characterRef: string): Promise<MemoryEntry[]>;
    add(characterRef: string, text: string, options?: { tags?: string[]; importance?: MemoryImportance }): Promise<MemoryEntry>;
    update(entry: MemoryEntry): Promise<MemoryEntry>;
    remove(id: string): Promise<void>;
    /** Force a consolidation pass for a session now. */
    consolidate(sessionId: string): Promise<MemoryEntry[]>;
  };
  ui: {
    onPrompt(listener: (request: UiPromptRequest) => void): Unsubscribe;
    respondPrompt(promptId: string, answer: UiPromptAnswer): Promise<void>;
  };
  media: {
    /** Media windows subscribe to commands here. */
    onCommand(listener: (command: MediaCommand) => void): Unsubscribe;
    /** Media windows report playback events. */
    report(event: MediaWindowEvent): Promise<void>;
    /** Main UI: close every open media item. */
    closeAll(): Promise<void>;
  };
  display: {
    backend(): Promise<DisplayBackendInfo>;
    monitors(): Promise<MonitorInfo[]>;
  };
  /** System integration (Linux): root daemon for input lock/injection, policy file, udev, autostart. */
  system: {
    status(): Promise<SystemIntegrationStatus>;
    /** Runs the bundled installer with elevated privileges (pkexec). Resolves with the installer's output. */
    install(options?: { autostart?: boolean }): Promise<{ ok: boolean; output: string }>;
    setAutostart(enabled: boolean): Promise<SystemIntegrationStatus>;
    /** Path of the bundled installer script, for users who prefer to run it themselves. */
    installerPath(): Promise<string | null>;
  };
  /** In-place app updates from the private GitHub releases (see `UpdateStatus`). */
  updates: {
    status(): Promise<UpdateStatus>;
    /** Manual check; allowed whenever a token exists and policy has not disabled updates. */
    check(): Promise<UpdateStatus>;
    /** Start downloading the available update (AppImage in a writable location only). */
    download(): Promise<UpdateStatus>;
    /** Quit and relaunch into the downloaded update. */
    install(): Promise<void>;
    /** Store (or with `null` remove) the per-user GitHub token used to read the private release feed. */
    setToken(token: string | null): Promise<UpdateStatus>;
    onStatus(listener: (status: UpdateStatus) => void): Unsubscribe;
  };
  /** SDK plugins: folders under the app's plugins dir adding capability modules. */
  plugins: {
    pluginsDir(): Promise<string>;
    list(): Promise<PluginInfo[]>;
    /** Native folder picker (when `dir` is omitted) → copies the plugin into the plugins dir and loads it. */
    install(dir?: string): Promise<PluginInfo | null>;
    remove(id: string): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<PluginInfo>;
    /** Re-import the entry module and re-register its modules (for plugin development). */
    reload(id: string): Promise<PluginInfo>;
    openFolder(): Promise<void>;
  };
  /** Pack editor: projects are pack folders; every write goes straight to disk. */
  editor: {
    workspaceDir(): Promise<string>;
    listProjects(): Promise<EditorProjectSummary[]>;
    create(input: CreateProjectInput): Promise<EditorProject>;
    /** Register an existing pack folder (picker when `dir` is omitted). */
    open(dir?: string): Promise<EditorProject | null>;
    /** Copy an installed pack into the workspace for editing. */
    importInstalled(packId: string): Promise<EditorProject>;
    forget(key: string): Promise<void>;
    read(key: string): Promise<EditorProject>;
    saveManifest(key: string, manifest: PackManifest): Promise<EditorProject>;
    addCharacter(key: string, characterId: string, name: string): Promise<EditorProject>;
    saveCharacter(key: string, input: SaveCharacterInput): Promise<EditorProject>;
    removeCharacter(key: string, dir: string): Promise<EditorProject>;
    /** Native picker → copies the image into the character dir and sets `avatar`. */
    pickAvatar(key: string, dir: string): Promise<EditorProject>;
    /** Native picker → copies the image/video into the character dir and adds an `avatarSet` expression. */
    pickExpression(key: string, dir: string, expression: string): Promise<EditorProject>;
    /** Native multi-file picker → copies into `media/<kind>/` (or `media/<kind>/<subfolder>/`). */
    addMedia(key: string, options?: AddMediaOptions): Promise<EditorProject>;
    /** Copy given absolute files into `media/<kind>/` (drag and drop). */
    addMediaFiles(key: string, files: string[], options?: AddMediaOptions): Promise<EditorProject>;
    removeMedia(key: string, assetPath: string): Promise<EditorProject>;
    saveMediaManifest(key: string, manifest: MediaManifest): Promise<EditorProject>;
    saveReadme(key: string, text: string): Promise<EditorProject>;
    validate(key: string): Promise<EditorValidation>;
    /** Save dialog → writes the .rppack; returns the file path or null when cancelled. */
    exportPack(key: string): Promise<string | null>;
    /** Install (or replace) the pack in the app from the project folder. */
    installToApp(key: string): Promise<InstalledPackView>;
    revealInFolder(key: string): Promise<void>;
    behaviourTemplates(): Promise<BehaviourTemplate[]>;
  };
}

/** Channel names. Request/response calls use `${ns}:${method}`; push events use these constants. */
export const IPC_EVENT_CHANNELS = {
  chatEvent: 'chat:event',
  permissionRequest: 'permissions:request',
  mediaCommand: 'media:command',
  uiPrompt: 'ui:prompt',
  updateStatus: 'updates:status',
} as const;

declare global {
  interface Window {
    rp: IpcApi;
  }
}
