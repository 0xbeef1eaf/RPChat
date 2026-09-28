/**
 * Presence sensing (docs/spec/living.md §4): samples the host, derives edge
 * events (`user-idle`/`user-back`, `app-idle`/`app-back`, `battery-low`, `screen-*`,
 * `song-changed`, `window-changed`, `app-launched`) and implements core's `SensesProvider`.
 * Edge detection is pure (`detectEdges`) so it is unit-tested with a fake sampler.
 *
 * Two idle timers run side by side and never reset each other: the **system** one
 * (`idleMs`, keyboard and mouse anywhere on the machine) says whether the user is
 * at the computer at all, and the **app** one (`appIdleMs`, from `AppActivity`) says
 * whether they are still with rpchat — someone can be typing away in another window
 * for an hour, which is `atKeyboard` but not `inApp`.
 */
import type { HostEvent, HostEventName, Json, NowPlaying, PresenceSnapshot } from '@rp/shared';

export interface ActiveWindow {
  title: string;
  app: string;
  class?: string;
}

/** One raw host sample (no derived fields). */
export interface PresenceSample {
  idleMs: number;
  /** Milliseconds since the last interaction with rpchat itself (`AppActivity`). */
  appIdleMs: number;
  screenLocked: boolean | null;
  onBattery: boolean | null;
  batteryPercent: number | null;
  activeWindow: ActiveWindow | null;
  nowPlaying: NowPlaying | null;
}

export interface PresenceSampler {
  sample(): Promise<PresenceSample>;
}

export interface EdgeState {
  idle: boolean;
  /** `idleMs` reported by the last `user-idle` event, so repeats are paced. */
  idleNotifiedMs?: number;
  /** The app timer's own away state, tracked separately from the system one. */
  appIdle: boolean;
  /** `appIdleMs` reported by the last `app-idle` event, so repeats are paced. */
  appIdleNotifiedMs?: number;
  batteryLow: boolean;
  locked: boolean | null;
  windowKey: string | null;
  seenApps: string[];
  songKey: string | null;
  /** False until the first sample has been seen (no change events for the first one). */
  primed: boolean;
}

export interface EdgeOptions {
  idleThresholdMs: number;
  /** When the app timer counts the user as gone from rpchat. Defaults to `idleThresholdMs`. */
  appIdleThresholdMs?: number;
  batteryLowPercent?: number;
  /**
   * How much further the user has to stay idle before `user-idle` is repeated.
   * Subscriptions carry their own `filter.idleMs` and only fire once an event
   * reports at least that much, so one event at the crossing would leave every
   * longer wait ("tell me when they have been away 15 minutes") unfired.
   * `app-idle` is paced the same way.
   */
  idleRepeatMs?: number;
}

/** Default pace of repeated `user-idle` / `app-idle` events while the user stays away. */
export const IDLE_REPEAT_MS = 30_000;

export function initialEdgeState(): EdgeState {
  return { idle: false, appIdle: false, batteryLow: false, locked: null, windowKey: null, seenApps: [], songKey: null, primed: false };
}

/** One idle timer's state: away or not, and the value its last event reported. */
interface IdleTimerState {
  idle: boolean;
  notifiedMs?: number;
}

/** Which timer `idleEdges` is running: the events it raises and the field it reports its number in. */
interface IdleTimerSpec {
  thresholdMs: number;
  repeatMs: number;
  idleEvent: 'user-idle' | 'app-idle';
  backEvent: 'user-back' | 'app-back';
  field: 'idleMs' | 'appIdleMs';
}

/**
 * The edges of one idle timer: the crossing, the paced repeats while the absence lasts (so a
 * subscription waiting for a longer idle than the threshold is reached) and the return. The system
 * timer and the app timer are the same shape over different numbers, and each keeps its own state —
 * coming back to the keyboard does not end an `app-idle`, and using the app ends both.
 */
