import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandardRegistry } from '@rp/sdk';
import { MockProvider } from '@rp/llm';
import type { MockProviderOptions } from '@rp/llm';
import type {
  ActionContext,
  CapabilityHandler,
  ChatEvent,
  Json,
  PermissionDecision,
  PermissionRequest,
  ProviderConfig,
  Storage,
} from '@rp/shared';
import { Engine } from '../engine.js';
import type { EngineOptions } from '../engine.js';
import { FakeRunner } from '../fake-runner.js';
import type { FakeRunHandler } from '../fake-runner.js';
import { MemoryStorage } from '../storage/memory.js';

export const EXAMPLES_DIR = fileURLToPath(new URL('../../../../examples/packs/', import.meta.url));
export const LUNA_DIR = path.join(EXAMPLES_DIR, 'luna');
export const MINIMAL_DIR = path.join(EXAMPLES_DIR, 'minimal');
export const LUNA_ID = 'com.example.luna';
export const MINIMAL_ID = 'com.example.minimal';
export const LUNA_REF = `${LUNA_ID}/luna`;
export const ECHO_REF = `${MINIMAL_ID}/echo`;

export async function makeTempDir(prefix = 'rp-core-'): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export const MOCK_PROVIDER: ProviderConfig = { id: 'mock', kind: 'mock', label: 'Mock', model: 'mock-model', supportsTools: true };

/** A host handler that records every call and returns a fixed value. */
export class RecordingHandler implements CapabilityHandler {
  readonly calls: Array<{ method: string; args: Json[]; context: ActionContext }> = [];
  constructor(
    readonly moduleId: string,
    private readonly result: Json | ((method: string, args: Json[]) => Json) = null,
  ) {}
  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json> {
    this.calls.push({ method, args, context });
    return typeof this.result === 'function' ? this.result(method, args) : this.result;
  }
}

export class FakeClock {
  private current: number;
  constructor(start = '2026-01-01T12:00:00.000Z') {
    this.current = Date.parse(start);
  }
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current += ms;
  }
  set(iso: string): void {
    this.current = Date.parse(iso);
  }
}

export interface TestEngineOptions {
  storage?: Storage;
  packsDir?: string;
  script?: MockProviderOptions['script'];
  respond?: MockProviderOptions['respond'];
  runnerHandler?: FakeRunHandler;
  hostHandlers?: CapabilityHandler[];
  prompter?: (request: PermissionRequest) => Promise<PermissionDecision>;
  clock?: FakeClock;
  supportsTools?: boolean;
  useToolCalling?: boolean;
}

export interface TestEngine {
  engine: Engine;
  storage: Storage;
  runner: FakeRunner;
  provider: MockProvider;
  events: ChatEvent[];
  prompts: PermissionRequest[];
  clock: FakeClock;
  packsDir: string;
  /** Event type sequence, e.g. ['turn-started', 'message-added', ...]. */
  eventTypes(sessionId?: string): string[];
  cleanup(): Promise<void>;
}

export async function createTestEngine(options: TestEngineOptions = {}): Promise<TestEngine> {
  const packsDir = options.packsDir ?? (await makeTempDir('rp-core-packs-'));
  const storage = options.storage ?? new MemoryStorage();
  const clock = options.clock ?? new FakeClock();
  const runner = new FakeRunner(options.runnerHandler);
  const providerOptions: MockProviderOptions = { chunks: 2 };
  if (options.script) providerOptions.script = options.script;
  if (options.respond) providerOptions.respond = options.respond;
  const provider = new MockProvider({ ...MOCK_PROVIDER, supportsTools: options.supportsTools ?? true }, providerOptions);
  const events: ChatEvent[] = [];
  const prompts: PermissionRequest[] = [];
  const prompter = options.prompter ?? (async () => 'allow-once' as const);

  const engineOptions: EngineOptions = {
    storage,
    registry: createStandardRegistry(),
    runner,
    packsDir,
    providerFactory: () => provider,
    hostHandlers: options.hostHandlers ?? [],
    permissionPrompter: async (request) => {
      prompts.push(request);
      return prompter(request);
    },
    appVersion: '0.0.0-test',
    now: clock.now,
  };
  const engine = new Engine(engineOptions);
  engine.events.on('chat', (e) => events.push(e));
  await engine.settings.update({
    providers: [{ ...MOCK_PROVIDER, supportsTools: options.supportsTools ?? true }],
    defaultProviderId: MOCK_PROVIDER.id,
    useToolCalling: options.useToolCalling ?? true,
  });
  await engine.start();

  return {
    engine,
    storage,
    runner,
    provider,
    events,
    prompts,
    clock,
    packsDir,
    eventTypes: (sessionId) => events.filter((e) => sessionId === undefined || e.sessionId === sessionId).map((e) => e.type),
    cleanup: async () => {
      await engine.stop();
      await fs.rm(packsDir, { recursive: true, force: true });
    },
  };
}

/** Build a run-action tool call for MockProvider scripts. */
export function runAction(code: string, purpose = 'test action', id?: string): { name: string; input: Json; id?: string } {
  const call: { name: string; input: Json; id?: string } = { name: 'run_action', input: { purpose, code } };
  if (id !== undefined) call.id = id;
  return call;
}
