import { describe, expect, it } from 'vitest';
import type { MonitorInfo } from '@rp/shared';
import { placeOverlay, resolvePlacement, selectMonitor, setRandomSource } from './placement.js';
import { applyOverlayUpdate, nearestLayer, resolveOverlayOptions, setRandomSource as setBackendRandomSource, visualPatch } from './backend.js';

const primary: MonitorInfo = { id: '1', name: 'DP-1', index: 0, primary: true, x: 0, y: 30, width: 1920, height: 1050, scale: 1, hasCursor: false };
const second: MonitorInfo = { id: '2', name: 'HDMI-A-1', index: 1, primary: false, x: 1920, y: 0, width: 1280, height: 720, scale: 1, hasCursor: true };
const monitors = [primary, second];

describe('selectMonitor', () => {
  it('resolves every selector form and falls back to primary', () => {
    expect(selectMonitor(undefined, monitors)).toBe(primary);
    expect(selectMonitor('primary', monitors)).toBe(primary);
    expect(selectMonitor('cursor', monitors)).toBe(second);
    expect(selectMonitor(1, monitors)).toBe(second);
    expect(selectMonitor('hdmi-a-1', monitors)).toBe(second);
    expect(selectMonitor('2', monitors)).toBe(second);
    expect(selectMonitor('nope', monitors)).toBe(primary);
    expect(selectMonitor(7, monitors)).toBe(primary);
    expect(() => selectMonitor('primary', [])).toThrow();
  });

  it("'random' draws one of the connected monitors from the injectable source, clamped to the list", () => {
    setRandomSource(() => 0.75);
    expect(selectMonitor('random', monitors)).toBe(second);
    setRandomSource(() => 0.25);
    expect(selectMonitor('random', monitors)).toBe(primary);
    setRandomSource(() => 1);
    expect(selectMonitor('random', monitors)).toBe(second);
    setRandomSource(() => Number.NaN);
    expect(selectMonitor('random', monitors)).toBe(primary);
    setRandomSource(() => -3);
    expect(selectMonitor('random', monitors)).toBe(primary);
    setRandomSource(() => 0.99);
    expect(selectMonitor('random', [primary])).toBe(primary);
    // The backend re-exports the same setter, so either import seeds the one source.
    setBackendRandomSource(() => 0.75);
    expect(selectMonitor('random', monitors)).toBe(second);
    setRandomSource(() => 0.25);
  });
});

describe('resolvePlacement', () => {
  it('anchors presets with the margin inside the work area', () => {
    expect(resolvePlacement({ position: 'bottom-right' }, monitors, { width: 480, height: 320 }).bounds).toEqual({ x: 1920 - 480 - 24, y: 30 + 1050 - 320 - 24, width: 480, height: 320 });
    expect(resolvePlacement({ position: 'top-left', marginPx: 0 }, monitors, { width: 100, height: 100 }).bounds).toEqual({ x: 0, y: 30, width: 100, height: 100 });
    expect(resolvePlacement({ position: 'center' }, monitors, { width: 400, height: 300 }).bounds).toEqual({ x: 760, y: 30 + 375, width: 400, height: 300 });
    expect(resolvePlacement({}, monitors, { width: 400, height: 300 }, { x: 0.5, y: 0.5 }).bounds).toEqual({ x: 24 + Math.round(0.5 * (1920 - 400 - 48)), y: 30 + 24 + Math.round(0.5 * (1050 - 300 - 48)), width: 400, height: 300 });
  });

  it('treats x/y in 0..1 as fractions and > 1 as pixels, clamped to the monitor', () => {
    const { bounds } = resolvePlacement({ monitor: 'cursor', x: 0.5, y: 0.5 }, monitors, { width: 200, height: 100 });
    expect(bounds).toEqual({ x: 1920 + 640, y: 360, width: 200, height: 100 });
    expect(resolvePlacement({ x: 5000, y: 5000 }, monitors, { width: 200, height: 100 }).bounds).toEqual({ x: 1720, y: 30 + 950, width: 200, height: 100 });
    expect(resolvePlacement({ x: 100 }, monitors, { width: 200, height: 100 }).bounds.y).toBe(30 + 475);
  });

  it('prefers explicit width/height over the content size and never exceeds the monitor', () => {
    expect(resolvePlacement({ width: 300, height: 200 }, monitors, { width: 800, height: 600 }).bounds).toMatchObject({ width: 300, height: 200 });
    expect(resolvePlacement({ width: 9000 }, monitors, { width: 10, height: 9000 }).bounds).toMatchObject({ x: 0, y: 30, width: 1920, height: 1050 });
    expect(resolvePlacement({}, monitors, { width: 0, height: -1 }).bounds).toMatchObject({ width: 480, height: 320 });
  });
});

