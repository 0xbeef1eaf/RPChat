import type { CodeRunResult } from './action.js';
import type { CharacterId, Json, PackId, SessionId } from './ids.js';

/**
 * An ad-hoc script the user runs by hand from the app's Sandbox tab. It runs exactly like a
 * behaviour or action body of that character: same SDK surface and permissions, same limits,
 * same function library (`lib`) prelude, `input` bound as a `const`, in the character's session.
 */
export interface SandboxRunRequest {
  packId: PackId;
  characterId: CharacterId;
  /** TypeScript body of an async function: `sdk`, `lib`, `input` and `console` are in scope; `return` yields the value. */
  code: string;
  /** Bound as `const input = <json>` on the first line (null when omitted). */
  input?: Json;
  /**
   * Id the caller picks so it can `cancel` the run while it is still going. Generated when
   * omitted; must be at most `SANDBOX_RUN_ID_MAX` characters of `[A-Za-z0-9_-]`.
   */
  runId?: string;
}

export const SANDBOX_RUN_ID_MAX = 80;
/** Upper bound for a sandbox script (source length in UTF-16 units). */
export const SANDBOX_CODE_MAX = 64 * 1024;

export interface SandboxRunResult {
  runId: string;
  /** The character's session the script ran in (created when the character had none). */
  sessionId: SessionId;
  /** Return value, error, logs, host calls and duration, as the runner reports them. */
  result: CodeRunResult;
}