function idleEdges(state: IdleTimerState, idleMs: number, spec: IdleTimerSpec, at: string): { state: IdleTimerState; events: HostEvent[] } {
  const events: HostEvent[] = [];
  const next: IdleTimerState = { ...state };
  const data = (ms: number): Json => ({ [spec.field]: ms });
  if (!state.idle && idleMs >= spec.thresholdMs) {
    next.idle = true;
    next.notifiedMs = idleMs;
    events.push({ name: spec.idleEvent, data: data(idleMs), at });
  } else if (state.idle && idleMs < spec.thresholdMs) {
    next.idle = false;
    delete next.notifiedMs;
    events.push({ name: spec.backEvent, data: data(idleMs), at });
  } else if (state.idle && idleMs - (state.notifiedMs ?? 0) >= spec.repeatMs) {
    next.notifiedMs = idleMs;
    events.push({ name: spec.idleEvent, data: data(idleMs), at });
  }
  return { state: next, events };
}

export function windowKey(w: ActiveWindow | null): string | null {
  return w ? `${w.app}\u0000${w.title}` : null;
}

export function songKey(n: NowPlaying | null): string | null {
  if (!n || !n.title) return null;
  return `${n.title}\u0000${n.artist ?? ''}\u0000${n.album ?? ''}`;
}

/** Derive edge events from a fresh sample. Pure: returns the new state and the events to emit. */
export function detectEdges(state: EdgeState, sample: PresenceSample, opts: EdgeOptions, at: string): { state: EdgeState; events: HostEvent[] } {
  const events: HostEvent[] = [];
  const next: EdgeState = { ...state, seenApps: [...state.seenApps] };
  const repeatMs = Math.max(1000, opts.idleRepeatMs ?? IDLE_REPEAT_MS);
  const low = opts.batteryLowPercent ?? 20;

  // The two timers, each with its own threshold and its own away state.
  const system = idleEdges({ idle: state.idle, notifiedMs: state.idleNotifiedMs }, sample.idleMs, {
    thresholdMs: Math.max(1000, opts.idleThresholdMs),
    repeatMs,
    idleEvent: 'user-idle',
    backEvent: 'user-back',
    field: 'idleMs',
  }, at);
  next.idle = system.state.idle;
  next.idleNotifiedMs = system.state.notifiedMs;
  events.push(...system.events);

  const appTimer = idleEdges({ idle: state.appIdle, notifiedMs: state.appIdleNotifiedMs }, sample.appIdleMs, {
    thresholdMs: Math.max(1000, opts.appIdleThresholdMs ?? opts.idleThresholdMs),
    repeatMs,
    idleEvent: 'app-idle',
    backEvent: 'app-back',
    field: 'appIdleMs',
  }, at);
  next.appIdle = appTimer.state.idle;
  next.appIdleNotifiedMs = appTimer.state.notifiedMs;
  events.push(...appTimer.events);

  const onBattery = sample.onBattery === true;
  const percent = sample.batteryPercent;
  if (onBattery && percent !== null && percent < low) {
    if (!state.batteryLow) {
      next.batteryLow = true;
      events.push({ name: 'battery-low', data: { percent }, at });
    }
  } else if (state.batteryLow && (!onBattery || (percent !== null && percent >= low))) {
    next.batteryLow = false;
  }

  if (sample.screenLocked !== null) {
    if (state.locked !== null && state.locked !== sample.screenLocked) {
      events.push({ name: sample.screenLocked ? 'screen-locked' : 'screen-unlocked', data: {}, at });
    }
    next.locked = sample.screenLocked;
  }

  const wk = windowKey(sample.activeWindow);
  if (wk !== state.windowKey) {
    next.windowKey = wk;
    if (state.primed && sample.activeWindow) {
      const w = sample.activeWindow;
      events.push({ name: 'window-changed', data: { title: w.title, app: w.app, ...(w.class !== undefined ? { class: w.class } : {}) }, at });
    }
  }
  const app = sample.activeWindow?.app;
  if (app && !state.seenApps.includes(app)) {
    next.seenApps.push(app);
    if (state.primed) events.push({ name: 'app-launched', data: { app }, at });
  }

  const sk = songKey(sample.nowPlaying);
  if (sk !== state.songKey) {
    next.songKey = sk;
    if (state.primed && sample.nowPlaying && sk) events.push({ name: 'song-changed', data: { ...sample.nowPlaying }, at });
  }

  next.primed = true;
  return { state: next, events };
}

