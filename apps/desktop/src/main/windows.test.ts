/**
 * A prompt window is keyed by the id its question is answered by, so `permissions.respond` /
 * `ui.respondPrompt` can close the right window. Those two ids come from different fields.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest, UiPromptRequest } from '@rp/shared';
import { promptIdOf } from './windows.js';

vi.mock('electron', () => ({ BrowserWindow: class {}, shell: {} }));

const request: PermissionRequest = {
  requestId: 'req-1',
  call: { callId: 'c1', module: 'system', method: 'exec', args: ['ls'] },
  context: { packId: 'com.x.p', characterId: 'luna', sessionId: 's' },
  description: 'Run a command',
  dangerous: true,
};
const prompt: UiPromptRequest = { promptId: 'prompt-1', sessionId: 's', characterName: 'Luna', kind: 'confirm', question: 'ok?' };

describe('promptIdOf', () => {
  it('is the id the answer comes back with', () => {
    expect(promptIdOf({ kind: 'permission', request, characterName: 'Luna', packName: 'Luna pack' })).toBe('req-1');
    expect(promptIdOf({ kind: 'ui', prompt })).toBe('prompt-1');
  });
});
