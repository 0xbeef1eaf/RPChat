import type { CapabilityModuleSpec } from '@rp/shared';

export const timersModule: CapabilityModuleSpec = {
  id: 'timers',
  version: '1.0.0',
  title: 'Timers',
  summary: 'Schedule a future wake-up for yourself (follow-ups, reminders, check-ins).',
  permission: 'trusted',
  apiTypeName: 'TimersApi',
  typings: `/**
 * Wake yourself up later. When a timer fires, the pack's onTimer behaviour runs if
 * it has one; otherwise you are woken with a system message containing the payload
 * and can decide what to say or do. Timers persist across app restarts.
 * This is the only way to do something after a delay: never loop or wait inside an action.
 */
interface TimersApi {
  /**
   * Schedule a timer.
   * @param delayMs Delay from now in milliseconds. Minimum 1000 (1 s), maximum 604800000 (7 days).
   * @param payload Json you want to receive when it fires, e.g. { reason: "ask about the walk" }.
   *   Make it self-explanatory: it is all you will get.
   * @param opts label: short text shown to the user in the timers list.
   * @returns The created timer (id, fireAt, payload, label).
   * @example await sdk.timers.schedule(15 * 60 * 1000, { reason: "check if they took a break" }, { label: "break check" });
   */
  schedule(delayMs: number, payload: Json, opts?: { label?: string }): Promise<TimerInfo>;
  /**
   * Cancel a pending timer.
   * @param id Timer id from schedule() or list().
   * @returns true if it was pending and is now cancelled, false if unknown or already fired.
   */
  cancel(id: string): Promise<boolean>;
  /** All pending timers of this character, soonest first. */
  list(): Promise<TimerInfo[]>;
}`,
  docs: `Ask to be woken later. Use it for follow-ups ("did you eat?"), scheduled surprises, reminders the user asked for, or checking back after a pause.

- \`delayMs\` is 1 second to 7 days. Put everything you will need into the \`payload\` — when the timer fires you only get that payload (plus your normal context).
- Check \`list()\` before scheduling repeated timers so you do not stack duplicates; \`cancel(id)\` to remove one.
- An action cannot sleep or wait; a timer is the only way to act after a delay.

\`\`\`ts
const pending = await sdk.timers.list();
if (!pending.some(t => t.label === "water")) {
  await sdk.timers.schedule(30 * 60 * 1000, { reason: "remind to drink water" }, { label: "water" });
}
\`\`\``,
  methods: {
    schedule: { description: 'Schedule a timer that wakes the character later.' },
    cancel: { description: 'Cancel a pending timer.' },
    list: { description: 'List pending timers.' },
  },
};
