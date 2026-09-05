import { describe, expect, it } from 'vitest';
import type { AvatarState } from '@rp/shared';
import { applyAvatarCommand, bubbleRemainingMs, lookTransform } from './avatar';

const base: AvatarState = {
  visible: true,
  expression: 'neutral',
  imageUrl: 'rp-asset://com.example.pack/characters/luna/neutral.png',
  size: 240,
  lookAtCursor: false,
  overlay: { layer: 'top', opacity: 0.9, clickThrough: false },
};

describe('avatar page reducer', () => {
  it('show creates the page state with overlay visuals', () => {
    const r = applyAvatarCommand(null, { type: 'avatar-show', id: 'av', state: base });
    expect(r.closed).toBe(false);
    expect(r.avatar).toMatchObject({ id: 'av', opacity: 0.9, clickThrough: false, animation: null });
    expect(r.avatar?.state.visible).toBe(true);
  });

  it('set merges defined patch keys, bumps the animation nonce and keeps unrelated fields', () => {
    const shown = applyAvatarCommand(null, { type: 'avatar-show', id: 'av', state: base }).avatar;
    const r1 = applyAvatarCommand(shown, { type: 'avatar-set', id: 'av', patch: { expression: 'happy', animation: 'bounce', opacity: 0.5 } });
    expect(r1.avatar?.state).toMatchObject({ expression: 'happy', size: 240, imageUrl: base.imageUrl });
    expect(r1.avatar?.animation).toEqual({ name: 'bounce', nonce: 1 });
    expect(r1.avatar?.opacity).toBe(0.5);
    const r2 = applyAvatarCommand(r1.avatar, { type: 'avatar-set', id: 'av', patch: { animation: 'bounce', bubble: { text: 'hi' }, imageUrl: undefined } });
    expect(r2.avatar?.animation).toEqual({ name: 'bounce', nonce: 2 });
    expect(r2.avatar?.state.bubble).toEqual({ text: 'hi' });
    expect(r2.avatar?.state.imageUrl).toBe(base.imageUrl);
    expect(r2.avatar?.opacity).toBe(0.5);
  });

  it('set/hide for another id or when hidden are no-ops', () => {
    expect(applyAvatarCommand(null, { type: 'avatar-set', id: 'x', patch: { expression: 'sad' } })).toEqual({ avatar: null, closed: false });
    const shown = applyAvatarCommand(null, { type: 'avatar-show', id: 'av', state: base }).avatar;
    expect(applyAvatarCommand(shown, { type: 'avatar-hide', id: 'other' })).toEqual({ avatar: shown, closed: false });
  });

  it('hide clears the page and requests a closed report', () => {
    const shown = applyAvatarCommand(null, { type: 'avatar-show', id: 'av', state: base }).avatar;
    expect(applyAvatarCommand(shown, { type: 'avatar-hide', id: 'av' })).toEqual({ avatar: null, closed: true });
  });

  it('bubbleRemainingMs', () => {
    const now = Date.parse('2026-05-01T12:00:00Z');
    expect(bubbleRemainingMs(undefined, now)).toBeNull();
    expect(bubbleRemainingMs({ text: 'x' }, now)).toBeNull();
    expect(bubbleRemainingMs({ text: 'x', until: '2026-05-01T12:00:05Z' }, now)).toBe(5000);
    expect(bubbleRemainingMs({ text: 'x', until: '2026-05-01T11:00:00Z' }, now)).toBe(0);
    expect(bubbleRemainingMs({ text: 'x', until: 'garbage' }, now)).toBeNull();
  });

  it('lookTransform tilts toward the cursor and is clamped', () => {
    expect(lookTransform({ x: 100, y: 100 }, null)).toEqual({ rotate: 0, dx: 0, dy: 0 });
    const right = lookTransform({ x: 100, y: 100 }, { x: 1000, y: 100 });
    expect(right.rotate).toBe(6);
    expect(right.dx).toBe(6);
    expect(right.dy).toBe(0);
    const near = lookTransform({ x: 100, y: 100 }, { x: 100, y: 300 });
    expect(near.rotate).toBe(0);
    expect(near.dy).toBe(3);
    expect(lookTransform({ x: 0, y: 0 }, { x: -800, y: 0 }).rotate).toBe(-6);
  });
});
