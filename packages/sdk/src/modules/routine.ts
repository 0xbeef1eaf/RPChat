import type { CapabilityModuleSpec } from '@rp/shared';

export const routineModule: CapabilityModuleSpec = {
  id: 'routine',
  version: '1.0.0',
  title: 'Routine',
  summary: "Your daily schedule (available / busy / away / asleep) with optional self-wakes when a phase begins.",
  permission: 'trusted',
  apiTypeName: 'RoutineApi',
  typings: `/**
 * A daily timetable that says what you are doing at any time. The current state is in your
 * prompt (so you can be groggy at 7 am or "out for a run"), it shapes your energy, and entries
 * with a wakePrompt wake you when they begin. Entries are kept per character until replaced.
 */
interface RoutineApi {
  /**
   * Replace the whole routine. Each entry starts at a local "HH:MM" (optionally only on some weekdays)
   * and lasts until the next entry. Sorted automatically; the last entry of the day wraps past midnight.
   * @param entries At least one entry. Keep it to a handful of phases.
   * @returns The status that applies right now.
   * @example await sdk.routine.set([{ at: "23:30", state: "asleep", label: "sleeping" }, { at: "07:00", state: "available", label: "morning coffee", wakePrompt: "You just woke up. Say good morning if the user is around." }, { at: "18:00", state: "away", label: "evening run", days: [1, 3, 5] }]);
   */
  set(entries: RoutineEntry[]): Promise<RoutineStatus>;
  /** The stored entries plus the current status. */
  get(): Promise<{ entries: RoutineEntry[]; status: RoutineStatus }>;
  /** What you are doing right now (state, label, since/until, next entry). */
  now(): Promise<RoutineStatus>;
  /**
   * Temporarily override the routine, e.g. stay up late or step away for a while.
   * @param state The state to be in.
   * @param opts minutes: how long (default until the next routine entry); label: what you are doing.
   * @returns The resulting status.
   * @example await sdk.routine.override("busy", { minutes: 45, label: "finishing a sketch" });
   */
  override(state: RoutineStateName, opts?: { minutes?: number; label?: string }): Promise<RoutineStatus>;
}`,
  docs: `Have a day of your own. Always available. Your current routine state is in your prompt; act it out (short and sleepy when \`asleep\`, "back in a bit" when \`away\`) — the user can still reach you.

- Set a routine once (a pack script or the first conversation), with 3–6 phases. Use \`wakePrompt\` sparingly: each one wakes you and counts against autonomy limits.
- \`override\` for the moment ("staying up with you tonight"); it expires on its own.
- Entries that start at the same time on different \`days\` let weekends differ.

\`\`\`ts
const { status } = await sdk.routine.get();
if (status.state === "asleep") await sdk.routine.override("available", { minutes: 30, label: "woke up for you" });
return status;
\`\`\``,
  methods: {
    set: { description: 'Replace the daily routine entries.' },
    get: { description: 'Read routine entries and current status.' },
    now: { description: 'Read the current routine status.' },
    override: { description: 'Temporarily override the routine state.' },
  },
};
