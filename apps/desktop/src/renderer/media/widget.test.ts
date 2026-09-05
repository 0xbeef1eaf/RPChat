import { describe, expect, it } from 'vitest';
import { applyWidgetCommand, drainWidgetOutbox, MAX_WIDGET_MESSAGE_BYTES, validateWidgetMessage, type WidgetEntry } from './widget';

const spec = { id: 'w1', title: 'Clock', html: '<b>hi</b>', width: 200, height: 100 };

describe('widget page reducer', () => {
  it('show adds, re-show replaces and bumps the revision', () => {
    let list: WidgetEntry[] = applyWidgetCommand([], { type: 'widget-show', id: 'w1', widget: spec, options: { opacity: 0.8 } });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'w1', revision: 0, outbox: [], options: { opacity: 0.8 } });
    list = applyWidgetCommand(list, { type: 'widget-show', id: 'w1', widget: { ...spec, html: '<i>x</i>' }, options: {} });
    expect(list).toHaveLength(1);
    expect(list[0]?.revision).toBe(1);
    expect(list[0]?.widget.html).toBe('<i>x</i>');
  });

  it('update merges html/title, reloads only when html changes, queues postMessage', () => {
    let list = applyWidgetCommand([], { type: 'widget-show', id: 'w1', widget: spec, options: {} });
    list = applyWidgetCommand(list, { type: 'widget-update', id: 'w1', title: 'Timer' });
    expect(list[0]).toMatchObject({ revision: 0, widget: { title: 'Timer', html: spec.html } });
    list = applyWidgetCommand(list, { type: 'widget-update', id: 'w1', html: '<p>new</p>', postMessage: { tick: 1 } });
    expect(list[0]?.revision).toBe(1);
    expect(list[0]?.outbox).toEqual([{ seq: 1, message: { tick: 1 } }]);
    list = applyWidgetCommand(list, { type: 'widget-update', id: 'w1', postMessage: 'second' });
    expect(list[0]?.outbox.map((m) => m.seq)).toEqual([1, 2]);
    list = drainWidgetOutbox(list, 'w1', 1);
    expect(list[0]?.outbox).toEqual([{ seq: 2, message: 'second' }]);
    expect(applyWidgetCommand(list, { type: 'widget-update', id: 'nope', html: 'x' })).toBe(list);
  });
});

describe('validateWidgetMessage', () => {
  it('accepts plain JSON', () => {
    expect(validateWidgetMessage({ a: [1, 'two', null, { b: true }] })).toEqual({ ok: true, message: { a: [1, 'two', null, { b: true }] } });
    expect(validateWidgetMessage('hello')).toEqual({ ok: true, message: 'hello' });
    expect(validateWidgetMessage(0)).toEqual({ ok: true, message: 0 });
  });

  it('rejects functions, cycles, non-finite numbers, undefined and oversized payloads', () => {
    expect(validateWidgetMessage({ f: () => 1 }).ok).toBe(false);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(validateWidgetMessage(cyc).ok).toBe(false);
    expect(validateWidgetMessage({ n: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateWidgetMessage(undefined).ok).toBe(false);
    expect(validateWidgetMessage('x'.repeat(MAX_WIDGET_MESSAGE_BYTES + 1)).ok).toBe(false);
  });
});
