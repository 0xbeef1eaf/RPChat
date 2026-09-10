/**
 * Source of the bootstrap function evaluated inside a fresh isolate before the
 * user's code. Evaluating it yields a function `(surfaceJson, hostCall, log)`
 * which the runner calls once with:
 *
 * - `surfaceJson`: `JSON.stringify(SdkSurface)`;
 * - `hostCall(module, method, argsJson) => Promise<string>`: host function
 *   returning the JSON text of a `CapabilityResult`;
 * - `log(level, message) => void`: host function capturing log output.
 *
 * It installs the frozen globals `sdk` and `console`. Nothing else leaks into
 * the isolate: `hostCall` and `log` are captured by closures only, so user code
 * can only reach the host through the methods listed in the surface.
 *
 * `sdk.log.*` (when the `log` module is in the surface) and `console.*` are
 * synchronous and captured locally; they never cross to the host as calls.
 * Dotted method names (`session.get`) are exposed one level deep
 * (`sdk.state.session.get`).
 */
export const BOOTSTRAP_SOURCE = String.raw`(function (surfaceJson, hostCall, log) {
  'use strict';
  var surface = JSON.parse(surfaceJson);
  var LEVELS = ['debug', 'info', 'warn', 'error'];

  function formatArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.name + ': ' + a.message;
    if (typeof a === 'bigint') return String(a) + 'n';
    if (typeof a === 'symbol' || typeof a === 'function') return String(a);
    try {
      var s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch (e) {
      return String(a);
    }
  }

  function logger(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(formatArg(arguments[i]));
      log(level, parts.join(' '));
    };
  }

  /**
   * Arguments cross to the host as JSON, which has no functions — but the code
   * an sdk method stores to run later (sdk.events.on, sdk.timers.runLater) is
   * far easier to write, and to type check, as a function than as a string.
   * A function argument is therefore sent as the action body that calls it:
   * "return await (<its source>)(input);". Its source is what the isolate
   * compiled, so it is already plain JavaScript.
   *
   * The function cannot close over anything: it runs later, in a fresh isolate.
   * Whatever it needs has to arrive through input.
   */
  function serialiseArg(key, value) {
    if (typeof value !== 'function') return value;
    return 'return await (' + String(value) + ')(input);';
  }

  function makeMethod(moduleId, method) {
    var label = 'sdk.' + moduleId + '.' + method;
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var json;
      try {
        json = JSON.stringify(args, serialiseArg);
      } catch (e) {
        return Promise.reject(new TypeError(label + ': arguments must be JSON-serialisable (' + (e && e.message) + ')'));
      }
      return hostCall(moduleId, method, json).then(function (raw) {
        var r = JSON.parse(raw);
        if (r.ok) return r.value;
        var err = new Error(r.error.message);
        err.code = r.error.code;
        err.details = r.error.details;
        err.capability = label;
        throw err;
      });
    };
  }

  var sdk = {};
  for (var m = 0; m < surface.modules.length; m++) {
    var mod = surface.modules[m];
    var target = {};
    for (var n = 0; n < mod.methods.length; n++) {
      var name = mod.methods[n];
      var fn = mod.id === 'log' ? logger(LEVELS.indexOf(name) >= 0 ? name : 'info') : makeMethod(mod.id, name);
      var dot = name.indexOf('.');
      if (dot === -1) {
        target[name] = fn;
      } else {
        var ns = name.slice(0, dot);
        var leaf = name.slice(dot + 1);
        if (typeof target[ns] !== 'object' || target[ns] === null) target[ns] = {};
        target[ns][leaf] = fn;
      }
    }
    var keys = Object.keys(target);
    for (var k = 0; k < keys.length; k++) {
      if (typeof target[keys[k]] === 'object') Object.freeze(target[keys[k]]);
    }
    sdk[mod.id] = Object.freeze(target);
  }
  Object.freeze(sdk);

  var console = Object.freeze({
    log: logger('info'),
    info: logger('info'),
    debug: logger('debug'),
    warn: logger('warn'),
    error: logger('error'),
    trace: logger('debug'),
  });

  Object.defineProperty(globalThis, 'sdk', { value: sdk, writable: false, configurable: false, enumerable: false });
  Object.defineProperty(globalThis, 'console', { value: console, writable: false, configurable: false, enumerable: false });
})`;

/**
 * Appended to the wrapped entry expression: serialises the return value inside
 * the isolate so only one JSON string crosses the boundary (`undefined` → null).
 */
export const RESULT_SERIALISER_SUFFIX = String.raw`.then(function (v) {
  var s;
  try {
    s = JSON.stringify(v);
  } catch (e) {
    throw new TypeError('return value is not JSON-serialisable: ' + (e && e.message));
  }
  return s === undefined ? 'null' : s;
})`;
