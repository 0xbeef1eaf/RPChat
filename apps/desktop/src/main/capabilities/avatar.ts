/** `sdk.avatar`: one animated avatar overlay per character, expressions from the character's `avatarSet`. */
import { randomUUID } from 'node:crypto';
import type { ActionContext, AvatarAnimation, AvatarState, CapabilityHandler, HostEvent, Json, LoadedCharacter, LoadedPack, MonitorInfo, OverlayOptions } from '@rp/shared';
import { RpError, assetUrl, characterRef } from '@rp/shared';
import { resolveAssetPath, joinRelative } from '@rp/pack';
import type { DisplayBackend, OverlayHandle, OverlaySpec, ResolvedOverlayOptions } from '../display/backend.js';
import { applyOverlayUpdate, resolveOverlayOptions } from '../display/backend.js';

export const AVATAR_DEFAULT_SIZE = 240;
export const AVATAR_MIN_SIZE = 48;
export const AVATAR_MAX_SIZE = 1024;
export const AVATAR_BUBBLE_DEFAULT_MS = 6000;
const ANIMATIONS: ReadonlySet<string> = new Set(['bounce', 'shake', 'nod', 'wave', 'pulse', 'spin', 'fade-in', 'fade-out']);

export type AvatarStateInfo = Omit<AvatarState, 'imageUrl'>;

export interface AvatarShowOptions extends OverlayOptions {
  expression?: string;
  size?: number;
  lookAtCursor?: boolean;
}

/** Expression → pack-relative path, from `avatarSet` or the plain avatar image as `neutral`. */
export function expressionMap(character: LoadedCharacter): { expressions: Record<string, string>; defaultExpression: string; size: number } {
  const set = character.definition.avatarSet;
  const expressions: Record<string, string> = {};
  if (set?.expressions) for (const [name, rel] of Object.entries(set.expressions)) expressions[name] = joinRelative(character.dir, rel);
  if (Object.keys(expressions).length === 0 && character.avatarPath) expressions.neutral = character.avatarPath;
  const names = Object.keys(expressions);
  const defaultExpression = set?.defaultExpression && expressions[set.defaultExpression] ? set.defaultExpression : names.includes('neutral') ? 'neutral' : (names[0] ?? 'neutral');
  return { expressions, defaultExpression, size: clampSize(set?.size) };
}

export function clampSize(v: unknown, fallback = AVATAR_DEFAULT_SIZE): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(AVATAR_MIN_SIZE, Math.min(AVATAR_MAX_SIZE, Math.round(v)));
}

/**
 * The avatar is drawn at exactly this width and keeps its own aspect ratio, so a size wider than the
 * monitor would be clipped by the window (which is clamped to the monitor) rather than shrunk.
 */
export function fitToMonitor(size: number, monitor: Pick<MonitorInfo, 'width'>): number {
  return Math.max(AVATAR_MIN_SIZE, Math.min(size, Math.round(monitor.width)));
}

/** Pure: resolved overlay options for an avatar (width = size; default bottom-right, top layer). */
export function avatarPlacement(opts: AvatarShowOptions, size: number, monitors: MonitorInfo[]): ResolvedOverlayOptions {
  const { width: _w, height: _h, ...rest } = opts;
  const options = resolveOverlayOptions({ monitor: 'primary', position: 'bottom-right', ...rest, width: size }, monitors, { layer: 'top' });
  return { ...options, width: fitToMonitor(options.width, options.monitor) };
}

export function toInfo(state: AvatarState): AvatarStateInfo {
  const { imageUrl: _url, ...info } = state;
  return info;
}

interface Live {
  handle: OverlayHandle;
  state: AvatarState;
  options: ResolvedOverlayOptions;
  expressions: Record<string, string>;
  packId: string;
  bubbleTimer?: NodeJS.Timeout;
  off: () => void;
}

export interface AvatarHandlerDeps {
  backend(): DisplayBackend;
  packs: { getLoaded(packId: string): LoadedPack };
  emit(event: HostEvent): void;
  logger: Pick<Console, 'warn' | 'debug'>;
  sleep?: (ms: number) => Promise<void>;
}

export class AvatarHandler implements CapabilityHandler {
  readonly moduleId = 'avatar';
  private readonly live = new Map<string, Live>();
  /** Last state per character, so `state()` after `hide()` still reports what was shown. */
  private readonly remembered = new Map<string, AvatarStateInfo>();

