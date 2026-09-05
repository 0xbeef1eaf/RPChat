import type { CapabilityModuleSpec } from '@rp/shared';

export const inputModule: CapabilityModuleSpec = {
  id: 'input',
  version: '1.0.0',
  title: 'Input lock',
  summary: "Temporarily lock the user's keyboard and mouse for a set duration (runs the user's configured lock command).",
  permission: 'prompt',
  apiTypeName: 'InputApi',
  typings: `/**
 * Lock the user's keyboard/mouse for a bounded time, using the lock command they configured
 * in Settings. Every call needs the user's confirmation (they can allow it for the session), and
 * durations are capped by their settings. Requires the 'input' capability.
 */
interface InputApi {
  /**
   * Lock input for a duration. Resolves once the lock is active; it is released automatically
   * when the duration elapses (or by unlock()).
   * @param durationMs 1000 .. the user's configured maximum (default 5 minutes). Longer requests are clamped.
   * @param options reason: shown in the confirmation dialog.
   * @returns until: ISO time the lock ends; durationMs: the effective (possibly clamped) duration.
   * @example await sdk.input.lock(30_000, { reason: "hold still for the surprise" });
   */
  lock(durationMs: number, options?: { reason?: string }): Promise<{ until: string; durationMs: number }>;
  /** Release an active lock early. No error when nothing is locked. */
  unlock(): Promise<void>;
  /** Whether a lock is active and when it ends. */
  status(): Promise<{ locked: boolean; until?: string }>;
}`,
  docs: `Lock the user's input for a short, agreed time. Requires the \`input\` capability and always asks the user first, so only use it when it is clearly part of the play and the user knows it is coming.

- Keep durations short; say what you are doing before locking; \`unlock()\` early if the user seems distressed.
- Fails with CAPABILITY_FAILED when the user has not configured a lock command.

\`\`\`ts
await sdk.chat.say("Close your eyes. Ten seconds.");
const { until } = await sdk.input.lock(10_000, { reason: "surprise" });
return { until };
\`\`\``,
  methods: {
    lock: { description: "Lock keyboard and mouse for a bounded duration (via the user's command).", dangerous: true },
    unlock: { description: 'Release the input lock early.', dangerous: true },
    status: { description: 'Whether input is currently locked.' },
  },
};