describe('resolveOverlayOptions / applyOverlayUpdate', () => {
  it('applies defaults and validates', () => {
    // Without a monitor the overlay lands on a random one (seed 0.25 → first of two), at a random spot.
    setRandomSource(() => 0.25);
    const r = resolveOverlayOptions(undefined, monitors, { layer: 'top' });
    expect(r).toEqual({ monitor: primary, layer: 'top', opacity: 1, clickThrough: false, anchor: 'random', marginPx: 24, width: 480, randomSeed: { x: 0.25, y: 0.25 } });
    setRandomSource(() => 0.75);
    expect(resolveOverlayOptions(undefined, monitors, { layer: 'top' })).toEqual({ monitor: second, layer: 'top', opacity: 1, clickThrough: false, anchor: 'random', marginPx: 24, width: 480, randomSeed: { x: 0.75, y: 0.75 } });
    expect(resolveOverlayOptions({}, monitors, { layer: 'top' }).monitor).toBe(second);
    // An explicit selector pins the monitor regardless of the seed.
    expect(resolveOverlayOptions({ monitor: 'primary' }, monitors, { layer: 'top' })).toMatchObject({ monitor: primary, anchor: 'random', randomSeed: { x: 0.75, y: 0.75 } });
    expect(resolveOverlayOptions({ monitor: 'cursor' }, monitors, { layer: 'top' }).monitor).toBe(second);
    setRandomSource(() => 0.25);
    expect(resolveOverlayOptions({ monitor: 'cursor' }, monitors, { layer: 'top' }).monitor).toBe(second);
    expect(resolveOverlayOptions({ monitor: 'random' }, monitors, { layer: 'top' }).monitor).toBe(primary);
    expect(resolveOverlayOptions({ position: 'center' }, monitors, { layer: 'top' }).randomSeed).toBeUndefined();
    expect(resolveOverlayOptions({ x: 10 }, monitors, { layer: 'top' }).randomSeed).toBeUndefined();
    const r2 = resolveOverlayOptions({ layer: 'background', opacity: 2, clickThrough: true, position: 'top-right', x: 0.25, y: 300, width: 640, height: 0, monitor: 'cursor' }, monitors, { layer: 'bottom' });
    expect(r2).toEqual({ monitor: second, layer: 'background', opacity: 1, clickThrough: true, anchor: 'top-right', marginPx: 24, width: 640, x: 320, y: 300 });
    expect(resolveOverlayOptions({ layer: 'weird' as never, opacity: -1 }, monitors, { layer: 'bottom' })).toMatchObject({ layer: 'bottom', opacity: 0 });
  });

  it('merges updates, re-resolving the monitor and clearing offsets on a new preset', () => {
    const base = resolveOverlayOptions({ x: 10, y: 10 }, monitors, { layer: 'top' });
    const moved = applyOverlayUpdate(base, { position: 'bottom-left', monitor: 1, opacity: 0.5 }, monitors);
    expect(moved).toMatchObject({ monitor: second, anchor: 'bottom-left', opacity: 0.5 });
    expect(moved.x).toBeUndefined();
    expect(placeOverlay(moved, { width: 100, height: 50 })).toEqual({ x: 1920 + 24, y: 720 - 50 - 24, width: 100, height: 50 });
    expect(visualPatch({ opacity: 0.3, layer: 'top', width: 100, monitor: 2 })).toEqual({ opacity: 0.3, width: 100 });
  });

  it("an update with monitor 'random' re-draws the monitor; other updates keep it", () => {
    setRandomSource(() => 0.25);
    const base = resolveOverlayOptions({ position: 'top-left' }, monitors, { layer: 'top' });
    expect(base.monitor).toBe(primary);
    setRandomSource(() => 0.75);
    expect(applyOverlayUpdate(base, { opacity: 0.5 }, monitors).monitor).toBe(primary);
    const redrawn = applyOverlayUpdate(base, { monitor: 'random' }, monitors);
    expect(redrawn).toMatchObject({ monitor: second, anchor: 'top-left', layer: 'top' });
    setRandomSource(() => 0.25);
    expect(applyOverlayUpdate(redrawn, { monitor: 'random' }, monitors).monitor).toBe(primary);
    expect(applyOverlayUpdate(redrawn, { monitor: 'primary' }, monitors).monitor).toBe(primary);
  });
});

