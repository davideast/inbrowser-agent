import { fault } from './protocol';

type Callback = (...args: unknown[]) => unknown;
function callable(value: unknown): value is Callback {
  return typeof value === 'function';
}

/** How the owning async context sees guest promises: each one is a PROMISE resource. */
export interface PromiseTracker<Owner> {
  /** Announces a new promise. `parent` is the promise `then` was called on. */
  create(promise: object, parent?: Owner): Owner;
  /** Runs a reaction or adoption job as the promise's resource. */
  run(owner: Owner, fn: Callback, args: unknown[]): unknown;
  /** The promise was fulfilled or rejected. */
  settled(owner: Owner): void;
}

/** Native promises schedule reactions; boxed values keep thenable adoption under context control. */
export function installContextPromise<Owner>(
  capture: (fn: Callback) => Callback,
  tracker: PromiseTracker<Owner>,
) {
  const NativePromise = globalThis.Promise;
  const nativeThen = NativePromise.prototype.then;
  const enqueue = globalThis.queueMicrotask.bind(globalThis);
  type Box = { value: unknown };
  // The engine promise behind each guest promise only schedules reactions. Its
  // species keeps the promises that scheduling derives out of the guest's sight.
  class SchedulingPromise<Value> extends NativePromise<Value> {
    static get [Symbol.species]() {
      return NativePromise;
    }
  }
  // Set by `then` for the promise it is about to construct.
  let parent: Owner | undefined;
  // The engine reports an unhandled rejection against the scheduling promise.
  // This names the guest promise it stands for and the resource that owns it.
  const guests = new WeakMap<object, { promise: object; owner: Owner }>();
  class ContextPromise {
    #native: Promise<Box>;
    #owner: Owner;
    constructor(executor: unknown) {
      if (!callable(executor)) throw new TypeError('Promise resolver is not a function');
      const owner = tracker.create(this, parent);
      parent = undefined;
      this.#owner = owner;
      this.#native = new SchedulingPromise<Box>((settleFulfilled, settleRejected) => {
        // Hooks observe settlement, not the call that started resolution.
        const fulfill = (box: Box) => {
          tracker.settled(owner);
          settleFulfilled(box);
        };
        const reject = (error: unknown) => {
          tracker.settled(owner);
          settleRejected(error);
        };
        let resolved = false;
        const adopt = (value: unknown): void => {
          if (value === this) {
            reject(new TypeError('Chaining cycle detected for promise'));
            return;
          }
          if ((typeof value === 'object' && value !== null) || callable(value)) {
            let then: unknown;
            try {
              then = Reflect.get(value, 'then');
            } catch (error) {
              reject(error);
              return;
            }
            if (callable(then)) {
              const invoke = then;
              // The adoption job belongs to the promise being resolved.
              const task = () => {
                let called = false;
                try {
                  Reflect.apply(invoke, value, [
                    (next: unknown) => {
                      if (!called) {
                        called = true;
                        adopt(next);
                      }
                    },
                    (error: unknown) => {
                      if (!called) {
                        called = true;
                        reject(error);
                      }
                    },
                  ]);
                } catch (error) {
                  if (!called) {
                    called = true;
                    reject(error);
                  }
                }
              };
              enqueue(() => {
                tracker.run(owner, task, []);
              });
              return;
            }
          }
          fulfill({ value });
        };
        try {
          executor(
            (value: unknown) => {
              if (!resolved) {
                resolved = true;
                adopt(value);
              }
            },
            (error: unknown) => {
              if (!resolved) {
                resolved = true;
                reject(error);
              }
            },
          );
        } catch (error) {
          if (!resolved) {
            resolved = true;
            reject(error);
          }
        }
      });
      guests.set(this.#native, { promise: this, owner });
    }
    // Engine promises reach guest code from host APIs and from the runtime's own
    // async functions. They pass this constructor's brand checks, and their
    // reactions capture context through the patched engine `then`. Their
    // `constructor` stays the engine's: redirecting it would route the engine's
    // own species lookups, and so every internal await, through guest promises.
    static [Symbol.hasInstance](value: unknown) {
      return (
        typeof value === 'object' &&
        value !== null &&
        (#native in value || value instanceof NativePromise)
      );
    }
    then(fulfilled?: unknown, rejected?: unknown): unknown {
      if (!(#native in this)) {
        if (!((this as unknown) instanceof NativePromise))
          throw new TypeError('Method Promise.prototype.then called on incompatible receiver');
        return Reflect.apply(NativePromise.prototype.then, this, [fulfilled, rejected]);
      }
      const onFulfilled = callable(fulfilled) ? fulfilled : undefined;
      const onRejected = callable(rejected) ? rejected : undefined;
      // The experiment currently supports its own Promise class, not species overrides.
      if (this.constructor !== ContextPromise)
        throw fault('ENOSYS', 'Promise subclasses are not supported in experimental async context');
      // The derived promise is the resource its reaction runs as. The reaction
      // only runs in a later job, after `derived` has been assigned.
      parent = this.#owner;
      const derived: ContextPromise = new ContextPromise((resolve: Callback, reject: Callback) => {
        Reflect.apply(nativeThen, this.#native, [
          (value: unknown) =>
            tracker.run(
              derived.#owner,
              () => {
                // The private native promise is fulfilled exclusively with Box values.
                const box = value as Box;
                try {
                  resolve(onFulfilled ? onFulfilled(box.value) : box.value);
                } catch (error) {
                  reject(error);
                }
              },
              [],
            ),
          (error: unknown) =>
            tracker.run(
              derived.#owner,
              () => {
                try {
                  if (onRejected) resolve(onRejected(error));
                  else reject(error);
                } catch (caught) {
                  reject(caught);
                }
              },
              [],
            ),
        ]);
      });
      return derived;
    }
    catch(rejected?: unknown) {
      return this.then(undefined, rejected);
    }
    finally(fn?: unknown) {
      if (!callable(fn)) return this.then(fn, fn);
      return this.then(
        (value: unknown) => ContextPromise.resolve(fn()).then(() => value),
        (error: unknown) =>
          ContextPromise.resolve(fn()).then(() => {
            throw error;
          }),
      );
    }
    static resolve(value?: unknown): ContextPromise {
      // An engine promise is adopted like any thenable, which makes it a guest promise.
      if (value instanceof ContextPromise && value.constructor === this) return value;
      return new this((resolve: Callback) => resolve(value));
    }
    static reject(error: unknown) {
      return new this((_resolve: Callback, reject: Callback) => reject(error));
    }
    static all(values: Iterable<unknown>) {
      return Reflect.apply(NativePromise.all, this, [values]);
    }
    static allSettled(values: Iterable<unknown>) {
      return Reflect.apply(NativePromise.allSettled, this, [values]);
    }
    static race(values: Iterable<unknown>) {
      return Reflect.apply(NativePromise.race, this, [values]);
    }
    static any(values: Iterable<unknown>) {
      return Reflect.apply(NativePromise.any, this, [values]);
    }
    static get [Symbol.species]() {
      return this;
    }
    get [Symbol.toStringTag]() {
      return 'Promise';
    }
  }
  Object.defineProperty(ContextPromise, 'name', { configurable: true, value: 'Promise' });
  Object.defineProperty(globalThis, 'Promise', {
    configurable: true,
    writable: true,
    value: ContextPromise,
  });
  const wrap = (fn: unknown) => (callable(fn) ? capture(fn) : fn);
  Object.defineProperty(NativePromise.prototype, 'then', {
    ...Object.getOwnPropertyDescriptor(NativePromise.prototype, 'then'),
    value: function (this: Promise<unknown>, fulfilled?: unknown, rejected?: unknown) {
      return Reflect.apply(nativeThen, this, [wrap(fulfilled), wrap(rejected)]);
    },
  });
  return {
    ContextPromise,
    /** The guest promise and owner behind a scheduling promise the engine reported. */
    guest: (native: object) => guests.get(native),
  };
}
