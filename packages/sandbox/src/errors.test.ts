import { describe, expect, it } from 'vitest';
import { describeIsolateError, mapHostCrash, mapIsolateError } from './errors.js';

const limits = { timeoutMs: 10, cpuMs: 5, hostCallTimeoutMs: 100 };

describe('mapIsolateError', () => {
  it('prefers the host termination reason', () => {
    expect(mapIsolateError({ name: 'InternalError', message: 'interrupted' }, { termination: 'cpu' }, limits)).toMatchObject({
      code: 'SANDBOX_TIMEOUT',
      message: /CPU budget of 5 ms/,
    });
    expect(mapIsolateError(undefined, { termination: 'aborted' }, limits).message).toBe('run aborted');
    expect(mapIsolateError(undefined, { termination: 'host-call-timeout', terminationDetail: 'sdk.ui.confirm' }, limits).message).toMatch(
      /sdk\.ui\.confirm .*100 ms/,
    );
  });

  it('maps out of memory and interrupted InternalErrors', () => {
    expect(mapIsolateError({ name: 'InternalError', message: 'out of memory' }, {}, limits).code).toBe('SANDBOX_MEMORY');
    expect(mapIsolateError({ name: 'InternalError', message: 'interrupted' }, {}, limits).code).toBe('SANDBOX_TIMEOUT');
  });

  it('maps thrown errors to SANDBOX_RUNTIME with stack and details', () => {
    const e = mapIsolateError({ name: 'TypeError', message: 'x is not a function', stack: '    at f (action.js:3:1)\n', code: 'NOT_FOUND' }, {}, limits);
    expect(e).toMatchObject({ code: 'SANDBOX_RUNTIME', message: 'TypeError: x is not a function', details: { name: 'TypeError', code: 'NOT_FOUND' } });
    expect(e.stack).toContain('at f (action.js:3:1)');
    expect(mapIsolateError('oops', {}, limits)).toMatchObject({ code: 'SANDBOX_RUNTIME', message: /non-Error value thrown: oops/ });
  });

  it('only honours SANDBOX_CALL_BUDGET when the host actually refused a call', () => {
    const err = { name: 'Error', message: 'budget', code: 'SANDBOX_CALL_BUDGET' };
    expect(mapIsolateError(err, { budgetExceeded: true }, limits).code).toBe('SANDBOX_CALL_BUDGET');
    expect(mapIsolateError(err, {}, limits).code).toBe('SANDBOX_RUNTIME');
  });
});

describe('describeIsolateError / mapHostCrash', () => {
  it('normalises non-error values', () => {
    expect(describeIsolateError({ a: 1 })).toMatchObject({ name: 'Error', raw: { a: 1 } });
    expect(describeIsolateError(null).message).toContain('null');
  });

  it('maps host-level crashes', () => {
    expect(mapHostCrash(new RangeError('Maximum call stack size exceeded')).code).toBe('SANDBOX_RUNTIME');
    expect(mapHostCrash(new Error('memory access out of bounds')).code).toBe('SANDBOX_MEMORY');
    expect(mapHostCrash(new Error('Aborted(Assertion failed)')).code).toBe('INTERNAL');
  });
});
