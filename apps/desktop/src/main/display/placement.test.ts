import { describe, expect, it } from 'vitest';
import type { MonitorInfo } from '@rp/shared';
import { placeOverlay, resolvePlacement, selectMonitor } from './placement.js';
import { applyOverlayUpdate, nearestLayer, resolveOverlayOptions, visualPatch } from './backend.js';

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
});

describe('resolvePlacement', () => {
  it('anchors presets with the margin inside the work area', () => {
    expect(resolvePlacement({ position: 'bottom-right' }, monitors, { width: 480, height: 320 }).bounds).toEqual({ x: 1920 - 480 - 24, y: 30 + 1050 - 320 - 24, width: 480, height: 320 });
    expect(resolvePlacement({ position: 'top-left', marginPx: 0 }, monitors, { width: 100, height: 100 }).bounds).toEqual({ x: 0, y: 30, width: 100, height: 100 });
    expect(resolvePlacement({}, monitors, { width: 400, height: 300 }).bounds).toEqual({ x: 760, y: 30 + 375, width: 400, height: 300 });
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
    const r = resolveOverlayOptions(undefined, monitors, { layer: 'top' });
    expect(r).toEqual({ monitor: primary, layer: 'top', opacity: 1, clickThrough: false, anchor: 'center', marginPx: 24, width: 480 });
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
