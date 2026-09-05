/** Wires the presence provider, samplers and directory watcher (Electron side). */
import { powerMonitor } from 'electron';
import type { AppSettings, HostEvent } from '@rp/shared';
import type { Logger } from '@rp/core';
import type { CommandRunner } from '../capabilities/commands-runner.js';
import type { HyprTransport } from '../display/hyprland.js';
import { PresenceProvider } from './presence.js';
import { CompositeSampler, activeWindowSource, nowPlayingSource, parseHyprActiveWindowEvent, readLinuxBatteryPercent } from './samplers.js';
import { DirWatcher } from './watch.js';

export interface SensesDeps {
  settings(): Promise<AppSettings>;
  commands: CommandRunner;
  hypr?: HyprTransport;
  logger: Logger;
  platform?: NodeJS.Platform;
}

export interface Senses {
  provider: PresenceProvider;
  watcher: DirWatcher;
  /** Re-read `settings.senses` (watch dirs). */
  refresh(): Promise<void>;
  dispose(): Promise<void>;
}

export function createSenses(deps: SensesDeps): Senses {
  const platform = deps.platform ?? process.platform;
  let locked: boolean | null = null;
  const sampler = new CompositeSampler(
    {
      idleMs: () => powerMonitor.getSystemIdleTime() * 1000,
      screenLocked: () => locked,
      onBattery: () => (platform === 'linux' || platform === 'win32' || platform === 'darwin' ? powerMonitor.isOnBatteryPower() : null),
      batteryPercent: () => (platform === 'linux' ? readLinuxBatteryPercent() : null),
      activeWindow: activeWindowSource({ commands: deps.commands, ...(deps.hypr ? { hypr: deps.hypr } : {}) }),
      nowPlaying: nowPlayingSource(deps.commands),
    },
    deps.logger,
  );
  const provider = new PresenceProvider({
    sampler,
    settings: async () => {
      const s = await deps.settings();
      return { pollMs: s.senses.pollMs, idleThresholdMs: s.senses.idleThresholdMs };
    },
    logger: deps.logger,
  });
  const emit = (event: HostEvent): void => provider.push(event);
  const onLock = (): void => {
    locked = true;
    emit({ name: 'screen-locked', data: {}, at: new Date().toISOString() });
  };
  const onUnlock = (): void => {
    locked = false;
    emit({ name: 'screen-unlocked', data: {}, at: new Date().toISOString() });
  };
  try {
    powerMonitor.on('lock-screen', onLock);
    powerMonitor.on('unlock-screen', onUnlock);
  } catch (err) {
    deps.logger.debug('[senses] powerMonitor lock events unavailable', err);
  }
  let offHypr: (() => void) | undefined;
  if (deps.hypr?.subscribe) {
    try {
      offHypr = deps.hypr.subscribe((event, data) => {
        if (event === 'activewindow') provider.pushActiveWindow(parseHyprActiveWindowEvent(data));
      });
    } catch (err) {
      deps.logger.debug('[senses] Hyprland event socket unavailable', err);
    }
  }
  const watcher = new DirWatcher({ emit, logger: deps.logger });
  const refresh = async (): Promise<void> => {
    const s = await deps.settings();
    watcher.setDirs(s.senses.watchDirs);
  };
  return {
    provider,
    watcher,
    refresh,
    async dispose() {
      offHypr?.();
      try {
        powerMonitor.off('lock-screen', onLock);
        powerMonitor.off('unlock-screen', onUnlock);
      } catch {
        /* ignore */
      }
      watcher.dispose();
      await provider.dispose();
    },
  };
}
