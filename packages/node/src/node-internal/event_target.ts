// Browser-safe `internal/event_target` bridge for upstream Node `lib/events.js`
// and `lib/internal/events/abort_listener.js`.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).
//
// Native browser `EventTarget` instances keep their listener lists in C++/DOM
// slots that JS cannot enumerate directly. Wrapping `addEventListener` and
// `removeEventListener` once on `EventTarget.prototype` exposes Node's
// `[kEvents]` linked-list view for `events.getEventListeners`, tracks
// `kMaxEventTargetListeners` / `kMaxEventTargetListenersWarned`, and emits
// `MaxListenersExceededWarning` via `process.emitWarning`.

import { inspect } from 'internal/nodelib/util/inspect';
import { activeProcess } from './process-ref';

export const kEvents = Symbol('kEvents');
export const kResistStopPropagation = Symbol('kResistStopPropagation');

export interface EventTargetEmitterStatics {
  defaultMaxListeners: number;
  readonly kMaxEventTargetListeners: symbol;
  readonly kMaxEventTargetListenersWarned: symbol;
}

interface ListenerRecord {
  listener: unknown;
  capture: boolean;
  onceCleanup?: EventListener;
  abortCleanup?: EventListener;
  signal?: AbortSignal;
}

interface LinkedListenerNode {
  listener: unknown;
  next: LinkedListenerNode | undefined;
}

type Listener = EventListenerOrEventListenerObject | null;
type AddOptions = boolean | AddEventListenerOptions | undefined;

const recorded = new WeakMap<object, Map<unknown, ListenerRecord[]>>();
const targetWarned = new WeakMap<object, boolean>();
let installed = false;

function captureOf(options: AddOptions): boolean {
  return typeof options === 'boolean' ? options : Boolean(options?.capture);
}

export function isEventTarget(value: unknown): value is EventTarget {
  return typeof EventTarget === 'function' && value instanceof EventTarget;
}

export function installEventTargetBridge(EventEmitter: EventTargetEmitterStatics): void {
  if (installed || typeof EventTarget !== 'function') return;
  installed = true;

  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const maxListenersSym = EventEmitter.kMaxEventTargetListeners;
  const maxListenersWarnedSym = EventEmitter.kMaxEventTargetListenersWarned;

  Object.defineProperties(proto, {
    [kEvents]: {
      configurable: true,
      enumerable: false,
      get(this: unknown) {
        if (!isEventTarget(this)) return undefined;
        return {
          get: (type: unknown) => {
            const list = recorded.get(this)?.get(type);
            if (!list || list.length === 0) return undefined;
            let next: LinkedListenerNode | undefined;
            for (let i = list.length - 1; i >= 0; i--) {
              next = { listener: list[i].listener, next };
            }
            return { size: list.length, next };
          },
        };
      },
    },
    [maxListenersSym]: {
      configurable: true,
      enumerable: false,
      get(this: unknown) {
        if (!isEventTarget(this)) return undefined;
        return typeof AbortSignal === 'function' && this instanceof AbortSignal
          ? 0
          : EventEmitter.defaultMaxListeners;
      },
      set(this: object, value: unknown) {
        Object.defineProperty(this, maxListenersSym, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    },
    [maxListenersWarnedSym]: {
      configurable: true,
      enumerable: false,
      get(this: unknown) {
        return isEventTarget(this) ? Boolean(targetWarned.get(this)) : undefined;
      },
      set(this: object, value: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          targetWarned.delete(this);
        }
        Object.defineProperty(this, maxListenersWarnedSym, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    },
  });

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

  proto.addEventListener = function addEventListener(
    this: EventTarget,
    type: string,
    listener: Listener,
    options?: AddOptions,
  ) {
    const signal = typeof options === 'object' && options !== null ? options.signal : undefined;
    const alreadyAborted = signal?.aborted === true;
    Reflect.apply(add, this, [type, listener, options]);
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

    if (typeof options === 'object' && options !== null && options.once) {
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

    const maxRaw: unknown = Reflect.get(this, maxListenersSym, this);
    const max = typeof maxRaw === 'number' ? maxRaw : EventEmitter.defaultMaxListeners;
    const alreadyWarned = Boolean(Reflect.get(this, maxListenersWarnedSym, this));
    if (max > 0 && list.length > max && !alreadyWarned) {
      if (Object.prototype.hasOwnProperty.call(this, maxListenersWarnedSym)) {
        Reflect.set(this, maxListenersWarnedSym, true, this);
      } else {
        targetWarned.set(this, true);
      }
      const targetLabel =
        Object.getPrototypeOf(this) === proto
          ? this.constructor?.name || 'EventTarget'
          : inspect(this, { depth: -1 });
      const warning = Object.assign(
        new Error(
          `Possible EventTarget memory leak detected. ${list.length} ${eventType} listeners ` +
            `added to ${targetLabel}. MaxListeners is ${max}. Use events.setMaxListeners() to increase limit`,
        ),
        {
          name: 'MaxListenersExceededWarning',
          target: this,
          type: eventType,
          count: list.length,
        },
      );
      activeProcess().emitWarning?.(warning);
    }
    // Invariant: DOM lib adds target-specific overloads on `addEventListener`; the runtime wrapper accepts all Web/Node inputs.
  } as typeof proto.addEventListener;

  proto.removeEventListener = function removeEventListener(
    this: EventTarget,
    type: string,
    listener: Listener,
    options?: boolean | EventListenerOptions,
  ) {
    Reflect.apply(remove, this, [type, listener, options]);
    forget(this, String(type), listener, captureOf(options));
    // Invariant: DOM lib adds target-specific overloads on `removeEventListener`; the runtime wrapper accepts all Web/Node inputs.
  } as typeof proto.removeEventListener;
}
