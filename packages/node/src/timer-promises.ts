import { abortError, invalidArgType, nodeError, validateObject } from './node-errors';

export type TimerHandleLike = { unref(): unknown };

export interface TimerPromisesExtraSchedulers<THandle extends TimerHandleLike = TimerHandleLike> {
  scheduleImmediate?: (callback: () => void) => THandle;
  cancelImmediate?: (timer: THandle) => void;
  scheduleInterval?: (callback: () => void, delay: number) => THandle;
  cancelInterval?: (timer: THandle) => void;
}

const kScheduler = Symbol('kScheduler');

interface ValidatedTimerOptions {
  signal: AbortSignal | undefined;
  ref: boolean;
}

function parseTimerOptions(options: unknown): ValidatedTimerOptions {
  validateObject(options, 'options');
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidArgType('options.signal', 'AbortSignal', signal);
  }
  const ref = options.ref === undefined ? true : options.ref;
  if (typeof ref !== 'boolean') {
    throw invalidArgType('options.ref', 'boolean', ref);
  }
  return { signal, ref };
}

export function createTimerPromises<THandle extends TimerHandleLike = TimerHandleLike>(
  schedule: (callback: () => void, delay: number) => THandle,
  cancel: (timer: THandle) => void,
  extra?: TimerPromisesExtraSchedulers<THandle>,
) {
  const scheduleImmediate = extra?.scheduleImmediate ?? ((cb: () => void) => schedule(cb, 0));
  const cancelImmediate = extra?.cancelImmediate ?? cancel;
  const scheduleInterval =
    extra?.scheduleInterval ??
    ((cb: () => void, delay: number): THandle => {
      let stopped = false;
      let unrefed = false;
      let current: THandle | undefined;
      const tick = () => {
        if (stopped) return;
        cb();
        if (!stopped) {
          current = schedule(tick, delay);
          if (unrefed) current.unref();
        }
      };
      current = schedule(tick, delay);
      const wrappedHandle = {
        unref() {
          unrefed = true;
          current?.unref();
          return this;
        },
        _stop() {
          stopped = true;
          if (current !== undefined) cancel(current);
        },
      };
      // Invariant: wrapper forwards unref() and cancellation to active scheduled handle.
      return wrappedHandle as unknown as THandle;
    });
  const cancelInterval =
    extra?.cancelInterval ??
    ((timer: THandle) => {
      const stopFn: unknown = Reflect.get(timer, '_stop');
      if (typeof stopFn === 'function') {
        Reflect.apply(stopFn, timer, []);
      } else {
        cancel(timer);
      }
    });

  function setTimeoutPromise(
    delay: unknown = 1,
    value?: unknown,
    options: unknown = {},
  ): Promise<unknown> {
    let parsed: ValidatedTimerOptions;
    let numericDelay = 1;
    try {
      if (delay !== undefined) {
        if (typeof delay !== 'number') throw invalidArgType('delay', 'number', delay);
        numericDelay = delay;
      }
      parsed = parseTimerOptions(options);
    } catch (err) {
      return Promise.reject(err);
    }

    const { signal, ref } = parsed;
    if (signal?.aborted) {
      return Promise.reject(abortError(undefined, { cause: signal.reason }));
    }

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cancel(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(abortError(undefined, { cause: signal?.reason }));
      };
      const timer = schedule(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      }, numericDelay);
      if (!ref) timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  Object.defineProperty(setTimeoutPromise, 'name', { configurable: true, value: 'setTimeout' });

  function setImmediatePromise(value?: unknown, options: unknown = {}): Promise<unknown> {
    let parsed: ValidatedTimerOptions;
    try {
      parsed = parseTimerOptions(options);
    } catch (err) {
      return Promise.reject(err);
    }

    const { signal, ref } = parsed;
    if (signal?.aborted) {
      return Promise.reject(abortError(undefined, { cause: signal.reason }));
    }

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cancelImmediate(immediate);
        signal?.removeEventListener('abort', onAbort);
        reject(abortError(undefined, { cause: signal?.reason }));
      };
      const immediate = scheduleImmediate(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      });
      if (!ref) immediate.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  Object.defineProperty(setImmediatePromise, 'name', { configurable: true, value: 'setImmediate' });

  async function* setIntervalGenerator(
    delay?: unknown,
    value?: unknown,
    options: unknown = {},
  ): AsyncGenerator<unknown, void, unknown> {
    let numericDelay = 1;
    if (delay !== undefined) {
      if (typeof delay !== 'number') throw invalidArgType('delay', 'number', delay);
      numericDelay = delay;
    }
    const { signal, ref } = parseTimerOptions(options);
    if (signal?.aborted) {
      throw abortError(undefined, { cause: signal.reason });
    }

    let onCancel: (() => void) | undefined;
    let interval: THandle | undefined;
    try {
      let notYielded = 0;
      let wake: { resolve: () => void; reject: (err: unknown) => void } | undefined;

      interval = scheduleInterval(() => {
        notYielded += 1;
        if (wake) {
          const currentWake = wake;
          wake = undefined;
          currentWake.resolve();
        }
      }, numericDelay);
      if (!ref) interval.unref();

      if (signal) {
        onCancel = () => {
          if (interval !== undefined) cancelInterval(interval);
          if (wake) {
            const currentWake = wake;
            wake = undefined;
            currentWake.reject(abortError(undefined, { cause: signal.reason }));
          }
        };
        signal.addEventListener('abort', onCancel, { once: true });
      }

      while (!signal?.aborted) {
        if (notYielded === 0) {
          await new Promise<void>((resolve, reject) => {
            wake = { resolve, reject };
          });
        }
        for (; notYielded > 0; notYielded -= 1) {
          if (signal?.aborted) {
            throw abortError(undefined, { cause: signal.reason });
          }
          yield value;
        }
      }
      throw abortError(undefined, { cause: signal?.reason });
    } finally {
      if (interval !== undefined) cancelInterval(interval);
      if (onCancel) signal?.removeEventListener('abort', onCancel);
    }
  }
  Object.defineProperty(setIntervalGenerator, 'name', { configurable: true, value: 'setInterval' });

  class Scheduler {
    constructor() {
      throw nodeError(TypeError, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
    }

    yield(): Promise<unknown> {
      if (Reflect.get(this, kScheduler) !== true) {
        throw nodeError(TypeError, 'ERR_INVALID_THIS', 'Value of "this" must be of type Scheduler');
      }
      return setImmediatePromise();
    }

    wait(delay?: unknown, options?: unknown): Promise<unknown> {
      if (Reflect.get(this, kScheduler) !== true) {
        throw nodeError(TypeError, 'ERR_INVALID_THIS', 'Value of "this" must be of type Scheduler');
      }
      return setTimeoutPromise(delay, undefined, options);
    }
  }

  const rawScheduler: unknown = Object.defineProperty(
    Object.create(Scheduler.prototype),
    kScheduler,
    {
      value: true,
    },
  );
  // Invariant: Object.create(Scheduler.prototype) tagged with [kScheduler] = true creates the singleton Scheduler instance without running the illegal constructor.
  const scheduler = rawScheduler as Scheduler;

  return {
    setTimeout: setTimeoutPromise,
    setImmediate: setImmediatePromise,
    setInterval: setIntervalGenerator,
    scheduler,
  };
}
