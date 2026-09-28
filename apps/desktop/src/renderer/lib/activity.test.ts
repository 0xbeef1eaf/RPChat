import { describe, expect, it } from 'vitest';
import { ACTIVITY_THROTTLE_MS, createActivityReporter, trackAppActivity } from './activity';
import type { ActivityKind, ActivityTarget } from './activity';

/** A window stand-in: remembers what was listened on and lets a test fire it. */
class FakeTarget implements ActivityTarget {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
  get count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

describe('createActivityReporter', () => {
  it('sends the first report and throttles the rest of the burst', () => {
    let now = 0;
    const sent: ActivityKind[] = [];
    const report = createActivityReporter({ send: (kind) => sent.push(kind), now: () => now, throttleMs: 2000 });

    expect(report('input')).toBe(true);
    // Typing a sentence is one ping, not one per key.
    now = 500;
    expect(report('input')).toBe(false);
    now = 1999;
    expect(report('input')).toBe(false);
    now = 2000;
    expect(report('focus')).toBe(true);
    expect(sent).toEqual(['input', 'focus']);
    expect(ACTIVITY_THROTTLE_MS).toBe(2000);
  });
});

describe('trackAppActivity', () => {
  it('reports keys, clicks, wheel and focus — not mouse movement — and unhooks on stop', () => {
    let now = 0;
    const sent: ActivityKind[] = [];
    const target = new FakeTarget();
    const stop = trackAppActivity(target, { send: (kind) => sent.push(kind), now: () => now });

    target.fire('keydown');
    now += 5000;
    target.fire('pointerdown');
    now += 5000;
    target.fire('wheel');
    now += 5000;
    target.fire('focus');
    // A cursor drifting over the window, or a nudged desk, is not someone reading the conversation.
    now += 5000;
    target.fire('mousemove');
    expect(sent).toEqual(['input', 'input', 'input', 'focus']);

    stop();
    expect(target.count).toBe(0);
    now += 5000;
    target.fire('keydown');
    expect(sent).toHaveLength(4);
  });
});
