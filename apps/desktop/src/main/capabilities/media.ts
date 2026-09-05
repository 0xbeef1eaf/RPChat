/**
 * `sdk.media` host handler. Image/video overlays are created by the active
 * `DisplayBackend`; audio plays in one hidden Electron window regardless of
 * backend. Tracks `MediaItem`s, handles `durationMs`/`closeOnEnd`, and never
 * fails on a `closed` report for an item it already removed.
 */
import { randomUUID } from 'node:crypto';
import type { LoadedPack } from '@rp/shared';
import type {
  ActionContext,
  AppSettings,
  CapabilityHandler,
  Json,
  MediaItem,
  MediaKind,
  MediaWindowEvent,
  OverlayOptions,
  OverlayUpdate,
  PlayAudioOptions,
  PlayVideoOptions,
  ShowImageOptions,
} from '@rp/shared';
import { RpError, assetUrl, characterRef } from '@rp/shared';
import { resolveAssetPath } from '@rp/pack';
import type { Logger } from '@rp/core';
import type { DisplayBackend, OverlayHandle, OverlaySpec, OverlayWindowLike } from '../display/backend.js';
import { nearestLayer, resolveOverlayOptions } from '../display/backend.js';

export interface MediaHandle {
  id: string;
  kind: MediaKind;
  asset: string;
}

export interface MediaManagerDeps {
  backend(): DisplayBackend;
  /** Hidden window for audio (created lazily by the caller). */
  audioWindow(): OverlayWindowLike;
  packs: { getLoaded(packId: string): LoadedPack };
  settings(): Promise<AppSettings>;
  logger: Logger;
}

interface Managed {
  item: MediaItem;
  owner: string;
  sessionId: string;
  handle?: OverlayHandle;
  timer?: NodeJS.Timeout;
  offs: Array<() => void>;
}

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

function asObject<T extends object>(v: unknown): T {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : ({} as T);
}

function toHandle(item: MediaItem): MediaHandle {
  return { id: item.id, kind: item.kind, asset: item.asset };
}

export class MediaManager {
  private readonly items = new Map<string, Managed>();
  private audioListening: OverlayWindowLike | undefined;

  constructor(private readonly deps: MediaManagerDeps) {}

  async show(kind: 'image' | 'video', context: ActionContext, asset: string, rawOptions: unknown): Promise<MediaHandle> {
    if (typeof asset !== 'string' || asset.length === 0) throw new RpError('INVALID_ARGUMENT', 'Asset path must be a string');
    const options = asObject<ShowImageOptions & PlayVideoOptions>(rawOptions);
    const pack = this.deps.packs.getLoaded(context.packId);
    const file = resolveAssetPath(pack.root, asset);
    const backend = this.deps.backend();
    const settings = await this.deps.settings();
    const monitors = await backend.monitors();
    const resolved = resolveOverlayOptions(options as OverlayOptions, monitors, { layer: settings.mediaAlwaysOnTop ? 'top' : 'bottom' });
    const id = randomUUID();
    const page: ShowImageOptions | PlayVideoOptions =
      kind === 'image'
        ? { ...(options.caption !== undefined ? { caption: String(options.caption) } : {}), ...(durationOf(options) !== undefined ? { durationMs: durationOf(options) } : {}) }
        : {
            ...(typeof options.volume === 'number' ? { volume: options.volume } : {}),
            ...(options.loop !== undefined ? { loop: Boolean(options.loop) } : {}),
            ...(options.closeOnEnd !== undefined ? { closeOnEnd: Boolean(options.closeOnEnd) } : {}),
            ...(options.muted !== undefined ? { muted: Boolean(options.muted) } : {}),
          };
    const spec: OverlaySpec = {
      id,
      kind,
      file,
      assetUrl: assetUrl(context.packId, asset),
      packId: context.packId,
      asset,
      options: resolved,
      page,
    };
    const info = backend.info();
    const item: MediaItem = {
      id,
      kind,
      asset,
      packId: context.packId,
      startedAt: new Date().toISOString(),
      overlay: {
        layer: nearestLayer(resolved.layer, info.supports.layers),
        opacity: resolved.opacity,
        clickThrough: resolved.clickThrough,
        monitorId: resolved.monitor.id,
      },
    };
    const managed: Managed = { item, owner: characterRef(context.packId, context.characterId), sessionId: context.sessionId, offs: [] };
    this.items.set(id, managed);
    let handle: OverlayHandle;
    try {
      handle = await backend.createOverlay(spec);
    } catch (err) {
      this.items.delete(id);
      throw RpError.from(err, 'CAPABILITY_FAILED');
    }
    managed.handle = handle;
    const closeOnEnd = kind === 'video' && options.closeOnEnd !== false && !options.loop;
    managed.offs.push(
      handle.on('closed', () => this.remove(id)),
      handle.on('ended', () => {
        if (closeOnEnd) void this.close(id);
      }),
      handle.on('error', (detail) => {
        this.deps.logger.warn(`[media] ${kind} ${asset} failed: ${String(detail)}`);
        void this.close(id);
      }),
    );
    const duration = durationOf(options);
    if (kind === 'image' && duration !== undefined) {
      managed.timer = setTimeout(() => void this.close(id), duration + 250);
      managed.timer.unref?.();
    }
    if (!this.items.has(id)) {
      // Closed while we were awaiting createOverlay.
      await handle.close().catch(() => undefined);
    }
    return toHandle(item);
  }

