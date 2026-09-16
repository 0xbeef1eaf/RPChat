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
 * It installs the frozen globals `sdk` and `console`, plus `__rp_lib`. Nothing
 * else leaks into the isolate: `hostCall` and `log` are captured by closures
 * only, so user code can only reach the host through the methods listed in the
 * surface.
 *
 * `console.*` is synchronous and captured locally; it never crosses to the
 * host as a call.
 * Dotted method names (`session.get`) are exposed one level deep
 * (`sdk.state.session.get`).
 *
 * The `lib` module is not a namespace of its own: `__rp_lib(functions)` builds
 * the character's function library — the `lib` the prelude defines — out of the
 * saved functions plus the module's `register` / `unregister`, and `sdk.lib`
 * reads back whatever it last built. `sdk.lib.cheer()` is therefore the same
 * call as `lib.cheer()`, which is what characters kept writing anyway.
 */
export const BOOTSTRAP_SOURCE = String.raw`(function (surfaceJson, hostCall, log) {
  'use strict';
  var surface = JSON.parse(surfaceJson);

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
  var libStatics = null;
  for (var m = 0; m < surface.modules.length; m++) {
    var mod = surface.modules[m];
    var target = {};
    for (var n = 0; n < mod.methods.length; n++) {
      var name = mod.methods[n];
      var fn = makeMethod(mod.id, name);
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
    if (mod.id === 'lib') libStatics = target; // the library's own methods; sdk.lib is the lib object (below)
    else sdk[mod.id] = Object.freeze(target);
  }

  /**
   * The character's function library. The prelude the host prepends to the code
   * calls __rp_lib once with the saved functions ("const lib = __rp_lib({...});");
   * a library with internal helpers calls it again with the subset the character
   * may see, and that outer object — the one the code runs against — is the one
   * sdk.lib ends up with. A later call from the character's own code can only
   * hand back functions it already holds, so nothing hidden can be reached
   * through it.
   */
  var libValue = buildLib({});

  function buildLib(functions) {
    var lib = {};
    var names = Object.keys(functions);
    for (var i = 0; i < names.length; i++) lib[names[i]] = functions[names[i]];
    if (libStatics !== null) {
      // Not overridable by a saved function: register and unregister are reserved names.
      lib.register = libStatics.register;
      lib.unregister = libStatics.unregister;
    }
    return Object.freeze(lib);
  }

  Object.defineProperty(sdk, 'lib', {
    get: function () {
      return libValue;
    },
    enumerable: true,
    configurable: false,
  });
  Object.freeze(sdk);

  var console = Object.freeze({
    log: logger('info'),
    info: logger('info'),
    debug: logger('debug'),
    warn: logger('warn'),
    error: logger('error'),
    trace: logger('debug'),
  });

  Object.defineProperty(globalThis, '__rp_lib', {
    value: function (functions) {
      libValue = buildLib(functions === null || typeof functions !== 'object' ? {} : functions);
      return libValue;
    },
    writable: false,
    configurable: false,
    enumerable: false,
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
