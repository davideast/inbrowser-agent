import { abortError, invalidArgType, nodeError, validateInteger } from './node-errors';
// EventEmitter behavior the `events` 3.3.0 polyfill lacks, after Node.js v22.18.0
// lib/events.js (Copyright Joyent, Inc. and other Node contributors, MIT license):
// the `captureRejections` option and static, `captureRejectionSymbol`,
// `errorMonitor`, Node's `emit` (errorMonitor, ERR_UNHANDLED_ERROR, rejected
// promise capture) and the `events.on` async iterator with `signal`, `close` and
// the high/low watermark options.
//
// The polyfill's constructor drops its argument, so a replacement constructor
// shares the polyfill's prototype and copies its statics. `instanceof` agrees in
// both directions, and the polyfill's own `EventEmitter.call(this)` sites (stream
// internals) keep working with the capture default.
//
// Not ported: EventEmitterAsyncResource (needs async_hooks) and the stack
// decoration Node adds to unhandled 'error' events.
import { inspect } from './util-inspect';

type Callable = (abstract new (...args: never[]) => unknown) | ((...args: never[]) => unknown);
type Hook = (...args: unknown[]) => unknown;
type NextTick = (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
interface Listeners {
  [type: string | symbol]: Hook | Hook[] | undefined;
}
interface Emitter {
  _events?: Listeners;
  [key: symbol]: unknown;
  emit(type: string | symbol, ...args: unknown[]): boolean;
}

const kCapture = Symbol('kCapture');
const kRejection = Symbol.for('nodejs.rejection');
const kErrorMonitor = Symbol('events.errorMonitor');
const kWatermarkData = Symbol.for('nodejs.watermarkData');

function validateBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw invalidArgType(name, 'boolean', value);
}

const AsyncIteratorPrototype = Object.getPrototypeOf(
  Object.getPrototypeOf(async function* () {}).prototype,
);

const installed = new WeakMap<object, { state: { nextTick: NextTick }; constructor: unknown }>();

/**
 * Installs the behavior on the polyfill emitter and returns the constructor to
 * expose as `require('events')`. `nextTick` is the guest's process.nextTick,
 * which schedules the rejection handlers; installing again only replaces it.
 */
