// Static events and AbortSignal helpers the `events` 3.3.0 polyfill and browser
// globals lack: setMaxListeners (with EventTarget support), getMaxListeners,
// getEventListeners, addAbortListener, once (with EventTarget + AbortSignal),
// listenerCount (static + prototype 2-arg listener filter), and Node-compatible
// AbortSignal.{abort,timeout,any} + AbortController#abort.
// Behavior and messages follow Node.js v22.18.0 lib/events.js,
// lib/internal/events/abort_listener.js, and lib/internal/abort_controller.js
// (Copyright Joyent, Inc. and other Node contributors, MIT license).
//
// Node keeps EventTarget listeners in private slots. Browser EventTargets cannot
// be enumerated, so addEventListener and removeEventListener are wrapped once to
// record them for getEventListeners. The wrapper delegates to the original for all
// behavior and records only what the original accepted.
import {
  abortError,
  invalidArgType,
  nodeError,
  validateInteger,
  validateNumber,
  validateObject,
} from './node-errors';

interface Emitter {
  defaultMaxListeners: number;
  prototype: object;
}
interface ListenerRecord {
  listener: unknown;
  capture: boolean;
  onceCleanup?: EventListener;
  abortCleanup?: EventListener;
  signal?: AbortSignal;
}
interface AgnosticTarget {
  on?: unknown;
  once?: unknown;
  removeListener?: unknown;
  addEventListener?: unknown;
  removeEventListener?: unknown;
}
type Hook = (...args: unknown[]) => unknown;
type Listener = EventListenerOrEventListenerObject | null;
type AddOptions = boolean | AddEventListenerOptions | undefined;

const kMaxEventTargetListeners = Symbol('events.maxEventTargetListeners');
const kMaxEventTargetListenersWarned = Symbol('events.maxEventTargetListenersWarned');

const recorded = new WeakMap<object, Map<string, ListenerRecord[]>>();
let tracking = false;

const savedControllerAbort =
  typeof AbortController === 'function' ? AbortController.prototype.abort : undefined;
const savedSignalAbort = typeof AbortSignal === 'function' ? AbortSignal.abort : undefined;
// Chromium 116+ defines AbortSignal.any on the constructor even though older TS DOM libs omit it.
const savedSignalAny =
  typeof AbortSignal === 'function'
    ? (AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }).any
    : undefined;

function captureOf(options: AddOptions): boolean {
  return typeof options === 'boolean' ? options : Boolean(options?.capture);
}

