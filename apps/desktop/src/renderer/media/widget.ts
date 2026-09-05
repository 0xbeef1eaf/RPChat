/** Pure state and validation for the `widget` overlay page. */
import type { Json, MediaCommand, MediaItemId, OverlayOptions, WidgetSpec } from '@rp/shared';

export const MAX_WIDGET_MESSAGE_BYTES = 16 * 1024;

export interface WidgetEntry {
  id: MediaItemId;
  widget: WidgetSpec;
  options: OverlayOptions;
  /** Bumped when `html` changes so the iframe reloads. */
  revision: number;
  /** Messages queued for the iframe (delivered by the view, then acknowledged via `drainWidgetOutbox`). */
  outbox: Array<{ seq: number; message: Json }>;
  nextSeq: number;
}

export type WidgetCommand = Extract<MediaCommand, { type: 'widget-show' | 'widget-update' }>;

export function isWidgetCommand(command: MediaCommand): command is WidgetCommand {
  return command.type === 'widget-show' || command.type === 'widget-update';
}

export function applyWidgetCommand(list: WidgetEntry[], command: WidgetCommand): WidgetEntry[] {
  const idx = list.findIndex((w) => w.id === command.id);
  switch (command.type) {
    case 'widget-show': {
      const existing = idx === -1 ? null : list[idx]!;
      const entry: WidgetEntry = {
        id: command.id,
        widget: command.widget,
        options: command.options ?? {},
        revision: existing ? existing.revision + 1 : 0,
        outbox: [],
        nextSeq: existing ? existing.nextSeq : 1,
      };
      if (!existing) return [...list, entry];
      const next = list.slice();
      next[idx] = entry;
      return next;
    }
    case 'widget-update': {
      if (idx === -1) return list;
      const current = list[idx]!;
      const htmlChanged = command.html !== undefined && command.html !== current.widget.html;
      const entry: WidgetEntry = {
        ...current,
        widget: { ...current.widget, html: command.html ?? current.widget.html, title: command.title ?? current.widget.title },
        revision: htmlChanged ? current.revision + 1 : current.revision,
        outbox: command.postMessage !== undefined ? [...current.outbox, { seq: current.nextSeq, message: command.postMessage }] : current.outbox,
        nextSeq: command.postMessage !== undefined ? current.nextSeq + 1 : current.nextSeq,
      };
      const next = list.slice();
      next[idx] = entry;
      return next;
    }
    default:
      return list;
  }
}

/** Remove delivered outbox entries (all with `seq <= upToSeq`). */
export function drainWidgetOutbox(list: WidgetEntry[], id: MediaItemId, upToSeq: number): WidgetEntry[] {
  return list.map((w) => (w.id === id && w.outbox.length > 0 ? { ...w, outbox: w.outbox.filter((m) => m.seq > upToSeq) } : w));
}

/**
 * Validate a `postMessage` payload coming out of a widget iframe before it is
 * reported to main as a `widget-message`: must be plain JSON (no functions,
 * cycles, non-finite numbers, or DOM objects) and reasonably small.
 */
export function validateWidgetMessage(data: unknown): { ok: true; message: Json } | { ok: false; reason: string } {
  let text: string;
  try {
    text = JSON.stringify(data, (_k, v: unknown) => {
      if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new Error('unsupported value');
      if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number');
      return v;
    }) as string;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'not serialisable' };
  }
  if (text === undefined) return { ok: false, reason: 'undefined message' };
  if (new TextEncoder().encode(text).byteLength > MAX_WIDGET_MESSAGE_BYTES) return { ok: false, reason: 'message too large' };
  return { ok: true, message: JSON.parse(text) as Json };
}
