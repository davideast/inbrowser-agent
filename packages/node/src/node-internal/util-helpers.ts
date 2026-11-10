// Curated Node.js v22.18.0 `lib/util.js`, `lib/internal/util/debuglog.js`, and
// `lib/internal/abort_controller.js` (`aborted`, `transferableAbort*`) helpers for `src/builtins/util.ts`.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { Buffer } from 'buffer';
import { format, formatWithOptions, inspect } from 'internal/nodelib/util/inspect';
import { createDeprecate } from '../util-promisify';
import {
  ErrnoException,
  ExceptionWithHostPort,
  codes,
  isErrorStackTraceLimitWritable,
  validateSystemErrorNumber,
} from './errors';
import { primordials } from './primordials';
import {
  getSystemErrorMap,
  getSystemErrorMessage as internalErrorMessage,
  getSystemErrorName as internalErrorName,
} from './util';
import { shouldColorize } from './util/colors';
import { isDate, isRegExp } from './util/types';

export interface UtilHelperProcess {
  pid?: number;
  env: Record<string, unknown>;
  noDeprecation?: unknown;
  emitWarning?: unknown;
  nextTick?: unknown;
  stdout?: { isTTY?: boolean; getColorDepth?: () => number; write?: (chunk: string) => unknown };
  stderr?: { isTTY?: boolean; getColorDepth?: () => number; write?: (chunk: string) => unknown };
}

type AnyFn = (...args: unknown[]) => unknown;

function captureStackTraceIfAvailable(target: object, ctor: (...args: never[]) => unknown): void {
  const fn: unknown = Reflect.get(Error, 'captureStackTrace');
  if (typeof fn === 'function') {
    Reflect.apply(fn, Error, [target, ctor]);
  }
}

function getStackTraceLimit(): number | undefined {
  const raw: unknown = Reflect.get(Error, 'stackTraceLimit');
  return typeof raw === 'number' ? raw : undefined;
}

function setStackTraceLimit(value: number | undefined): void {
  Reflect.set(Error, 'stackTraceLimit', value);
}

