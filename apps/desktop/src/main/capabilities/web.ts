/** `sdk.web`: allowlisted http(s) fetch, RSS/Atom, and open-meteo weather. */
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import { isAllowlisted } from './allowlist.js';
import { parseFeed } from './rss.js';

export const WEB_TIMEOUT_MS = 20_000;
export const WEB_DEFAULT_MAX_BYTES = 512 * 1024;
export const WEB_HARD_MAX_BYTES = 4 * 1024 * 1024;

export interface WebHandlerDeps {
  settings(): Promise<{ allowlist: string[]; maxBytes: number }>;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

const WEATHER_CODES: Array<[number, string]> = [
  [0, 'clear sky'],
  [1, 'mainly clear'],
  [2, 'partly cloudy'],
  [3, 'overcast'],
  [45, 'fog'],
  [48, 'rime fog'],
  [51, 'light drizzle'],
  [53, 'drizzle'],
  [55, 'heavy drizzle'],
  [56, 'freezing drizzle'],
  [57, 'freezing drizzle'],
  [61, 'light rain'],
  [63, 'rain'],
  [65, 'heavy rain'],
  [66, 'freezing rain'],
  [67, 'freezing rain'],
  [71, 'light snow'],
  [73, 'snow'],
  [75, 'heavy snow'],
  [77, 'snow grains'],
  [80, 'rain showers'],
  [81, 'rain showers'],
  [82, 'violent rain showers'],
  [85, 'snow showers'],
  [86, 'heavy snow showers'],
  [95, 'thunderstorm'],
  [96, 'thunderstorm with hail'],
  [99, 'thunderstorm with heavy hail'],
];

export function weatherCondition(code: number | undefined): string {
  if (typeof code !== 'number') return 'unknown';
  return WEATHER_CODES.find(([c]) => c === code)?.[1] ?? `code ${code}`;
}

function httpUrl(v: unknown): string {
  if (typeof v !== 'string') throw new RpError('INVALID_ARGUMENT', 'url must be a string');
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new RpError('INVALID_ARGUMENT', `Invalid URL: ${v}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new RpError('INVALID_ARGUMENT', 'Only http/https URLs are allowed');
  return parsed.toString();
}

export class WebHandler implements CapabilityHandler {
  readonly moduleId = 'web';

  constructor(private readonly deps: WebHandlerDeps) {}

  /** Allowlisted hosts (and weather, which only talks to open-meteo) skip the per-call prompt. */
  async preauthorize(method: string, args: Json[], _context: ActionContext): Promise<boolean> {
    if (method === 'weather') return true;
    if (method !== 'fetch' && method !== 'rss') return false;
    if (typeof args[0] !== 'string') return false;
    const { allowlist } = await this.deps.settings();
    return isAllowlisted(args[0], allowlist);
  }

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'fetch':
        return (await this.fetch(httpUrl(args[0]), args[1])) as unknown as Json;
      case 'rss': {
        const limit = typeof args[1] === 'number' && args[1] > 0 ? Math.min(50, Math.round(args[1])) : 10;
        const res = await this.fetch(httpUrl(args[0]), { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
        if (res.status >= 400) throw new RpError('CAPABILITY_FAILED', `Feed request failed with HTTP ${res.status}`);
        return parseFeed(res.text, limit) as unknown as Json;
      }
      case 'weather':
        return (await this.weather(args[0])) as unknown as Json;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.web.${method}`);
    }
  }

  async fetch(url: string, optionsArg: unknown): Promise<FetchResult> {
    const o = optionsArg && typeof optionsArg === 'object' ? (optionsArg as { method?: unknown; headers?: unknown; body?: unknown; maxBytes?: unknown }) : {};
    const method = o.method === 'POST' ? 'POST' : 'GET';
    const settings = await this.deps.settings();
    const cap = Math.min(WEB_HARD_MAX_BYTES, settings.maxBytes > 0 ? settings.maxBytes : WEB_DEFAULT_MAX_BYTES);
    const maxBytes = typeof o.maxBytes === 'number' && o.maxBytes > 0 ? Math.min(cap, Math.round(o.maxBytes)) : cap;
    const headers: Record<string, string> = { 'user-agent': this.deps.userAgent ?? 'rp-code/0.1 (+https://github.com/rp-code)' };
    if (o.headers && typeof o.headers === 'object') {
      for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
        if (typeof v === 'string' && /^[a-z0-9-]+$/i.test(k) && !['host', 'cookie', 'authorization'].includes(k.toLowerCase())) headers[k] = v;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
    try {
      const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'follow' };
      if (method === 'POST' && typeof o.body === 'string') init.body = o.body;
      const res = await (this.deps.fetchImpl ?? fetch)(url, init);
      const text = await readCapped(res, maxBytes);
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      return { status: res.status, headers: outHeaders, text };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new RpError('CAPABILITY_FAILED', `Request to ${url} timed out after ${WEB_TIMEOUT_MS} ms`);
      throw new RpError('CAPABILITY_FAILED', `Request to ${url} failed: ${(err as Error).message}`, undefined, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async weather(placeArg: unknown): Promise<Json> {
    if (typeof placeArg !== 'string' || placeArg.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'place must be a non-empty string');
    const place = placeArg.trim();
    const geo = await this.json(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
    const hit = (geo as { results?: Array<{ name: string; latitude: number; longitude: number; country?: string; admin1?: string }> }).results?.[0];
    if (!hit) throw new RpError('NOT_FOUND', `No place named "${place}" found`);
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m' +
      '&daily=temperature_2m_min,temperature_2m_max,weather_code&forecast_days=5&timezone=auto';
    const data = (await this.json(url)) as {
      current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number; relative_humidity_2m?: number };
      daily?: { time?: string[]; temperature_2m_min?: number[]; temperature_2m_max?: number[]; weather_code?: number[] };
    };
    const c = data.current ?? {};
    const d = data.daily ?? {};
    const forecast = (d.time ?? []).map((day, i) => ({
      day,
      minC: d.temperature_2m_min?.[i] ?? null,
      maxC: d.temperature_2m_max?.[i] ?? null,
      condition: weatherCondition(d.weather_code?.[i]),
    }));
    return {
      place: [hit.name, hit.admin1, hit.country].filter((p): p is string => typeof p === 'string' && p.length > 0).join(', '),
      tempC: c.temperature_2m ?? null,
      feelsLikeC: c.apparent_temperature ?? null,
      condition: weatherCondition(c.weather_code),
      windKph: c.wind_speed_10m ?? null,
      humidity: c.relative_humidity_2m ?? null,
      forecast,
    };
  }

  private async json(url: string): Promise<unknown> {
    const res = await this.fetch(url, { headers: { accept: 'application/json' } });
    if (res.status >= 400) throw new RpError('CAPABILITY_FAILED', `Weather service answered HTTP ${res.status}`);
    try {
      return JSON.parse(res.text) as unknown;
    } catch {
      throw new RpError('CAPABILITY_FAILED', 'Weather service returned invalid JSON');
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const remaining = maxBytes - total;
    if (value.byteLength >= remaining) {
      chunks.push(value.subarray(0, Math.max(0, remaining)));
      total += Math.max(0, remaining);
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
