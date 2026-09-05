/** Host samplers behind `PresenceSampler`: Electron powerMonitor, Hyprland IPC, and command templates. */
import * as fs from 'node:fs';
import type { NowPlaying } from '@rp/shared';
import type { CommandRunner } from '../capabilities/commands-runner.js';
import type { HyprTransport } from '../display/hyprland.js';
import type { ActiveWindow, PresenceSample, PresenceSampler } from './presence.js';

/** `{title, app, class?}` JSON or `title<TAB>app` text → ActiveWindow. */
export function parseActiveWindowOutput(text: string): ActiveWindow | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>;
      const title = typeof j.title === 'string' ? j.title : '';
      const app = typeof j.app === 'string' ? j.app : typeof j.class === 'string' ? j.class : '';
      if (!title && !app) return null;
      const out: ActiveWindow = { title, app };
      if (typeof j.class === 'string') out.class = j.class;
      return out;
    } catch {
      return null;
    }
  }
  const line = trimmed.split('\n')[0] ?? '';
  const tab = line.indexOf('\t');
  if (tab < 0) return { title: line, app: '' };
  return { title: line.slice(0, tab), app: line.slice(tab + 1).trim() };
}

/** Hyprland `j/activewindow` → ActiveWindow (empty object when nothing is focused). */
export function parseHyprActiveWindow(json: string): ActiveWindow | null {
  try {
    const j = JSON.parse(json) as Record<string, unknown>;
    if (!j || typeof j !== 'object' || typeof j.title !== 'string') return null;
    const cls = typeof j.class === 'string' ? j.class : typeof j.initialClass === 'string' ? j.initialClass : '';
    return { title: j.title, app: cls, class: cls };
  } catch {
    return null;
  }
}

/** `activewindow>>class,title` event socket payload. */
export function parseHyprActiveWindowEvent(data: string): ActiveWindow | null {
  const comma = data.indexOf(',');
  if (comma < 0) return data.trim().length === 0 ? null : { title: '', app: data.trim(), class: data.trim() };
  const cls = data.slice(0, comma);
  const title = data.slice(comma + 1);
  if (cls.length === 0 && title.length === 0) return null;
  return { title, app: cls, class: cls };
}

const STATUSES: ReadonlySet<string> = new Set(['playing', 'paused', 'stopped']);

/** JSON `{title, artist, album, app, status}` (playerctl default) → NowPlaying, null when nothing plays. */
export function parseNowPlayingOutput(text: string): NowPlaying | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || typeof j.title !== 'string' || j.title.length === 0) return null;
  const rawStatus = typeof j.status === 'string' ? j.status.toLowerCase() : 'playing';
  const status = STATUSES.has(rawStatus) ? (rawStatus as NowPlaying['status']) : 'playing';
  if (status === 'stopped') return null;
  const out: NowPlaying = { title: j.title, status };
  if (typeof j.artist === 'string' && j.artist) out.artist = j.artist;
  if (typeof j.album === 'string' && j.album) out.album = j.album;
  if (typeof j.app === 'string' && j.app) out.app = j.app;
  if (typeof j.positionMs === 'number') out.positionMs = j.positionMs;
  if (typeof j.durationMs === 'number') out.durationMs = j.durationMs;
  return out;
}

/** Linux: the `capacity` of the first battery under /sys/class/power_supply, else null. */
export function readLinuxBatteryPercent(root = '/sys/class/power_supply'): number | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const name of entries) {
    try {
      const type = fs.readFileSync(`${root}/${name}/type`, 'utf8').trim().toLowerCase();
      if (type !== 'battery') continue;
      const v = Number.parseInt(fs.readFileSync(`${root}/${name}/capacity`, 'utf8').trim(), 10);
      if (Number.isFinite(v)) return Math.max(0, Math.min(100, v));
    } catch {
      /* next */
    }
  }
  return null;
}

export interface SamplerParts {
  idleMs(): number;
  screenLocked(): boolean | null;
  onBattery(): boolean | null;
  batteryPercent(): number | null;
  activeWindow(): Promise<ActiveWindow | null>;
  nowPlaying(): Promise<NowPlaying | null>;
}

/** Composes independent sources into one sample; every source failure degrades to null. */
export class CompositeSampler implements PresenceSampler {
  constructor(
    private readonly parts: SamplerParts,
    private readonly logger?: Pick<Console, 'debug'>,
  ) {}

  async sample(): Promise<PresenceSample> {
    const [activeWindow, nowPlaying] = await Promise.all([
      this.parts.activeWindow().catch((err) => {
        this.logger?.debug?.('[senses] activeWindow failed', err);
        return null;
      }),
      this.parts.nowPlaying().catch((err) => {
        this.logger?.debug?.('[senses] nowPlaying failed', err);
        return null;
      }),
    ]);
    return {
      idleMs: safe(() => this.parts.idleMs(), 0),
      screenLocked: safe(() => this.parts.screenLocked(), null),
      onBattery: safe(() => this.parts.onBattery(), null),
      batteryPercent: safe(() => this.parts.batteryPercent(), null),
      activeWindow,
      nowPlaying,
    };
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Active window via Hyprland IPC when available, else the `activeWindow` template. */
export function activeWindowSource(opts: { hypr?: HyprTransport; commands: CommandRunner }): () => Promise<ActiveWindow | null> {
  return async () => {
    if (opts.hypr) {
      try {
        return parseHyprActiveWindow(await opts.hypr.request('j/activewindow'));
      } catch {
        /* fall through to the template */
      }
    }
    if (!(await opts.commands.isConfigured('activeWindow'))) return null;
    const r = await opts.commands.runQuiet('activeWindow', {});
    return r.code === 0 ? parseActiveWindowOutput(r.stdout) : null;
  };
}

export function nowPlayingSource(commands: CommandRunner): () => Promise<NowPlaying | null> {
  return async () => {
    if (!(await commands.isConfigured('nowPlaying'))) return null;
    const r = await commands.runQuiet('nowPlaying', {});
    return r.code === 0 ? parseNowPlayingOutput(r.stdout) : null;
  };
}
