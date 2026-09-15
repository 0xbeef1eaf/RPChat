import type { CapabilityModuleSpec } from '@rp/shared';

export const calendarModule: CapabilityModuleSpec = {
  id: 'calendar',
  version: '1.0.0',
  title: 'Calendar',
  summary: "Read the user's upcoming calendar events (from the calendars they configured).",
  permission: 'pack',
  apiTypeName: 'CalendarApi',
  typings: `/**
 * Read-only view of the calendars the user configured in Settings (ICS files or URLs).
 * Empty results usually mean no calendar is configured, not a free day.
 */
interface CalendarApi {
  /**
   * Events starting within the next N hours, soonest first.
   * @param hours Window length in hours. Default 24, maximum 336 (14 days).
   * @example const next = (await sdk.calendar.upcoming(6))[0]; return next ? { next: next.title, at: next.start } : {};
   */
  upcoming(hours?: number): Promise<CalendarEvent[]>;
  /** Every event of the current local day (including all-day events), soonest first. */
  today(): Promise<CalendarEvent[]>;
}`,
  docs: `Know the user's schedule. Requires the \`calendar\` capability and at least one calendar configured by the user.

- \`today()\` for "what's on today", \`upcoming(hours)\` for "anything soon?". Times are local ISO strings; \`allDay\` events have no useful time.
- An empty list can simply mean no calendar is configured — do not conclude the user is free.
- When the configured sources cannot be read (bad path or URL) the call throws CAPABILITY_FAILED naming them (Settings → Senses → Calendar sources) — tell the user.
- Combine with \`sdk.timers\` or \`sdk.events.on("time", ...)\` to remind them before an event.

\`\`\`ts
const events = await sdk.calendar.upcoming(3);
return events.map(e => ({ title: e.title, start: e.start, where: e.location ?? null }));
\`\`\``,
  methods: {
    upcoming: { description: 'List events in the next N hours.' },
    today: { description: "List today's events." },
  },
};
