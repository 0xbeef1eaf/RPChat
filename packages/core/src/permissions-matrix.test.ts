/**
 * Permission matrix: for a non-trusted module, every combination of
 *   pack request (manifest capabilities) × global policy (Settings → Permissions) × per-pack grant
 * must agree across: `permissions.effective`, the dispatcher verdict, the sandbox surface, the pack
 * view shown in the UI and the system prompt the character reads.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionContext, Json } from '@rp/shared';
import { LUNA_ID, LUNA_REF, RecordingHandler, createTestEngine, installLunaWith } from './test/helpers.js';
import type { TestEngine } from './test/helpers.js';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const MODULES = ['desktop', 'wallpaper', 'media', 'ui', 'web', 'files'] as const;
type Requested = 'requested' | 'not-requested';
type Policy = 'unset' | 'allow' | 'deny';
type Grant = 'on' | 'off' | 'untouched';

interface Expectation {
  allowed: boolean;
  reason?: 'not-requested' | 'policy' | 'not-granted';
}

function expected(requested: Requested, policy: Policy, grant: Grant): Expectation {
  if (requested === 'not-requested') return { allowed: false, reason: 'not-requested' };
  if (policy === 'deny') return { allowed: false, reason: 'policy' };
  // "untouched" grants default from the policy at install time: policy allow/unset → granted.
  if (grant === 'off') return { allowed: false, reason: 'not-granted' };
  return { allowed: true };
}

function cases(): Array<{ module: (typeof MODULES)[number]; requested: Requested; policy: Policy; grant: Grant }> {
  const out: Array<{ module: (typeof MODULES)[number]; requested: Requested; policy: Policy; grant: Grant }> = [];
  for (const module of MODULES) {
    for (const requested of ['requested', 'not-requested'] as Requested[]) {
      for (const policy of ['unset', 'allow', 'deny'] as Policy[]) {
        for (const grant of ['on', 'off', 'untouched'] as Grant[]) out.push({ module, requested, policy, grant });
      }
    }
  }
  return out;
}

describe('permission matrix (pack request × global policy × per-pack grant)', () => {
  it.each(cases())('$module: $requested / policy $policy / grant $grant', async ({ module, requested, policy, grant }) => {
    const handler = new RecordingHandler(module, null);
    t = await createTestEngine({ hostHandlers: [handler], respond: () => ({ text: 'ok' }) });
    const { engine, packsDir } = t;
    if (policy !== 'unset') await engine.settings.update({ permissions: { moduleAllow: { [module]: policy === 'allow' } } });
    await installLunaWith(engine, packsDir, requested === 'requested' ? [module] : []);
    if (grant !== 'untouched') {
      // The UI toggle only exists for requested modules; setting a grant on an unrequested one must not enable it either.
      await engine.permissions.setGrant(LUNA_ID, module, grant === 'on');
    }
    const want = expected(requested, policy, grant);

    // 1. effective set + reason
    const eff = await engine.permissions.effective(LUNA_ID);
    expect(eff.effective.includes(module), 'effective').toBe(want.allowed);
    if (want.reason) expect(eff.denied[module], 'denial reason').toBe(want.reason);
    else expect(eff.denied[module], 'no denial').toBeUndefined();

    // 2. dispatcher verdict (what the sandbox call actually gets)
    const session = await engine.sessions.create({ characterRef: LUNA_REF });
    const context: ActionContext = { packId: LUNA_ID, characterId: 'luna', sessionId: session.id, packRoot: engine.packs.getLoaded(LUNA_ID).root, trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } };
    const method = module === 'desktop' ? 'getVolume' : module === 'wallpaper' ? 'restore' : module === 'media' ? 'list' : module === 'ui' ? 'notify' : module === 'web' ? 'fetch' : 'list';
    const args: Json[] = module === 'ui' ? ['hi'] : module === 'web' ? ['https://example.com'] : module === 'files' ? ['.'] : [];
    const result = await engine.dispatcher.invoke({ callId: 'c', module, method, args, context });
    expect(result.ok, `dispatcher ok (${JSON.stringify(result)})`).toBe(want.allowed);
    if (!want.allowed) expect(result.error?.code).toBe('PERMISSION_DENIED');
    expect(handler.calls.length, 'handler reached').toBe(want.allowed ? 1 : 0);

    // 3. sandbox surface and allowed list
    const allowed = await engine.permissions.allowedModules(LUNA_ID);
    expect(allowed.includes(module), 'allowedModules').toBe(want.allowed);
    const surface = await engine.behaviours.surfaceFor(LUNA_ID);
    expect(surface.modules.some((m) => m.id === module), 'sandbox surface').toBe(want.allowed);

    // 4. pack view (what the Packs page shows)
    const view = await engine.packs.view(LUNA_ID);
    expect(view.effectiveCapabilities.includes(module), 'view.effective').toBe(want.allowed);
    expect(view.blockedByPolicy.includes(module), 'view.blockedByPolicy').toBe(want.reason === 'policy');
    expect(view.requestedCapabilities.includes(module), 'view.requested').toBe(requested === 'requested');

    // 5. the prompt the character reads
    await engine.chat.send(session.id, 'hello');
    const system = t.provider.requests.at(-1)!.system;
    if (want.allowed) {
      expect(system).toContain(`## sdk.${module} —`);
      expect(system).toMatch(new RegExp(`^Granted sdk modules: .*\\b${module}\\b`, 'm'));
    } else {
      expect(system).not.toContain(`## sdk.${module} —`);
      const hint = want.reason === 'not-requested' ? 'not requested by the pack' : want.reason === 'policy' ? 'denied by your settings' : 'not granted';
      expect(system).toMatch(new RegExp(`^Not available: .*\\b${module} \\(${hint}`, 'm'));
    }
  });

  it('a pack edited in place after install picks up new capabilities on the next start', async () => {
    t = await createTestEngine();
    const { engine, packsDir, storage } = t;
    await installLunaWith(engine, packsDir, ['media']);
    expect((await engine.permissions.effective(LUNA_ID)).denied.desktop).toBe('not-requested');

    // Edit pack.json inside the installed copy (what a user does by hand).
    const root = engine.packs.getLoaded(LUNA_ID).root;
    const file = path.join(root, 'pack.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    manifest.capabilities = ['media', 'desktop'];
    await fs.writeFile(file, JSON.stringify(manifest));

    // Same storage, fresh engine = app restart.
    const second = await createTestEngine({ storage, packsDir });
    try {
      const eff = await second.engine.permissions.effective(LUNA_ID);
      expect(eff.effective).toEqual(expect.arrayContaining(['media', 'desktop']));
      expect(eff.denied.desktop).toBeUndefined();
      const view = await second.engine.packs.view(LUNA_ID);
      expect(view.requestedCapabilities).toEqual(['desktop', 'media']);
      expect((await second.engine.permissions.grantsFor(LUNA_ID)).find((g) => g.module === 'desktop')?.granted).toBe(true);
    } finally {
      await second.cleanup();
    }
  });
});
