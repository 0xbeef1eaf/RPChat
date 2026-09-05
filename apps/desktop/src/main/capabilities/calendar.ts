/** `sdk.calendar`: events from the user's ICS sources (files or http(s) URLs), cached 5 minutes. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActionContext, CalendarEvent, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import { expandHome } from '../commands.js';
import { expandEvents, parseIcs } from './ics.js';
import type { RawEvent } from './ics.js';

export const CALENDAR_CACHE_MS = 5 * 60_000;
export const CALENDAR_MAX_HOURS = 14 * 24;

export interface CalendarHandlerDeps {
  sources(): Promise<string[]>;
  logger: Pick<Console, 'warn' | 'debug'>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface CacheEntry {
  at: number;
  events: RawEvent[];
}

export class CalendarHandler implements CapabilityHandler {
  readonly moduleId = 'calendar';
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: CalendarHandlerDeps) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    const now = (this.deps.now ?? (() => new Date()))();
    switch (method) {
      case 'upcoming': {
        const hoursArg = args[0];
        let hours = 24;
        if (typeof hoursArg === 'number' && Number.isFinite(hoursArg) && hoursArg > 0) hours = Math.min(CALENDAR_MAX_HOURS, hoursArg);
        return (await this.events(now, new Date(now.getTime() + hours * 3_600_000))) as unknown as Json;
      }
      case 'today': {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        return (await this.events(start, new Date(end.getTime() - 1))) as unknown as Json;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.calendar.${method}`);
    }
  }

  async events(from: Date, to: Date): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    for (const source of await this.deps.sources()) {
      const raw = await this.load(source);
      out.push(...expandEvents(raw, calendarName(source), from, to));
    }
    return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }

  private async load(source: string): Promise<RawEvent[]> {
    const nowMs = Date.now();
    const cached = this.cache.get(source);
    if (cached && nowMs - cached.at < CALENDAR_CACHE_MS) return cached.events;
    try {
      const text = await this.read(source);
      const events = parseIcs(text);
      this.cache.set(source, { at: nowMs, events });
      return events;
    } catch (err) {
      this.deps.logger.warn(`[calendar] cannot read ${source}`, err);
      return cached?.events ?? [];
    }
  }

  private async read(source: string): Promise<string> {
    if (/^https?:\/\//i.test(source)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const res = await (this.deps.fetchImpl ?? fetch)(source, { signal: controller.signal, headers: { accept: 'text/calendar, */*' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    }
    return fs.readFile(expandHome(source), 'utf8');
  }
}

export function calendarName(source: string): string {
  if (/^https?:\/\//i.test(source)) {
    try {
      return new URL(source).hostname;
    } catch {
      return source;
    }
  }
  return path.basename(source).replace(/\.ics$/i, '');
}
