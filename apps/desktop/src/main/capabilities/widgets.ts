/**
 * `sdk.widgets`: character-authored HTML in sandboxed iframes, one overlay per widget. The HTML
 * may embed pack images as `{{asset:<pack-relative path>}}` placeholders; the host validates each
 * path against the pack and swaps in the URL the media page can load (`rp-asset://…` for Electron
 * windows, the loopback URL for native helper views) — the sandboxed iframe has no other way to
 * reach a file.
 */
import { randomUUID } from 'node:crypto';
import type { ActionContext, CapabilityHandler, HostEvent, Json, LoadedPack, OverlayOptions, WidgetSpec } from '@rp/shared';
import { RpError, assetUrl, characterRef, parseCharacterRef } from '@rp/shared';
import { resolvePackAsset } from '@rp/core';
import type { Logger } from '@rp/core';
import type { DisplayBackend, OverlayHandle, OverlaySpec } from '../display/backend.js';
import { resolveOverlayOptions } from '../display/backend.js';

export const WIDGET_HTML_MAX = 256 * 1024;
export const WIDGET_DEFAULT_WIDTH = 320;
export const WIDGET_DEFAULT_HEIGHT = 240;
export const WIDGETS_PER_CHARACTER = 8;

interface Live {
  owner: string;
  spec: WidgetSpec;
  handle: OverlayHandle;
  off: () => void;
  /** What a restart needs to show it again: the HTML as the character wrote it (placeholders unresolved) and its placement. */
  record: WidgetRecord;
}

/**
 * A widget as session-state.ts keeps it across a restart. The HTML is the character's own, with
 * its `{{asset:…}}` placeholders still in it: the URLs they resolve to depend on the display
 * backend and the loopback port, which can both be different next time.
 */
export interface WidgetRecord {
  id: string;
  packId: string;
  characterId: string;
  html: string;
  title?: string;
  width: number;
  height: number;
  /** The overlay options the widget was shown with (`monitor`, `position`, `x`, `y`, `layer`…). */
  overlay: Record<string, unknown>;
}

/** Pure: the widget records in a stored file, skipping any entry that could not be shown again. */
export function parseWidgetRecords(raw: unknown): WidgetRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: WidgetRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (![e.id, e.packId, e.characterId, e.html].every((v) => typeof v === 'string' && v.length > 0)) continue;
    if ((e.html as string).length > WIDGET_HTML_MAX) continue;
    out.push({
      id: e.id as string,
      packId: e.packId as string,
      characterId: e.characterId as string,
      html: e.html as string,
      ...(typeof e.title === 'string' ? { title: e.title } : {}),
      width: clampDim(e.width, WIDGET_DEFAULT_WIDTH),
      height: clampDim(e.height, WIDGET_DEFAULT_HEIGHT),
      overlay: e.overlay && typeof e.overlay === 'object' && !Array.isArray(e.overlay) ? { ...(e.overlay as Record<string, unknown>) } : {},
    });
  }
  return out;
}

export interface WidgetsHandlerDeps {
  backend(): DisplayBackend;
  emit(event: HostEvent): void;
  defaultLayer(): Promise<'top' | 'bottom'>;
  /** Installed packs, for `{{asset:…}}` placeholders. Without it placeholders are an error. */
  packs?: { getLoaded(packId: string): LoadedPack };
  logger?: Pick<Logger, 'warn'>;
}

/** `{{asset:media/images/x.png}}` (whitespace around the path tolerated). */
export const ASSET_PLACEHOLDER_RE = /\{\{\s*asset:\s*([^{}]*?)\s*\}\}/g;

/**
 * Replace every `{{asset:<path>}}` in widget HTML with `resolve(path)`. Pure: `resolve` validates
 * the path and returns the URL (or throws). Paths are resolved once each; the HTML is otherwise
 * untouched. Braces that do not form a placeholder stay as they are.
 */
export function substituteAssetPlaceholders(html: string, resolve: (path: string) => string): string {
  const cache = new Map<string, string>();
  return html.replace(ASSET_PLACEHOLDER_RE, (_m, rawPath: string) => {
    const path = rawPath.trim();
    let url = cache.get(path);
    if (url === undefined) {
      url = resolve(path);
      cache.set(path, url);
    }
    return url;
  });
}

