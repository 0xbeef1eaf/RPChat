import { describe, expect, it } from 'vitest';
import { createStandardRegistry } from '@rp/sdk';
import type { ActionContext, AuditEntry, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import { CapabilityDispatcher } from './dispatcher.js';
import type { PermissionVerdict } from './services/permissions.js';

const context: ActionContext = {
  packId: 'com.example.p',
  characterId: 'c',
  sessionId: 's',
  packRoot: '/nowhere',
  trigger: { kind: 'llm', actionId: 'a', messageId: 'm' },
};

function setup(verdict: PermissionVerdict, handler?: CapabilityHandler) {
  const audit: Array<Omit<AuditEntry, 'id' | 'at'>> = [];
  const dispatcher = new CapabilityDispatcher({
    registry: createStandardRegistry(),
    handlers: handler ? [handler] : [],
    permissions: {
      isAllowed: async () => verdict,
      prompt: async () => 'deny',
      buildRequest: (ctx, module, method, args, callId) => ({
        requestId: 'r',
        call: { callId, module, method, args },
        context: { packId: ctx.packId, characterId: ctx.characterId, sessionId: ctx.sessionId },
        description: 'd',
        dangerous: false,
      }),
    },
    audit: { record: async (entry) => { audit.push(entry); return { id: 'x', at: 't', ...entry }; } },
  });
  return { dispatcher, audit };
}

describe('CapabilityDispatcher', () => {
  it('cleans results to JSON and turns undefined into null', async () => {
    const handler: CapabilityHandler = { moduleId: 'ui', invoke: async (method) => (method === 'notify' ? undefined : ({ a: undefined, b: 1, d: new Date(0) } as unknown as Json)) };
    const { dispatcher, audit } = setup('allow', handler);
    expect(await dispatcher.invoke({ callId: '1', module: 'ui', method: 'notify', args: ['t'], context })).toEqual({ ok: true, value: null });
    expect(await dispatcher.invoke({ callId: '2', module: 'ui', method: 'confirm', args: ['q'], context })).toEqual({ ok: true, value: { b: 1, d: '1970-01-01T00:00:00.000Z' } });
    expect(audit.map((a) => a.outcome)).toEqual(['allowed', 'allowed']);
    expect(audit[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('wraps handler failures and reports unknown modules/methods', async () => {
    const handler: CapabilityHandler = {
      moduleId: 'ui',
      invoke: async (method) => {
        if (method === 'notify') throw new Error('boom');
        throw new RpError('NOT_FOUND', 'nope');
      },
    };
    const { dispatcher, audit } = setup('allow', handler);
    expect(await dispatcher.invoke({ callId: '1', module: 'ui', method: 'notify', args: [], context })).toMatchObject({ ok: false, error: { code: 'CAPABILITY_FAILED', message: 'boom' } });
    expect(await dispatcher.invoke({ callId: '2', module: 'ui', method: 'confirm', args: [], context })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await dispatcher.invoke({ callId: '3', module: 'nope', method: 'x', args: [], context })).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNKNOWN' } });
    expect(await dispatcher.invoke({ callId: '4', module: 'media', method: 'list', args: [], context })).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNKNOWN' } });
    expect(audit.map((a) => a.outcome)).toEqual(['failed', 'failed', 'denied', 'denied']);
  });

  it('rejects prompt-level calls the user declines', async () => {
    const calls: string[] = [];
    const { dispatcher, audit } = setup('prompt', { moduleId: 'system', invoke: async (m) => { calls.push(m); return null; } });
    expect(await dispatcher.invoke({ callId: '1', module: 'system', method: 'exec', args: ['rm'], context })).toMatchObject({ ok: false, error: { code: 'PERMISSION_PROMPT_REJECTED' } });
    expect(calls).toEqual([]);
    expect(audit[0]).toMatchObject({ outcome: 'denied', module: 'system', method: 'exec', args: ['rm'] });
  });

  it('shortens huge string arguments in the audit log', async () => {
    const { dispatcher, audit } = setup('allow', { moduleId: 'system', invoke: async () => null });
    await dispatcher.invoke({ callId: '1', module: 'system', method: 'writeFile', args: ['/f', 'x'.repeat(5000)], context });
    expect((audit[0]!.args[1] as string).length).toBeLessThan(1100);
  });
});
