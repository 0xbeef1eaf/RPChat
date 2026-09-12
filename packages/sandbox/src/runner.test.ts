import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpError } from '@rp/shared';
import type { ActionContext, CapabilityCall, CapabilityInvoker, CapabilityResult, CodeRunRequest, SdkSurface } from '@rp/shared';
import { QuickJsRunner } from './runner.js';

const surface: SdkSurface = {
  modules: [
    { id: 'media', methods: ['showImage', 'close'] },
    { id: 'state', methods: ['get', 'set', 'session.get', 'session.set'] },
    { id: 'events', methods: ['on'] },
    { id: 'log', methods: ['debug', 'info', 'warn', 'error'] },
  ],
};

const context: ActionContext = {
  packId: 'com.example.test',
  characterId: 'luna',
  sessionId: 'session-1',
  packRoot: '/tmp/packs/com.example.test/1.0.0',
  trigger: { kind: 'llm', actionId: 'a1', messageId: 'm1' },
};

type Handler = (call: CapabilityCall) => Promise<CapabilityResult> | CapabilityResult;

function makeInvoker(handler?: Handler): CapabilityInvoker & { calls: CapabilityCall[] } {
  const calls: CapabilityCall[] = [];
  return {
    calls,
    async invoke(call) {
      calls.push(call);
      if (handler) return handler(call);
      return { ok: true, value: { echo: { module: call.module, method: call.method, args: call.args } } };
    },
  };
}

