/**
 * `sdk.media` host handler. Image/video overlays are created by the active
 * `DisplayBackend`; audio plays in one hidden Electron window regardless of
 * backend. Tracks `MediaItem`s, handles `durationMs`/`closeOnEnd`, and never
 * fails on a `closed` report for an item it already removed. A full-screen
 * overlay (`overlay()`) is one item with one backend overlay per screen.
 *
 * How much may be on screen at once is `settings.media` (`AppSettings.media`, pinnable by the
 * policy's `settings.media` block), counted per `MediaKind`: images, video and audio each have
 * their own concurrency cap and their own queue. Admission never blocks the caller — a call over
 * its kind's cap joins that kind's queue and returns a handle in the `queued` state straight away,
 * and the item opens on its own as soon as one of the open items of that kind goes away, raising
 * `media-started`. `close()` works on a queued item too: it leaves the queue and reports
 * `media-closed` without ever having been shown. A cap of `0` is no cap, which is the default, so
 * nothing queues unless someone asked for a limit.
 */
import { randomUUID } from 'node:crypto';
import type { LoadedPack } from '@rp/shared';
import type {
  ActionContext,
  AppSettings,
  CapabilityHandler,
  FullscreenOverlayOptions,
  HostEvent,
  Json,
  MediaCloseReason,
  MediaConcurrencySettings,
  MediaItem,
  MediaKind,
  MediaKindLimits,
  MediaOverlayOptions,
  MediaState,
  MediaWindowEvent,
  MonitorInfo,
  MonitorSelector,
  OverlayOptions,
  OverlayUpdate,
  PlayAudioOptions,
  PlayVideoOptions,
  ShowImageOptions,
} from '@rp/shared';
import { DEFAULT_MEDIA_SETTINGS, RpError, assetUrl, characterRef } from '@rp/shared';
import { assetKindFor, resolveAssetPath } from '@rp/pack';
import type { Logger } from '@rp/core';
import type { DisplayBackend, OverlayClosedDetail, OverlayHandle, OverlaySpec, OverlayWindowLike } from '../display/backend.js';
import { clampOpacity, nearestLayer, resolveOverlayOptions } from '../display/backend.js';
import { selectMonitor } from '../display/placement.js';

export interface MediaHandle {
  id: string;
  kind: MediaKind;
  asset: string;
  /** `queued` means it is waiting behind other media of its kind and will open by itself. */
  state: MediaState;
}

export interface MediaManagerDeps {
  backend(): DisplayBackend;
  /** Hidden window for audio (created lazily by the caller). */
  audioWindow(): OverlayWindowLike;
  packs: { getLoaded(packId: string): LoadedPack };
  settings(): Promise<AppSettings>;
  logger: Logger;
  /** Host events for `sdk.events`: `media-clicked` and `media-closed` (see `docs/spec/living.md`). */
  emit?: (event: HostEvent) => void;
}

interface Managed {
  item: MediaItem;
  owner: string;
  sessionId: string;
  /** The backend overlays behind this item: one per screen (several only for a full-screen overlay), none for audio. */
  handles: OverlayHandle[];
  timer?: NodeJS.Timeout;
  offs: Array<() => void>;
  /** Full-screen overlay: it is pinned to its screens, so `update` only fades it. */
  fullscreen?: boolean;
}

/**
 * One `sdk.media` call waiting for a slot: everything `start` needs to open it later. The call
 * that created it has already returned, so nothing here may fail in a way the character could
 * still catch — the asset is resolved before an item is ever queued.
 */
interface Pending {
  id: string;
  kind: MediaKind;
  /** Which entry point queued it: `show` is `showImage`/`playVideo`, `overlay` the whole-screen wash. */
  mode: 'show' | 'overlay' | 'audio';
  asset: string;
  context: ActionContext;
  owner: string;
  /** Mutable: `update` on a queued item folds its patch in here, so it opens the way it was last asked to. */
  options: Record<string, unknown>;
  queuedAt: string;
}

/** Who an event is about; the same fields whether the item is open or still queued. */
interface EventSubject {
  id: string;
  asset: string;
  packId: string;
  kind: MediaKind;
  owner: string;
}

export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video', 'audio'];

