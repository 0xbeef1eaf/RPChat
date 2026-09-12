/**
 * `sdk.ui.notify` urgency: what a character asks for has to reach the OS notification, and a
 * value it made up must not make it louder than `normal`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '@rp/shared';
import { PendingPrompts } from '../prompts.js';
import { UiHandler, notificationOptions, urgencyOf } from './ui.js';
import type { NotificationUrgency } from './ui.js';

vi.mock('electron', () => ({
  Notification: { isSupported: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
}));

const ctx: ActionContext = { packId: 'com.x.p', characterId: 'luna', sessionId: 's', packRoot: '/nowhere', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function handlerRecording(shown: Array<{ title: string; body: string; urgency: NotificationUrgency }>): UiHandler {
  return new UiHandler({
    prompts: new PendingPrompts({ fallback: null }),
    deliver: () => false,
    characterName: () => 'Luna',
    logger,
    notify: (title, body, urgency) => shown.push({ title, body, urgency }),
  });
}

describe('ui.notify urgency', () => {
  it('passes the requested urgency through and defaults to normal', async () => {
    const shown: Array<{ title: string; body: string; urgency: NotificationUrgency }> = [];
    const ui = handlerRecording(shown);
    await ui.invoke('notify', ['Luna', 'tea is ready'], ctx);
    await ui.invoke('notify', ['Luna', 'the song changed', { urgency: 'low' }], ctx);
    await ui.invoke('notify', ['Luna', 'your train leaves in 5 minutes', { urgency: 'critical' }], ctx);
    expect(shown.map((n) => n.urgency)).toEqual(['normal', 'low', 'critical']);
  });

  it('falls back to normal for anything it does not know', async () => {
    const shown: Array<{ title: string; body: string; urgency: NotificationUrgency }> = [];
    const ui = handlerRecording(shown);
    await ui.invoke('notify', ['Luna', 'hi', { urgency: 'URGENT!!' }], ctx);
    await ui.invoke('notify', ['Luna', 'hi', { urgency: 9 }], ctx);
    await ui.invoke('notify', ['Luna', 'hi', 'critical'], ctx);
    expect(shown.map((n) => n.urgency)).toEqual(['normal', 'normal', 'normal']);
    expect(urgencyOf(undefined)).toBe('normal');
  });

  it('keeps a critical notification on screen and a low one silent', () => {
    expect(notificationOptions('normal')).toEqual({ urgency: 'normal', silent: false, timeoutType: 'default' });
    expect(notificationOptions('low')).toEqual({ urgency: 'low', silent: true, timeoutType: 'default' });
    expect(notificationOptions('critical')).toEqual({ urgency: 'critical', silent: false, timeoutType: 'never' });
  });
});
