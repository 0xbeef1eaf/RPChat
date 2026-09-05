/** Small RFC 5545 parser: VEVENT with DTSTART/DTEND (all-day, UTC, TZID, floating), text fields, RRULE DAILY/WEEKLY expansion. */
import type { CalendarEvent } from '@rp/shared';

export interface RawEvent {
  uid: string;
  summary: string;
  start: Date;
  end: Date | undefined;
  allDay: boolean;
  location?: string;
  description?: string;
  rrule?: Record<string, string>;
}

/** Unfold continuation lines (CRLF/LF followed by a space or tab). */
export function unfoldLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out.filter((l) => l.length > 0);
}

export function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\');
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

export function parseProperty(line: string): Prop | undefined {
  const colon = findValueColon(line);
  if (colon < 0) return undefined;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [rawName = '', ...paramParts] = head.split(';');
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: rawName.toUpperCase(), params, value };
}

/** The first `:` outside a quoted parameter value. */
function findValueColon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) return i;
  }
  return -1;
}

/** Offset (ms) of an IANA zone at `utcDate`; undefined for unknown zones. */
export function zoneOffsetMs(timeZone: string, utcDate: Date): number | undefined {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(utcDate)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
    const asUtc = Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
    return asUtc - utcDate.getTime();
  } catch {
    return undefined;
  }
}

/** `YYYYMMDD` / `YYYYMMDDTHHMMSS[Z]` (+ TZID param) → Date and all-day flag. */
export function parseDateValue(value: string, params: Record<string, string>): { date: Date; allDay: boolean } | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const [, y = '0', mo = '1', d = '1', hh, mm, ss, z] = m;
  const Y = Number(y);
  const M = Number(mo) - 1;
  const D = Number(d);
  if (params.VALUE === 'DATE' || hh === undefined) return { date: new Date(Y, M, D), allDay: true };
  const H = Number(hh);
  const Mi = Number(mm ?? '0');
  const S = Number(ss ?? '0');
  if (z) return { date: new Date(Date.UTC(Y, M, D, H, Mi, S)), allDay: false };
  const tzid = params.TZID;
  if (tzid) {
    const guess = Date.UTC(Y, M, D, H, Mi, S);
    const offset = zoneOffsetMs(tzid, new Date(guess));
    if (offset !== undefined) {
      // Second pass with the corrected instant handles DST boundaries.
      const first = guess - offset;
      const offset2 = zoneOffsetMs(tzid, new Date(first)) ?? offset;
      return { date: new Date(guess - offset2), allDay: false };
    }
  }
  return { date: new Date(Y, M, D, H, Mi, S), allDay: false };
}

export function parseRrule(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  return out;
}