/** The effective per-kind limits: non-negative whole numbers, defaults for anything missing or nonsensical. */
export function mediaLimits(raw: Partial<MediaConcurrencySettings> | undefined): MediaConcurrencySettings {
  const side = (which: 'maxConcurrent' | 'maxQueued'): MediaKindLimits => {
    const from = raw?.[which];
    const out: MediaKindLimits = { ...DEFAULT_MEDIA_SETTINGS[which] };
    for (const kind of MEDIA_KINDS) {
      const v = from?.[kind];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[kind] = Math.round(v);
    }
    return out;
  };
  return { maxConcurrent: side('maxConcurrent'), maxQueued: side('maxQueued') };
}

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/** Default opacity of a full-screen overlay: seen, but still worked through. */
export const FULLSCREEN_DEFAULT_OPACITY = 0.25;
/** Default volume of a full-screen video overlay. */
export const FULLSCREEN_DEFAULT_VOLUME = 0.5;

function asObject<T extends object>(v: unknown): T {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : ({} as T);
}

function toHandle(item: MediaItem): MediaHandle {
  return { id: item.id, kind: item.kind, asset: item.asset, state: item.state };
}

function pendingHandle(p: Pending): MediaHandle {
  return { id: p.id, kind: p.kind, asset: p.asset, state: 'queued' };
}

function pendingItem(p: Pending): MediaItem {
  return { id: p.id, kind: p.kind, asset: p.asset, packId: p.context.packId, startedAt: '', state: 'queued', queuedAt: p.queuedAt };
}

function subjectOf(m: Managed): EventSubject {
  return { id: m.item.id, asset: m.item.asset, packId: m.item.packId, kind: m.item.kind, owner: m.owner };
}

function pendingSubject(p: Pending): EventSubject {
  return { id: p.id, asset: p.asset, packId: p.context.packId, kind: p.kind, owner: p.owner };
}

/**
 * The screens a full-screen overlay covers: every monitor for `all` (the default), else the one the
 * selector picks. The screen that plays the video's sound comes first — the one under the cursor if
 * the pointer is on a covered screen, else the primary.
 */
export function overlayScreens(selector: MediaOverlayOptions['monitor'], monitors: MonitorInfo[]): MonitorInfo[] {
  if (monitors.length === 0) throw new RpError('CAPABILITY_FAILED', 'No monitor is available for a full-screen overlay');
  if (selector !== undefined && selector !== 'all') return [selectMonitor(selector as MonitorSelector, monitors)];
  const lead = monitors.find((m) => m.hasCursor) ?? monitors.find((m) => m.primary) ?? (monitors[0] as MonitorInfo);
  return [lead, ...monitors.filter((m) => m.id !== lead.id)];
}

/** `update` on a full-screen overlay: it keeps its screens, its size and its click-through, so only a fade gets through. */
export function fullscreenUpdate(patch: OverlayUpdate): OverlayUpdate {
  return patch.opacity !== undefined ? { opacity: patch.opacity } : {};
}

export class MediaManager {
  private readonly items = new Map<string, Managed>();
  /** Calls waiting for a slot, oldest first, all kinds in one list (each kind is counted separately). */
  private readonly queue: Pending[] = [];
  /** Slots handed out but not yet in `items`: a start that is still awaiting the backend. */
  private readonly starting: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
  /** Admission decisions run one at a time, so two calls racing cannot both take the last slot. */
  private admitting: Promise<unknown> = Promise.resolve();
  private audioListening: OverlayWindowLike | undefined;

  constructor(private readonly deps: MediaManagerDeps) {}

  async show(kind: 'image' | 'video', context: ActionContext, asset: string, rawOptions: unknown): Promise<MediaHandle> {
    if (typeof asset !== 'string' || asset.length === 0) throw new RpError('INVALID_ARGUMENT', 'Asset path must be a string');
    // Resolved here rather than in `start`: a bad asset must fail the character's call, not a
    // queued start it can no longer catch.
    resolveAssetPath(this.deps.packs.getLoaded(context.packId).root, asset);
    return this.admit({ id: randomUUID(), kind, mode: 'show', asset, context, owner: characterRef(context.packId, context.characterId), options: asObject(rawOptions), queuedAt: new Date().toISOString() });
  }

