import type { CapabilityModuleSpec } from '@rp/shared';

export const eventsModule: CapabilityModuleSpec = {
  id: 'events',
  version: '1.0.0',
  title: 'Events',
  summary: 'React to things happening on the PC (idle, window/song changes, time, files, widget clicks) with a handler that runs when they occur.',
  permission: 'trusted',
  apiTypeName: 'EventsApi',
  typings: `/**
 * Subscribe a handler to host events. When the event fires, your code runs as an action (same sdk, same
 * permissions) with a global input = { event, data, ...opts.input }; from there you can act
 * directly or wake yourself with sdk.llm.wake(). Subscriptions belong to this session (max 30)
 * and survive app restarts. Nothing polls: this is the right way to "wait for" something.
 */
interface EventsApi {
  /**
   * Run a handler whenever an event occurs.
   * @param event A host event (see HostEventName) or 'custom:<name>' raised by sdk.events.emit().
   * @param handler Write it as a function taking input: it is checked like the rest of your code.
   *   It runs later in a fresh run, so it cannot use anything from around it — no variables from this
   *   action, no imports, no closures. Put what it needs in opts.input and read it from input.
   *   (A string with the body of an async function still works.)
   * @param opts filter: event-specific match, e.g. { idleMs: 600000 } for 'user-idle', { hour: 22, minute: 30 } for 'time',
   *   { app: "steam" } for 'window-changed', { percent: 15 } for 'battery-low', { widgetId } for 'widget-message',
   *   { url: "wikipedia.org" } for 'browser-navigated' (data: { tabId, url, title }; needs the browser extension);
   *   input: extra Json merged into input; once: remove after the first firing; label: shown in the UI.
   * @returns The subscription (keep the id if you want to remove it later).
   * @example await sdk.events.on("user-back", async (input) => {
   *   await sdk.llm.wake({ reason: "user is back after " + Math.round(Number(input.data.idleMs) / 60000) + " min" });
   * }, { filter: { idleMs: 900000 }, label: "welcome back" });
   */
  on(event: EventName, handler: Handler, opts?: { filter?: Record<string, Json>; input?: Json; once?: boolean; label?: string }): Promise<EventSubscriptionInfo>;
  /**
   * Remove a subscription.
   * @param id Subscription id from on() or list().
   * @returns true if it existed.
   */
  off(id: string): Promise<boolean>;
  /** All live subscriptions of this session. Check it before adding one, to avoid duplicates. */
  list(): Promise<EventSubscriptionInfo[]>;
  /**
   * Raise a custom event 'custom:<name>' for your own subscriptions (e.g. from a widget handler or a timer).
   * @param name Event name without the 'custom:' prefix.
   * @param data Json handed to the subscribers as input.data.
   * @example await sdk.events.emit("tea-ready", { cup: 2 });
   */
  emit(name: string, data?: Json): Promise<void>;
}`,
  docs: `React to what happens on the PC instead of polling. Always available (the events themselves need the matching senses to exist on the host).

- Write the handler as a **function**: \`sdk.events.on("time", async (input) => { ... })\`. It is part of your code, so it is checked like the rest of it, instead of hiding in a string.
- It runs later as its own action with \`input = { event, data, ...opts.input }\`, in a fresh run: **nothing around it is in scope** — no variable you just computed, no helper you defined above. Pass those through \`opts.input\`. Keep it small: usually store something, show something, or \`sdk.llm.wake({...})\` so you can respond in words.
- Check \`list()\` first and reuse/replace rather than stacking duplicates (30 per session). Use \`once: true\` for one-shot reactions.
- Filters: \`time\` \`{ hour, minute?, weekday? }\`; \`user-idle\` \`{ idleMs }\` (without it, as soon as the host counts the user as idle; with it, once they have been away that long); \`window-changed\`/\`app-launched\` \`{ app?, title? }\` (substring); \`battery-low\` \`{ percent }\`; \`file-added\` \`{ dir?, ext? }\`; \`widget-message\` \`{ widgetId }\`; \`browser-navigated\` \`{ url?, title? }\` (substring; data \`{ tabId, url, title }\`, only while the browser extension is connected).

\`\`\`ts
const subs = await sdk.events.list();
if (!subs.some(s => s.label === "bedtime")) {
  await sdk.events.on("time", async () => {
    await sdk.llm.wake({ reason: "it is 23:00, gently suggest sleep" });
  }, { filter: { hour: 23, minute: 0 }, label: "bedtime" });
}

// Anything the handler needs travels in opts.input, never in a closure.
await sdk.events.on("window-changed", async (input) => {
  await sdk.media.showImage(String(input.pic), { durationMs: 4000 });
}, { filter: { app: "steam" }, input: { pic: "media/images/wave.png" }, once: true });
\`\`\``,
  methods: {
    on: { description: 'Subscribe a handler to a host or custom event.' },
    off: { description: 'Remove an event subscription.' },
    list: { description: 'List event subscriptions of this session.' },
    emit: { description: 'Raise a custom event for own subscriptions.' },
  },
};
