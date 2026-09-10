/** `sdk.screen`: `look` (screenshot → vision model) and `draw` (annotations on a full-monitor click-through overlay). */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActionContext, CapabilityHandler, DrawShape, Json, MonitorInfo, MonitorSelector } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { CommandRunner } from './commands-runner.js';
import { notConfigured, templateLocation } from '../commands.js';
import type { DisplayBackend, OverlayHandle, OverlaySpec } from '../display/backend.js';
import { selectMonitor } from '../display/placement.js';

export const SCREENSHOT_MAX_PX = 1280;
export const DRAW_MAX_SHAPES = 64;
export const DRAW_DEFAULT_DURATION_MS = 15_000;
const SHAPES: ReadonlySet<string> = new Set(['arrow', 'circle', 'rect', 'text', 'line']);

/** A PNG capture of a monitor, already downscaled to ≤ 1280 px on the long edge. */
export interface Capturer {
  /** Native capture (desktopCapturer); undefined when the platform cannot (Wayland). */
  capture?(monitor: MonitorInfo): Promise<{ png: Buffer; width: number; height: number } | undefined>;
  /** Downscale a PNG buffer (Electron nativeImage). */
  downscale(png: Buffer, maxPx: number): Promise<{ png: Buffer; width: number; height: number }>;
}

export interface ScreenHandlerDeps {
  backend(): DisplayBackend;
  commands: CommandRunner;
  capturer: Capturer;
  /** Wayland needs the screenshot template instead of desktopCapturer. */
  preferTemplate(): boolean;
  tmpDir: string;
  describeImage(sessionId: string, pngBase64: string, question: string | undefined): Promise<string>;
  logger: Pick<Console, 'warn' | 'debug'>;
}

/** Fractions 0..1 → px on the monitor (pure). */
export function resolveShape(shape: DrawShape, monitor: MonitorInfo): DrawShape {
  const px = (v: number | undefined, extent: number): number | undefined => (v === undefined ? undefined : v >= 0 && v <= 1 ? Math.round(v * extent) : Math.round(v));
  const out: DrawShape = { ...shape, x: px(shape.x, monitor.width) ?? 0, y: px(shape.y, monitor.height) ?? 0 };
  if (shape.x2 !== undefined) out.x2 = px(shape.x2, monitor.width);
  if (shape.y2 !== undefined) out.y2 = px(shape.y2, monitor.height);
  if (shape.width !== undefined) out.width = px(shape.width, monitor.width);
  if (shape.height !== undefined) out.height = px(shape.height, monitor.height);
  if (shape.radius !== undefined) out.radius = px(shape.radius, Math.min(monitor.width, monitor.height));
  return out;
}

export function validateShape(v: unknown): DrawShape {
  const s = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  if (typeof s.type !== 'string' || !SHAPES.has(s.type)) throw new RpError('INVALID_ARGUMENT', `shape.type must be one of ${[...SHAPES].join(', ')}`);
  if (typeof s.x !== 'number' || typeof s.y !== 'number') throw new RpError('INVALID_ARGUMENT', 'shape.x and shape.y are required numbers');
  const out: DrawShape = { type: s.type as DrawShape['type'], x: s.x, y: s.y };
  for (const k of ['x2', 'y2', 'width', 'height', 'radius', 'strokeWidth', 'durationMs'] as const) {
    if (typeof s[k] === 'number' && Number.isFinite(s[k] as number)) out[k] = s[k] as number;
  }
  if (typeof s.text === 'string') out.text = s.text.slice(0, 200);
  if (typeof s.color === 'string' && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([\d.,\s%]+\))$/.test(s.color)) out.color = s.color;
  return out;
}

interface Surface {
  handle: OverlayHandle;
  monitor: MonitorInfo;
  shapes: Map<string, { shape: DrawShape; timer?: NodeJS.Timeout }>;
}

export class ScreenHandler implements CapabilityHandler {
  readonly moduleId = 'screen';
  private readonly surfaces = new Map<string, Surface>();
  private readonly shapeOwner = new Map<string, string>(); // shapeId → monitor id