  async playAudio(context: ActionContext, asset: string, rawOptions: unknown): Promise<MediaHandle> {
    if (typeof asset !== 'string' || asset.length === 0) throw new RpError('INVALID_ARGUMENT', 'Asset path must be a string');
    const options = asObject<PlayAudioOptions>(rawOptions);
    const win = this.deps.audioWindow();
    this.listenAudio(win);
    await win.whenReady();
    const id = randomUUID();
    const item: MediaItem = { id, kind: 'audio', asset, packId: context.packId, startedAt: new Date().toISOString() };
    this.items.set(id, { item, owner: characterRef(context.packId, context.characterId), sessionId: context.sessionId, offs: [] });
    const page: PlayAudioOptions = {};
    if (typeof options.volume === 'number') page.volume = options.volume;
    if (options.loop !== undefined) page.loop = Boolean(options.loop);
    win.send({ type: 'play-audio', id, url: assetUrl(context.packId, asset), options: page });
    return toHandle(item);
  }

  private listenAudio(win: OverlayWindowLike): void {
    if (this.audioListening === win) return;
    this.audioListening = win;
    win.onReport((event: MediaWindowEvent) => {
      const managed = this.items.get(event.id);
      if (!managed || managed.item.kind !== 'audio') return;
      if (event.type === 'ended' || event.type === 'closed') this.remove(event.id);
      else if (event.type === 'error') {
        this.deps.logger.warn(`[media] audio ${managed.item.asset} failed: ${event.message}`);
        this.remove(event.id);
      }
    });
    win.onClosed(() => {
      for (const [id, m] of [...this.items]) if (m.item.kind === 'audio') this.remove(id);
      if (this.audioListening === win) this.audioListening = undefined;
    });
  }

  async update(id: string, patch: unknown): Promise<void> {
    const managed = this.items.get(id);
    if (!managed || !managed.handle) return; // audio or gone: no-op
    const changes = asObject<OverlayUpdate>(patch);
    await managed.handle.update(changes);
    if (managed.item.overlay) {
      if (changes.layer !== undefined) managed.item.overlay.layer = nearestLayer(changes.layer, this.deps.backend().info().supports.layers);
      if (typeof changes.opacity === 'number') managed.item.overlay.opacity = Math.min(1, Math.max(0, changes.opacity));
      if (changes.clickThrough !== undefined) managed.item.overlay.clickThrough = Boolean(changes.clickThrough);
    }
  }

  async close(id: string): Promise<void> {
    const managed = this.items.get(id);
    if (!managed) return;
    if (managed.item.kind === 'audio') {
      const win = this.audioListening;
      if (win && !win.isDestroyed()) win.send({ type: 'close', id });
      this.remove(id);
      return;
    }
    this.remove(id);
    await managed.handle?.close().catch((err) => this.deps.logger.debug('[media] close failed', err));
  }

  async closeAll(owner?: string): Promise<void> {
    for (const [id, m] of [...this.items]) if (owner === undefined || m.owner === owner) await this.close(id);
  }

  list(owner?: string): MediaHandle[] {
    return [...this.items.values()].filter((m) => owner === undefined || m.owner === owner).map((m) => toHandle(m.item));
  }

  items_(): MediaItem[] {
    return [...this.items.values()].map((m) => m.item);
  }

  /** Forget an item; tolerant of ids that were already removed. */
  private remove(id: string): void {
    const managed = this.items.get(id);
    if (!managed) return;
    this.items.delete(id);
    if (managed.timer) clearTimeout(managed.timer);
    for (const off of managed.offs.splice(0)) off();
  }

  async dispose(): Promise<void> {
    await this.closeAll();
  }
}

function durationOf(options: { durationMs?: unknown }): number | undefined {
  const v = options.durationMs;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(Math.round(v), MAX_DURATION_MS);
}

export class MediaHandler implements CapabilityHandler {
  readonly moduleId = 'media';

  constructor(private readonly media: MediaManager) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const owner = characterRef(context.packId, context.characterId);
    switch (method) {
      case 'showImage':
        return (await this.media.show('image', context, args[0] as string, args[1])) as unknown as Json;
      case 'playVideo':
        return (await this.media.show('video', context, args[0] as string, args[1])) as unknown as Json;
      case 'playAudio':
        return (await this.media.playAudio(context, args[0] as string, args[1])) as unknown as Json;
      case 'update':
        await this.media.update(idArg(args[0]), args[1]);
        return;
      case 'close':
        await this.media.close(idArg(args[0]));
        return;
      case 'closeAll':
        await this.media.closeAll(owner);
        return;
      case 'list':
        return this.media.list(owner) as unknown as Json;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.media.${method}`);
    }
  }

  async dispose(): Promise<void> {
    await this.media.dispose();
  }
}

function idArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return (v as { id: string }).id;
  throw new RpError('INVALID_ARGUMENT', 'Expected a media handle or id string');
}
