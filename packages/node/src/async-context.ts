import { installContextPromise } from './context-promise';
import { fault, record } from './protocol';

type Callback = (...args: unknown[]) => unknown;

function invalidArgument(message: string): TypeError {
  return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
}

/**
 * Owned by one process Worker. Frames are immutable values and `current` is the
 * active one. The model follows Node 22's, where a store lives on the executing
 * resource:
 *   - `run` and `enterWith` change one storage's slot in the current frame;
 *     `run` puts back only its own slot, so anything else entered inside stays.
 *   - A resource (timer, bound function, AsyncResource, host handle) owns a
 *     frame. Calling into it swaps the whole frame and swaps back afterwards,
 *     and the resource keeps whatever its callback entered.
 *   - A new resource copies the current frame, minus disabled storages.
 */
export function createAsyncContext() {
  const NativePromise = globalThis.Promise;
  type Frame = {
    stores: ReadonlyMap<AsyncLocalStorage, unknown>;
    id: number;
    trigger: number;
    /** What `executionAsyncResource()` returns while this frame is current. */
    resource: object;
  };
  /**
   * A resource's frame is replaced when its callback leaves different stores
   * behind. A resource with a `type` was announced to hooks by `init` and gets
   * `before`/`after` around every call; one without is runtime plumbing that
   * keeps its creator's identity.
   */
  type Resource = { frame: Frame; type?: string };
  const initial: Frame = { stores: new Map(), id: 1, trigger: 0, resource: {} };
  let current = initial;
  // The frame an unowned job starts in. It follows `current` only while no
  // resource scope and no module segment is active, which is how a CommonJS
  // entry's top-level `enterWith` reaches later work.
  let base = current;
  let scopes = 0;
  // A module body cannot be wrapped in a function, so its segments are entered
  // without a scope. The segment ends when the job's stack empties; the queued
  // microtask is the first thing that runs after that and puts `base` back.
  let unscoped = false;
  let nextId = 2;
  // Storages that were activated and then disabled. Node stops propagating a
  // disabled storage, so new resources must not copy its slot.
  const disabled = new Set<AsyncLocalStorage>();
  const hostQueue = globalThis.queueMicrotask.bind(globalThis);
  // Captured before the loader installs guest timers in this realm.
  const hostTimeout = globalThis.setTimeout.bind(globalThis);
  type HookCallbacks = {
    init?: Callback;
    before?: Callback;
    after?: Callback;
    destroy?: Callback;
    promiseResolve?: Callback;
  };
  // Enabled hooks in enable order. Replaced, never mutated, so an emission that
  // enables or disables a hook finishes with the list it started with.
  let enabledHooks: readonly HookCallbacks[] = [];
  let fatal: (error: unknown) => void = (error) => {
    throw error;
  };
  function emit(kind: keyof HookCallbacks, ...args: unknown[]) {
    for (const callbacks of enabledHooks) {
      const hook = callbacks[kind];
      if (!hook) continue;
      try {
        hook(...args);
      } catch (error) {
        // Node treats a throwing hook as fatal: it cannot be caught by the code
        // that happened to create or enter the resource.
        fatal(error);
      }
    }
  }
  // Node delivers destroy from the event loop, after the current callback and
  // its microtasks and before any later timer. The host task covers the first
  // two; guest timers flush before they run for the third.
  let destroyed: number[] = [];
  function flushDestroys() {
    const ids = destroyed;
    destroyed = [];
    for (const id of ids) emit('destroy', id);
  }
  function queueDestroy(id: number) {
    if (destroyed.push(id) === 1) hostTimeout(flushDestroys, 0);
  }
  function setCurrent(frame: Frame) {
    current = frame;
    if (scopes === 0 && !unscoped) base = frame;
  }
  function withSlot(frame: Frame, storage: AsyncLocalStorage, present: boolean, store?: unknown) {
    const stores = new Map(frame.stores);
    if (present) stores.set(storage, store);
    else stores.delete(storage);
    return { ...frame, stores };
  }
  /** The stores a new resource inherits from the current frame. */
  function propagated(): ReadonlyMap<AsyncLocalStorage, unknown> {
    if (!disabled.size) return current.stores;
    const stores = new Map(current.stores);
    for (const storage of disabled) stores.delete(storage);
    return stores;
  }
  // Node enters a timer, tick or host callback from native code, which does not
  // unwind the resource when the callback throws: the `uncaughtException`
  // listener still observes it. The frame is kept until the job that threw ends.
  let escaped: { error: unknown; frame: Frame } | undefined;
  function runIn(
    resource: Resource,
    fn: Callback,
    receiver: unknown,
    args: unknown[],
    native = false,
  ) {
    const previous = current;
    current = resource.frame;
    scopes++;
    const announced = resource.type !== undefined && enabledHooks.length > 0;
    try {
      if (announced) emit('before', resource.frame.id);
      return Reflect.apply(fn, receiver, args);
    } catch (error) {
      if (native && (!escaped || escaped.error !== error)) {
        if (!escaped)
          hostQueue(() => {
            escaped = undefined;
          });
        escaped = { error, frame: current };
      }
      throw error;
    } finally {
      if (current.stores !== resource.frame.stores)
        resource.frame = { ...resource.frame, stores: current.stores };
      if (resource.type !== undefined && enabledHooks.length > 0) emit('after', resource.frame.id);
      scopes--;
      current = previous;
    }
  }
  /** A new resource of a type hooks can observe; `init` fires before it returns. */
  function createResource(type: string, object: object, trigger = current.id): Resource {
    const frame = { stores: propagated(), id: nextId++, trigger, resource: object };
    if (enabledHooks.length) emit('init', frame.id, type, trigger, object);
    return { frame, type };
  }
  function enterUnscoped(frame: Frame) {
    current = frame;
    if (unscoped) return;
    unscoped = true;
    hostQueue(() => {
      unscoped = false;
      current = base;
    });
  }
  function capture(fn: Callback): Callback {
    const resource: Resource = { frame: { ...current, stores: propagated() } };
    return function (this: unknown, ...args: unknown[]) {
      return runIn(resource, fn, this, args, true);
    };
  }
  class AsyncLocalStorage {
    #enabled = false;
    // Node 22.18 ignores constructor arguments.
    #enable() {
      this.#enabled = true;
      disabled.delete(this);
    }
    getStore() {
      return this.#enabled ? current.stores.get(this) : undefined;
    }
    disable() {
      if (!this.#enabled) return;
      this.#enabled = false;
      disabled.add(this);
    }
    run(store: unknown, fn: unknown, ...args: unknown[]) {
      // Like Node, an identical active store is not re-entered and the callback
      // is not validated here: a non-callable throws the engine's own TypeError.
      if (Object.is(store, this.getStore())) return Reflect.apply(fn as Callback, null, args);
      this.#enable();
      const had = current.stores.has(this);
      const previous = current.stores.get(this);
      setCurrent(withSlot(current, this, true, store));
      try {
        return Reflect.apply(fn as Callback, null, args);
      } finally {
        setCurrent(withSlot(current, this, had, previous));
      }
    }
    enterWith(store: unknown) {
      this.#enable();
      setCurrent(withSlot(current, this, true, store));
    }
    exit(fn: unknown, ...args: unknown[]) {
      if (!this.#enabled) return Reflect.apply(fn as Callback, null, args);
      // Node hides the storage for the call rather than removing its slot.
      this.disable();
      try {
        return Reflect.apply(fn as Callback, null, args);
      } finally {
        this.#enable();
      }
    }
    static bind(fn: unknown) {
      return AsyncResource.bind(fn);
    }
    static snapshot() {
      return AsyncLocalStorage.bind((fn: unknown, ...args: unknown[]) =>
        Reflect.apply(fn as Callback, undefined, args),
      );
    }
  }
  Object.defineProperty(AsyncLocalStorage, 'name', {
    configurable: true,
    value: 'AsyncLocalStorage',
  });
  class AsyncResource {
    #resource: Resource;
    constructor(type: unknown, options: unknown = {}) {
      if (typeof type !== 'string')
        throw invalidArgument(
          `The "type" argument must be of type string. Received ${type === null ? 'null' : typeof type}`,
        );
      // Node only rejects an empty type while an init hook could observe it.
      if (type.length === 0 && enabledHooks.some((callbacks) => callbacks.init))
        throw Object.assign(new TypeError('Invalid name for async "type": '), {
          code: 'ERR_ASYNC_TYPE',
        });
      // Property access on null throws the engine's TypeError, as it does in Node.
      const supplied =
        typeof options === 'number'
          ? options
          : (options as { triggerAsyncId?: unknown }).triggerAsyncId;
      const trigger = supplied === undefined ? current.id : supplied;
      if (typeof trigger !== 'number' || !Number.isSafeInteger(trigger) || trigger < -1)
        throw Object.assign(new RangeError(`Invalid triggerAsyncId value: ${String(trigger)}`), {
          code: 'ERR_INVALID_ASYNC_ID',
        });
      this.#resource = createResource(type, this, trigger);
    }
    runInAsyncScope(fn: unknown, receiver?: unknown, ...args: unknown[]) {
      return runIn(this.#resource, fn as Callback, receiver, args);
    }
    bind(fn: unknown, receiver?: unknown) {
      if (typeof fn !== 'function')
        throw invalidArgument(
          `The "fn" argument must be of type function. Received ${fn === null ? 'null' : typeof fn}`,
        );
      const holder: { owner: unknown } = { owner: this };
      // Without a fixed receiver the bound function forwards its call-site receiver.
      const forward = (target: unknown, args: unknown[]) =>
        this.runInAsyncScope(fn, target, ...args);
      const bound =
        receiver === undefined
          ? function (this: unknown, ...args: unknown[]) {
              return forward(this, args);
            }
          : this.runInAsyncScope.bind(this, fn, receiver);
      Object.defineProperties(bound, {
        name: {
          configurable: true,
          value: receiver === undefined ? 'bound' : 'bound runInAsyncScope',
        },
        length: { configurable: true, enumerable: false, writable: false, value: fn.length },
        // Deprecated in Node (DEP0172) but still an own enumerable accessor.
        asyncResource: {
          configurable: true,
          enumerable: true,
          get: () => holder.owner,
          set(value: unknown) {
            holder.owner = value;
          },
        },
      });
      return bound;
    }
    static bind(fn: unknown, type?: unknown, receiver?: unknown) {
      // Node reads `fn.name` before validating `fn`, so null and undefined are
      // the engine's TypeError and other non-functions are ERR_INVALID_ARG_TYPE.
      type = type || (fn as { name?: unknown }).name;
      return new AsyncResource(type || 'bound-anonymous-fn').bind(fn, receiver);
    }
    asyncId() {
      return this.#resource.frame.id;
    }
    triggerAsyncId() {
      return this.#resource.frame.trigger;
    }
    emitDestroy() {
      // Every call is delivered, as in Node. A detached call fails the private read.
      queueDestroy(this.#resource.frame.id);
      return this;
    }
  }
  Object.defineProperty(AsyncResource, 'name', { configurable: true, value: 'AsyncResource' });
  type PromiseLike = { then(fulfilled: Callback, rejected: Callback): unknown };
  let resolvePromise: (value: unknown) => PromiseLike = () => {
    throw fault('EPROTO', 'Async context is not installed');
  };
  type Executor = (resolve: Callback, reject: Callback) => void;
  let createPromise: (executor: Executor) => unknown = () => resolvePromise(undefined);
  type Suspension = { frame: Frame; ok: boolean; value: unknown };
  // ESM evaluation. The browser engine owns linking and evaluation order, so the
  // loader reports the static graph and each compiled module reports when its
  // body starts and, for a top-level-await module, when it finishes.
  const pendingImports = new Map<number, Frame>();
  const dependencies = new Map<number, number[]>();
  const awaiting = new Set<number>();
  const started = new Map<number, Frame>();
  const finished = new Map<number, number>();
  let completions = 0;
  const modules = {
    /** Called synchronously by `import()`: the graph evaluates in the importer's frame. */
    open(evaluation: number) {
      pendingImports.set(evaluation, { ...current, stores: propagated() });
    },
    /** First statement of an import's evaluation job. */
    begin(evaluation: number) {
      const frame = pendingImports.get(evaluation);
      pendingImports.delete(evaluation);
      if (frame) enterUnscoped(frame);
    },
    close(evaluation: number) {
      pendingImports.delete(evaluation);
    },
    define(id: number, topLevelAwait: boolean) {
      if (topLevelAwait) awaiting.add(id);
    },
    link(id: number, imports: number[]) {
      dependencies.set(id, imports);
    },
    /**
     * First statement of a module body. Within one evaluation job modules share
     * the job's frame. A module that starts in a later job is an ancestor that
     * waited for top-level await: Node runs it in the frame its last-finishing
     * awaiting dependency started with.
     */
    enter(id: number) {
      if (!unscoped) {
        let frame = base;
        let latest = 0;
        const seen = new Set<number>([id]);
        const pending = [...(dependencies.get(id) ?? [])];
        while (pending.length) {
          const next = pending.pop();
          if (next === undefined || seen.has(next)) continue;
          seen.add(next);
          const order = finished.get(next);
          const snapshot = started.get(next);
          if (order !== undefined && snapshot && order > latest) {
            latest = order;
            frame = snapshot;
          }
          pending.push(...(dependencies.get(next) ?? []));
        }
        enterUnscoped(frame);
      }
      if (awaiting.has(id)) started.set(id, current);
    },
    leave(id: number) {
      finished.set(id, ++completions);
    },
    /** `await value` at module top level: settle through the guest promise, then resume here. */
    suspend(value: unknown): Promise<Suspension> {
      const frame = { ...current, stores: propagated() };
      return new NativePromise<Suspension>((resolve) => {
        resolvePromise(value).then(
          (result) => resolve({ frame, ok: true, value: result }),
          (error) => resolve({ frame, ok: false, value: error }),
        );
      });
    },
    resume(suspension: Suspension) {
      enterUnscoped(suspension.frame);
      if (suspension.ok) return suspension.value;
      throw suspension.value;
    },
    /** Iterator for a top-level `for await`, with the semantics of the lowered form. */
    forAwait(iterable: unknown) {
      // Property access on a non-object throws the same TypeError the engine would.
      const source = iterable as Record<symbol, unknown>;
      const asyncMethod = source[Symbol.asyncIterator];
      if (asyncMethod !== undefined && asyncMethod !== null)
        return Reflect.apply(asyncMethod as Callback, source, []);
      const iterator = Reflect.apply(source[Symbol.iterator] as Callback, source, []) as Record<
        string,
        unknown
      >;
      const wrapped: Record<string, Callback> = {};
      for (const key of ['next', 'return']) {
        const method = iterator[key];
        if (typeof method !== 'function') continue;
        wrapped[key] = (argument: unknown) =>
          createPromise((resolve: Callback, reject: Callback) => {
            const step = Reflect.apply(method, iterator, [argument]) as {
              done?: boolean;
              value?: unknown;
            };
            const done = step.done;
            resolvePromise(step.value).then((value) => resolve({ value, done }), reject);
          });
      }
      return wrapped;
    },
  };
  /**
   * Node's MessagePort and BroadcastChannel are handles: their listeners run in
   * the context that created the channel, not the one that registered or posted.
   * The engine dispatches these events itself, so each listener is wrapped.
   */
  function bindTarget(target: EventTarget, handlers: string[]) {
    const scope = capture((fn: unknown, receiver: unknown, args: unknown) =>
      // Only called below, with a callable and its argument list.
      Reflect.apply(fn as Callback, receiver, args as unknown[]),
    );
    const wrappers = new WeakMap<object, EventListener>();
    const wrap = (listener: unknown): unknown => {
      if (typeof listener !== 'function' && !record(listener)) return listener;
      let wrapper = wrappers.get(listener);
      if (!wrapper) {
        wrapper = function (this: unknown, event: Event) {
          if (typeof listener === 'function') return scope(listener, this, [event]);
          const handle = listener.handleEvent;
          if (typeof handle === 'function') scope(handle, listener, [event]);
        };
        wrappers.set(listener, wrapper);
      }
      return wrapper;
    };
    const { addEventListener, removeEventListener } = target;
    Object.defineProperties(target, {
      addEventListener: {
        configurable: true,
        writable: true,
        value(type: string, listener: unknown, options?: unknown) {
          return Reflect.apply(addEventListener, this, [type, wrap(listener), options]);
        },
      },
      removeEventListener: {
        configurable: true,
        writable: true,
        value(type: string, listener: unknown, options?: unknown) {
          const wrapper =
            typeof listener === 'function' || record(listener) ? wrappers.get(listener) : undefined;
          return Reflect.apply(removeEventListener, this, [type, wrapper ?? listener, options]);
        },
      },
    });
    for (const name of handlers) {
      let prototype: object | null = Object.getPrototypeOf(target);
      let descriptor: PropertyDescriptor | undefined;
      while (prototype && !(descriptor = Object.getOwnPropertyDescriptor(prototype, name)))
        prototype = Object.getPrototypeOf(prototype);
      const setter = descriptor?.set;
      if (!setter) continue;
      let assigned: unknown = null;
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        get: () => assigned,
        set(value: unknown) {
          assigned = typeof value === 'function' || record(value) ? value : null;
          Reflect.apply(setter, target, [typeof value === 'function' ? wrap(value) : value]);
        },
      });
    }
  }
  function installChannels() {
    const NativeChannel = globalThis.MessageChannel;
    const NativeBroadcast = globalThis.BroadcastChannel;
    const handlers = ['onmessage', 'onmessageerror'];
    const replace = (
      name: string,
      Native: { prototype: object },
      construct: (args: unknown[]) => object,
    ) => {
      const Context = function (this: unknown, ...args: unknown[]) {
        if (!new.target)
          throw new TypeError(`Class constructor ${name} cannot be invoked without 'new'`);
        return construct(args);
      };
      Context.prototype = Native.prototype;
      Object.defineProperty(Context, 'name', { configurable: true, value: name });
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: Context,
      });
    };
    replace('MessageChannel', NativeChannel, () => {
      const channel = new NativeChannel();
      bindTarget(channel.port1, handlers);
      bindTarget(channel.port2, handlers);
      return channel;
    });
    replace('BroadcastChannel', NativeBroadcast, (args) => {
      const channel: BroadcastChannel = Reflect.construct(NativeBroadcast, args);
      bindTarget(channel, handlers);
      return channel;
    });
  }
  /** Node's `events.EventEmitterAsyncResource`: every emit runs in the resource's scope. */
  function createEventEmitterAsyncResource(
    Emitter: new (
      options?: object,
    ) => {
      emit(event: string | symbol, ...args: unknown[]): boolean;
    },
  ) {
    const resources = new WeakMap<object, AsyncResource>();
    class EventEmitterReferencingAsyncResource extends AsyncResource {
      #emitter: object;
      constructor(emitter: object, type: unknown, options: unknown) {
        super(type, options);
        this.#emitter = emitter;
      }
      get eventEmitter() {
        return this.#emitter;
      }
    }
    const resourceOf = (emitter: object) => {
      const resource = resources.get(emitter);
      if (!resource)
        throw Object.assign(
          new TypeError('Value of "this" must be of type EventEmitterAsyncResource'),
          {
            code: 'ERR_INVALID_THIS',
          },
        );
      return resource;
    };
    class GuestEventEmitterAsyncResource extends Emitter {
      constructor(options?: unknown) {
        let name: unknown;
        if (typeof options === 'string') {
          name = options;
          options = undefined;
        } else {
          const supplied = record(options) ? options.name : undefined;
          if (new.target === GuestEventEmitterAsyncResource && typeof supplied !== 'string')
            throw Object.assign(
              new TypeError('The "options.name" property must be of type string.'),
              { code: 'ERR_INVALID_ARG_TYPE' },
            );
          name = supplied || new.target.name;
        }
        super(record(options) ? options : undefined);
        resources.set(this, new EventEmitterReferencingAsyncResource(this, name, options));
      }
      emit(event: string | symbol, ...args: unknown[]): boolean {
        // Truthiness of the listener result is the emitter's own return value.
        return Boolean(resourceOf(this).runInAsyncScope(super.emit, this, event, ...args));
      }
      emitDestroy() {
        resourceOf(this).emitDestroy();
      }
      get asyncId() {
        return resourceOf(this).asyncId();
      }
      get triggerAsyncId() {
        return resourceOf(this).triggerAsyncId();
      }
      get asyncResource() {
        return resourceOf(this);
      }
    }
    Object.defineProperty(GuestEventEmitterAsyncResource, 'name', {
      configurable: true,
      value: 'EventEmitterAsyncResource',
    });
    return GuestEventEmitterAsyncResource;
  }
  class AsyncHook {
    #callbacks: HookCallbacks;
    constructor(callbacks: HookCallbacks) {
      for (const name of ['init', 'before', 'after', 'destroy', 'promiseResolve'] as const) {
        const hook = callbacks[name];
        if (hook !== undefined && typeof hook !== 'function')
          throw Object.assign(new TypeError(`hook.${name} must be a function`), {
            code: 'ERR_ASYNC_CALLBACK',
          });
      }
      this.#callbacks = callbacks;
    }
    enable() {
      if (!enabledHooks.includes(this.#callbacks))
        enabledHooks = [...enabledHooks, this.#callbacks];
      return this;
    }
    disable() {
      enabledHooks = enabledHooks.filter((callbacks) => callbacks !== this.#callbacks);
      return this;
    }
  }
  function createHook(callbacks: unknown) {
    // Destructuring undefined or null is the engine's TypeError, as in Node.
    const { init, before, after, destroy, promiseResolve } = callbacks as HookCallbacks;
    return new AsyncHook({ init, before, after, destroy, promiseResolve });
  }
  /** A handle the runtime owns: a timer. The owner says when it is destroyed. */
  function resource(type: string, object: object) {
    const owned = createResource(type, object);
    return {
      run: (fn: Callback, receiver: unknown, args: unknown[]) =>
        runIn(owned, fn, receiver, args, true),
      destroy: () => queueDestroy(owned.frame.id),
    };
  }
  /** A one-shot callback resource, destroyed after it runs: a tick. */
  function once(fn: Callback, type: string): Callback {
    const owned = createResource(type, {});
    return function (this: unknown, ...args: unknown[]) {
      try {
        return runIn(owned, fn, this, args, true);
      } finally {
        queueDestroy(owned.frame.id);
      }
    };
  }
  let guestPromise: (native: object) => { promise: object; owner: Resource } | undefined = () =>
    undefined;
  /** Runs a process lifecycle listener in `frame` without announcing a resource. */
  const enter = (frame: Frame, fn: () => void) => {
    runIn({ frame }, fn, undefined, []);
  };
  // The frames Node runs the process lifecycle listeners in.
  const lifecycle = {
    /** `beforeExit` and a natural `exit` come from the loop itself: no context. */
    root: (fn: () => void) => enter(initial, fn),
    /** The frame `error` escaped from, if a timer, tick or host callback threw it. */
    thrown(error: unknown, fn: () => void) {
      if (escaped && escaped.error === error) enter(escaped.frame, fn);
      else fn();
    },
    /** A rejection is reported in the frame that created the rejected promise. */
    promise(native: object) {
      const guest = guestPromise(native);
      return (
        guest && {
          promise: guest.promise,
          run: (fn: () => void) => enter(guest.owner.frame, fn),
        }
      );
    },
  };
  function install() {
    const { ContextPromise, guest } = installContextPromise<Resource>(capture, {
      create: (promise, parent) => createResource('PROMISE', promise, parent?.frame.id),
      run: (owner, fn, args) => runIn(owner, fn, undefined, args),
      settled: (owner) => {
        if (enabledHooks.length) emit('promiseResolve', owner.frame.id);
      },
    });
    guestPromise = guest;
    resolvePromise = (value) => ContextPromise.resolve(value);
    createPromise = (executor) => new ContextPromise(executor);
    // Node implements queueMicrotask with an AsyncResource of type Microtask.
    globalThis.queueMicrotask = (fn) => {
      if (typeof fn !== 'function')
        throw invalidArgument(
          `The "callback" argument must be of type function. Received ${fn === null ? 'null' : typeof fn}`,
        );
      const microtask = new AsyncResource('Microtask', { requireManualDestroy: true });
      hostQueue(() => {
        try {
          microtask.runInAsyncScope(fn);
        } finally {
          microtask.emitDestroy();
        }
      });
    };
    installChannels();
  }
  return {
    install,
    capture,
    resource,
    once,
    flushDestroys,
    /** How a throwing hook ends the process; set by the bootstrap that owns stderr and exit. */
    setFatal(handler: (error: unknown) => void) {
      fatal = handler;
    },
    modules,
    lifecycle,
    createEventEmitterAsyncResource,
    hooks: {
      AsyncLocalStorage,
      AsyncResource,
      executionAsyncId: () => current.id,
      triggerAsyncId: () => current.trigger,
      executionAsyncResource: () => current.resource,
      createHook,
    },
  };
}