function trackEventTargets() {
  if (tracking) return;
  tracking = true;
  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const cleanupEntry = (target: EventTarget, type: string, entry: ListenerRecord) => {
    const list = recorded.get(target)?.get(type);
    if (list) {
      const idx = list.indexOf(entry);
      if (idx >= 0) list.splice(idx, 1);
    }
    if (entry.onceCleanup) {
      const fn = entry.onceCleanup;
      entry.onceCleanup = undefined;
      Reflect.apply(remove, target, [type, fn, { capture: entry.capture }]);
    }
    if (entry.signal && entry.abortCleanup) {
      const sig = entry.signal;
      const fn = entry.abortCleanup;
      entry.signal = undefined;
      entry.abortCleanup = undefined;
      Reflect.apply(remove, sig, ['abort', fn]);
    }
  };
  const forget = (target: EventTarget, type: string, listener: unknown, capture: boolean) => {
    const list = recorded.get(target)?.get(type);
    const entry = list?.find((item) => item.listener === listener && item.capture === capture);
    if (entry) cleanupEntry(target, type, entry);
  };
  // The replacement preserves EventTarget#addEventListener's signature while recording entries.
  proto.addEventListener = function addEventListener(
    this: EventTarget,
    type: string,
    listener: Listener,
    options?: AddOptions,
  ) {
    const signal = typeof options === 'object' ? options?.signal : undefined;
    const alreadyAborted = signal?.aborted === true;
    Reflect.apply(add, this, [type, listener, options]);
    // A null listener, a pre-aborted signal and a duplicate registration are no-ops.
    if (listener == null || alreadyAborted) return;
    const capture = captureOf(options);
    const eventType = String(type);
    let byType = recorded.get(this);
    if (!byType) recorded.set(this, (byType = new Map()));
    let list = byType.get(eventType);
    if (!list) byType.set(eventType, (list = []));
    if (list.some((item) => item.listener === listener && item.capture === capture)) return;
    const entry: ListenerRecord = { listener, capture };
    list.push(entry);
    if (typeof options === 'object' && options?.once) {
      // Registered after the original, so it runs after it and drops the record + abort hook.
      const onceCleanup: EventListener = () => {
        entry.onceCleanup = undefined;
        cleanupEntry(this, eventType, entry);
      };
      entry.onceCleanup = onceCleanup;
      Reflect.apply(add, this, [eventType, onceCleanup, { once: true, capture }]);
    }
    if (signal instanceof EventTarget) {
      const abortCleanup: EventListener = () => {
        entry.abortCleanup = undefined;
        cleanupEntry(this, eventType, entry);
      };
      entry.signal = signal;
      entry.abortCleanup = abortCleanup;
      Reflect.apply(add, signal, ['abort', abortCleanup, { once: true }]);
    }
  } as typeof proto.addEventListener;
  // The replacement preserves EventTarget#removeEventListener's signature while forgetting entries.
  proto.removeEventListener = function removeEventListener(
    this: EventTarget,
    type: string,
    listener: Listener,
    options?: boolean | EventListenerOptions,
  ) {
    Reflect.apply(remove, this, [type, listener, options]);
    forget(this, String(type), listener, captureOf(options));
  } as typeof proto.removeEventListener;
}

function isEventTarget(value: unknown): value is EventTarget {
  return typeof EventTarget === 'function' && value instanceof EventTarget;
}

const invalidEmitter = (name: string, value: unknown) =>
  invalidArgType(name, ['EventEmitter', 'EventTarget'], value);

function eventTargetAgnosticAddListener(
  emitter: unknown,
  name: string | symbol,
  listener: Hook,
  flags?: { once?: boolean },
): void {
  // Null or undefined throws the native property-access TypeError, matching Node's helper.
  const target = emitter as AgnosticTarget;
  if (typeof target.on === 'function') {
    if (flags?.once) {
      // Node 22.18 lib/events.js:1033 calls `emitter.once(name, listener)` directly.
      (emitter as { once(event: string | symbol, fn: Hook): unknown }).once(name, listener);
    } else {
      // Verified `typeof target.on === 'function'` above.
      Reflect.apply(target.on as Hook, emitter, [name, listener]);
    }
  } else if (typeof target.addEventListener === 'function') {
    // Verified `typeof target.addEventListener === 'function'` above.
    Reflect.apply(target.addEventListener as Hook, emitter, [name, listener, flags]);
  } else {
    throw invalidArgType('emitter', 'EventEmitter', emitter);
  }
}

function eventTargetAgnosticRemoveListener(
  emitter: unknown,
  name: string | symbol,
  listener: Hook,
  flags?: unknown,
): void {
  // Null or undefined throws the native property-access TypeError, matching Node's helper.
  const target = emitter as AgnosticTarget;
  if (typeof target.removeListener === 'function') {
    Reflect.apply(target.removeListener as Hook, emitter, [name, listener]);
  } else if (typeof target.removeEventListener === 'function') {
    Reflect.apply(target.removeEventListener as Hook, emitter, [name, listener, flags]);
  } else {
    throw invalidArgType('emitter', 'EventEmitter', emitter);
  }
}

