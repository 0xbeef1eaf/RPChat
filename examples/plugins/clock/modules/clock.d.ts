/**
 * Exact time and countdowns. The `<senses>` line in your prompt already tells you the rough
 * time of day; use now() when you need the precise time, the date or the weekday, and
 * countdown() when you want to be woken after a fixed number of seconds without scheduling a
 * timer yourself.
 */
interface ClockApi {
  /**
   * The current date and time on the user's computer.
   * @returns iso: ISO-8601 with offset; local: human-readable local time; weekday: e.g. "Tuesday"; unix: seconds since the epoch.
   * @example const { local, weekday } = await sdk.clock.now(); return { local, weekday };
   */
  now(): Promise<{ iso: string; local: string; weekday: string; unix: number }>;
  /**
   * Start a countdown. When it ends the host raises the `custom:countdown` event with
   * `{ label, seconds, id }`; subscribe with sdk.events.on("custom:countdown", handler) to react.
   * @param seconds 1 .. 86400 (a day). Longer values are clamped.
   * @param label Optional label handed back in the event, e.g. "tea".
   * @returns id of the countdown and the ISO time it ends.
   * @example
   * await sdk.events.on("custom:countdown", async (input) => { await sdk.llm.wake(`The countdown "${input.data.label}" is up. Tell them.`); }, { once: true });
   * await sdk.clock.countdown(180, "tea");
   */
  countdown(seconds: number, label?: string): Promise<{ id: string; endsAt: string }>;
  /**
   * Countdowns started by this plugin that have not fired yet (survive app restarts).
   * @returns One entry per pending countdown.
   */
  pending(): Promise<Array<{ id: string; label?: string; endsAt: string }>>;
}