function clampDim(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.max(64, Math.min(4096, Math.round(v)));
}

export class WidgetsHandler implements CapabilityHandler {
  readonly moduleId = 'widgets';
  private readonly live = new Map<string, Live>();

  constructor(private readonly deps: WidgetsHandlerDeps) {}

  /**
   * Widget HTML with every `{{asset:…}}` placeholder replaced by a URL the page can load.
   * Throws INVALID_ARGUMENT naming the placeholder when a path is not an asset of the pack.
   */
  renderHtml(html: string, packId: string): string {
    return substituteAssetPlaceholders(html, (path) => {
      const packs = this.deps.packs;
      if (!packs) throw new RpError('INVALID_ARGUMENT', `Widget placeholder {{asset:${path}}}: pack assets are not available here`);
      let ref: { path: string };
      try {
        ref = resolvePackAsset(packs.getLoaded(packId), path);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new RpError('INVALID_ARGUMENT', `Widget placeholder {{asset:${path}}} is not a pack asset: ${reason}`, { path });
      }
      const url = assetUrl(packId, ref.path);
      const backend = this.deps.backend();
      return backend.pageAssetUrl ? backend.pageAssetUrl(url) : url;
    });
  }

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const owner = characterRef(context.packId, context.characterId);
    switch (method) {
      case 'show':
        return (await this.show(owner, context.packId, args[0])) as unknown as Json;
      case 'update':
        await this.update(owner, context.packId, args[0], args[1]);
        return;
      case 'close':
        await this.close(owner, args[0]);
        return;
      case 'closeAll':
        for (const [id, w] of [...this.live]) if (w.owner === owner) await this.close(owner, id);
        return;
      case 'list':
        return [...this.live.values()].filter((w) => w.owner === owner).map((w) => ({ id: w.spec.id, ...(w.spec.title !== undefined ? { title: w.spec.title } : {}) }));
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.widgets.${method}`);
    }
  }

  /** The widgets on screen, as records a later launch can show again (`restore`). */
  snapshot(): WidgetRecord[] {
    return [...this.live.values()].map((w) => ({ ...w.record, overlay: { ...w.record.overlay } }));
  }

  /**
   * Show the widgets a previous launch had up, under their old ids. `owns` says whether the
   * character is still installed; a widget whose pack is gone, or whose HTML no longer resolves
   * against it, is skipped. Returns how many were put back.
   */
  async restore(records: WidgetRecord[], owns: (packId: string, characterId: string) => boolean): Promise<number> {
    let restored = 0;
    for (const r of records) {
      if (this.live.has(r.id) || !owns(r.packId, r.characterId)) continue;
      try {
        await this.show(characterRef(r.packId, r.characterId), r.packId, { ...r.overlay, id: r.id, html: r.html, width: r.width, height: r.height, ...(r.title !== undefined ? { title: r.title } : {}) });
        restored++;
      } catch (err) {
        this.deps.logger?.warn(`[widgets] could not restore widget ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return restored;
  }