describe('nearestLayer', () => {
  it('keeps supported layers and degrades to the nearest one', () => {
    expect(nearestLayer('background', ['bottom', 'top', 'overlay'])).toBe('bottom');
    expect(nearestLayer('background', ['top', 'overlay'])).toBe('top');
    expect(nearestLayer('bottom', ['top', 'overlay'])).toBe('top');
    expect(nearestLayer('overlay', ['top'])).toBe('top');
    expect(nearestLayer(undefined, ['bottom', 'top'])).toBe('top');
    expect(nearestLayer('overlay', ['background', 'bottom', 'top', 'overlay'])).toBe('overlay');
  });
});

describe('random default placement', () => {
  const mon: MonitorInfo = { id: '0', name: 'M', index: 0, primary: true, x: 100, y: 50, width: 1920, height: 1080, scale: 1, hasCursor: true };

  it('stays fully on the monitor for every seed and size, and is stable across content-size updates', () => {
    for (const seed of [0, 0.001, 0.5, 0.999, 1, 7, -2, Number.NaN]) {
      for (const size of [{ width: 400, height: 300 }, { width: 1920, height: 1080 }, { width: 5000, height: 20 }, { width: 10, height: 4000 }]) {
        const b = placeOverlay({ monitor: mon, anchor: 'random', marginPx: 24, randomSeed: { x: seed, y: seed } }, size);
        expect(b.x).toBeGreaterThanOrEqual(mon.x);
        expect(b.y).toBeGreaterThanOrEqual(mon.y);
        expect(b.x + b.width).toBeLessThanOrEqual(mon.x + mon.width);
        expect(b.y + b.height).toBeLessThanOrEqual(mon.y + mon.height);
      }
    }
    const input = { monitor: mon, anchor: 'random' as const, marginPx: 24, randomSeed: { x: 0, y: 1 } };
    expect(placeOverlay(input, { width: 400, height: 300 })).toEqual({ x: 124, y: 50 + 1080 - 300 - 24, width: 400, height: 300 });
    // Same seed, bigger content (as reported later by the page): the corner keeps its side, still in bounds.
    expect(placeOverlay(input, { width: 800, height: 600 })).toEqual({ x: 124, y: 50 + 1080 - 600 - 24, width: 800, height: 600 });
    // No seed → centre.
    expect(placeOverlay({ monitor: mon, anchor: 'random', marginPx: 24 }, { width: 400, height: 300 })).toEqual({ x: 100 + 760, y: 50 + 390, width: 400, height: 300 });
  });

  it('resolvePlacement defaults to random with a supplied seed and honours presets', () => {
    const monitors = [mon];
    const r = resolvePlacement({}, monitors, { width: 200, height: 100 }, { x: 1, y: 0 });
    expect(r.bounds).toEqual({ x: 100 + 1920 - 200 - 24, y: 50 + 24, width: 200, height: 100 });
    expect(resolvePlacement({ position: 'center' }, monitors, { width: 200, height: 100 }, { x: 1, y: 0 }).bounds).toEqual({ x: 100 + 860, y: 50 + 490, width: 200, height: 100 });
  });

  it('a new random preset in an update draws a fresh seed; explicit x/y drop it', () => {
    setRandomSource(() => 0.75);
    const base = resolveOverlayOptions({ position: 'top-left' }, monitors, { layer: 'top' });
    const rnd = applyOverlayUpdate(base, { position: 'random' }, monitors);
    expect(rnd).toMatchObject({ anchor: 'random', randomSeed: { x: 0.75, y: 0.75 } });
    const explicit = applyOverlayUpdate(rnd, { x: 5, y: 5 }, monitors);
    expect(explicit).toMatchObject({ x: 5, y: 5 });
  });
});