/** Parse every VEVENT in an ICS document. Malformed events are skipped. */
export function parseIcs(text: string): RawEvent[] {
  const events: RawEvent[] = [];
  let current: Partial<RawEvent> & { started?: boolean } | undefined;
  let counter = 0;
  for (const line of unfoldLines(text)) {
    if (line === 'BEGIN:VEVENT') {
      current = { started: true };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current?.start && current.started) {
        counter += 1;
        events.push({
          uid: current.uid ?? `event-${counter}`,
          summary: current.summary ?? '(untitled)',
          start: current.start,
          end: current.end,
          allDay: current.allDay ?? false,
          ...(current.location !== undefined ? { location: current.location } : {}),
          ...(current.description !== undefined ? { description: current.description } : {}),
          ...(current.rrule !== undefined ? { rrule: current.rrule } : {}),
        });
      }
      current = undefined;
      continue;
    }
    if (!current) continue;
    const prop = parseProperty(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID':
        current.uid = prop.value;
        break;
      case 'SUMMARY':
        current.summary = unescapeText(prop.value);
        break;
      case 'LOCATION':
        current.location = unescapeText(prop.value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(prop.value);
        break;
      case 'DTSTART': {
        const p = parseDateValue(prop.value, prop.params);
        if (p) {
          current.start = p.date;
          current.allDay = p.allDay;
        }
        break;
      }
      case 'DTEND': {
        const p = parseDateValue(prop.value, prop.params);
        if (p) current.end = p.date;
        break;
      }
      case 'RRULE':
        current.rrule = parseRrule(prop.value);
        break;
      default:
        break;
    }
  }
  return events;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function addDays(d: Date, n: number, allDay: boolean): Date {
  if (allDay) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
  return new Date(d.getTime() + n * DAY_MS);
}

/** Occurrence start times of an event inside [from, to], expanding DAILY/WEEKLY rules (INTERVAL, COUNT, UNTIL, BYDAY). */
export function occurrences(ev: RawEvent, from: Date, to: Date, maxOccurrences = 500): Date[] {
  const duration = ev.end ? Math.max(0, ev.end.getTime() - ev.start.getTime()) : ev.allDay ? DAY_MS : 0;
  const overlaps = (start: Date): boolean => start.getTime() <= to.getTime() && start.getTime() + duration >= from.getTime();
  const rule = ev.rrule;
  const freq = rule?.FREQ;
  if (!rule || (freq !== 'DAILY' && freq !== 'WEEKLY')) return overlaps(ev.start) ? [ev.start] : [];
  const interval = Math.max(1, Number.parseInt(rule.INTERVAL ?? '1', 10) || 1);
  const count = rule.COUNT ? Number.parseInt(rule.COUNT, 10) : undefined;
  const until = rule.UNTIL ? parseDateValue(rule.UNTIL, {})?.date : undefined;
  const byDay = freq === 'WEEKLY' && rule.BYDAY ? rule.BYDAY.split(',').map((d) => WEEKDAYS[d.slice(-2)]).filter((d): d is number => d !== undefined) : undefined;
  const out: Date[] = [];
  let produced = 0;
  if (freq === 'DAILY') {
    for (let i = 0; produced < (count ?? Number.POSITIVE_INFINITY) && out.length < maxOccurrences; i += 1) {
      const start = addDays(ev.start, i * interval, ev.allDay);
      if (until && start.getTime() > until.getTime() + (ev.allDay ? DAY_MS : 0)) break;
      if (start.getTime() > to.getTime()) break;
      produced += 1;
      if (overlaps(start)) out.push(start);
    }
    return out;
  }
  const days = byDay && byDay.length > 0 ? [...new Set(byDay)].sort((a, b) => a - b) : [ev.start.getDay()];
  const weekStart = addDays(ev.start, -ev.start.getDay(), ev.allDay); // Sunday of the first week
  for (let week = 0; out.length < maxOccurrences; week += interval) {
    let broke = false;
    for (const day of days) {
      const start = addDays(weekStart, week * 7 + day, ev.allDay);
      if (start.getTime() < ev.start.getTime()) continue;
      if (until && start.getTime() > until.getTime() + (ev.allDay ? DAY_MS : 0)) {
        broke = true;
        break;
      }
      if (count !== undefined && produced >= count) {
        broke = true;
        break;
      }
      if (start.getTime() > to.getTime()) {
        broke = true;
        break;
      }
      produced += 1;
      if (overlaps(start)) out.push(start);
    }
    if (broke) break;
    if (week > 52 * 20) break; // safety
  }
  return out;
}

/** Expand raw events into `CalendarEvent`s within the window, sorted by start. */
export function expandEvents(raw: RawEvent[], calendar: string, from: Date, to: Date): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const ev of raw) {
    const duration = ev.end ? ev.end.getTime() - ev.start.getTime() : undefined;
    for (const start of occurrences(ev, from, to)) {
      const item: CalendarEvent = {
        id: `${ev.uid}@${start.getTime()}`,
        title: ev.summary,
        start: ev.allDay ? localDateString(start) : start.toISOString(),
        allDay: ev.allDay,
        calendar,
      };
      if (duration !== undefined) {
        const end = new Date(start.getTime() + duration);
        item.end = ev.allDay ? localDateString(end) : end.toISOString();
      }
      if (ev.location) item.location = ev.location;
      if (ev.description) item.description = ev.description;
      out.push(item);
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

export function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
