/**
 * Display backend abstraction (docs/spec/overlay.md §1). This module has no
 * Electron dependency: the `electron` backend receives the `screen` module
 * through `BackendDeps`, so everything here is unit-testable in plain Node.
 */
import type { AppSettings, DisplayBackendInfo, MonitorInfo, OverlayLayer, OverlayUpdate } from '@rp/shared';
import { detectWindowSystem, isHyprland } from './layers.js';
import type { Bounds } from './placement.js';
import { ElectronBackend } from './electron.js';
import type { ScreenLike } from './electron.js';
import { HyprlandBackend, createHyprTransport } from './hyprland.js';
import type { HyprTransport } from './hyprland.js';

/** What a backend manipulates: a BrowserWindow behind an interface (fakeable in tests). */
export interface OverlayWindowLike {
  id: string;
  title: string;
  setBounds(b: Bounds): void;
  getBounds(): Bounds;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setIgnoreMouseEvents(ignore: boolean, opts?: { forward?: boolean }): void;
  /** Electron: Windows/macOS only; no-op on Linux. */
  setOpacity(v: number): void;
  setFocusable(flag: boolean): void;
  show(): void;
  hide(): void;
  blur(): void;
  isDestroyed(): boolean;
}

/** After defaults + monitor resolution + fallbacks. */
export interface ResolvedOverlayOptions {
  monitor: MonitorInfo;
  layer: OverlayLayer;
  opacity: number;
  clickThrough: boolean;
  /** Absolute logical px. */
  bounds: Bounds;
}

export interface DisplayBackend {
  info(): DisplayBackendInfo;
  monitors(): Promise<MonitorInfo[]>;
  /** Called after the window is created and shown; applies every option. Idempotent. */
  apply(win: OverlayWindowLike, opts: ResolvedOverlayOptions): Promise<void>;
  /** Live change (subset: layer / opacity / clickThrough / width / height). Placement changes go through `apply`. */
  update(win: OverlayWindowLike, patch: OverlayUpdate): Promise<void>;
  /** Forget per-window state (called when an overlay window is destroyed). */
  forget?(win: OverlayWindowLike): void;
  dispose(): Promise<void>;
}

export type { WindowSystem } from './layers.js';
export { LAYER_ORDER, isOverlayLayer, nearestLayer, clampOpacity, isHyprland, detectWindowSystem } from './layers.js';

export interface BackendDeps {
  screen: ScreenLike;
  platform?: NodeJS.Platform;
  logger?: Pick<Console, 'info' | 'warn' | 'debug'>;
  /** Injected Hyprland transport (tests); default: socket with CLI fallback. */
  hyprTransport?: HyprTransport;
}

/** Choose the backend for the `displayBackend` setting (`auto` → hyprland when running under Hyprland). */
export function selectBackend(setting: AppSettings['displayBackend'], env: NodeJS.ProcessEnv = process.env, deps: BackendDeps): DisplayBackend {
  const platform = deps.platform ?? process.platform;
  const useHyprland = setting === 'hyprland' || (setting !== 'electron' && platform === 'linux' && isHyprland(env));
  if (useHyprland) {
    const transport = deps.hyprTransport ?? createHyprTransport(env);
    return new HyprlandBackend(transport, { logger: deps.logger });
  }
  return new ElectronBackend(deps.screen, { platform, windowSystem: detectWindowSystem(env, platform), logger: deps.logger });
}
