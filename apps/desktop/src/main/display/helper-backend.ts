/**
 * `hyprland` backend tier 1: overlays are real wlr-layer-shell surfaces
 * rendered by the native helper (docs/spec/overlay-helper.md). The helper
 * loads media.html from the loopback server; commands after the initial one
 * reach the page through the `js` op (`window.__rpMediaCommand(json)`).
 */
import type { DisplayBackendInfo, MediaCloseReason, MediaCommand, MediaWindowEvent, MonitorInfo, OverlayLayer, OverlayUpdate } from '@rp/shared';
import type { BackendLogger, DisplayBackend, OverlayClosedDetail, OverlayEvent, OverlayEventListener, OverlayHandle, OverlaySpec, ResolvedOverlayOptions } from './backend.js';
import { applyOverlayUpdate, visualPatch } from './backend.js';
import { OverlayEvents, showCommand } from './electron.js';
import type { HelperEvent, HelperProcess, HelperReady } from './helper-process.js';
import type { HyprClientJson, HyprMonitorJson, HyprTransport } from './hyprland.js';
import { parseMonitors } from './hyprland.js';
import { isOverlayLayer } from './layers.js';
import type { LoopbackServerLike } from '../loopback.js';

export interface HelperBackendOptions {
  helper: HelperProcess;
  loopback: LoopbackServerLike;
  ready: HelperReady;
  /** Hyprland IPC, used to fill in connector names the helper may lack. */
  hypr?: HyprTransport;
  logger?: BackendLogger;
}

/** `show`/`update` payload fields for the helper, derived from resolved options. */
export function helperPlacement(o: ResolvedOverlayOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {
    layer: o.layer,
    anchor: o.anchor,
    marginPx: o.marginPx,
    monitor: { index: o.monitor.index, name: o.monitor.name, x: o.monitor.x, y: o.monitor.y },
    width: o.width,
    opacity: o.opacity,
    clickThrough: o.clickThrough,
  };
  if (o.height !== undefined) out.height = o.height;
  if (o.maxHeight !== undefined) out.maxHeight = o.maxHeight;
  if (o.x !== undefined) out.x = o.x;
  if (o.y !== undefined) out.y = o.y;
  if (o.randomSeed) {
    out.randomX = o.randomSeed.x;
    out.randomY = o.randomSeed.y;
  }
  return out;
}

/**
 * A command as the helper's pages can load it: every asset URL it carries is rewritten (WebKit
 * has no `rp-asset://` scheme). Only the first command of an overlay goes through `showCommand`;
 * later ones arrive here — above all the `avatar-set` that swaps in another expression frame,
 * which would otherwise leave the page with an `rp-asset://` src it cannot fetch.
 */
export function pageCommand(command: MediaCommand, rewrite: (url: string) => string): MediaCommand {
  switch (command.type) {
    case 'show-image':
    case 'play-video':
    case 'play-audio':
      return { ...command, url: rewrite(command.url) };
    case 'avatar-show':
      return { ...command, state: { ...command.state, imageUrl: rewrite(command.state.imageUrl) } };
    case 'avatar-set':
      if (command.patch.imageUrl === undefined) return command;
      return { ...command, patch: { ...command.patch, imageUrl: rewrite(command.patch.imageUrl) } };
    default:
      // Widget HTML already carries page URLs: `{{asset:…}}` is substituted through `pageAssetUrl`.
      return command;
  }
}

/** JS that hands a command to the page (`window.__rpMediaCommand(json)`). */
export function commandScript(command: MediaCommand): string {
  const json = JSON.stringify(JSON.stringify(command));
  return `(function(){try{if(typeof window.__rpMediaCommand==='function'){window.__rpMediaCommand(${json});}}catch(e){}})();`;
}

