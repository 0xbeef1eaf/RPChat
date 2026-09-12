/** `sdk.widgets`: character-authored HTML in sandboxed iframes, one overlay per widget. */
import { randomUUID } from 'node:crypto';
import type { ActionContext, CapabilityHandler, HostEvent, Json, OverlayOptions, WidgetSpec } from '@rp/shared';
import { RpError, characterRef } from '@rp/shared';
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
}

export interface WidgetsHandlerDeps {
  backend(): DisplayBackend;
  emit(event: HostEvent): void;
  defaultLayer(): Promise<'top' | 'bottom'>;
}

function clampDim(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.max(64, Math.min(4096, Math.round(v)));
}

export class WidgetsHandler implements CapabilityHandler {
  readonly moduleId = 'widgets';
  private readonly live = new Map<string, Live>();

  constructor(private readonly deps: WidgetsHandlerDeps) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const owner = characterRef(context.packId, context.characterId);
    switch (method) {
      case 'show':
        return (await this.show(owner, context, args[0])) as unknown as Json;
      case 'update':
        await this.update(owner, args[0], args[1]);
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

  private async show(owner: string, context: ActionContext, specArg: unknown): Promise<{ id: string; title?: string }> {
    const s = specArg && typeof specArg === 'object' ? (specArg as Record<string, unknown>) : {};
    if (typeof s.html !== 'string' || s.html.length === 0) throw new RpError('INVALID_ARGUMENT', 'html must be a non-empty string');
    if (s.html.length > WIDGET_HTML_MAX) throw new RpError('INVALID_ARGUMENT', `html exceeds ${WIDGET_HTML_MAX} characters`);
    const id = typeof s.id === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(s.id) ? s.id : randomUUID();
    const existing = this.live.get(id);
    if (existing) {
      if (existing.owner !== owner) throw new RpError('PERMISSION_DENIED', `Widget "${id}" belongs to another character`);
      await this.update(owner, id, { html: s.html, ...(typeof s.title === 'string' ? { title: s.title } : {}) });
      return { id, ...(existing.spec.title !== undefined ? { title: existing.spec.title } : {}) };
    }
    if ([...this.live.values()].filter((w) => w.owner === owner).length >= WIDGETS_PER_CHARACTER) {
      throw new RpError('INVALID_ARGUMENT', `At most ${WIDGETS_PER_CHARACTER} widgets per character`);
    }
    const widget: WidgetSpec = {
      id,
      html: s.html,
      width: clampDim(s.width, WIDGET_DEFAULT_WIDTH),
      height: clampDim(s.height, WIDGET_DEFAULT_HEIGHT),
      ...(typeof s.title === 'string' ? { title: s.title.slice(0, 120) } : {}),
    };
    const backend = this.deps.backend();
    const monitors = await backend.monitors();
    const { html: _html, id: _id, title: _title, ...overlayOpts } = s;
    const options = resolveOverlayOptions({ monitor: 'primary', position: 'top-right', ...(overlayOpts as OverlayOptions), width: widget.width, height: widget.height }, monitors, { layer: await this.deps.defaultLayer() });
    const spec: OverlaySpec = { id: `widget-${id}`, kind: 'widget', file: '', assetUrl: '', packId: context.packId, asset: '', options, page: {}, widget };
    const handle = await backend.createOverlay(spec);
    const offs = [
      handle.on('widget-message', (message) => this.deps.emit({ name: 'widget-message', data: { widgetId: id, message: (message ?? null) as Json, characterRef: owner }, at: new Date().toISOString() })),
      handle.on('closed', () => {
        if (this.live.get(id)?.handle === handle) this.live.delete(id);
      }),
    ];
    this.live.set(id, { owner, spec: widget, handle, off: () => offs.forEach((o) => o()) });
    return { id, ...(widget.title !== undefined ? { title: widget.title } : {}) };
  }

  private requireOwn(owner: string, idArg: unknown): Live {
    if (typeof idArg !== 'string') throw new RpError('INVALID_ARGUMENT', 'id must be a string');
    const live = this.live.get(idArg);
    if (!live) throw new RpError('NOT_FOUND', `No widget "${idArg}"`);
    if (live.owner !== owner) throw new RpError('PERMISSION_DENIED', `Widget "${idArg}" belongs to another character`);
    return live;
  }

  private async update(owner: string, idArg: unknown, patchArg: unknown): Promise<void> {
    const live = this.requireOwn(owner, idArg);
    const p = patchArg && typeof patchArg === 'object' ? (patchArg as { html?: unknown; title?: unknown; postMessage?: unknown }) : {};
    const cmd: Extract<Parameters<OverlayHandle['send']>[0], { type: 'widget-update' }> = { type: 'widget-update', id: live.handle.id };
    if (typeof p.html === 'string') {
      if (p.html.length > WIDGET_HTML_MAX) throw new RpError('INVALID_ARGUMENT', `html exceeds ${WIDGET_HTML_MAX} characters`);
      cmd.html = p.html;
      live.spec.html = p.html;
    }
    if (typeof p.title === 'string') {
      cmd.title = p.title.slice(0, 120);
      live.spec.title = cmd.title;
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
