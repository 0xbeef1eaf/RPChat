/** Pure helpers shared by the display backends (no Electron dependency). */
import type { DisplayBackendInfo, OverlayLayer } from '@rp/shared';

export type WindowSystem = DisplayBackendInfo['windowSystem'];

export const LAYER_ORDER: readonly OverlayLayer[] = ['background', 'bottom', 'top', 'overlay'];

export function isOverlayLayer(v: unknown): v is OverlayLayer {
  return typeof v === 'string' && (LAYER_ORDER as readonly string[]).includes(v);
}

/** The requested layer when supported, otherwise the nearest supported one (ties prefer the higher layer). */
export function nearestLayer(requested: OverlayLayer | undefined, supported: readonly OverlayLayer[]): OverlayLayer {
  const wanted = requested && isOverlayLayer(requested) ? requested : 'top';
  if (supported.includes(wanted)) return wanted;
  if (supported.length === 0) return wanted;
  const idx = LAYER_ORDER.indexOf(wanted);
  let best: OverlayLayer = supported[0] as OverlayLayer;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const layer of supported) {
    const d = Math.abs(LAYER_ORDER.indexOf(layer) - idx);
    if (d < bestDist || (d === bestDist && LAYER_ORDER.indexOf(layer) > LAYER_ORDER.indexOf(best))) {
      best = layer;
      bestDist = d;
    }
  }
  return best;
}

export function clampOpacity(v: unknown, fallback = 1): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

export function isHyprland(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.HYPRLAND_INSTANCE_SIGNATURE === 'string' && env.HYPRLAND_INSTANCE_SIGNATURE.length > 0;
}

/** `wayland` / `x11` on Linux from `WAYLAND_DISPLAY` / `XDG_SESSION_TYPE` / `DISPLAY`; `native` on Windows and macOS. */
export function detectWindowSystem(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): WindowSystem {
  if (platform === 'win32' || platform === 'darwin') return 'native';
  const sessionType = (env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (isHyprland(env) || env.WAYLAND_DISPLAY || sessionType === 'wayland') return 'wayland';
  if (sessionType === 'x11' || env.DISPLAY) return 'x11';
  return 'unknown';
}