function req(code: string, extra: Partial<CodeRunRequest> = {}): CodeRunRequest {
  return { code, language: 'ts', context, surface, invoker: makeInvoker(), ...extra };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('QuickJsRunner', () => {
  let runner: QuickJsRunner;
  beforeAll(() => {
    runner = new QuickJsRunner();
  });
  afterAll(async () => {
    await runner.dispose();
  });

  it('returns a JSON value and reaches the invoker with parsed args and context', async () => {
    const invoker = makeInvoker();
    const result = await runner.run(
      req(
        `const pic = "images/a.png";
         const r = await sdk.media.showImage(pic, { durationMs: 8000, position: "bottom-right" });
         return { shown: true, r, n: 1 + 1, list: [1, "two", null] };`,
        { invoker },
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.returnValue).toEqual({
      shown: true,
      r: { echo: { module: 'media', method: 'showImage', args: ['images/a.png', { durationMs: 8000, position: 'bottom-right' }] } },
      n: 2,
      list: [1, 'two', null],
    });
    expect(invoker.calls).toHaveLength(1);
    const call = invoker.calls[0]!;
    expect(call.module).toBe('media');
    expect(call.method).toBe('showImage');
    expect(call.args).toEqual(['images/a.png', { durationMs: 8000, position: 'bottom-right' }]);
    expect(call.context).toEqual(context);
    expect(typeof call.callId).toBe('string');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ callId: call.callId, module: 'media', method: 'showImage', ok: true });
    expect(result.compiledCode).toContain('async function __rp_main()');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('maps undefined return to null and supports no return at all', async () => {
    const a = await runner.run(req(`await sdk.state.set("k", 1);`));
    expect(a.ok).toBe(true);
    expect(a.returnValue).toBeNull();
    const b = await runner.run(req(`return undefined;`));
    expect(b.returnValue).toBeNull();
    const c = await runner.run(req(`return "text";`));
    expect(c.returnValue).toBe('text');
  });

  it('exposes nested dotted methods (sdk.state.session.get)', async () => {
    const invoker = makeInvoker(async (call) => ({ ok: true, value: `${call.method}:${String(call.args[0])}` }));
    const result = await runner.run(
      req(`const v = await sdk.state.session.get("mood"); await sdk.state.session.set("mood", "happy"); return v;`, { invoker }),
    );
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe('session.get:mood');
    expect(invoker.calls.map((c) => c.method)).toEqual(['session.get', 'session.set']);
    expect(invoker.calls[0]!.module).toBe('state');
  });

  it('only exposes modules present in the surface', async () => {
    const result = await runner.run(req(`return { hasMedia: typeof sdk.media, hasSystem: typeof sdk.system, hasHostCall: typeof globalThis.__rp_host_call };`));
    expect(result.returnValue).toEqual({ hasMedia: 'object', hasSystem: 'undefined', hasHostCall: 'undefined' });
  });

  it('captures console output and sdk.log without host calls', async () => {
    const invoker = makeInvoker();
    const result = await runner.run(
      req(
        `console.log("hello", 42, { a: 1 }, [1, 2], null, undefined);
         console.warn("careful");
         console.error(new Error("boom"));
         sdk.log.debug("dbg");
         sdk.log.info("inf", 1);
         const r = sdk.log.warn("sync");
         return r === undefined;`,
        { invoker },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe(true);
    expect(invoker.calls).toHaveLength(0);
    expect(result.logs.map((l) => [l.level, l.message])).toEqual([
      ['info', 'hello 42 {"a":1} [1,2] null undefined'],
      ['warn', 'careful'],
      ['error', 'Error: boom'],
      ['debug', 'dbg'],
      ['info', 'inf 1'],
      ['warn', 'sync'],
    ]);
    for (const entry of result.logs) expect(() => new Date(entry.at).toISOString()).not.toThrow();
  });

  it('truncates log output at maxLogBytes with a final marker', async () => {
    const result = await runner.run(
      req(`for (let i = 0; i < 100; i++) console.log("line-" + i + "-" + "x".repeat(50)); return "done";`, {
        limits: { maxLogBytes: 300 },
      }),
    );
    expect(result.ok).toBe(true);
    const last = result.logs[result.logs.length - 1]!;
    expect(last.message).toBe('…[truncated]');
    const bytes = result.logs.slice(0, -1).reduce((n, l) => n + Buffer.byteLength(l.message, 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(300);
    expect(result.logs.length).toBeLessThan(100);
  });

  it('interrupts an infinite loop with SANDBOX_TIMEOUT within ~cpuMs', async () => {
    const started = Date.now();
    const result = await runner.run(req(`while (true) {}`, { limits: { cpuMs: 300, timeoutMs: 5000 } }));
    const took = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_TIMEOUT');
    expect(took).toBeLessThan(2000);
  });

  it('interrupts an infinite loop after an await (inside a pending job)', async () => {
    const result = await runner.run(req(`await sdk.state.get("x"); try { while (true) {} } catch (e) { return "caught" }`, { limits: { cpuMs: 300 } }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_TIMEOUT');
  });

  it('survives a memory bomb with SANDBOX_MEMORY (or SANDBOX_TIMEOUT) and keeps working afterwards', async () => {
    const result = await runner.run(
      req(`const a = []; while (true) a.push({ i: a.length, s: "x".repeat(100) });`, {
        limits: { memoryBytes: 8 * 1024 * 1024, cpuMs: 4000, timeoutMs: 8000 },
      }),
    );
    expect(result.ok).toBe(false);
    expect(['SANDBOX_MEMORY', 'SANDBOX_TIMEOUT']).toContain(result.error?.code);
    const after = await runner.run(req(`return 1 + 1;`));
    expect(after.returnValue).toBe(2);
  }, 30_000);

  it('reports a huge string allocation as SANDBOX_MEMORY', async () => {
    const result = await runner.run(req(`const s = "x".repeat(2 ** 28); return s.length;`, { limits: { memoryBytes: 16 * 1024 * 1024 } }));
    expect(result.error?.code).toBe('SANDBOX_MEMORY');
  });

  it('enforces the host call budget', async () => {
    const invoker = makeInvoker();
    const result = await runner.run(
      req(`for (let i = 0; i < 10; i++) await sdk.state.get("k" + i); return "unreachable";`, { invoker, limits: { maxHostCalls: 3 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_CALL_BUDGET');
    expect(invoker.calls).toHaveLength(3);
    expect(result.calls).toHaveLength(3);

    const caught = await runner.run(
      req(
        `let code = null; for (let i = 0; i < 10; i++) { try { await sdk.state.get("k") } catch (e) { code = e.code; break; } } return code;`,
        { invoker: makeInvoker(), limits: { maxHostCalls: 2 } },
      ),
    );
    expect(caught.ok).toBe(true);
    expect(caught.returnValue).toBe('SANDBOX_CALL_BUDGET');
  });

  it('propagates host errors as catchable Errors with .code inside the isolate', async () => {
    const invoker = makeInvoker(async (call) =>
      call.method === 'showImage'
        ? { ok: false, error: { code: 'PERMISSION_DENIED', message: 'media not granted', details: { module: 'media' } } }
        : { ok: true, value: 'fine' },
    );
    const result = await runner.run(
      req(
        `try {
           await sdk.media.showImage("a.png");
           return "no error";
         } catch (e) {
           const ok = await sdk.state.get("x");
           return { isError: e instanceof Error, message: e.message, code: e.code, details: e.details, ok };
         }`,
        { invoker },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.returnValue).toEqual({
      isError: true,
      message: 'media not granted',
      code: 'PERMISSION_DENIED',
      details: { module: 'media' },
      ok: 'fine',
    });
    expect(result.calls[0]).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('turns an invoker that throws into a failed call, and an uncaught host error into SANDBOX_RUNTIME', async () => {
    const invoker = makeInvoker(async () => {
      throw new RpError('CAPABILITY_FAILED', 'handler exploded');
    });
    const result = await runner.run(req(`await sdk.media.close("id");`, { invoker }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_RUNTIME');
    expect(result.error?.message).toContain('handler exploded');
    expect(result.error?.details).toMatchObject({ code: 'CAPABILITY_FAILED' });
    expect(result.calls[0]).toMatchObject({ ok: false, error: { code: 'CAPABILITY_FAILED', message: 'handler exploded' } });
  });

  it('runs concurrent host calls issued via Promise.all', async () => {
    const invoker = makeInvoker(async (call) => {
      await sleep(5);
      return { ok: true, value: call.args[0] ?? null };
    });
    const result = await runner.run(req(`const r = await Promise.all([sdk.state.get("a"), sdk.state.get("b"), sdk.state.get("c")]); return r;`, { invoker }));
    expect(result.returnValue).toEqual(['a', 'b', 'c']);
    expect(invoker.calls).toHaveLength(3);
  });

  it('transpiles TypeScript syntax (types, generics, satisfies, class fields)', async () => {
    const result = await runner.run(
      req(
        `interface Point { x: number; y: number }
         const p = { x: 1, y: 2 } satisfies Point;
         const id = <T,>(v: T): T => v;
         class Box<T> { value: T; constructor(v: T) { this.value = v } }
         enum Color { Red = "red" }
         const total: number = [1, 2, 3].reduce((a, b) => a + b, 0);
         return { p, v: id("ok"), boxed: new Box(3).value, color: Color.Red, total, opt: (null as { a?: number } | null)?.a ?? "d" };`,
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.returnValue).toEqual({ p: { x: 1, y: 2 }, v: 'ok', boxed: 3, color: 'red', total: 6, opt: 'd' });
  });

  it('reports syntax errors as SANDBOX_COMPILE with the line number', async () => {
    const result = await runner.run(req(`const a = 1;\nconst b = ;\nreturn a;`));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_COMPILE');
    expect(result.error?.details).toMatchObject({ line: 2 });
    expect(result.error?.message).toMatch(/line 2/);
    expect(result.compiledCode).toBeUndefined();

    const js = await runner.run(req(`const x: number = 1; return x;`, { language: 'js' }));
    expect(js.error?.code).toBe('SANDBOX_COMPILE');
  });

  it('reports thrown errors as SANDBOX_RUNTIME with message and stack', async () => {
    const result = await runner.run(req(`function deep() { throw new RangeError("deep trouble") }\nawait null;\ndeep();`));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_RUNTIME');
    expect(result.error?.message).toBe('RangeError: deep trouble');
    expect(result.error?.stack).toContain('deep');
    expect(result.error?.details).toMatchObject({ name: 'RangeError' });

    const thrown = await runner.run(req(`throw { weird: true };`));
    expect(thrown.error?.code).toBe('SANDBOX_RUNTIME');
    expect(thrown.error?.details).toMatchObject({ thrown: { weird: true } });
  });

  it('points a failure at the line the model wrote, with a caret and a mapped stack', async () => {
    const code = ['const items = [1, 2, 3];', 'function pick(list: any[]) {', '  return list.find((x) => x.missing.deep);', '}', 'return pick(items);'].join('\n');
    const result = await runner.run(req(code));
    expect(result.ok).toBe(false);
    const details = result.error?.details as { line?: number; column?: number; frame?: string };
    // esbuild reformats and the runner wraps the code, so the isolate reports
    // other line numbers; what comes back is the model's own line 3.
    expect(details.line).toBe(3);
    expect(details.frame).toContain('> 3 |   return list.find((x) => x.missing.deep);');
    expect(details.frame).toContain('^');
    expect(result.error?.stack).toContain('at pick (action.ts:3:');
    expect(result.error?.stack).not.toContain('action.js');
    expect(result.error?.stack).not.toContain('__rp_main');
  });

  it('gives a compile error the same frame, without the host stack', async () => {
    const result = await runner.run(req('const a = 1;\nconst b = ;'));
    expect(result.error?.code).toBe('SANDBOX_COMPILE');
    const details = result.error?.details as { line?: number; column?: number; frame?: string };
    expect(details.line).toBe(2);
    expect(details.frame).toContain('> 2 | const b = ;');
    // The RpError was thrown on the host: those frames say nothing to the model.
    expect(result.error?.stack).toBeUndefined();
  });

  describe('prelude (the character\'s function library)', () => {
    const prelude = ['const lib = Object.freeze({', '  "double": (async (n: number) => n * 2),', '});'].join('\n');

    it('defines lib in front of the user code, inside the same async wrapper', async () => {
      const result = await runner.run(req('const four = await lib.double(2);\nreturn { four, keys: Object.keys(lib) };', { prelude }));
      expect(result.error).toBeUndefined();
      expect(result.returnValue).toEqual({ four: 4, keys: ['double'] });
    });

    it('still reports the user\'s own line numbers after a three-line prelude', async () => {
      const code = ['const items = [1, 2, 3];', 'function pick(list: any[]) {', '  return list.find((x) => x.missing.deep);', '}', 'return pick(items);'].join('\n');
      const result = await runner.run(req(code, { prelude }));
      expect(result.ok).toBe(false);
      const details = result.error?.details as { line?: number; frame?: string };
      expect(details.line).toBe(3);
      expect(details.frame).toContain('> 3 |   return list.find((x) => x.missing.deep);');
      expect(result.error?.stack).toContain('at pick (action.ts:3:');
      expect(result.error?.stack).not.toContain('library');
    });

    it('names the library function when the failure is inside it, and keeps the frame in the user\'s code', async () => {
      const broken = ['const lib = Object.freeze({', '  "boom": (async (x: any) => {', '    return x.missing.deep;', '  }),', '});'].join('\n');
      const result = await runner.run(req('const a = 1;\nreturn await lib.boom(a);', { prelude: broken }));
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('SANDBOX_RUNTIME');
      expect(result.error?.stack).toMatch(/at lib\.boom \(library:3:/);
      const details = result.error?.details as { line?: number; frame?: string };
      // The caret never points into the library: `line`/`frame` are the user's call site (if any frame of theirs is left).
      if (details.line !== undefined) {
        expect(details.line).toBe(2);
        expect(details.frame).toContain('lib.boom(a)');
      }
    });

    it('reports a syntax error in the prelude as a library problem, not as a line of the action', async () => {
      const result = await runner.run(req('return 1;', { prelude: 'const lib = Object.freeze({\n  "bad": (async ( => 1),\n});' }));
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('SANDBOX_COMPILE');
      expect(result.error?.message).toMatch(/function library/);
      expect(result.error?.message).toMatch(/library line 2/);
      expect(result.error?.details).toMatchObject({ library: true, libraryLine: 2 });
      expect((result.error?.details as { line?: number }).line).toBeUndefined();
      expect((result.error?.details as { frame?: string }).frame).toBeUndefined();
    });

    it('compile errors in the user code are still reported against its own lines', async () => {
      const result = await runner.run(req('const a = 1;\nconst b = ;', { prelude }));
      expect(result.error?.code).toBe('SANDBOX_COMPILE');
      expect(result.error?.details).toMatchObject({ line: 2 });
      expect((result.error?.details as { frame?: string }).frame).toContain('> 2 | const b = ;');
    });
  });

  it('sends a function argument as the action body that calls it, and runs that body later', async () => {
    const invoker = makeInvoker();
    const stored = await runner.run(
      req(
        [
          'await sdk.events.on("user-idle", async (input: { data: { idleMs: number } }) => {',
          '  await sdk.state.set("lastIdle", input.data.idleMs);',
          '});',
          // A string handler still works, unchanged.
          'await sdk.events.on("user-back", \'await sdk.state.set("back", true);\');',
          'return "subscribed";',
        ].join('\n'),
        { invoker },
      ),
    );
    expect(stored.error).toBeUndefined();
    const [asFunction, asString] = invoker.calls.map((c) => c.args[1] as string);
    expect(asFunction).toBe('return await (async (input) => {\n    await sdk.state.set("lastIdle", input.data.idleMs);\n  })(input);');
    expect(asString).toBe('await sdk.state.set("back", true);');

    // What the host stored is a normal action body: bind `input` and run it.
    const later = makeInvoker();
    const fired = await runner.run(req(`const input = { data: { idleMs: 900000 } }; ${asFunction}`, { invoker: later }));
    expect(fired.error).toBeUndefined();
    expect(later.calls.map((c) => [c.module, c.method, c.args])).toEqual([['state', 'set', ['lastIdle', 900000]]]);
  });

  it('still refuses arguments that are not serialisable at all', async () => {
    const result = await runner.run(req('const cycle: any = {}; cycle.self = cycle; await sdk.state.set("x", cycle); return 1;'));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('sdk.state.set');
  });

  it('catches runaway recursion as a runtime error and keeps the runner usable', async () => {
    const result = await runner.run(req(`function f(n: number): number { return f(n + 1) + 1 } return f(0);`));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_RUNTIME');
    expect(result.error?.message).toMatch(/stack overflow/);
    const after = await runner.run(req(`function f(n: number): number { return n === 0 ? 0 : 1 + f(n - 1) } return f(300);`));
    expect(after.returnValue).toBe(300);
  });

  it('recovers when an overflow escapes to the host (module is replaced), on this and other runners', async () => {
    // Pathological parser nesting can exhaust the host's native stack before
    // QuickJS's own check fires; either way it must surface as a runtime error
    // and every runner must keep working afterwards.
    const other = new QuickJsRunner();
    try {
      expect((await other.run(req(`return "warm";`))).returnValue).toBe('warm');
      const result = await runner.run(req(`const s = "(".repeat(60000) + "1" + ")".repeat(60000); return eval(s);`));
      expect(result.ok).toBe(false);
      expect(['SANDBOX_RUNTIME', 'SANDBOX_MEMORY', 'INTERNAL']).toContain(result.error?.code);
      expect((await runner.run(req(`return "same runner";`))).returnValue).toBe('same runner');
      expect((await other.run(req(`await sdk.state.get("x"); return "other runner";`))).returnValue).toBe('other runner');
    } finally {
      await other.dispose();
    }
  });

  it('rejects with SANDBOX_TIMEOUT when signal.abort() fires mid-await, without waiting for the host call', async () => {
    const controller = new AbortController();
    let resolveHost: ((r: CapabilityResult) => void) | undefined;
    let hostCallStarted!: () => void;
    const started = new Promise<void>((resolve) => (hostCallStarted = resolve));
    const invoker = makeInvoker(() => {
      hostCallStarted();
      return new Promise<CapabilityResult>((resolve) => (resolveHost = resolve));
    });
    const startedAt = Date.now();
    const pending = runner.run(req(`console.log("before"); const v = await sdk.state.get("k"); console.log("after"); return v;`, { invoker, signal: controller.signal }));
    // Abort only once the isolate is parked in the host call, so the test exercises the
    // mid-await path deterministically (slow CI runners otherwise abort during bootstrap).
    await started;
    await sleep(10);
    controller.abort();
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_TIMEOUT');
    expect(result.error?.message).toMatch(/abort/);
    expect(result.logs.map((l) => l.message)).toEqual(['before']);
    expect(result.calls).toHaveLength(0);
    resolveHost?.({ ok: true, value: 'late' });
    const after = await runner.run(req(`return "still alive";`));
    expect(after.returnValue).toBe('still alive');
  });

  it('reports SANDBOX_TIMEOUT when the abort lands during bootstrap (before any host call)', async () => {
    const controller = new AbortController();
    const pending = runner.run(req(`console.log("x"); return 1;`, { signal: controller.signal }));
    controller.abort(); // fires while the run is still starting up
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_TIMEOUT');
    const after = await runner.run(req(`return "still alive";`));
    expect(after.returnValue).toBe('still alive');
  });

  it('returns SANDBOX_TIMEOUT immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run(req(`return 1;`, { signal: controller.signal }));
    expect(result.error?.code).toBe('SANDBOX_TIMEOUT');
  });

  it('does not count time spent in a host call towards timeoutMs/cpuMs', async () => {
    const invoker = makeInvoker(async () => {
      await sleep(400);
      return { ok: true, value: 'answered' };
    });
    const result = await runner.run(
      req(`const a = await sdk.state.get("slow"); let n = 0; for (let i = 0; i < 1e5; i++) n += i; return { a, n };`, {
        invoker,
        limits: { timeoutMs: 150, cpuMs: 100 },
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.returnValue).toEqual({ a: 'answered', n: 4999950000 });
    expect(result.calls[0]!.durationMs).toBeGreaterThanOrEqual(350);
  });

  it('still applies timeoutMs to isolate time spread across host calls', async () => {
    const invoker = makeInvoker(async () => ({ ok: true, value: null }));
    const result = await runner.run(
      req(`for (let i = 0; i < 50; i++) { await sdk.state.get("k"); const end = Date.now() + 20; while (Date.now() < end) {} } return "done";`, {
        invoker,
        limits: { timeoutMs: 200, cpuMs: 5000 },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_TIMEOUT');
    expect(result.error?.message).toMatch(/time limit/);
  });

  it('caps a single host call with hostCallTimeoutMs', async () => {
    const slow = new QuickJsRunner({ hostCallTimeoutMs: 80 });
    try {
      const invoker = makeInvoker(() => new Promise<CapabilityResult>(() => undefined));
      const result = await slow.run(req(`await sdk.media.showImage("x"); return 1;`, { invoker }));
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('SANDBOX_TIMEOUT');
      expect(result.error?.message).toMatch(/sdk\.media\.showImage/);
    } finally {
      await slow.dispose();
    }
  });

  it('fails a run that awaits a promise which can never settle', async () => {
    const result = await runner.run(req(`await new Promise(() => {}); return 1;`));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_RUNTIME');
    expect(result.error?.message).toMatch(/stalled/);
  });

  it('rejects oversized and non-serialisable results', async () => {
    const big = await runner.run(req(`return "x".repeat(20000);`, { limits: { maxResultBytes: 1024 } }));
    expect(big.error?.code).toBe('SANDBOX_RUNTIME');
    expect(big.error?.message).toMatch(/too large/);
    const circular = await runner.run(req(`const o: any = {}; o.self = o; return o;`));
    expect(circular.error?.code).toBe('SANDBOX_RUNTIME');
    expect(circular.error?.message).toMatch(/JSON/);
  });

  it('has no ambient authority inside the isolate', async () => {
    const result = await runner.run(
      req(`return [typeof require, typeof fetch, typeof setTimeout, typeof process, typeof globalThis.__rp_log, typeof XMLHttpRequest];`),
    );
    expect(result.returnValue).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('refuses host calls after dispose and serialises concurrent runs', async () => {
    const local = new QuickJsRunner();
    const results = await Promise.all([1, 2, 3].map((n) => local.run(req(`await sdk.state.get("k"); return ${n};`))));
    expect(results.map((r) => r.returnValue)).toEqual([1, 2, 3]);
    await local.dispose();
    await expect(local.run(req(`return 1;`))).rejects.toThrow(/disposed/);
  });

  it('survives 200 sequential runs without leaking or throwing', async () => {
    const invoker = makeInvoker();
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 200; i++) {
      const kind = i % 4;
      const code =
        kind === 0
          ? `const v = await sdk.state.get("k${i}"); console.log("i", ${i}); return { i: ${i}, v };`
          : kind === 1
            ? `throw new Error("fail ${i}");`
            : kind === 2
              ? `const a = []; for (let j = 0; j < 2000; j++) a.push({ j, s: "y".repeat(50) }); return a.length;`
              : `try { await sdk.media.close("x") } catch {} return ${i};`;
      const result = await runner.run(req(code, { invoker }));
      if (kind === 1) expect(result.error?.code).toBe('SANDBOX_RUNTIME');
      else expect(result.ok).toBe(true);
    }
    const after = process.memoryUsage().rss;
    expect(after - before).toBeLessThan(200 * 1024 * 1024);
  }, 60_000);
});