export function installEventCapture<T extends Callable>(Original: T, nextTick: NextTick): T {
  const existing = installed.get(Original);
  if (existing) {
    existing.state.nextTick = nextTick;
    return existing.constructor as T;
  }
  const state = { nextTick };
  const prototype = Original.prototype as Emitter;
  const Base = Original as unknown as Record<string | symbol, unknown>;

  const init = function init(this: Emitter & Record<string | symbol, unknown>, opts?: unknown) {
    const proto = Object.getPrototypeOf(this) as Emitter;
    if (this._events === undefined || this._events === proto._events) {
      this._events = Object.create(null) as Listeners;
      (this as { _eventsCount?: number })._eventsCount = 0;
    }
    (this as { _maxListeners?: number })._maxListeners ||= undefined;
    const requested = (opts as { captureRejections?: unknown } | null | undefined)
      ?.captureRejections;
    if (requested) {
      validateBoolean(requested, 'options.captureRejections');
      this[kCapture] = Boolean(requested);
    } else {
      this[kCapture] = prototype[kCapture];
    }
  };
  Base.init = init;

  // The replacement constructor, named and sized as Node's `function EventEmitter(opts)`.
  const EventEmitter = function EventEmitter(this: Emitter, opts?: unknown) {
    init.call(this as never, opts);
  } as unknown as Record<string | symbol, unknown> & { prototype: unknown };
  Object.defineProperty(EventEmitter, 'name', { value: 'EventEmitter' });
  EventEmitter.prototype = prototype;
  Object.defineProperty(prototype, 'constructor', {
    value: EventEmitter,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  for (const key of Reflect.ownKeys(Original)) {
    if (key === 'prototype' || key === 'length' || key === 'name') continue;
    Object.defineProperty(EventEmitter, key, Object.getOwnPropertyDescriptor(Original, key)!);
  }
  EventEmitter.EventEmitter = EventEmitter;
  Base.EventEmitter = EventEmitter;
  EventEmitter.usingDomains = false;
  EventEmitter.captureRejectionSymbol = kRejection;
  EventEmitter.errorMonitor = kErrorMonitor;
  Object.defineProperty(prototype, kCapture, { value: false, writable: true, enumerable: false });
  Object.defineProperty(EventEmitter, 'captureRejections', {
    get: () => prototype[kCapture],
    set(value: unknown) {
      validateBoolean(value, 'EventEmitter.captureRejections');
      prototype[kCapture] = value;
    },
    enumerable: true,
  });

  function emitUnhandledRejectionOrErr(
    ee: Emitter,
    err: unknown,
    type: string | symbol,
    args: unknown[],
  ) {
    const rejection = ee[kRejection];
    if (typeof rejection === 'function') {
      Reflect.apply(rejection, ee, [err, type, ...args]);
      return;
    }
    // Disable capture while emitting, or a throwing handler would loop.
    const previous = ee[kCapture];
    try {
      ee[kCapture] = false;
      ee.emit('error', err);
    } finally {
      ee[kCapture] = previous;
    }
  }

  function addCatch(that: Emitter, promise: unknown, type: string | symbol, args: unknown[]) {
    if (!that[kCapture]) return;
    // A thenable's `then` may be a getter that throws.
    try {
      const then = (promise as { then?: unknown }).then;
      if (typeof then === 'function') {
        Reflect.apply(then, promise, [
          undefined,
          (err: unknown) => {
            // nextTick keeps a follow-up rejection from this promise out of the way.
            state.nextTick(emitUnhandledRejectionOrErr as never, that, err, type, args);
          },
        ]);
      }
    } catch (err) {
      that.emit('error', err);
    }
  }

  prototype.emit = function emit(this: Emitter, type: string | symbol, ...args: unknown[]) {
    let doError = type === 'error';
    const events = this._events;
    if (events !== undefined) {
      if (doError && events[kErrorMonitor] !== undefined) this.emit(kErrorMonitor, ...args);
      doError &&= events.error === undefined;
    } else if (!doError) return false;

    // No 'error' listener: throw.
    if (doError) {
      const er = args.length > 0 ? args[0] : undefined;
      if (er instanceof Error) throw er;
      let stringified: unknown;
      try {
        stringified = inspect(er);
      } catch {
        stringified = er;
      }
      const err = nodeError(
        Error,
        'ERR_UNHANDLED_ERROR',
        stringified === undefined
          ? 'Unhandled error.'
          : `Unhandled error. (${String(stringified)})`,
      );
      Object.assign(err, { context: er });
      throw err;
    }

    const handler = events![type];
    if (handler === undefined) return false;
    if (typeof handler === 'function') {
      const result = Reflect.apply(handler, this, args);
      if (result !== undefined && result !== null) addCatch(this, result, type, args);
    } else {
      const listeners = handler.slice();
      for (const listener of listeners) {
        const result = Reflect.apply(listener, this, args);
        if (result !== undefined && result !== null) addCatch(this, result, type, args);
      }
    }
    return true;
  };
  // Keep the polyfill's descriptor shape for the method.
  Object.defineProperty(prototype.emit, 'name', { value: 'emit' });

  Object.defineProperty(EventEmitter, 'on', {
    value: on,
    enumerable: true,
    writable: true,
    configurable: true,
  });

  installed.set(Original, { state, constructor: EventEmitter });
  return EventEmitter as unknown as T;
}

type Target = {
  on?: unknown;
  once?: unknown;
  removeListener?: unknown;
  removeEventListener?: unknown;
  addEventListener?: unknown;
  pause?: unknown;
  resume?: unknown;
};

function addAgnostic(emitter: Target, name: string, listener: Hook, flags?: { once?: boolean }) {
  if (typeof emitter.on === 'function') {
    if (flags?.once) Reflect.apply(emitter.once as Hook, emitter, [name, listener]);
    else Reflect.apply(emitter.on, emitter, [name, listener]);
  } else if (typeof emitter.addEventListener === 'function') {
    Reflect.apply(emitter.addEventListener, emitter, [name, listener, flags]);
  } else {
    throw invalidArgType('emitter', 'EventEmitter', emitter);
  }
}

function removeAgnostic(emitter: Target, name: string, listener: Hook, flags?: unknown) {
  if (typeof emitter.removeListener === 'function') {
    Reflect.apply(emitter.removeListener, emitter, [name, listener]);
  } else if (typeof emitter.removeEventListener === 'function') {
    Reflect.apply(emitter.removeEventListener, emitter, [name, listener, flags]);
  } else {
    throw invalidArgType('emitter', 'EventEmitter', emitter);
  }
}

interface OnOptions {
  signal?: AbortSignal;
  close?: string[];
  highWaterMark?: number;
  highWatermark?: number;
  lowWaterMark?: number;
  lowWatermark?: number;
}

/** events.on(emitter, event, options): an async iterator over `event` (Node's `on`). */
function on(emitter: unknown, event: string, options: unknown = {}) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options === 'function'
  )
    throw invalidArgType('options', 'Object', options);
  const settings = options as OnOptions;
  const signal = settings.signal;
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== 'object' || !('aborted' in signal))
  )
    throw invalidArgType('options.signal', 'AbortSignal', signal);
  if (signal?.aborted) throw abortError(undefined, { cause: signal.reason });
  // Both spellings are accepted for backward compatibility.
  const highWatermark = settings.highWaterMark ?? settings.highWatermark ?? Number.MAX_SAFE_INTEGER;
  validateInteger(highWatermark, 'options.highWaterMark', 1);
  const lowWatermark = settings.lowWaterMark ?? settings.lowWatermark ?? 1;
  validateInteger(lowWatermark, 'options.lowWaterMark', 1);

  const target = emitter as Target;
  const unconsumedEvents: unknown[] = [];
  const unconsumedPromises: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
  let paused = false;
  let error: unknown = null;
  let finished = false;
  let size = 0;
  const result = (value: unknown, done: boolean) => ({ value, done });

  const iterator = Object.setPrototypeOf(
    {
      next() {
        // Unread events first.
        if (size) {
          const value = unconsumedEvents.shift();
          size--;
          if (paused && size < lowWatermark) {
            Reflect.apply(target.resume as Hook, emitter, []);
            paused = false;
          }
          return Promise.resolve(result(value, false));
        }
        // Then a pending failure, once.
        if (error) {
          const rejected = Promise.reject(error);
          error = null;
          return rejected;
        }
        if (finished) return closeHandler();
        return new Promise((resolve, reject) => {
          unconsumedPromises.push({ resolve, reject });
        });
      },
      return() {
        return closeHandler();
      },
      throw(err: unknown) {
        if (!err || !(err instanceof Error))
          throw invalidArgType('EventEmitter.AsyncIterator', 'Error', err);
        errorHandler(err);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      [kWatermarkData]: {
        get size() {
          return size;
        },
        get low() {
          return lowWatermark;
        },
        get high() {
          return highWatermark;
        },
        get isPaused() {
          return paused;
        },
      },
    },
    AsyncIteratorPrototype,
  );

  const registered: [Target, string, Hook, unknown][] = [];
  const addListener = (item: Target, name: string, handler: Hook, flags?: { once?: boolean }) => {
    addAgnostic(item, name, handler, flags);
    registered.push([item, name, handler, flags]);
  };
  const removeAll = () => {
    while (registered.length > 0) {
      const [item, name, handler, flags] = registered.pop()!;
      removeAgnostic(item, name, handler, flags);
    }
  };

  addListener(target, event, (...args: unknown[]) => eventHandler(args));
  if (event !== 'error' && typeof target.on === 'function')
    addListener(target, 'error', errorHandler as Hook);
  const closeEvents = settings.close;
  if (closeEvents?.length) {
    for (let i = 0; i < closeEvents.length; i++) addListener(target, closeEvents[i], closeHandler);
  }

  const onAbort = () => errorHandler(abortError(undefined, { cause: signal?.reason }));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  return iterator;

  function eventHandler(value: unknown) {
    if (unconsumedPromises.length === 0) {
      size++;
      if (!paused && size > highWatermark) {
        paused = true;
        Reflect.apply(target.pause as Hook, emitter, []);
      }
      unconsumedEvents.push(value);
    } else unconsumedPromises.shift()!.resolve(result(value, false));
  }

  function errorHandler(err: unknown) {
    if (unconsumedPromises.length === 0) error = err;
    else unconsumedPromises.shift()!.reject(err);
    closeHandler();
  }

  function closeHandler() {
    signal?.removeEventListener('abort', onAbort);
    removeAll();
    finished = true;
    const done = result(undefined, true);
    while (unconsumedPromises.length > 0) unconsumedPromises.shift()!.resolve(done);
    return Promise.resolve(done);
  }
}
