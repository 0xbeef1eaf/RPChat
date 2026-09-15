import type { CapabilityModuleSpec } from '@rp/shared';

export const timersModule: CapabilityModuleSpec = {
  id: 'timers',
  version: '1.2.0',
  title: 'Timers',
  summary: 'Schedule future wake-ups or a handler to run later (setTimeout-style), once or repeating.',
  permission: 'trusted',
  apiTypeName: 'TimersApi',
  typings: `/**
 * Do things later. Timers persist across app restarts and fire even when the user is away.
 * Three kinds: schedule() wakes you (onTimer behaviour or an LLM turn with your payload);
 * runLater() executes a handler you write now, later, without an LLM turn (like setTimeout);
 * sdk.llm.wake() (see the llm module) wakes you with a prompt you wrote for your future self.
 * An action cannot sleep or wait; a timer is the only way to act after a delay.
 */
interface TimersApi {
  /**
   * Schedule a timer.
   * @param delayMs Delay from now in milliseconds. MINIMUM 30000 (30 s, configurable by the user): shorter values are raised to it,
   *   so plan in minutes; maximum 604800000 (7 days). The returned fireAt is authoritative.
   * @param payload Json you want to receive when it fires, e.g. { reason: "ask about the walk" }.
   *   Make it self-explanatory: it is all you will get.
   * @param opts label: short text shown to the user in the timers list.
   * @returns The created timer (id, fireAt, payload, label).
   * @example await sdk.timers.schedule(15 * 60 * 1000, { reason: "check if they took a break" }, { label: "break check" });
   */
  schedule(delayMs: number, payload: Json, opts?: { label?: string }): Promise<TimerInfo>;
  /**
   * Run a handler later, like setTimeout, without waking the LLM. It runs with your permissions
   * and the full sdk when the timer fires.
   * @param delayMs Delay from now in ms. MINIMUM 30000 (30 s, configurable; shorter values are raised to it), maximum 604800000 (7 days).
   * @param handler Write it as a function taking input: it is checked like the rest of your code.
   *   It runs in a fresh run, so nothing around it is in scope — no variable from this action, no
   *   closures. Put what it needs in opts.input. (A string with the body of an async function still works.)
   * @param opts input: Json passed to the handler as its argument; label; repeatEveryMs (>= 60000) and maxRuns to repeat.
   * @returns The created timer.
   * @example await sdk.timers.runLater(10 * 60 * 1000, async () => {
   *   await sdk.media.closeAll();
   *   await sdk.llm.wake("Their break is over. Tell them so.");
   * }, { label: "end break" });
   * @example await sdk.timers.runLater(60_000, async (input) => {
   *   await sdk.media.showImage(String(input.pic), { durationMs: 3000, layer: "background", opacity: 0.4 });
   * }, { input: { pic: "media/images/star.png" }, repeatEveryMs: 5 * 60_000, maxRuns: 6 });
   */
  runLater(delayMs: number, handler: Handler, opts?: { input?: Json; label?: string; repeatEveryMs?: number; maxRuns?: number }): Promise<TimerInfo>;
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

- \`delayMs\`: at least 30 s (the user can raise this), at most 7 days; anything shorter is silently raised to the minimum, so think in minutes and read \`fireAt\` from the result. Put everything you will need into the \`payload\` — when the timer fires you only get that payload (plus your normal context).
- Check \`list()\` before scheduling repeated timers so you do not stack duplicates; \`cancel(id)\` to remove one.
- An action cannot sleep or wait; a timer is the only way to act after a delay.
- \`runLater(delayMs, handler, { input })\` is your setTimeout: write the handler as a function \`async (input) => { ... }\` so it is checked like the rest of your code; it runs later with the sdk, no LLM turn needed. It runs in a fresh run, so nothing around it is in scope — everything it needs goes in \`opts.input\`. Use \`sdk.llm.wake\` instead when you want to *think* later.
- Repeating timers (\`repeatEveryMs\`, at least 1 minute) keep going until \`maxRuns\` or \`cancel(id)\`; do not create more than a handful.

\`\`\`ts
const pending = await sdk.timers.list();
if (!pending.some(t => t.label === "water")) {
  await sdk.timers.schedule(30 * 60 * 1000, { reason: "remind to drink water" }, { label: "water" });
}
\`\`\``,
  methods: {
    schedule: { description: 'Schedule a timer that wakes the character later.' },
    runLater: { description: 'Run stored code later (setTimeout-style), optionally repeating.' },
    cancel: { description: 'Cancel a pending timer.' },
    list: { description: 'List pending timers.' },
  },
};
