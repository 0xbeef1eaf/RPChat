/**
 * Source of the bootstrap function evaluated inside a fresh isolate before the
 * user's code. Evaluating it yields a function `(surfaceJson, hostCall, log, restrictInternals, libCall)`
 * which the runner calls once with:
 *
 * - `surfaceJson`: `JSON.stringify(SdkSurface)`;
 * - `hostCall(module, method, argsJson) => Promise<string>`: host function
 *   returning the JSON text of a `CapabilityResult`;
 * - `log(level, message) => void`: host function capturing log output;
 * - `restrictInternals`: true for an LLM-authored run, where the action body may
 *   not call the library's `@internal` helpers (see `__rp_lib` below);
 * - `libCall(name, reportJson) => void`: host function told about each settled
 *   `lib.<name>(...)` call so the action log can show it.
 *
 * It installs the frozen globals `sdk` and `console`, plus `__rp_lib`. Nothing
 * else leaks into the isolate: `hostCall`, `log` and `libCall` are captured by
 * closures only, so user code can only reach the host through the methods listed
 * in the surface.
 *
 * `console.*` is synchronous and captured locally; it never crosses to the
 * host as a call.
 * Dotted method names (`session.get`) are exposed one level deep
 * (`sdk.state.session.get`).
 *
 * `lib` is not a module of the surface: `__rp_lib(functions, internalNames)` builds the
 * character's function library — the `lib` the prelude defines — out of the exports of
 * its pack's `lib/` folder, and `sdk.lib` reads back whatever it last built. `sdk.lib.cheer()` is therefore the same
 * call as `lib.cheer()`, which is what characters kept writing anyway.
 */
export const BOOTSTRAP_SOURCE = String.raw`(function (surfaceJson, hostCall, log, restrictInternals, libCall) {
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
    // sdk.lib is the character's library (below), never a module of the surface.
    if (mod.id !== 'lib') sdk[mod.id] = Object.freeze(target);
  }

  /**
   * The character's function library. The prelude the host prepends to the code calls
   * __rp_lib once ("const lib = __rp_lib(<bundle>, ["helper"]);"): the first argument is the
   * object of every export of the pack's lib/ folder, the second names the exports tagged
   * @internal. A library function that imports a sibling calls it directly, past this object.
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
   *
   * Every exported function is wrapped in every run, whatever the trigger, because the wrapper
   * is also what reports the call to the host for the action log (reportLibCall).
   */
  var libValue = buildLib({});
  /** Greater than 0 while a library function is on the stack. */
  var libDepth = 0;

  /**
   * Tell the host a library call settled, so it lands in the action log beside the sdk
   * calls the same code made. One synchronous crossing per call, like console: nothing is
   * awaited and the report cannot change what the function already returned, so a host
   * that chooses not to listen costs the run nothing.
   */
  function reportLibCall(name, args, outcome, message, startedAt) {
    if (typeof libCall !== 'function') return;
    var report = { args: args, outcome: outcome, durationMs: Date.now() - startedAt };
    if (message !== undefined) report.message = message;
    var json;
    try {
      json = JSON.stringify(report, function (key, value) {
        return typeof value === 'function' ? '[function]' : value;
      });
    } catch (e) {
      // A cyclic argument, or one holding a bigint: still log the call, and say so in place of them.
      report.args = ['[arguments are not JSON-serialisable]'];
      json = JSON.stringify(report);
    }
    libCall(name, json);
  }

  /** Why a library call failed, in one line and bounded: it reaches the action log as the entry's error. */
  function failureMessage(e) {
    var text = e instanceof Error ? e.name + ': ' + e.message : formatArg(e);
    return text.length > 1024 ? text.slice(0, 1024) + '… (' + text.length + ' chars)' : text;
  }

  function guardInternal(name, fn) {
    var wrapped = function () {
      if (libDepth === 0) {
        var refusal =
          'lib.' + name + ' is an internal helper of this character: it is not listed in <library> and ' +
          'an action cannot call it. Call one of the listed functions instead.';
        reportLibCall(name, Array.prototype.slice.call(arguments), 'denied', refusal, Date.now());
        throw new Error(refusal);
      }
      return callDeeper(name, fn, this, arguments);
    };
    // Keep String(lib.<name>) the saved source, which is what the isolate reports and what
    // serialiseArg stores when a library function is handed to sdk.events.on.
    wrapped.toString = function () {
      return String(fn);
    };
    return wrapped;
  }

  function trackDepth(name, fn) {
    var wrapped = function () {
      return callDeeper(name, fn, this, arguments);
    };
    wrapped.toString = function () {
      return String(fn);
    };
    return wrapped;
  }

  /** Run fn with libDepth raised, lowering it again once it settles, and report the call. */
  function callDeeper(name, fn, self, args) {
    var list = Array.prototype.slice.call(args);
    var startedAt = Date.now();
    libDepth++;
    var out;
    try {
      out = fn.apply(self, args);
    } catch (e) {
      libDepth--;
      reportLibCall(name, list, 'failed', failureMessage(e), startedAt);
      throw e;
    }
    if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
      return out.then(
        function (v) {
          libDepth--;
          reportLibCall(name, list, 'allowed', undefined, startedAt);
          return v;
        },
        function (e) {
          libDepth--;
          reportLibCall(name, list, 'failed', failureMessage(e), startedAt);
          throw e;
        },
      );
    }
    libDepth--;
    reportLibCall(name, list, 'allowed', undefined, startedAt);
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
      if (typeof fn !== 'function') lib[name] = fn;
      else if (internal[name] === true) lib[name] = guardInternal(name, fn);
      else lib[name] = trackDepth(name, fn);
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
