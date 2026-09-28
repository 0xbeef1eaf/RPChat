import { describe, expect, it } from 'vitest';
import { APP_INTERACTION_EVENTS, AppActivity } from './app-activity.js';
import { PresenceProvider } from './presence.js';
import type { PresenceSample } from './presence.js';

const silent = { warn: () => undefined, debug: () => undefined };

describe('AppActivity', () => {
  it('counts from the last interaction, and from the app start when there has been none', () => {
    let now = 1000;
    const activity = new AppActivity({ now: () => now });
    now += 45_000;
    expect(activity.idleMs()).toBe(45_000);
    expect(activity.reason).toBe('app started');

    activity.mark('message sent');
    expect(activity.idleMs()).toBe(0);
    expect(activity.reason).toBe('message sent');
    now += 90_000;
    expect(activity.idleMs()).toBe(90_000);

    // The two timers are unrelated: nothing here looks at the machine's idle time.
    activity.mark('input in the app');
    expect(activity.idleMs()).toBe(0);
  });

  it('marks only the events that are the user reaching for the app', () => {
    const activity = new AppActivity({ now: () => 0 });
    expect(activity.markFromEvent('avatar-clicked')).toBe(true);
    expect(activity.markFromEvent('chat-shown')).toBe(true);
    expect(activity.markFromEvent('media-clicked')).toBe(true);
    // A queued image opening on its own, a video ending, the user leaving: none of them is a click.
    expect(activity.markFromEvent('media-started')).toBe(false);
    expect(activity.markFromEvent('media-closed')).toBe(false);
    expect(activity.markFromEvent('chat-hidden')).toBe(false);
    expect(activity.markFromEvent('user-idle')).toBe(false);
    expect(APP_INTERACTION_EVENTS.has('widget-message')).toBe(true);
  });
});

describe('PresenceProvider + AppActivity', () => {
  it('reads the app timer through the sampler, and marks it from pushed interactions', async () => {
    let now = 0;
    const activity = new AppActivity({ now: () => now });
    const sample = (): PresenceSample => ({
      idleMs: 0,
      appIdleMs: activity.idleMs(),
      screenLocked: null,
      onBattery: null,
      batteryPercent: null,
      activeWindow: null,
      nowPlaying: null,
    });
    const provider = new PresenceProvider({
      sampler: { sample: async () => sample() },
      settings: async () => ({ pollMs: 5000, idleThresholdMs: 120_000, appIdleThresholdMs: 300_000 }),
      logger: silent,
      now: () => new Date(now),
      snapshotCacheMs: 0,
      onPush: (event) => void activity.markFromEvent(event.name),
    });

    now = 400_000;
    expect(await provider.snapshot()).toMatchObject({ appIdleMs: 400_000, inApp: false });

    // A click on the character's avatar arrives as a host event: that is the user, in the app.
    provider.push({ name: 'avatar-clicked', data: {}, at: new Date(now).toISOString() });
    now += 1;
    expect(await provider.snapshot()).toMatchObject({ appIdleMs: 1, inApp: true });

    // A video ending by itself is not.
    now += 310_000;
    provider.push({ name: 'media-closed', data: { reason: 'ended' }, at: new Date(now).toISOString() });
    expect(await provider.snapshot()).toMatchObject({ appIdleMs: 310_001, inApp: false });
    await provider.dispose();
  });
});