// Invariant: populated on `primordials` in `src/node-internal/primordials.ts`.
const promiseWithResolvers = primordials.PromiseWithResolvers as () => {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

const abortedRegistry = new FinalizationRegistry<{
  signal: AbortSignal;
  onAbort: () => void;
}>(({ signal, onAbort }) => {
  signal.removeEventListener('abort', onAbort);
});

export async function aborted(signal: unknown, resource: unknown): Promise<void> {
  if (
    signal === undefined ||
    signal === null ||
    typeof signal !== 'object' ||
    !('aborted' in signal)
  ) {
    throw new codes.ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  if (resource === null || (typeof resource !== 'object' && typeof resource !== 'function')) {
    throw new codes.ERR_INVALID_ARG_TYPE('resource', 'Object', resource);
  }
  // Invariant: narrowed above to a non-null object carrying an `aborted` property.
  const abortSignal = signal as AbortSignal;
  if (abortSignal.aborted) {
    return;
  }
  const { promise, resolve } = promiseWithResolvers();
  const token = {};
  const ref = new WeakRef(resource);
  const onAbort = (): void => {
    abortedRegistry.unregister(token);
    if (ref.deref() !== undefined) resolve();
  };
  abortSignal.addEventListener('abort', onAbort, { once: true });
  abortedRegistry.register(resource, { signal: abortSignal, onAbort }, token);
  return promise;
}

export function transferableAbortController(): AbortController {
  return new AbortController();
}

export function transferableAbortSignal(signal: unknown): AbortSignal {
  if (typeof AbortSignal !== 'function' || !(signal instanceof AbortSignal)) {
    throw new codes.ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  return signal;
}

function isObjectOrFunction(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export function inherits(ctor: unknown, superCtor: unknown): void {
  if (!isObjectOrFunction(ctor)) {
    throw new codes.ERR_INVALID_ARG_TYPE('ctor', 'Function', ctor);
  }
  if (!isObjectOrFunction(superCtor)) {
    throw new codes.ERR_INVALID_ARG_TYPE('superCtor', 'Function', superCtor);
  }
  const superProto: unknown = Reflect.get(superCtor, 'prototype');
  if (superProto === undefined || (superProto !== null && typeof superProto !== 'object')) {
    throw new codes.ERR_INVALID_ARG_TYPE('superCtor.prototype', 'Object', superProto);
  }
  const ctorProto: unknown = Reflect.get(ctor, 'prototype');
  if (ctorProto === null || typeof ctorProto !== 'object') {
    throw new codes.ERR_INVALID_ARG_TYPE('ctor.prototype', 'Object', ctorProto);
  }
  Object.defineProperty(ctor, 'super_', {
    value: superCtor,
    writable: true,
    configurable: true,
  });
  Object.setPrototypeOf(ctorProto, superProto);
}

function extendTarget(target: Record<string, unknown>, source: unknown): Record<string, unknown> {
  if (source === null || typeof source !== 'object') return target;
  const keys = Object.keys(source);
  let i = keys.length;
  while (i--) {
    const k = keys[i];
    target[k] = Reflect.get(source, k);
  }
  return target;
}

export function getSystemErrorName(err: unknown): string {
  validateSystemErrorNumber(err);
  return internalErrorName(err);
}

export function getSystemErrorMessage(err: unknown): string {
  validateSystemErrorNumber(err);
  return internalErrorMessage(err);
}

export function _errnoException(err: number, syscall: string, original?: string): Error {
  if (isErrorStackTraceLimitWritable()) {
    const limit = getStackTraceLimit();
    setStackTraceLimit(0);
    const e = new ErrnoException(err, syscall, original);
    setStackTraceLimit(limit);
    captureStackTraceIfAvailable(e, _errnoException);
    return e;
  }
  return new ErrnoException(err, syscall, original);
}

export function _exceptionWithHostPort(
  err: number,
  syscall: string,
  address: string,
  port?: number,
  additional?: string,
): Error {
  if (isErrorStackTraceLimitWritable()) {
    const limit = getStackTraceLimit();
    setStackTraceLimit(0);
    const e = new ExceptionWithHostPort(err, syscall, address, port, additional);
    setStackTraceLimit(limit);
    captureStackTraceIfAvailable(e, _exceptionWithHostPort);
    return e;
  }
  return new ExceptionWithHostPort(err, syscall, address, port, additional);
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function timestamp(): string {
  const d = new Date();
  const time = [pad2(d.getHours()), pad2(d.getMinutes()), pad2(d.getSeconds())].join(':');
  return `${d.getDate()} ${months[d.getMonth()]} ${time}`;
}

export function createUtilHelpers(proc: UtilHelperProcess) {
  const deprecate = createDeprecate(() => proc);

  const callbackifyOnRejected = (reason: unknown, cb: AnyFn): unknown => {
    let err: unknown = reason;
    if (!err) {
      const falsyErr = new codes.ERR_FALSY_VALUE_REJECTION.HideStackFramesError(reason);
      captureStackTraceIfAvailable(falsyErr, callbackifyOnRejected);
      err = falsyErr;
    }
    return cb(err);
  };

  function callbackify(original: unknown): AnyFn {
    if (typeof original !== 'function') {
      throw new codes.ERR_INVALID_ARG_TYPE('original', 'Function', original);
    }
    const targetFn = original;

    function callbackified(this: unknown, ...args: unknown[]): void {
      const maybeCb = args.pop();
      if (typeof maybeCb !== 'function') {
        throw new codes.ERR_INVALID_ARG_TYPE('last argument', 'Function', maybeCb);
      }
      // Invariant: `Function.prototype.bind` applied to narrowed `maybeCb` produces a callable bound function.
      const cb = Function.prototype.bind.call(maybeCb, this) as AnyFn;
      const scheduleTick = <A extends unknown[]>(
        fn: (...tickFnArgs: A) => unknown,
        ...tickArgs: A
      ): void => {
        if (typeof proc.nextTick === 'function') {
          Reflect.apply(proc.nextTick, proc, [fn, ...tickArgs]);
        } else {
          queueMicrotask(() => fn(...tickArgs));
        }
      };
      const returned: unknown = Reflect.apply(targetFn, this, args);
      const thenFn: unknown =
        (typeof returned === 'object' && returned !== null) || typeof returned === 'function'
          ? Reflect.get(returned, 'then')
          : undefined;
      if (typeof thenFn !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'then')");
      }
      Reflect.apply(thenFn, returned, [
        (ret: unknown) => scheduleTick(cb, null, ret),
        (rej: unknown) => scheduleTick(callbackifyOnRejected, rej, cb),
      ]);
    }

    const descriptors = Object.getOwnPropertyDescriptors(original);
    if (typeof descriptors.length?.value === 'number') {
      descriptors.length.value++;
    }
    if (typeof descriptors.name?.value === 'string') {
      descriptors.name.value += 'Callbackified';
    }
    for (const desc of Object.values(descriptors)) {
      Object.setPrototypeOf(desc, null);
    }
    Object.defineProperties(callbackified, descriptors);
    return callbackified;
  }

  // Per-process NODE_DEBUG matcher (lib/internal/util/debuglog.js)
  const rawDebugEnv: unknown = Reflect.get(proc.env, 'NODE_DEBUG');
  const initialDebugEnv = typeof rawDebugEnv === 'string' ? rawDebugEnv : '';
  let testEnabled: (section: string) => boolean;
  if (initialDebugEnv) {
    const pattern = initialDebugEnv
      .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll(',', '$|^');
    const regex = new RegExp(`^${pattern}$`, 'i');
    testEnabled = (section: string) => regex.exec(section) !== null;
  } else {
    testEnabled = () => false;
  }

  // Invariant: `Object.create(null)` initializes a prototype-free cache of per-section debug loggers.
  const debugImpls: Record<string, (...args: unknown[]) => void> = Object.create(null) as Record<
    string,
    (...args: unknown[]) => void
  >;
  const noop = (): void => {};

  function debuglogImpl(enabled: boolean, set: string): (...args: unknown[]) => void {
    if (debugImpls[set] === undefined) {
      if (enabled) {
        const pid = proc.pid ?? 1;
        if ((set === 'HTTP' || set === 'HTTP2') && typeof proc.emitWarning === 'function') {
          Reflect.apply(proc.emitWarning, proc, [
            `Setting the NODE_DEBUG environment variable to '${set.toLowerCase()}' can expose sensitive data (such as passwords, tokens and authentication headers) in the resulting log.`,
          ]);
        }
        debugImpls[set] = function debug(...args: unknown[]): void {
          const colors = shouldColorize(proc.stderr);
          const msg = formatWithOptions({ colors }, ...args);
          const coloredPid = inspect(pid, { colors });
          const line = format('%s %s: %s\n', set, coloredPid, msg);
          if (proc.stderr?.write) {
            proc.stderr.write(line);
          }
        };
      } else {
        debugImpls[set] = noop;
      }
    }
    return debugImpls[set];
  }

  function debuglog(
    rawSet: string,
    cb?: (fn: (...args: unknown[]) => void) => void,
  ): ((...args: unknown[]) => void) & { readonly enabled: boolean } {
    let set = rawSet;
    let enabled: boolean | undefined;
    const init = (): void => {
      set = String(set).toUpperCase();
      enabled = testEnabled(set);
    };
    let debug = (...args: unknown[]): void => {
      init();
      debug = debuglogImpl(Boolean(enabled), set);
      if (typeof cb === 'function') cb(debug);
      debug(...args);
    };
    let test = (): boolean => {
      init();
      const resolved = Boolean(enabled);
      test = () => resolved;
      return resolved;
    };
    const baseLogger = (...args: unknown[]): void => {
      if (enabled === false) return;
      debug(...args);
    };
    Object.defineProperty(baseLogger, 'enabled', {
      get() {
        return test();
      },
      configurable: true,
      enumerable: true,
    });
    // Invariant: `Object.defineProperty` immediately above defines the `enabled: boolean` getter on `baseLogger`.
    return baseLogger as ((...args: unknown[]) => void) & { readonly enabled: boolean };
  }

  function log(...args: unknown[]): void {
    const line = `${format('%s - %s', timestamp(), format(...args))}\n`;
    proc.stdout?.write?.(line);
  }

  const isBoolean = (arg: unknown): arg is boolean => typeof arg === 'boolean';
  const isNull = (arg: unknown): arg is null => arg === null;
  const isNullOrUndefined = (arg: unknown): arg is null | undefined =>
    arg === null || arg === undefined;
  const isNumber = (arg: unknown): arg is number => typeof arg === 'number';
  const isString = (arg: unknown): arg is string => typeof arg === 'string';
  const isSymbol = (arg: unknown): arg is symbol => typeof arg === 'symbol';
  const isUndefined = (arg: unknown): arg is undefined => arg === undefined;
  const isObject = (arg: unknown): arg is object => arg !== null && typeof arg === 'object';
  const isErrorPred = (e: unknown): e is Error =>
    Object.prototype.toString.call(e) === '[object Error]' || e instanceof Error;
  const isFunction = (arg: unknown): arg is AnyFn => typeof arg === 'function';
  const isPrimitive = (arg: unknown): boolean =>
    arg === null || (typeof arg !== 'object' && typeof arg !== 'function');

  return {
    _errnoException,
    _exceptionWithHostPort,
    _extend: deprecate(
      extendTarget,
      'The `util._extend` API is deprecated. Please use Object.assign() instead.',
      'DEP0060',
    ),
    aborted,
    callbackify,
    debug: debuglog,
    debuglog,
    getSystemErrorMap,
    getSystemErrorName,
    getSystemErrorMessage,
    inherits,
    isArray: deprecate(
      Array.isArray,
      'The `util.isArray` API is deprecated. Please use `Array.isArray()` instead.',
      'DEP0044',
    ),
    isBoolean: deprecate(
      isBoolean,
      'The `util.isBoolean` API is deprecated.  Please use `typeof arg === "boolean"` instead.',
      'DEP0045',
    ),
    isBuffer: deprecate(
      Buffer.isBuffer,
      'The `util.isBuffer` API is deprecated. Please use `Buffer.isBuffer()` instead.',
      'DEP0046',
    ),
    isDate: deprecate(
      isDate,
      'The `util.isDate` API is deprecated.  Please use `arg instanceof Date` instead.',
      'DEP0047',
    ),
    isError: deprecate(
      isErrorPred,
      'The `util.isError` API is deprecated. Please use `ObjectPrototypeToString(e) === "[object Error]" || e instanceof Error` instead.',
      'DEP0048',
    ),
    isFunction: deprecate(
      isFunction,
      'The `util.isFunction` API is deprecated.  Please use `typeof arg === "function"` instead.',
      'DEP0049',
    ),
    isNull: deprecate(
      isNull,
      'The `util.isNull` API is deprecated. Please use `arg === null` instead.',
      'DEP0050',
    ),
    isNullOrUndefined: deprecate(
      isNullOrUndefined,
      'The `util.isNullOrUndefined` API is deprecated. Please use `arg === null || arg === undefined` instead.',
      'DEP0051',
    ),
    isNumber: deprecate(
      isNumber,
      'The `util.isNumber` API is deprecated. Please use `typeof arg === "number"` instead.',
      'DEP0052',
    ),
    isObject: deprecate(
      isObject,
      'The `util.isObject` API is deprecated. Please use `arg !== null && typeof arg === "object"` instead.',
      'DEP0053',
    ),
    isPrimitive: deprecate(
      isPrimitive,
      'The `util.isPrimitive` API is deprecated. Please use `arg === null || (typeof arg !== "object" && typeof arg !== "function")` instead.',
      'DEP0054',
    ),
    isRegExp: deprecate(
      isRegExp,
      'The `util.isRegExp` API is deprecated. Please use `arg instanceof RegExp` instead.',
      'DEP0055',
    ),
    isString: deprecate(
      isString,
      'The `util.isString` API is deprecated.  Please use `typeof arg === "string"` instead.',
      'DEP0056',
    ),
    isSymbol: deprecate(
      isSymbol,
      'The `util.isSymbol` API is deprecated.  Please use `arg === "symbol"` instead.',
      'DEP0057',
    ),
    isUndefined: deprecate(
      isUndefined,
      'The `util.isUndefined` API is deprecated. Please use `arg === undefined` instead.',
      'DEP0058',
    ),
    log: deprecate(
      log,
      'The `util.log API is deprecated. Please use console.log() with a custom formatter or a third-party logger instead.',
      'DEP0059',
    ),
    transferableAbortController,
    transferableAbortSignal,
  };
}
