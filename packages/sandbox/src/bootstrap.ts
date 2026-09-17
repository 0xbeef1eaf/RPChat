/**
 * Source of the bootstrap function evaluated inside a fresh isolate before the
 * user's code. Evaluating it yields a function `(surfaceJson, hostCall, log, restrictInternals)`
 * which the runner calls once with:
 *
 * - `surfaceJson`: `JSON.stringify(SdkSurface)`;
 * - `hostCall(module, method, argsJson) => Promise<string>`: host function
 *   returning the JSON text of a `CapabilityResult`;
 * - `log(level, message) => void`: host function capturing log output;
 * - `restrictInternals`: true for an LLM-authored run, where the action body may
 *   not call the library's `@internal` helpers (see `__rp_lib` below).
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
 * The `lib` module is not a namespace of its own: `__rp_lib(functions, internalNames)`
 * builds the character's function library — the `lib` the prelude defines — out of the
 * saved functions plus the module's `register` / `unregister`, and `sdk.lib`
 * reads back whatever it last built. `sdk.lib.cheer()` is therefore the same
 * call as `lib.cheer()`, which is what characters kept writing anyway.
 */
export const BOOTSTRAP_SOURCE = String.raw`(function (surfaceJson, hostCall, log, restrictInternals) {
  'use strict';
  var surface = JSON.parse(surfaceJson);
  var hideInternals = restrictInternals === true;

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
   * The character's function library. The prelude the host prepends to the code calls
   * __rp_lib once ("const lib = __rp_lib({...}, ["helper"]);"): the first argument holds
   * every saved function, the second names the ones marked @internal in the pack.
   *
   * There is only ever one lib object, and every function is on it — a second, narrower
   * one in a nested scope would make the transpiler rename the inner binding (lib -> lib2),
   * and a handler a library function hands to sdk.events.on is stored as its compiled
   * source, so the rename travelled into the stored code and broke it when it ran.
   *
   * @internal is enforced here instead: in an LLM-authored run the internal functions
   * refuse a call made from the action body, while a call made from inside another library
   * function goes through (libDepth > 0). Every other trigger — the pack's behaviour hooks,
   * event handlers, timers, the Sandbox tab — reaches them normally. It keeps the model out
   * of the author's plumbing; it is not a security boundary, since every one of these
   * functions is the character's own code running with the same permissions.
   */
  var libValue = buildLib({});
  /** Greater than 0 while a library function is on the stack. */
  var libDepth = 0;

  function guardInternal(name, fn) {
    var wrapped = function () {
      if (libDepth === 0) {
        throw new Error(
          'lib.' + name + ' is an internal helper of this character: it is not listed in <library> and ' +
            'an action cannot call it. Call one of the listed functions instead.',
        );
      }
      return callDeeper(fn, this, arguments);
    };
    // Keep String(lib.<name>) the saved source, which is what the isolate reports and what
    // serialiseArg stores when a library function is handed to sdk.events.on.
    wrapped.toString = function () {
      return String(fn);
    };
    return wrapped;
  }

  function trackDepth(fn) {
    var wrapped = function () {
      return callDeeper(fn, this, arguments);
    };
    wrapped.toString = function () {
      return String(fn);
    };
    return wrapped;
  }

  /** Run fn with libDepth raised, lowering it again once it settles. */
  function callDeeper(fn, self, args) {
    libDepth++;
    var out;
    try {
      out = fn.apply(self, args);
    } catch (e) {
      libDepth--;
      throw e;
    }
    if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
      return out.then(
        function (v) {
          libDepth--;
          return v;
        },
        function (e) {
          libDepth--;
          throw e;
        },
      );
    }
    libDepth--;
    return out;
  }

  function buildLib(functions, internalNames) {
    var lib = {};
    var internal = {};
    var i;
    if (hideInternals && internalNames && typeof internalNames.length === 'number') {
      for (i = 0; i < internalNames.length; i++) internal[internalNames[i]] = true;
    }
    var names = Object.keys(functions);
    for (i = 0; i < names.length; i++) {
      var name = names[i];
      var fn = functions[name];
      if (!hideInternals || typeof fn !== 'function') lib[name] = fn;
      else if (internal[name] === true) lib[name] = guardInternal(name, fn);
      else lib[name] = trackDepth(fn);
    }
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
    value: function (functions, internalNames) {
      libValue = buildLib(functions === null || typeof functions !== 'object' ? {} : functions, internalNames);
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