  private async show(owner: string, packId: string, specArg: unknown): Promise<{ id: string; title?: string }> {
    const s = specArg && typeof specArg === 'object' ? (specArg as Record<string, unknown>) : {};
    if (typeof s.html !== 'string' || s.html.length === 0) throw new RpError('INVALID_ARGUMENT', 'html must be a non-empty string');
    if (s.html.length > WIDGET_HTML_MAX) throw new RpError('INVALID_ARGUMENT', `html exceeds ${WIDGET_HTML_MAX} characters`);
    const id = typeof s.id === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(s.id) ? s.id : randomUUID();
    const existing = this.live.get(id);
    if (existing) {
      if (existing.owner !== owner) throw new RpError('PERMISSION_DENIED', `Widget "${id}" belongs to another character`);
      await this.update(owner, packId, id, { html: s.html, ...(typeof s.title === 'string' ? { title: s.title } : {}) });
      return { id, ...(existing.spec.title !== undefined ? { title: existing.spec.title } : {}) };
    }
    const html = this.renderHtml(s.html, packId);
    if ([...this.live.values()].filter((w) => w.owner === owner).length >= WIDGETS_PER_CHARACTER) {
      throw new RpError('INVALID_ARGUMENT', `At most ${WIDGETS_PER_CHARACTER} widgets per character`);
    }
    const widget: WidgetSpec = {
      id,
      html,
      width: clampDim(s.width, WIDGET_DEFAULT_WIDTH),
      height: clampDim(s.height, WIDGET_DEFAULT_HEIGHT),
      ...(typeof s.title === 'string' ? { title: s.title.slice(0, 120) } : {}),
    };
    const backend = this.deps.backend();
    const monitors = await backend.monitors();
    const { html: _html, id: _id, title: _title, ...overlayOpts } = s;
    const options = resolveOverlayOptions({ monitor: 'primary', position: 'top-right', ...(overlayOpts as OverlayOptions), width: widget.width, height: widget.height }, monitors, { layer: await this.deps.defaultLayer() });
    const spec: OverlaySpec = { id: `widget-${id}`, kind: 'widget', file: '', assetUrl: '', packId, asset: '', options, page: {}, widget };
    const handle = await backend.createOverlay(spec);
    const offs = [
      handle.on('widget-message', (message) => this.deps.emit({ name: 'widget-message', data: { widgetId: id, message: (message ?? null) as Json, characterRef: owner }, at: new Date().toISOString() })),
      handle.on('closed', () => {
        if (this.live.get(id)?.handle === handle) this.live.delete(id);
      }),
    ];
    const { characterId } = parseCharacterRef(owner);
    const { width: _width, height: _height, ...placement } = overlayOpts as Record<string, unknown>;
    const record: WidgetRecord = { id, packId, characterId, html: s.html, ...(widget.title !== undefined ? { title: widget.title } : {}), width: widget.width, height: widget.height, overlay: placement };
    this.live.set(id, { owner, spec: widget, handle, off: () => offs.forEach((o) => o()), record });
    return { id, ...(widget.title !== undefined ? { title: widget.title } : {}) };
  }

  private requireOwn(owner: string, idArg: unknown): Live {
    if (typeof idArg !== 'string') throw new RpError('INVALID_ARGUMENT', 'id must be a string');
    const live = this.live.get(idArg);
    if (!live) throw new RpError('NOT_FOUND', `No widget "${idArg}"`);
    if (live.owner !== owner) throw new RpError('PERMISSION_DENIED', `Widget "${idArg}" belongs to another character`);
    return live;
  }

  private async update(owner: string, packId: string, idArg: unknown, patchArg: unknown): Promise<void> {
    const live = this.requireOwn(owner, idArg);
    const p = patchArg && typeof patchArg === 'object' ? (patchArg as { html?: unknown; title?: unknown; postMessage?: unknown }) : {};
    const cmd: Extract<Parameters<OverlayHandle['send']>[0], { type: 'widget-update' }> = { type: 'widget-update', id: live.handle.id };
    if (typeof p.html === 'string') {
      if (p.html.length > WIDGET_HTML_MAX) throw new RpError('INVALID_ARGUMENT', `html exceeds ${WIDGET_HTML_MAX} characters`);
      const html = this.renderHtml(p.html, packId);
      cmd.html = html;
      live.spec.html = html;
      live.record.html = p.html;
    }
    if (typeof p.title === 'string') {
      cmd.title = p.title.slice(0, 120);
      live.spec.title = cmd.title;
      live.record.title = cmd.title;
    }
    if (p.postMessage !== undefined) cmd.postMessage = p.postMessage as Json;
    await live.handle.send(cmd);
  }

  private async close(owner: string, idArg: unknown): Promise<void> {
    if (typeof idArg !== 'string' || !this.live.has(idArg)) return;
    const live = this.requireOwn(owner, idArg);
    this.live.delete(idArg);
    live.off();
    await live.handle.close();
  }

  async dispose(): Promise<void> {
    for (const [id, w] of [...this.live]) {
      this.live.delete(id);
      w.off();
      await w.handle.close().catch(() => undefined);
    }
  }
}
