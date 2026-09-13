import { randomUUID } from 'node:crypto';
import type { CodeRunResult, SandboxRunRequest, SandboxRunResult, Session } from '@rp/shared';
import { RpError, SANDBOX_CODE_MAX, SANDBOX_RUN_ID_MAX, serializeError } from '@rp/shared';
import type { BehaviourRunner } from '../behaviours.js';
import type { Clock, Logger } from '../types.js';
import type { AuditService } from './audit.js';
import type { PackService } from './packs.js';
import type { SessionService } from './sessions.js';

export interface SandboxServiceOptions {
  packs: Pick<PackService, 'getLoaded'>;
  sessions: Pick<SessionService, 'forCharacter' | 'create'>;
  behaviours: Pick<BehaviourRunner, 'runScript'>;
  audit: Pick<AuditService, 'record'>;
  /** Serialise the run with the session's turns (the chat queue), like event code and code timers. */
  runExclusive: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  now: Clock;
  logger: Logger;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Ad-hoc scripts from the app's Sandbox tab (`IpcApi.sandbox`). A run is exactly a behaviour/action
 * body of the character — `BehaviourRunner.runScript` with the `sandbox` trigger — in the character's
 * own session (created when it has none), so `sdk.chat`, memories, state and timers land where a
 * character's own code would put them. Every run is recorded in the audit log as `sandbox.run`
 * next to the SDK calls it made.
 */
export class SandboxService {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly o: SandboxServiceOptions) {}

  /** Ids of the runs still going. */
  active(): string[] {
    return [...this.running.keys()];
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const { packId, characterId, code, input } = validate(request);
    const runId = request.runId ?? randomUUID();
    if (this.running.has(runId)) throw new RpError('INVALID_ARGUMENT', `Sandbox run "${runId}" is still going`, { runId });
    const pack = this.o.packs.getLoaded(packId);
    if (!pack.characters.some((c) => c.definition.id === characterId)) {
      throw new RpError('NOT_FOUND', `Character "${characterId}" does not exist in pack ${packId}`, { packId, characterId });
    }
    const session = await this.sessionFor(`${packId}/${characterId}`);

    const controller = new AbortController();
    this.running.set(runId, controller);
    const started = this.o.now().getTime();
    let result: CodeRunResult;
    try {
      result = await this.o.runExclusive(session.id, () =>
        this.o.behaviours.runScript(packId, characterId, session.id, code, input, { kind: 'sandbox', runId }, { signal: controller.signal }),
      );
    } catch (err) {
      // The runner reports its own failures in the result; this is the host side (pack gone mid-run, storage…).
      result = { ok: false, error: serializeError(err), logs: [], calls: [], durationMs: this.o.now().getTime() - started };
    } finally {
      if (this.running.get(runId) === controller) this.running.delete(runId);
    }

    if (!result.ok) this.o.logger.debug(`[sandbox] run ${runId} for ${packId}/${characterId} failed: ${result.error?.message ?? 'unknown error'}`);
    const entry: Parameters<AuditService['record']>[0] = {
      sessionId: session.id,
      characterRef: session.characterRef,
      module: 'sandbox',
      method: 'run',
      args: [runId, code.length, result.calls.length],
      outcome: result.ok ? 'allowed' : 'failed',
      durationMs: result.durationMs,
    };
    if (result.error) entry.error = result.error;
    try {
      await this.o.audit.record(entry);
    } catch (err) {
      this.o.logger.warn(`[sandbox] could not record run ${runId} in the audit log`, err);
    }
    return { runId, sessionId: session.id, result };
  }

  /** Abort a running script. Resolves true when a run with that id was still going. */
  async cancel(runId: string): Promise<boolean> {
    const controller = this.running.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Abort every running script (engine shutdown). */
  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort();
  }

  private async sessionFor(characterRef: string): Promise<Session> {
    return (await this.o.sessions.forCharacter(characterRef)) ?? this.o.sessions.create({ characterRef });
  }
}

function validate(request: SandboxRunRequest): Pick<SandboxRunRequest, 'packId' | 'characterId' | 'code' | 'input'> {
  if (!request || typeof request !== 'object') throw new RpError('INVALID_ARGUMENT', 'A sandbox run request is required');
  const { packId, characterId, code, input, runId } = request;
  if (typeof packId !== 'string' || packId.length === 0) throw new RpError('INVALID_ARGUMENT', 'packId must be a non-empty string');
  if (typeof characterId !== 'string' || characterId.length === 0) throw new RpError('INVALID_ARGUMENT', 'characterId must be a non-empty string');
  if (typeof code !== 'string') throw new RpError('INVALID_ARGUMENT', 'code must be a string');
  if (code.length > SANDBOX_CODE_MAX) throw new RpError('INVALID_ARGUMENT', `code is longer than ${SANDBOX_CODE_MAX} characters`, { length: code.length });
  if (runId !== undefined && (typeof runId !== 'string' || runId.length === 0 || runId.length > SANDBOX_RUN_ID_MAX || !RUN_ID_PATTERN.test(runId))) {
    throw new RpError('INVALID_ARGUMENT', `runId must match ${RUN_ID_PATTERN} and be at most ${SANDBOX_RUN_ID_MAX} characters`);
  }
  if (input !== undefined) {
    try {
      JSON.stringify(input);
    } catch {
      throw new RpError('INVALID_ARGUMENT', 'input must be JSON-serialisable');
    }
  }
  return { packId, characterId, code, input };
}