  private async startShow(pending: Pending): Promise<MediaHandle> {
    const { id, context, asset } = pending;
    const kind = pending.kind as 'image' | 'video';
    const options = pending.options as ShowImageOptions & PlayVideoOptions;
    const pack = this.deps.packs.getLoaded(context.packId);
    const file = resolveAssetPath(pack.root, asset);
    const backend = this.deps.backend();
    const settings = await this.deps.settings();
    const monitors = await backend.monitors();
    const resolved = resolveOverlayOptions(options as OverlayOptions, monitors, { layer: settings.mediaAlwaysOnTop ? 'top' : 'bottom', randomSize: true });
    const page: ShowImageOptions | PlayVideoOptions =
      kind === 'image'
        ? {
            ...(options.caption !== undefined ? { caption: String(options.caption) } : {}),
            ...(durationOf(options) !== undefined ? { durationMs: durationOf(options) } : {}),
            ...(options.closeOnClick !== undefined ? { closeOnClick: Boolean(options.closeOnClick) } : {}),
          }
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
      state: 'open',
      overlay: {
        layer: nearestLayer(resolved.layer, info.supports.layers),
        opacity: resolved.opacity,
        clickThrough: resolved.clickThrough,
        monitorId: resolved.monitor.id,
      },
    };
    const managed: Managed = { item, owner: pending.owner, sessionId: context.sessionId, handles: [], offs: [] };
    this.items.set(id, managed);
    let handle: OverlayHandle;
    try {
      handle = await backend.createOverlay(spec);
    } catch (err) {
      this.items.delete(id);
      throw RpError.from(err, 'CAPABILITY_FAILED');
    }
    managed.handles = [handle];
    const closeOnEnd = kind === 'video' && options.closeOnEnd !== false && !options.loop;
    managed.offs.push(
      handle.on('closed', (detail) => this.remove(id, (detail as OverlayClosedDetail | undefined)?.reason ?? 'api')),
      handle.on('clicked', () => this.emitEvent('media-clicked', subjectOf(managed))),
      handle.on('ended', () => {
        if (closeOnEnd) void this.close(id, 'ended');
      }),
      handle.on('error', (detail) => {
        this.deps.logger.warn(`[media] ${kind} ${asset} failed: ${String(detail)}`);
        void this.close(id, 'error');
      }),
    );
    const duration = durationOf(options);
    if (kind === 'image' && duration !== undefined) {
      managed.timer = setTimeout(() => void this.close(id, 'timeout'), duration + 250);
      managed.timer.unref?.();
    }
    if (!this.items.has(id)) {
      // Closed while we were awaiting createOverlay.
      await handle.close().catch(() => undefined);
    }
    return toHandle(item);
  }

  /**
   * `sdk.media.overlay`: an image or video washed over whole screens — one backend overlay per
   * screen, all tracked as a single item, so the character closes every screen with one handle.
   * Always click-through, always on the `overlay` layer; the page tiles the picture out from the
   * centre when its aspect ratio does not match the screen.
   */
  async overlay(context: ActionContext, asset: string, rawOptions: unknown): Promise<MediaHandle> {
    if (typeof asset !== 'string' || asset.length === 0) throw new RpError('INVALID_ARGUMENT', 'Asset path must be a string');
    const kind = assetKindFor(asset);
    if (kind !== 'image' && kind !== 'video') {
      throw new RpError('INVALID_ARGUMENT', `sdk.media.overlay needs an image or video asset; "${asset}" is ${kind}`, { path: asset, kind });
    }
    resolveAssetPath(this.deps.packs.getLoaded(context.packId).root, asset);
    return this.admit({ id: randomUUID(), kind, mode: 'overlay', asset, context, owner: characterRef(context.packId, context.characterId), options: asObject(rawOptions), queuedAt: new Date().toISOString() });
  }

  private async startOverlay(pending: Pending): Promise<MediaHandle> {
    const { id, context, asset } = pending;
    const kind = pending.kind as 'image' | 'video';
    const options = pending.options as MediaOverlayOptions;
    const pack = this.deps.packs.getLoaded(context.packId);
    const file = resolveAssetPath(pack.root, asset);
    const backend = this.deps.backend();
    const screens = overlayScreens(options.monitor, await backend.monitors());
    const opacity = clampOpacity(options.opacity, FULLSCREEN_DEFAULT_OPACITY);
    // Same 0..1 clamp as opacity, with the volume default the docs promise.
    const volume = clampOpacity(options.volume, FULLSCREEN_DEFAULT_VOLUME);
    const duration = durationOf(options);
    // A timed overlay should stay filled for its whole duration, so a video loops unless told not to.
    const loop = options.loop !== undefined ? Boolean(options.loop) : duration !== undefined;
    const url = assetUrl(context.packId, asset);
    const item: MediaItem = {
      id,
      kind,
      asset,
      packId: context.packId,
      startedAt: new Date().toISOString(),
      state: 'open',
      overlay: {
        layer: nearestLayer('overlay', backend.info().supports.layers),
        opacity,
        clickThrough: true,
        ...(screens.length === 1 ? { monitorId: (screens[0] as MonitorInfo).id } : {}),
      },
    };
    const managed: Managed = {
      item,
      owner: pending.owner,
      sessionId: context.sessionId,
      handles: [],
      offs: [],
      fullscreen: true,
    };
    this.items.set(id, managed);
    const opened: OverlayHandle[] = [];
    try {
      for (const [index, monitor] of screens.entries()) {
        const page: FullscreenOverlayOptions = {
          media: kind,
          opacity,
          // One soundtrack: the lead screen plays, the copies are silent.
          ...(kind === 'video' ? { volume: index === 0 ? volume : 0, loop, muted: options.muted === true || index > 0 } : {}),
        };
        opened.push(
          await backend.createOverlay({
            // The first screen carries the item's own id; the others hang off it.
            id: index === 0 ? id : `${id}#${index}`,
            kind: 'fullscreen',
            file,
            assetUrl: url,
            packId: context.packId,
            asset,
            options: { monitor, layer: 'overlay', opacity, clickThrough: true, anchor: 'top-left', marginPx: 0, x: 0, y: 0, width: monitor.width, height: monitor.height },
            page: {},
            fullscreen: page,
          }),
        );
      }
    } catch (err) {
      this.items.delete(id);
      for (const handle of opened) await handle.close().catch(() => undefined);
      throw RpError.from(err, 'CAPABILITY_FAILED');
    }
    managed.handles = opened;
    for (const handle of opened) {
      managed.offs.push(
        // One screen going away takes the whole overlay with it, so screens never disagree.
        handle.on('closed', (detail) => void this.close(id, (detail as OverlayClosedDetail | undefined)?.reason ?? 'api')),
        handle.on('ended', () => {
          if (!loop) void this.close(id, 'ended');
        }),
        handle.on('error', (detail) => {
          this.deps.logger.warn(`[media] full-screen ${kind} ${asset} failed: ${String(detail)}`);
          void this.close(id, 'error');
        }),
      );
    }
    if (duration !== undefined) {
      managed.timer = setTimeout(() => void this.close(id, 'timeout'), duration);
      managed.timer.unref?.();
    }
    if (!this.items.has(id)) {
      // Closed while we were opening the screens.
      for (const handle of opened) await handle.close().catch(() => undefined);
    }
    return toHandle(item);
  }

  async playAudio(context: ActionContext, asset: string, rawOptions: unknown): Promise<MediaHandle> {
    if (typeof asset !== 'string' || asset.length === 0) throw new RpError('INVALID_ARGUMENT', 'Asset path must be a string');
    return this.admit({ id: randomUUID(), kind: 'audio', mode: 'audio', asset, context, owner: characterRef(context.packId, context.characterId), options: asObject(rawOptions), queuedAt: new Date().toISOString() });
  }

  private async startAudio(pending: Pending): Promise<MediaHandle> {
    const { id, context, asset } = pending;
    const options = pending.options as PlayAudioOptions;
    const win = this.deps.audioWindow();
    this.listenAudio(win);
    await win.whenReady();
    const item: MediaItem = { id, kind: 'audio', asset, packId: context.packId, startedAt: new Date().toISOString(), state: 'open' };
    this.items.set(id, { item, owner: pending.owner, sessionId: context.sessionId, handles: [], offs: [] });
    const page: PlayAudioOptions = {};
    if (typeof options.volume === 'number') page.volume = options.volume;
    if (options.loop !== undefined) page.loop = Boolean(options.loop);
    win.send({ type: 'play-audio', id, url: assetUrl(context.packId, asset), options: page });
    return toHandle(item);
  }

  /**
   * Open `pending` now, put it in its kind's queue, or refuse it because the queue is full too.
   * Returns as soon as the decision is made — a queued call does not wait for its turn.
   */
  private async admit(pending: Pending): Promise<MediaHandle> {
    const decision = await this.serialise(async () => {
      const limits = mediaLimits((await this.deps.settings()).media);
      const cap = limits.maxConcurrent[pending.kind];
      // A queue that already has entries of this kind is joined even when a slot looks free, so
      // items always start in the order they were asked for.
      const waiting = this.queue.filter((q) => q.kind === pending.kind).length;
      if (cap === 0 || (waiting === 0 && this.countOf(pending.kind) < cap)) {
        this.starting[pending.kind]++;
        return 'start' as const;
      }
      if (waiting >= limits.maxQueued[pending.kind]) return { full: limits } as const;
      this.queue.push(pending);
      return 'queued' as const;
    });
    if (decision === 'start') {
      try {
        return await this.start(pending);
      } finally {
        this.starting[pending.kind]--;
        // The limit may have been raised since the queue formed; a start is as good a moment as a
        // close to notice, and the queue stays empty in the usual (uncapped) case anyway.
        this.pump(pending.kind);
      }
    }
    if (decision === 'queued') return pendingHandle(pending);
    const { maxConcurrent, maxQueued } = decision.full;
    throw new RpError(
      'CAPABILITY_FAILED',
      `Too much ${pending.kind} media at once: ${maxConcurrent[pending.kind]} can run and ${maxQueued[pending.kind]} can wait, and the queue is full. Close something first.`,
      { kind: pending.kind, maxConcurrent: maxConcurrent[pending.kind], maxQueued: maxQueued[pending.kind] },
    );
  }

  private start(pending: Pending): Promise<MediaHandle> {
    if (pending.mode === 'audio') return this.startAudio(pending);
    if (pending.mode === 'overlay') return this.startOverlay(pending);
    return this.startShow(pending);
  }

  /** Open/playing items of `kind`, plus the slots already handed to a start that is still running. */
  private countOf(kind: MediaKind): number {
    let open = 0;
    for (const m of this.items.values()) if (m.item.kind === kind) open++;
    return open + this.starting[kind];
  }

  /** Start whatever of `kind` now fits, oldest first. Fire and forget: nothing waits for the queue. */
  private pump(kind: MediaKind): void {
    // Nothing of this kind is waiting, which is every call on a machine with no limits set: the
    // whole queue costs nothing until someone asks for one.
    if (!this.queue.some((q) => q.kind === kind)) return;
    void (async () => {
      for (;;) {
        const next = await this.serialise(async () => this.take(kind));
        if (!next) return;
        try {
          await this.start(next);
          this.emitEvent('media-started', pendingSubject(next));
        } catch (err) {
          // Nobody is left holding the promise of a queued call, so a failed start is reported the
          // way any other failure is: the item goes away, with `error`.
          this.deps.logger.warn(`[media] queued ${next.kind} ${next.asset} could not start: ${String(err)}`);
          this.emitEvent('media-closed', pendingSubject(next), { reason: 'error' });
        } finally {
          this.starting[kind]--;
        }
      }
    })();
  }

  /** Under the admission lock: the next queued item of `kind` that fits, with its slot already taken. */
  private async take(kind: MediaKind): Promise<Pending | undefined> {
    const cap = mediaLimits((await this.deps.settings()).media).maxConcurrent[kind];
    if (cap !== 0 && this.countOf(kind) >= cap) return undefined;
    const index = this.queue.findIndex((q) => q.kind === kind);
    if (index < 0) return undefined;
    this.starting[kind]++;
    return this.queue.splice(index, 1)[0];
  }

  /** Run `fn` after every admission decision queued before it, so slot counts are never raced. */
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.admitting.then(fn, fn);
    this.admitting = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private listenAudio(win: OverlayWindowLike): void {
    if (this.audioListening === win) return;
    this.audioListening = win;
    win.onReport((event: MediaWindowEvent) => {
      const managed = this.items.get(event.id);
      if (!managed || managed.item.kind !== 'audio') return;
      if (event.type === 'ended') this.remove(event.id, 'ended');
      else if (event.type === 'closed') this.remove(event.id, event.reason ?? 'api');
      else if (event.type === 'error') {
        this.deps.logger.warn(`[media] audio ${managed.item.asset} failed: ${event.message}`);
        this.remove(event.id, 'error');
      }
    });
    win.onClosed(() => {
      for (const [id, m] of [...this.items]) if (m.item.kind === 'audio') this.remove(id, 'api');
      if (this.audioListening === win) this.audioListening = undefined;
    });
  }

  async update(id: string, patch: unknown): Promise<void> {
    const pending = this.queue.find((q) => q.id === id);
    if (pending) {
      // Not on screen yet, so the patch is folded into the options it will open with — the same
      // fields an open item would have taken, so waiting changes nothing about what `update` does.
      const raw = asObject<OverlayUpdate>(patch);
      if (pending.mode === 'show') Object.assign(pending.options, raw);
      else if (pending.mode === 'overlay') Object.assign(pending.options, fullscreenUpdate(raw));
      return;
    }
    const managed = this.items.get(id);
    if (!managed || managed.handles.length === 0) return; // audio or gone: no-op
    const raw = asObject<OverlayUpdate>(patch);
    const changes = managed.fullscreen ? fullscreenUpdate(raw) : raw;
    for (const handle of managed.handles) await handle.update(changes);
    if (managed.item.overlay) {
      if (changes.layer !== undefined) managed.item.overlay.layer = nearestLayer(changes.layer, this.deps.backend().info().supports.layers);
      if (typeof changes.opacity === 'number') managed.item.overlay.opacity = Math.min(1, Math.max(0, changes.opacity));
      if (changes.clickThrough !== undefined) managed.item.overlay.clickThrough = Boolean(changes.clickThrough);
    }
  }

  /** Close an item; `reason` is what `media-closed` reports (`api` for a character's or the app's own close). */
  async close(id: string, reason: MediaCloseReason = 'api'): Promise<void> {
    const queued = this.queue.findIndex((q) => q.id === id);
    if (queued >= 0) {
      const [pending] = this.queue.splice(queued, 1);
      this.emitEvent('media-closed', pendingSubject(pending as Pending), { reason });
      return;
    }
    const managed = this.items.get(id);
    if (!managed) return;
    if (managed.item.kind === 'audio') {
      const win = this.audioListening;
      if (win && !win.isDestroyed()) win.send({ type: 'close', id });
      this.remove(id, reason);
      return;
    }
    this.remove(id, reason);
    for (const handle of managed.handles) await handle.close().catch((err) => this.deps.logger.debug('[media] close failed', err));
  }

  async closeAll(owner?: string): Promise<void> {
    for (const p of [...this.queue]) if (owner === undefined || p.owner === owner) await this.close(p.id);
    for (const [id, m] of [...this.items]) if (owner === undefined || m.owner === owner) await this.close(id);
  }

  /** Open items first, then the ones still waiting, each in the order they were asked for. */
  list(owner?: string): MediaHandle[] {
    const mine = <T extends { owner: string }>(x: T) => owner === undefined || x.owner === owner;
    return [...[...this.items.values()].filter(mine).map((m) => toHandle(m.item)), ...this.queue.filter(mine).map(pendingHandle)];
  }

  items_(): MediaItem[] {
    return [...[...this.items.values()].map((m) => m.item), ...this.queue.map(pendingItem)];
  }

  /** Forget an item and report `media-closed` once; tolerant of ids that were already removed. */
  private remove(id: string, reason: MediaCloseReason): void {
    const managed = this.items.get(id);
    if (!managed) return;
    this.items.delete(id);
    if (managed.timer) clearTimeout(managed.timer);
    for (const off of managed.offs.splice(0)) off();
    this.emitEvent('media-closed', subjectOf(managed), { reason });
    // A slot of this kind just came free: whatever is waiting for one starts now.
    this.pump(managed.item.kind);
  }

  private emitEvent(name: 'media-clicked' | 'media-started' | 'media-closed', subject: EventSubject, extra: Record<string, Json> = {}): void {
    if (!this.deps.emit) return;
    const { id, asset, packId, kind } = subject;
    try {
      this.deps.emit({ name, data: { mediaId: id, asset, packId, kind, characterRef: subject.owner, ...extra }, at: new Date().toISOString() });
    } catch (err) {
      this.deps.logger.debug(`[media] ${name} listener failed`, err);
    }
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
      case 'overlay':
        return (await this.media.overlay(context, args[0] as string, args[1])) as unknown as Json;
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
