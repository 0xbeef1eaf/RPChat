/**
 * @rp/core — the chat engine: packs, sessions, prompt construction, the
 * LLM ⇄ action loop, behaviours/timers, permissions, storage and audit.
 * Runs in plain Node; the desktop app supplies the sandbox runner and the
 * host capability handlers.
 */
export { Engine } from './engine.js';
export type { EngineOptions } from './engine.js';
export { FileStorage } from './storage/file.js';
export type { FileStorageOptions } from './storage/file.js';
export { MemoryStorage } from './storage/memory.js';
export { FakeRunner } from './fake-runner.js';
export type { FakeRunHandler, FakeRunOutcome } from './fake-runner.js';
export { PromptBuilder, transcriptToMessages, STATE_JSON_CAP } from './prompt.js';
export type { PromptInput, BuiltPrompt } from './prompt.js';
export { ActionLoop, ACTION_LIMIT_NOTICE, resultPayload } from './action-loop.js';
export type { ActionLoopOptions, TurnInput } from './action-loop.js';
export { CapabilityDispatcher } from './dispatcher.js';
export type { DispatcherOptions } from './dispatcher.js';
export { BehaviourRunner, wrapBehaviourScript } from './behaviours.js';
export type { BehaviourRunnerOptions, BehaviourRunOptions } from './behaviours.js';
export { TypedEmitter } from './emitter.js';
export type { Unsubscribe } from './emitter.js';
export { defaultSettings, mergeSettings } from './defaults.js';
export { resolvePackAsset, coerceAssetArg, toAssetRef, findAssets, showableAssets, summariseTags, tagsOf, FIND_ASSETS_DEFAULT_LIMIT, FIND_ASSETS_MAX_LIMIT } from './assets.js';
export type { AssetRef, FindAssetsQuery } from './assets.js';
export { assetLine } from './prompt.js';
export type { Logger, Clock, EngineEvents, EngineEmitter, BehaviourHooks, BehaviourInput, SensesProvider } from './types.js';

export { AuditService } from './services/audit.js';
export { ChatService } from './services/chat.js';
export type { ChatServiceOptions } from './services/chat.js';
export { PackService } from './services/packs.js';
export type { InstallHookRunner } from './services/packs.js';
export { PermissionService } from './services/permissions.js';
export type { PermissionPrompter, PermissionVerdict } from './services/permissions.js';
export { SessionService } from './services/sessions.js';
export type { NewMessage } from './services/sessions.js';
export { SettingsService } from './services/settings.js';
export type { ProviderFactory } from './services/settings.js';
export { TimerService } from './services/timers.js';
export { MemoryService, memoryLine, parseJsonArray, normalizeTags, normalizeImportance, normalizeText, MEMORY_TEXT_MAX } from './services/memory.js';
export type { AddMemoryOptions, ConsolidateOptions, MemoryServiceOptions } from './services/memory.js';
export { LibraryService, LIB_STATE_KEY, EMPTY_PRELUDE, buildPrelude, functionParams, functionSourceProblem, toLibFunction, unwrapFunctionSource } from './services/library.js';
export type { LibraryPacks, LibraryTarget } from './services/library.js';
export { LibHandler } from './handlers/lib.js';
export { libraryLine } from './prompt.js';
export { HistoryService, transcriptTokens, HISTORY_SUMMARY_KEY, HISTORY_STATE_SCOPE, COMPRESSION_MIN_MESSAGES } from './services/history.js';
export type { CompressOptions, HistoryServiceOptions } from './services/history.js';
export { rankMemories, scoreMemory, matchScore, tokenize, jaccard, promptOrder } from './memory/rank.js';
export type { ScoredMemory } from './memory/rank.js';
export { MemoryHandler, toSdkMemory, MEMORY_LIST_DEFAULT, MEMORY_LIST_MAX } from './handlers/memory.js';
export type { TimerFireHandler } from './services/timers.js';

export { ChatHandler } from './handlers/chat.js';
export { PackHandler } from './handlers/pack.js';
export { StateHandler, STATE_MAX_KEYS, STATE_MAX_VALUE_BYTES, characterScope, sessionScope } from './handlers/state.js';
export { TimersHandler, timerInfo, TIMER_MAX_DELAY_MS, TIMER_MIN_DELAY_MS } from './handlers/timers.js';
export { LlmHandler, ASK_DEFAULT_MAX_TOKENS, ASK_MAX_TOKENS, ASK_TIMEOUT_MS, ASK_DEFAULT_SYSTEM } from './handlers/llm.js';
export type { LlmHandlerOptions } from './handlers/llm.js';
export { normalizeTimer, validateDelay, minDelayOf, TIMER_CODE_MAX_BYTES, TIMER_PROMPT_MAX, TIMER_LABEL_MAX } from './services/timers.js';
export type { RunLaterOptions, TimerLimits } from './services/timers.js';
export { SELF_WAKE_PREFIX, sensesLine } from './prompt.js';
export { EventService, matchesFilter, isCustomEvent, isKnownEvent, HOST_EVENT_NAMES, SUBSCRIPTIONS_PER_SESSION, EVENT_DEBOUNCE_MS } from './services/events.js';
export type { EventServiceOptions, SubscribeOptions } from './services/events.js';
export { MoodService, moodWord, energyWord, moodPromptText, decayToward, ROUTINE_ENERGY_FACTOR } from './services/mood.js';
export type { MoodServiceOptions } from './services/mood.js';
export { RoutineService, evaluateRoutine, normalizeEntries } from './services/routine.js';
export type { RoutineServiceOptions, RoutineTransition, RoutineOverride } from './services/routine.js';
export { EventsHandler, MoodHandler, RoutineHandler, subscriptionInfo } from './handlers/living.js';
export { policyAllows, DENIAL_TEXT, DENIAL_HINT } from './services/permissions.js';
export type { DenialReason, EffectiveCapabilities } from './services/permissions.js';
export { dayPartOf } from './services/chat.js';
export { recordExchange, snapshotRequest, providerLabel } from './services/exchanges.js';
export type { ExchangeMeta } from './services/exchanges.js';
export type { SelfWakeSource } from './services/chat.js';
export { SandboxService } from './services/sandbox.js';
export type { SandboxServiceOptions } from './services/sandbox.js';

export {
  ALGORITHM as CRYPTO_ALGORITHM,
  KEY_BYTES as CRYPTO_KEY_BYTES,
  CryptoLog,
  CryptoManager,
  DaemonKeyStore,
  LocalKeyStore,
  MAX_FILE_BYTES as CRYPTO_MAX_FILE_BYTES,
  decryptContainer,
  encryptBuffer,
  isEncryptedContainer,
  isWithinHome,
  looksLikeSystemFile,
  md5Hex,
  parseContainer,
} from './crypto/index.js';
export type {
  CryptoKey,
  CryptoKeyStore,
  CryptoLogEntry,
  CryptoManagerOptions,
  DaemonKeyStoreOptions,
  DecryptAllOutcome,
  DecryptResult,
  EncryptedContainer,
  EncryptResult,
} from './crypto/index.js';

export { extractFencedActions } from '@rp/llm';