  constructor(private readonly deps: AvatarHandlerDeps) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const ref = characterRef(context.packId, context.characterId);
    switch (method) {
      case 'show':
        return (await this.show(ref, context, asObject(args[0]))) as unknown as Json;
      case 'set':
        return (await this.set(ref, asObject(args[0]))) as unknown as Json;
      case 'say':
        await this.say(ref, args[0], asObject(args[1]));
        return;
      case 'animate': {
        const live = this.require(ref);
        if (typeof args[0] !== 'string' || !ANIMATIONS.has(args[0])) throw new RpError('INVALID_ARGUMENT', `Unknown animation; use one of ${[...ANIMATIONS].join(', ')}`);
        await live.handle.send({ type: 'avatar-set', id: live.handle.id, patch: { animation: args[0] as AvatarAnimation } });
        return;
      }
      case 'moveTo':
        await this.moveTo(ref, asObject(args[0]), asObject(args[1]));
        return;
      case 'hide':
        await this.hide(ref);
        return;
      case 'state': {
        const live = this.live.get(ref);
        return (live ? toInfo(live.state) : (this.remembered.get(ref) ?? null)) as unknown as Json;
      }
      case 'expressions':
        return Object.keys(this.live.get(ref)?.expressions ?? expressionMap(this.character(context).character).expressions);
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.avatar.${method}`);
    }
  }

  private character(context: ActionContext): { pack: LoadedPack; character: LoadedCharacter } {
    const pack = this.deps.packs.getLoaded(context.packId);
    const character = pack.characters.find((c) => c.definition.id === context.characterId);
    if (!character) throw new RpError('NOT_FOUND', `Character ${context.characterId} not found`);
    return { pack, character };
  }

  private require(ref: string): Live {
    const live = this.live.get(ref);
    if (!live) throw new RpError('CAPABILITY_FAILED', 'The avatar is not shown; call sdk.avatar.show() first');
    return live;
  }

  private imageFor(live: Pick<Live, 'expressions' | 'packId'>, expression: string): { expression: string; url: string } {
    const rel = live.expressions[expression];
    if (!rel) throw new RpError('INVALID_ARGUMENT', `Unknown expression "${expression}"; available: ${Object.keys(live.expressions).join(', ') || 'none'}`);
    return { expression, url: assetUrl(live.packId, rel) };
  }

  async show(ref: string, context: ActionContext, opts: AvatarShowOptions): Promise<AvatarStateInfo> {
    const { pack, character } = this.character(context);
    const map = expressionMap(character);
    if (Object.keys(map.expressions).length === 0) throw new RpError('CAPABILITY_FAILED', 'This character has no avatar image (add `avatar` or `avatarSet` to character.json)');
    const existing = this.live.get(ref);
    if (existing) {
      const raw = opts as unknown as Record<string, unknown>;
      await this.set(ref, raw);
      if (opts.monitor !== undefined || opts.position !== undefined || opts.x !== undefined || opts.y !== undefined || opts.layer !== undefined) {
        await this.moveTo(ref, raw, {});
      }
      return toInfo(existing.state);
    }
    const backend = this.deps.backend();
    const monitors = await backend.monitors();
    const options = avatarPlacement(opts, clampSize(opts.size, map.size), monitors);
    const size = options.width;
    const expression = typeof opts.expression === 'string' && map.expressions[opts.expression] ? opts.expression : map.defaultExpression;
    const rel = map.expressions[expression] as string;
    const state: AvatarState = {
      visible: true,
      expression,
      imageUrl: assetUrl(context.packId, rel),
      size,
      lookAtCursor: opts.lookAtCursor === true,
      overlay: { layer: options.layer, opacity: options.opacity, clickThrough: options.clickThrough, monitorId: options.monitor.id, ...(options.x !== undefined ? { x: options.x } : {}), ...(options.y !== undefined ? { y: options.y } : {}), position: options.anchor },
    };
    const spec: OverlaySpec = {
      id: `avatar-${randomUUID()}`,
      kind: 'avatar',
      file: resolveAssetPath(pack.root, rel),
      assetUrl: state.imageUrl,
      packId: context.packId,
      asset: rel,
      options,
      page: {},
      avatar: state,
    };
    const handle = await backend.createOverlay(spec);
    const offs = [
      handle.on('avatar-clicked', () => this.deps.emit({ name: 'avatar-clicked', data: { characterRef: ref }, at: new Date().toISOString() })),
      handle.on('closed', () => {
        const l = this.live.get(ref);
        if (l && l.handle === handle) {
          this.remembered.set(ref, { ...toInfo(l.state), visible: false });
          if (l.bubbleTimer) clearTimeout(l.bubbleTimer);
          this.live.delete(ref);
        }
      }),
    ];
    const live: Live = { handle, state, options, expressions: map.expressions, packId: context.packId, off: () => offs.forEach((o) => o()) };
    this.live.set(ref, live);
    return toInfo(state);
  }

  async set(ref: string, patch: Record<string, unknown>): Promise<AvatarStateInfo> {
    const live = this.require(ref);
    const cmdPatch: Extract<Parameters<OverlayHandle['send']>[0], { type: 'avatar-set' }>['patch'] = {};
    if (typeof patch.expression === 'string' && patch.expression !== live.state.expression) {
      const img = this.imageFor(live, patch.expression);
      live.state.expression = img.expression;
      live.state.imageUrl = img.url;
      cmdPatch.expression = img.expression;
      cmdPatch.imageUrl = img.url;
    }
    if (patch.size !== undefined) {
      live.state.size = fitToMonitor(clampSize(patch.size, live.state.size), live.options.monitor);
      cmdPatch.size = live.state.size;
    }
    if (typeof patch.lookAtCursor === 'boolean') {
      live.state.lookAtCursor = patch.lookAtCursor;
      cmdPatch.lookAtCursor = patch.lookAtCursor;
    }
    const overlayPatch: { opacity?: number; clickThrough?: boolean; width?: number } = {};
    if (typeof patch.opacity === 'number') {
      overlayPatch.opacity = Math.max(0, Math.min(1, patch.opacity));
      cmdPatch.opacity = overlayPatch.opacity;
    }
    if (typeof patch.clickThrough === 'boolean') {
      overlayPatch.clickThrough = patch.clickThrough;
      cmdPatch.clickThrough = patch.clickThrough;
    }
    if (cmdPatch.size !== undefined) overlayPatch.width = cmdPatch.size;
    if (Object.keys(cmdPatch).length > 0) await live.handle.send({ type: 'avatar-set', id: live.handle.id, patch: cmdPatch });
    if (Object.keys(overlayPatch).length > 0) {
      await live.handle.update(overlayPatch);
      const monitors = await this.deps.backend().monitors().catch(() => [live.options.monitor]);
      live.options = applyOverlayUpdate(live.options, overlayPatch, monitors);
      live.state.overlay = { ...live.state.overlay, opacity: live.options.opacity, clickThrough: live.options.clickThrough };
    }
    return toInfo(live.state);
  }

  async say(ref: string, textArg: unknown, opts: Record<string, unknown>): Promise<void> {
    const live = this.require(ref);
    if (typeof textArg !== 'string' || textArg.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'text must be a non-empty string');
    const text = textArg.trim().slice(0, 500);
    const durationMs = typeof opts.durationMs === 'number' && opts.durationMs > 0 ? Math.min(60_000, Math.round(opts.durationMs)) : AVATAR_BUBBLE_DEFAULT_MS;
    const until = new Date(Date.now() + durationMs).toISOString();
    live.state.bubble = { text, until };
    if (live.bubbleTimer) clearTimeout(live.bubbleTimer);
    live.bubbleTimer = setTimeout(() => {
      if (live.state.bubble?.until === until) delete live.state.bubble;
    }, durationMs);
    live.bubbleTimer.unref?.();
    await live.handle.send({ type: 'avatar-set', id: live.handle.id, patch: { bubble: { text, until } } });
  }

  async moveTo(ref: string, target: Record<string, unknown>, opts: Record<string, unknown>): Promise<void> {
    const live = this.require(ref);
    const monitors = await this.deps.backend().monitors();
    const patch: OverlayOptions = {};
    if (target.monitor !== undefined) patch.monitor = target.monitor as OverlayOptions['monitor'];
    if (typeof target.position === 'string') patch.position = target.position as OverlayOptions['position'];
    if (typeof target.x === 'number') patch.x = target.x;
    if (typeof target.y === 'number') patch.y = target.y;
    if (typeof target.layer === 'string') patch.layer = target.layer as OverlayOptions['layer'];
    const next = applyOverlayUpdate(live.options, patch, monitors);
    const durationMs = typeof opts.durationMs === 'number' && opts.durationMs > 0 ? Math.min(10_000, Math.round(opts.durationMs)) : 0;
    const sameMonitor = next.monitor.id === live.options.monitor.id;
    const from = live.options;
    if (durationMs > 0 && sameMonitor && from.x !== undefined && from.y !== undefined && next.x !== undefined && next.y !== undefined) {
      // Animate by re-placing in steps (≈ 20 fps, at most 40 steps).
      const steps = Math.max(1, Math.min(40, Math.round(durationMs / 50)));
      const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const x = Math.round(from.x + (next.x - from.x) * t);
        const y = Math.round(from.y + (next.y - from.y) * t);
        await live.handle.update({ x: x <= 1 ? x + 1.001 : x, y: y <= 1 ? y + 1.001 : y });
        if (i < steps) await sleep(durationMs / steps);
      }
    } else {
      await live.handle.update(patch);
    }
    live.options = next;
    live.state.overlay = {
      ...live.state.overlay,
      layer: next.layer,
      monitorId: next.monitor.id,
      position: next.anchor,
      ...(next.x !== undefined ? { x: next.x } : {}),
      ...(next.y !== undefined ? { y: next.y } : {}),
    };
    if (next.x === undefined) delete live.state.overlay.x;
    if (next.y === undefined) delete live.state.overlay.y;
  }

  async hide(ref: string): Promise<void> {
    const live = this.live.get(ref);
    if (!live) return;
    this.remembered.set(ref, { ...toInfo(live.state), visible: false });
    if (live.bubbleTimer) clearTimeout(live.bubbleTimer);
    this.live.delete(ref);
    live.off();
    await live.handle.close();
  }

  async dispose(): Promise<void> {
    for (const ref of [...this.live.keys()]) await this.hide(ref);
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