  constructor(private readonly deps: ScreenHandlerDeps) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'look':
        return (await this.look(context, asObject(args[0]))) as unknown as Json;
      case 'draw':
        return (await this.draw(args[0], asObject(args[1]))) as unknown as Json;
      case 'clear':
        await this.clear(Array.isArray(args[0]) ? (args[0] as unknown[]).filter((s): s is string => typeof s === 'string') : undefined);
        return;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.screen.${method}`);
    }
  }

  async look(context: ActionContext, opts: Record<string, unknown>): Promise<{ description: string; width: number; height: number }> {
    const monitors = await this.deps.backend().monitors();
    const monitor = selectMonitor(opts.monitor as MonitorSelector | undefined, monitors);
    const shot = await this.capture(monitor);
    const question = typeof opts.question === 'string' && opts.question.trim().length > 0 ? opts.question.trim().slice(0, 500) : undefined;
    const description = await this.deps.describeImage(context.sessionId, shot.png.toString('base64'), question);
    return { description, width: shot.width, height: shot.height };
  }

  private async capture(monitor: MonitorInfo): Promise<{ png: Buffer; width: number; height: number }> {
    if (!this.deps.preferTemplate() && this.deps.capturer.capture) {
      const native = await this.deps.capturer.capture(monitor).catch((err) => {
        this.deps.logger.debug('[screen] native capture failed', err);
        return undefined;
      });
      if (native) return native;
    }
    if (!(await this.deps.commands.isConfigured('screenshot'))) throw notConfigured('screenshot');
    await fs.mkdir(this.deps.tmpDir, { recursive: true });
    const file = path.join(this.deps.tmpDir, `shot-${randomUUID()}.png`);
    try {
      await this.deps.commands.runChecked('screenshot', { file, monitor: monitor.name });
      const png = await fs.readFile(file).catch(() => {
        throw new RpError('CAPABILITY_FAILED', `The screenshot command exited 0 but did not write ${file}; it must save a PNG to {file} — check it in ${templateLocation('screenshot')}`, { file });
      });
      return this.deps.capturer.downscale(png, SCREENSHOT_MAX_PX);
    } finally {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }

  async draw(shapesArg: unknown, opts: Record<string, unknown>): Promise<{ ids: string[] }> {
    if (!Array.isArray(shapesArg) || shapesArg.length === 0) throw new RpError('INVALID_ARGUMENT', 'shapes must be a non-empty array');
    if (shapesArg.length > DRAW_MAX_SHAPES) throw new RpError('INVALID_ARGUMENT', `At most ${DRAW_MAX_SHAPES} shapes per call`);
    const shapes = shapesArg.map(validateShape);
    const backend = this.deps.backend();
    const monitors = await backend.monitors();
    const monitor = selectMonitor(opts.monitor as MonitorSelector | undefined, monitors);
    const defaultDuration = typeof opts.durationMs === 'number' && opts.durationMs > 0 ? Math.min(10 * 60_000, Math.round(opts.durationMs)) : DRAW_DEFAULT_DURATION_MS;
    const surface = await this.surface(monitor);
    const ids: string[] = [];
    for (const raw of shapes) {
      const id = `shape-${randomUUID().slice(0, 8)}`;
      const shape = resolveShape(raw, monitor);
      const duration = shape.durationMs && shape.durationMs > 0 ? shape.durationMs : defaultDuration;
      const timer = setTimeout(() => void this.clear([id]).catch(() => undefined), duration);
      timer.unref?.();
      surface.shapes.set(id, { shape, timer });
      this.shapeOwner.set(id, monitor.id);
      ids.push(id);
    }
    await this.flush(surface);
    return { ids };
  }

  async clear(ids?: string[]): Promise<void> {
    const targets = ids ?? [...this.shapeOwner.keys()];
    const touched = new Set<Surface>();
    for (const id of targets) {
      const monitorId = this.shapeOwner.get(id);
      if (!monitorId) continue;
      const surface = this.surfaces.get(monitorId);
      const entry = surface?.shapes.get(id);
      if (entry?.timer) clearTimeout(entry.timer);
      surface?.shapes.delete(id);
      this.shapeOwner.delete(id);
      if (surface) touched.add(surface);
    }
    for (const surface of touched) await this.flush(surface);
  }

  private async surface(monitor: MonitorInfo): Promise<Surface> {
    const existing = this.surfaces.get(monitor.id);
    if (existing) return existing;
    const spec: OverlaySpec = {
      id: `draw-${monitor.id}-${randomUUID().slice(0, 8)}`,
      kind: 'draw',
      file: '',
      assetUrl: '',
      packId: '',
      asset: '',
      options: { monitor, layer: 'overlay', opacity: 1, clickThrough: true, anchor: 'top-left', marginPx: 0, x: 0, y: 0, width: monitor.width, height: monitor.height },
      page: {},
    };
    const handle = await this.deps.backend().createOverlay(spec);
    const surface: Surface = { handle, monitor, shapes: new Map() };
    handle.on('closed', () => {
      if (this.surfaces.get(monitor.id) === surface) {
        for (const [id, e] of surface.shapes) {
          if (e.timer) clearTimeout(e.timer);
          this.shapeOwner.delete(id);
        }
        this.surfaces.delete(monitor.id);
      }
    });
    this.surfaces.set(monitor.id, surface);
    return surface;
  }

  private async flush(surface: Surface): Promise<void> {
    if (surface.shapes.size === 0) {
      if (this.surfaces.get(surface.monitor.id) === surface) this.surfaces.delete(surface.monitor.id);
      await surface.handle.close();
      return;
    }
    await surface.handle.send({ type: 'draw-set', id: surface.handle.id, shapes: [...surface.shapes].map(([shapeId, e]) => ({ ...e.shape, shapeId })) });
  }

  async dispose(): Promise<void> {
    await this.clear();
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