export function dayPartOf(date: Date): PresenceSnapshot['dayPart'] {
  const h = date.getHours();
  if (h < 5) return 'night';
  if (h < 8) return 'early-morning';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'late-evening';
}

export function localTimeOf(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  return `${day} ${hh}:${mm}`;
}

/** The two thresholds a snapshot is read against: the machine's and rpchat's own. */
export interface IdleThresholds {
  idleThresholdMs: number;
  appIdleThresholdMs: number;
}

export function toSnapshot(sample: PresenceSample, thresholds: IdleThresholds, now: Date): PresenceSnapshot {
  return {
    at: now.toISOString(),
    idleMs: sample.idleMs,
    atKeyboard: sample.idleMs < Math.max(1000, thresholds.idleThresholdMs),
    appIdleMs: sample.appIdleMs,
    inApp: sample.appIdleMs < Math.max(1000, thresholds.appIdleThresholdMs),
    activeWindow: sample.activeWindow ? { title: sample.activeWindow.title, app: sample.activeWindow.app, ...(sample.activeWindow.class !== undefined ? { class: sample.activeWindow.class } : {}) } : null,
    screenLocked: sample.screenLocked,
    onBattery: sample.onBattery,
    batteryPercent: sample.batteryPercent,
    nowPlaying: sample.nowPlaying,
    sinceLastMessageMs: null,
    localTime: localTimeOf(now),
    dayPart: dayPartOf(now),
  };
}

/** Events the host samples for; others (`time`, `routine-changed`, `custom:*`) are core's. */
export const HOST_SAMPLED_EVENTS: ReadonlySet<HostEventName> = new Set<HostEventName>([
  'user-idle',
  'user-back',
  'app-idle',
  'app-back',
  'window-changed',
  'app-launched',
  'battery-low',
  'screen-locked',
  'screen-unlocked',
  'song-changed',
]);

export interface PresenceProviderOptions {
  sampler: PresenceSampler;
  settings(): Promise<{ pollMs: number } & IdleThresholds>;
  logger: Pick<Console, 'warn' | 'debug'>;
  now?: () => Date;
  /**
   * Called for every event that goes through `push()`, before the listeners see it. The host uses
   * it to keep the app idle timer honest: a click on an avatar or a widget message is the user
   * interacting with rpchat, and only main knows that.
   */
  onPush?(event: HostEvent): void;
  /** Cache window for `snapshot()` so prompt building does not re-run commands every call. Default 1000. */
  snapshotCacheMs?: number;
}

/** Core's `SensesProvider`: on-demand snapshots plus edge events while something subscribes. */
export class PresenceProvider {
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private state = initialEdgeState();
  private timer: NodeJS.Timeout | undefined;
  private interest = new Set<HostEventName>();
  private last: { at: number; sample: PresenceSample } | undefined;
  private sampling: Promise<PresenceSample> | undefined;
  private disposed = false;

  constructor(private readonly o: PresenceProviderOptions) {}

  private now(): Date {
    return (this.o.now ?? (() => new Date()))();
  }