/** Fill in Hyprland connector names on helper monitors whose name is missing/generic, matching by geometry. */
export function mergeMonitorNames(helperMonitors: MonitorInfo[], hyprMonitors: MonitorInfo[]): MonitorInfo[] {
  return helperMonitors.map((m) => {
    const generic = !m.name || /^(display|monitor)\s*\d*$/i.test(m.name) || m.name === m.id;
    if (!generic) return m;
    const match = hyprMonitors.find((h) => h.x === m.x && h.y === m.y && h.width === m.width && h.height === m.height) ?? hyprMonitors.find((h) => h.index === m.index);
    return match ? { ...m, name: match.name } : m;
  });
}

class HelperOverlay implements OverlayHandle {
  readonly id: string;
  readonly events = new OverlayEvents();
  options: ResolvedOverlayOptions;
  closed = false;

  constructor(
    readonly spec: OverlaySpec,
    private readonly backend: HelperBackend,
  ) {
    this.id = spec.id;
    this.options = spec.options;
  }

  async update(patch: OverlayUpdate): Promise<void> {
    if (this.closed) return;
    const monitors = await this.backend.monitors();
    this.options = applyOverlayUpdate(this.options, patch, monitors);
    await this.backend.helper.request('update', { id: this.id, patch: helperPlacement(this.options) });
    const visual = visualPatch(patch);
    if (Object.keys(visual).length > 0) await this.backend.runScript(this.id, { type: 'update', id: this.id, options: visual });
  }

  async close(reason: MediaCloseReason = 'api'): Promise<void> {
    if (this.closed) return;
    try {
      await this.backend.helper.request('close', { id: this.id });
    } catch (err) {
      this.backend.log.debug?.(`[display:hyprland] close ${this.id} failed`, err);
    }
    this.finish(reason);
  }

  on(event: OverlayEvent, listener: OverlayEventListener): () => void {
    return this.events.on(event, listener);
  }

  async send(command: MediaCommand): Promise<void> {
    if (this.closed) return;
    await this.backend.runScript(this.id, command);
  }

  finish(reason: MediaCloseReason = 'api'): void {
    if (this.closed) return;
    this.closed = true;
    this.backend.forget(this);
    const detail: OverlayClosedDetail = { reason };
    this.events.emit('closed', detail);
    this.events.clear();
  }

  handlePayload(payload: MediaWindowEvent): void {
    switch (payload.type) {
      case 'content-size':
        this.events.emit('content-size', { width: payload.width, height: payload.height });
        return;
      case 'ended':
        this.events.emit('ended');
        return;
      case 'error':
        this.events.emit('error', payload.message);
        return;
      case 'closed':
        // The page removed the item; tear the surface down too.
        void this.close(payload.reason ?? 'api');
        return;
      case 'clicked':
        this.events.emit('clicked');
        return;
      case 'avatar-clicked':
        this.events.emit('avatar-clicked');
        return;
      case 'widget-message':
        this.events.emit('widget-message', payload.message);
        return;
      default:
        return;
    }
  }
}

export class HelperBackend implements DisplayBackend {
  readonly name = 'hyprland';

  /** The helper's WebKit views cannot use `rp-asset://`: widget HTML gets loopback URLs instead. */
  pageAssetUrl(assetUrl: string): string {
    return this.loopback.rewriteAssetUrl(assetUrl);
  }
  readonly helper: HelperProcess;
  readonly log: BackendLogger;
  private readonly loopback: LoopbackServerLike;
  private readonly ready: HelperReady;
  private readonly hypr: HyprTransport | undefined;
  private readonly overlays = new Map<string, HelperOverlay>();
  private readonly offs: Array<() => void> = [];

