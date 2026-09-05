/** Pure state for the `avatar` overlay page. */
import type { AvatarAnimation, AvatarState, MediaCommand, MediaItemId } from '@rp/shared';

export interface AvatarPageState {
  id: MediaItemId;
  state: AvatarState;
  /** Last requested one-shot animation; `nonce` changes so the same animation can replay. */
  animation: { name: AvatarAnimation; nonce: number } | null;
  /** Visual overrides applied by `avatar-set` on top of `state.overlay`. */
  opacity: number;
  clickThrough: boolean;
}

export type AvatarCommand = Extract<MediaCommand, { type: 'avatar-show' | 'avatar-set' | 'avatar-hide' }>;

export function isAvatarCommand(command: MediaCommand): command is AvatarCommand {
  return command.type === 'avatar-show' || command.type === 'avatar-set' || command.type === 'avatar-hide';
}

/** Returns the next avatar page state (null = hidden) and whether a `closed` report is due. */
export function applyAvatarCommand(current: AvatarPageState | null, command: AvatarCommand): { avatar: AvatarPageState | null; closed: boolean } {
  switch (command.type) {
    case 'avatar-show':
      return {
        avatar: {
          id: command.id,
          state: { ...command.state, visible: true },
          animation: current && current.id === command.id ? current.animation : null,
          opacity: command.state.overlay?.opacity ?? 1,
          clickThrough: command.state.overlay?.clickThrough ?? false,
        },
        closed: false,
      };
    case 'avatar-set': {
      if (!current || current.id !== command.id) return { avatar: current, closed: false };
      const { animation, opacity, clickThrough, ...patch } = command.patch;
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<AvatarState>;
      return {
        avatar: {
          ...current,
          state: { ...current.state, ...defined },
          animation: animation ? { name: animation, nonce: (current.animation?.nonce ?? 0) + 1 } : current.animation,
          opacity: opacity ?? current.opacity,
          clickThrough: clickThrough ?? current.clickThrough,
        },
        closed: false,
      };
    }
    case 'avatar-hide':
      if (!current || current.id !== command.id) return { avatar: current, closed: false };
      return { avatar: null, closed: true };
    default:
      return { avatar: current, closed: false };
  }
}

/** Milliseconds until a speech bubble expires (null = no bubble or no expiry). */
export function bubbleRemainingMs(bubble: AvatarState['bubble'], now: number): number | null {
  if (!bubble || !bubble.until) return null;
  const t = Date.parse(bubble.until);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now);
}

/**
 * Subtle tilt/shift toward the cursor for `lookAtCursor`. Inputs are the avatar's
 * centre and the cursor in the same coordinate space; output is clamped.
 */
export function lookTransform(
  center: { x: number; y: number },
  cursor: { x: number; y: number } | null,
  maxTiltDeg = 6,
  maxShiftPx = 6,
): { rotate: number; dx: number; dy: number } {
  if (!cursor) return { rotate: 0, dx: 0, dy: 0 };
  const dx = cursor.x - center.x;
  const dy = cursor.y - center.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return { rotate: 0, dx: 0, dy: 0 };
  const nx = dx / dist;
  const ny = dy / dist;
  const strength = Math.min(1, dist / 400);
  const round = (v: number) => Math.round(v * 100) / 100;
  return { rotate: round(nx * maxTiltDeg * strength), dx: round(nx * maxShiftPx * strength), dy: round(ny * maxShiftPx * strength) };
}