  async snapshot(_sessionId?: string): Promise<PresenceSnapshot> {
    const { idleThresholdMs, appIdleThresholdMs } = await this.o.settings();
    const sample = await this.sample(this.o.snapshotCacheMs ?? 1000);
    return toSnapshot(sample, { idleThresholdMs, appIdleThresholdMs }, this.now());
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Only poll while a live subscription needs a host-sampled event. */
  setInterest(events: HostEventName[]): void {
    this.interest = new Set(events.filter((e) => HOST_SAMPLED_EVENTS.has(e)));
    void this.reschedule();
  }

  /**
   * Re-read the settings. The poll loop captures `pollMs` when it is scheduled,
   * so a changed interval only takes effect once the loop is restarted.
   */
  async refreshSettings(): Promise<void> {
    await this.reschedule();
  }

  get polling(): boolean {
    return this.timer !== undefined;
  }

  /** Push an event from another source (file watcher, Hyprland event socket, overlay pages). */
  push(event: HostEvent): void {
    try {
      this.o.onPush?.(event);
    } catch (err) {
      this.o.logger.warn('[senses] onPush failed', err);
    }
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        this.o.logger.warn('[senses] listener failed', err);
      }
    }
  }

  /** Instant active-window change (Hyprland `activewindow>>`): runs edge detection so a later poll does not repeat it. */
  pushActiveWindow(window: ActiveWindow | null): void {
    const base = this.last?.sample ?? { idleMs: 0, appIdleMs: 0, screenLocked: null, onBattery: null, batteryPercent: null, activeWindow: null, nowPlaying: null };
    const sample: PresenceSample = { ...base, activeWindow: window };
    if (this.last) this.last = { at: this.last.at, sample };
    this.applyEdges(sample, { onlyWindow: true });
  }

  /** Run one poll now (used by tests and by the scheduler). */
  async tick(): Promise<HostEvent[]> {
    const sample = await this.sample(0);
    return this.applyEdges(sample);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  private applyEdges(sample: PresenceSample, opts: { onlyWindow?: boolean } = {}): HostEvent[] {
    const settingsPromise = this.o.settings();
    const at = this.now().toISOString();
    // Edge detection needs the thresholds synchronously; use the last known ones, refreshed asynchronously.
    const thresholds = this.cachedThresholds;
    void settingsPromise
      .then((s) => (this.cachedThresholds = { idleThresholdMs: s.idleThresholdMs, appIdleThresholdMs: s.appIdleThresholdMs }))
      .catch(() => undefined);
    const { state, events } = detectEdges(this.state, sample, thresholds, at);
    this.state = state;
    const out = opts.onlyWindow ? events.filter((e) => e.name === 'window-changed' || e.name === 'app-launched') : events;
    for (const e of out) this.push(e);
    return out;
  }

  private cachedThresholds: IdleThresholds = { idleThresholdMs: 120_000, appIdleThresholdMs: 300_000 };

  private async sample(maxAgeMs: number): Promise<PresenceSample> {
    const nowMs = this.now().getTime();
    if (this.last && nowMs - this.last.at <= maxAgeMs) return this.last.sample;
    if (this.sampling) return this.sampling;
    this.sampling = this.o.sampler
      .sample()
      .then((sample) => {
        this.last = { at: this.now().getTime(), sample };
        return sample;
      })
      .finally(() => {
        this.sampling = undefined;
      });
    return this.sampling;
  }

  private async reschedule(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || this.interest.size === 0) return;
    const { pollMs, idleThresholdMs, appIdleThresholdMs } = await this.o.settings();
    this.cachedThresholds = { idleThresholdMs, appIdleThresholdMs };
    if (this.disposed || this.interest.size === 0) return;
    const loop = async (): Promise<void> => {
      try {
        await this.tick();
      } catch (err) {
        this.o.logger.warn('[senses] sample failed', err);
      }
      if (this.disposed || this.interest.size === 0) {
        this.timer = undefined;
        return;
      }
      this.timer = setTimeout(() => void loop(), Math.max(500, pollMs));
      this.timer.unref?.();
    };
    this.timer = setTimeout(() => void loop(), 0);
    this.timer.unref?.();
  }
}