export function installEventStatics(EventEmitter: Emitter): void {
  trackEventTargets();
  // EventEmitter is a function object whose static and prototype properties are configured here.
  const target = EventEmitter as unknown as Record<string | symbol, unknown>;
  const define = (key: string | symbol, value: unknown, enumerable: boolean) =>
    Object.defineProperty(target, key, {
      value,
      enumerable,
      writable: enumerable,
      configurable: true,
    });

  const maxListenersOf = (that: { _maxListeners?: number }) =>
    that._maxListeners === undefined ? EventEmitter.defaultMaxListeners : that._maxListeners;

  // Node assigns an anonymous function, so its name is empty and length is 0.
  const setMaxListeners = {
    '': (n: unknown = EventEmitter.defaultMaxListeners, ...eventTargets: unknown[]) => {
      validateNumber(n, 'setMaxListeners', 0);
      if (eventTargets.length === 0) {
        // validateNumber above verified `n` is a number >= 0.
        EventEmitter.defaultMaxListeners = n as number;
        return;
      }
      for (const item of eventTargets) {
        if (isEventTarget(item)) {
          // EventTarget is an object and accepts symbol-keyed private slots.
          const slots = item as unknown as Record<symbol, unknown>;
          slots[kMaxEventTargetListeners] = n;
          slots[kMaxEventTargetListenersWarned] = false;
        } else if (typeof (item as { setMaxListeners?: unknown }).setMaxListeners === 'function') {
          // Verified item has a callable setMaxListeners method and n is a validated number.
          (item as { setMaxListeners(count: number): void }).setMaxListeners(n as number);
        } else {
          throw invalidEmitter('eventTargets', item);
        }
      }
    },
  }[''];

  function getMaxListeners(emitterOrTarget: unknown): number {
    // Optional chaining safely probes nullish or primitive inputs before narrowing.
    const candidate = emitterOrTarget as
      | { getMaxListeners?: unknown; [kMaxEventTargetListeners]?: unknown }
      | null
      | undefined;
    if (typeof candidate?.getMaxListeners === 'function')
      return maxListenersOf(candidate as { _maxListeners?: number });
    if (typeof candidate?.[kMaxEventTargetListeners] === 'number')
      return candidate[kMaxEventTargetListeners];
    // Node's EventTarget constructor records the default limit; a browser
    // EventTarget has no constructor hook, so an unset one reports the current default.
    if (isEventTarget(emitterOrTarget)) return EventEmitter.defaultMaxListeners;
    throw invalidEmitter('emitter', emitterOrTarget);
  }

  function getEventListeners(emitterOrTarget: unknown, type: unknown): unknown[] {
    // Null/undefined throws on property read just as Node's `emitterOrTarget.listeners` check does.
    const candidate = emitterOrTarget as { listeners?: unknown };
    if (typeof candidate.listeners === 'function')
      return Reflect.apply(candidate.listeners as Hook, emitterOrTarget, [type]) as unknown[];
    if (isEventTarget(emitterOrTarget)) {
      const list = recorded.get(emitterOrTarget)?.get(String(type));
      return list ? list.map((entry) => entry.listener) : [];
    }
    throw invalidEmitter('emitter', emitterOrTarget);
  }

  function listenerCount(
    this: { _events?: Record<string | symbol, unknown> },
    type: string | symbol,
    listener?: unknown,
  ): number {
    const events = this._events;
    if (events !== undefined) {
      const evlistener = events[type];
      if (typeof evlistener === 'function') {
        if (listener != null) {
          // `events` 3.3.0 once-wrappers store the original function on `.listener`.
          const wrapped = (evlistener as { listener?: unknown }).listener;
          return listener === evlistener || listener === wrapped ? 1 : 0;
        }
        return 1;
      }
      if (Array.isArray(evlistener)) {
        if (listener != null) {
          let matching = 0;
          for (let i = 0; i < evlistener.length; i++) {
            const entry: unknown = evlistener[i];
            const wrapped =
              typeof entry === 'function' ? (entry as { listener?: unknown }).listener : undefined;
            if (entry === listener || wrapped === listener) matching++;
          }
          return matching;
        }
        return evlistener.length;
      }
    }
    return 0;
  }

  // Node assigns `EventEmitter.listenerCount = function(emitter, type)` (name === '', length === 2).
  const staticListenerCount = {
    '': (emitter: unknown, type: string | symbol): number => {
      // Null/undefined throws on property read just as Node's `emitter.listenerCount` check does.
      const candidate = emitter as { listenerCount?: unknown };
      if (typeof candidate.listenerCount === 'function') {
        return Reflect.apply(candidate.listenerCount as Hook, emitter, [type]) as number;
      }
      return Reflect.apply(listenerCount, emitter, [type]) as number;
    },
  }[''];

  async function once(
    emitter: unknown,
    name: string | symbol,
    options: unknown = {},
  ): Promise<unknown[]> {
    validateObject(options, 'options');
    const { signal } = options;
    if (
      signal !== undefined &&
      (signal === null || typeof signal !== 'object' || !('aborted' in signal))
    )
      throw invalidArgType('options.signal', 'AbortSignal', signal);
    // Validated above as either undefined or an AbortSignal-shaped object.
    const abortSignal = signal as AbortSignal | undefined;
    if (abortSignal?.aborted) throw abortError(undefined, { cause: abortSignal.reason });

    return new Promise<unknown[]>((resolve, reject) => {
      // Accessed only after agnosticAddListener or guarded `typeof` checks.
      const candidate = emitter as AgnosticTarget;
      const errorListener = (err: unknown) => {
        if (typeof candidate.removeListener === 'function') {
          Reflect.apply(candidate.removeListener as Hook, emitter, [name, resolver]);
        }
        if (abortSignal != null) {
          eventTargetAgnosticRemoveListener(abortSignal, 'abort', abortListener);
        }
        reject(err);
      };
      const resolver = (...args: unknown[]) => {
        if (typeof candidate.removeListener === 'function') {
          Reflect.apply(candidate.removeListener as Hook, emitter, ['error', errorListener]);
        }
        if (abortSignal != null) {
          eventTargetAgnosticRemoveListener(abortSignal, 'abort', abortListener);
        }
        resolve(args);
      };
      const opts = Object.assign(Object.create(null) as { once: boolean }, { once: true });
      eventTargetAgnosticAddListener(emitter, name, resolver, opts);
      if (name !== 'error' && typeof candidate.once === 'function') {
        Reflect.apply(candidate.once as Hook, emitter, ['error', errorListener]);
      }
      function abortListener() {
        eventTargetAgnosticRemoveListener(emitter, name, resolver);
        eventTargetAgnosticRemoveListener(emitter, 'error', errorListener);
        reject(abortError(undefined, { cause: abortSignal?.reason }));
      }
      if (abortSignal != null) {
        const abortOpts = Object.assign(Object.create(null) as { once: boolean }, { once: true });
        eventTargetAgnosticAddListener(abortSignal, 'abort', abortListener, abortOpts);
      }
    });
  }

  function addAbortListener(signal: unknown, listener: unknown) {
    if (signal === undefined) throw invalidArgType('signal', 'AbortSignal', signal);
    if (signal === null || typeof signal !== 'object' || !('aborted' in signal))
      throw invalidArgType('signal', 'AbortSignal', signal);
    if (typeof listener !== 'function') throw invalidArgType('listener', 'Function', listener);
    // Validated above as an object with `aborted` and `listener` as a function.
    const abortSignal = signal as AbortSignal;
    let removeEventListener: (() => void) | undefined;
    if (abortSignal.aborted) {
      queueMicrotask(() => (listener as () => void)());
    } else {
      abortSignal.addEventListener('abort', listener as EventListener, { once: true });
      removeEventListener = () => {
        abortSignal.removeEventListener('abort', listener as EventListener);
      };
    }
    const dispose: symbol =
      (Symbol as unknown as { dispose?: symbol }).dispose ?? Symbol.for('nodejs.dispose');
    return Object.defineProperty(Object.create(null), dispose, {
      value() {
        removeEventListener?.();
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  Object.defineProperty(EventEmitter.prototype, 'listenerCount', {
    value: listenerCount,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  define('setMaxListeners', setMaxListeners, true);
  define('getMaxListeners', getMaxListeners, true);
  define('getEventListeners', getEventListeners, true);
  define('listenerCount', staticListenerCount, true);
  define('once', once, true);
  define('addAbortListener', addAbortListener, true);
  define('kMaxEventTargetListeners', kMaxEventTargetListeners, false);
  define('kMaxEventTargetListenersWarned', kMaxEventTargetListenersWarned, false);
}

/**
 * Aligns global `AbortSignal.{abort,timeout,any}` and `AbortController#abort`
 * with Node 22.18 error codes, default abort reasons, descriptors, and
 * unreferenced guest timer scheduling (preserving AsyncLocalStorage context).
 */
export function installAbortSignalStatics(
  setTimeoutFn: (callback: () => void, delay: number) => { unref(): unknown },
): void {
  if (typeof AbortSignal !== 'function' || typeof AbortController !== 'function') return;

  if (typeof savedControllerAbort === 'function') {
    const controllerAbort = {
      abort(
        this: AbortController,
        reason: unknown = new DOMException('This operation was aborted', 'AbortError'),
      ): void {
        Reflect.apply(savedControllerAbort, this, [reason]);
      },
    }.abort;
    Object.defineProperty(AbortController.prototype, 'abort', {
      value: controllerAbort,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  if (typeof savedSignalAbort === 'function') {
    const signalAbort = {
      abort(
        reason: unknown = new DOMException('This operation was aborted', 'AbortError'),
      ): AbortSignal {
        return Reflect.apply(savedSignalAbort, AbortSignal, [reason]) as AbortSignal;
      },
    }.abort;
    Object.defineProperty(AbortSignal, 'abort', {
      value: signalAbort,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  const signalTimeout = {
    timeout(delay: unknown): AbortSignal {
      validateInteger(delay, 'delay', 0, 4294967295);
      const controller = new AbortController();
      // validateInteger narrowed `delay` to a safe uint32 integer.
      setTimeoutFn(
        () =>
          controller.abort(
            new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
          ),
        delay as number,
      ).unref();
      return controller.signal;
    },
  }.timeout;
  Object.defineProperty(AbortSignal, 'timeout', {
    value: signalTimeout,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  if (typeof savedSignalAny === 'function') {
    const signalAny = {
      any(signals: unknown): AbortSignal {
        // WebIDL sequence conversion in Node's internal/webidl.js requires an Object before Symbol.iterator.
        if ((typeof signals !== 'object' || signals === null) && typeof signals !== 'function') {
          throw nodeError(
            TypeError,
            'ERR_INVALID_ARG_TYPE',
            'Value can not be converted to sequence.',
          );
        }
        // Verified `signals` is an object or function above.
        const iteratorMethod: unknown = Reflect.get(signals, Symbol.iterator);
        if (typeof iteratorMethod !== 'function') {
          throw nodeError(
            TypeError,
            'ERR_INVALID_ARG_TYPE',
            'Value can not be converted to sequence.',
          );
        }
        const rawItems: unknown[] = [];
        // Verified `signals` implements a callable `[Symbol.iterator]` above.
        for (const item of signals as Iterable<unknown>) {
          rawItems.push(item);
        }
        const list: AbortSignal[] = [];
        for (let i = 0; i < rawItems.length; i++) {
          const item = rawItems[i];
          if (!(item instanceof AbortSignal)) {
            throw invalidArgType(`signals[${i}]`, 'AbortSignal', item);
          }
          list.push(item);
        }
        // Native AbortSignal.any returns a composite AbortSignal.
        return Reflect.apply(savedSignalAny, AbortSignal, [list]) as AbortSignal;
      },
    }.any;
    Object.defineProperty(AbortSignal, 'any', {
      value: signalAny,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}