  constructor(opts: HelperBackendOptions) {
    this.helper = opts.helper;
    this.loopback = opts.loopback;
    this.ready = opts.ready;
    this.hypr = opts.hypr;
    this.log = opts.logger ?? { info: () => undefined, warn: () => undefined, debug: () => undefined };
    const onMessage = (ev: HelperEvent): void => {
      const overlay = typeof ev.id === 'string' ? this.overlays.get(ev.id) : undefined;
      const payload = ev.payload as MediaWindowEvent | undefined;
      if (!overlay || !payload || typeof payload !== 'object' || typeof payload.type !== 'string') return;
      overlay.handlePayload(payload);
    };
    const onClosed = (ev: HelperEvent): void => {
      if (typeof ev.id === 'string') this.overlays.get(ev.id)?.finish();
    };
    const onError = (ev: HelperEvent): void => {
      const overlay = typeof ev.id === 'string' ? this.overlays.get(ev.id) : undefined;
      if (overlay) overlay.events.emit('error', ev.message);
      else this.log.warn?.(`[display:hyprland] helper error: ${String(ev.message)}`);
    };
    const onExit = (): void => {
      for (const overlay of [...this.overlays.values()]) overlay.finish();
    };
    this.helper.on('message', onMessage);
    this.helper.on('closed', onClosed);
    this.helper.on('error', onError);
    this.helper.on('exit', onExit);
    this.offs.push(
      () => this.helper.off('message', onMessage),
      () => this.helper.off('closed', onClosed),
      () => this.helper.off('error', onError),
      () => this.helper.off('exit', onExit),
    );
  }

  info(): DisplayBackendInfo {
    const f = this.ready.features ?? { layers: ['background', 'bottom', 'top', 'overlay'], opacity: true, clickThrough: true, exactPosition: true, video: true };
    const layers = (Array.isArray(f.layers) ? f.layers : []).filter(isOverlayLayer) as OverlayLayer[];
    return {
      name: this.name,
      platform: 'linux',
      windowSystem: 'wayland',
      supports: {
        layers: layers.length > 0 ? layers : ['background', 'bottom', 'top', 'overlay'],
        opacity: f.opacity !== false,
        clickThrough: f.clickThrough !== false,
        monitorSelection: true,
        exactPosition: f.exactPosition !== false,
      },
    };
  }

  async monitors(): Promise<MonitorInfo[]> {
    await this.helper.start();
    const fromHelper = await this.helper.monitors();
    if (!this.hypr) return fromHelper;
    try {
      const raw = JSON.parse(await this.hypr.request('j/monitors')) as HyprMonitorJson[];
      return mergeMonitorNames(fromHelper, parseMonitors(Array.isArray(raw) ? raw : []));
    } catch (err) {
      this.log.debug?.('[display:hyprland] j/monitors unavailable for name merge', err);
      return fromHelper;
    }
  }

  async createOverlay(spec: OverlaySpec): Promise<OverlayHandle> {
    await this.helper.start();
    const overlay = new HelperOverlay(spec, this);
    this.overlays.set(spec.id, overlay);
    const command = showCommand(spec, this.loopback.rewriteAssetUrl(spec.assetUrl));
    const url = this.loopback.mediaPageUrl(command);
    try {
      await this.helper.request('show', { id: spec.id, url, ...helperPlacement(spec.options) });
    } catch (err) {
      this.overlays.delete(spec.id);
      throw err;
    }
    return overlay;
  }

  async runScript(id: string, command: MediaCommand): Promise<void> {
    try {
      await this.helper.request('js', { id, script: commandScript(pageCommand(command, (url) => this.loopback.rewriteAssetUrl(url))) });
    } catch (err) {
      this.log.debug?.(`[display:hyprland] js for ${id} failed`, err);
    }
  }

  forget(overlay: HelperOverlay): void {
    if (this.overlays.get(overlay.id) === overlay) this.overlays.delete(overlay.id);
  }

  async closeAll(): Promise<void> {
    if (this.overlays.size === 0) return;
    try {
      await this.helper.request('closeAll');
    } catch (err) {
      this.log.debug?.('[display:hyprland] closeAll failed', err);
    }
    for (const overlay of [...this.overlays.values()]) overlay.finish();
  }

  async dispose(): Promise<void> {
    await this.closeAll();
    for (const off of this.offs.splice(0)) off();
    await this.helper.dispose();
  }
}

/** Exposed for tests: what a client list lookup would use (kept for parity with the IPC tier). */
export type { HyprClientJson };
