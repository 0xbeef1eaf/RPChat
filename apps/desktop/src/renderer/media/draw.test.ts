import { describe, expect, it } from 'vitest';
import { arrowHead, isSafeColor, resolveCoord, resolveShape, resolveShapes } from './draw';

const vp = { width: 1920, height: 1080 };

describe('draw geometry', () => {
  it('resolveCoord treats 0..1 as fractions and larger values as px', () => {
    expect(resolveCoord(0.5, 1920)).toBe(960);
    expect(resolveCoord(1, 1920)).toBe(1920);
    expect(resolveCoord(0, 1920)).toBe(0);
    expect(resolveCoord(300, 1920)).toBe(300);
    expect(resolveCoord(undefined, 1920, 7)).toBe(7);
    expect(resolveCoord(Number.NaN, 1920, 7)).toBe(7);
  });

  it('resolves a fractional rect and an absolute circle', () => {
    const rect = resolveShape({ shapeId: 'r', type: 'rect', x: 0.25, y: 0.5, width: 0.5, height: 100, color: 'lime' }, vp);
    expect(rect.geometry).toEqual({ kind: 'rect', x: 480, y: 540, width: 960, height: 100 });
    expect(rect.color).toBe('lime');
    const circle = resolveShape({ shapeId: 'c', type: 'circle', x: 100, y: 200, radius: 0.1, strokeWidth: 5 }, vp);
    expect(circle.geometry).toEqual({ kind: 'circle', cx: 100, cy: 200, r: 108 });
    expect(circle.strokeWidth).toBe(5);
  });

  it('lines and arrows default the end point to the start and build an arrowhead', () => {
    const line = resolveShape({ shapeId: 'l', type: 'line', x: 10, y: 10 }, vp);
    expect(line.geometry).toEqual({ kind: 'line', x1: 10, y1: 10, x2: 10, y2: 10 });
    const arrow = resolveShape({ shapeId: 'a', type: 'arrow', x: 0, y: 0, x2: 0.5, y2: 0 }, vp);
    expect(arrow.geometry).toMatchObject({ kind: 'arrow', x1: 0, y1: 0, x2: 960, y2: 0 });
    const head = (arrow.geometry as { head: string }).head.split(' ');
    expect(head).toHaveLength(3);
    expect(head[0]).toBe('960,0');
    // head points lie behind the tip (smaller x) and symmetric around the axis
    const [p1x, p1y] = head[1]!.split(',').map(Number);
    const [p2x, p2y] = head[2]!.split(',').map(Number);
    expect(p1x).toBeLessThan(960);
    expect(p1x).toBeCloseTo(p2x!, 5);
    expect(p1y).toBeCloseTo(-p2y!, 5);
  });

  it('arrowHead for a vertical arrow', () => {
    const pts = arrowHead(0, 0, 0, 100, 10).split(' ');
    expect(pts[0]).toBe('0,100');
    for (const p of pts.slice(1)) expect(Number(p.split(',')[1])).toBeLessThan(100);
  });

  it('text uses defaults for missing values and keeps durationMs', () => {
    const t = resolveShape({ shapeId: 't', type: 'text', x: 0.1, y: 0.9, text: 'look here', durationMs: 3000 }, vp);
    expect(t.geometry).toEqual({ kind: 'text', x: 192, y: 972, text: 'look here', fontSize: 18 });
    expect(t.color).toBe('#ff3b30');
    expect(t.durationMs).toBe(3000);
    expect(resolveShapes([], vp)).toEqual([]);
  });

  it('isSafeColor accepts colours and rejects attribute injection', () => {
    expect(isSafeColor('#fff')).toBe(true);
    expect(isSafeColor('rgba(255, 0, 0, 0.5)')).toBe(true);
    expect(isSafeColor('tomato')).toBe(true);
    expect(isSafeColor('red" onload="alert(1)')).toBe(false);
    expect(isSafeColor('url(javascript:x)')).toBe(false);
  });
});
