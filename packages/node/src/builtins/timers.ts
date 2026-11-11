import { createTimerPromises } from '../timer-promises';

export interface GuestTimerHandle {
  ref(): unknown;
  unref(): unknown;
  hasRef(): boolean;
  refresh(): unknown;
  close(): unknown;
  cancel(): void;
}

export interface GuestTimersShape {
  setTimeout: (
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => GuestTimerHandle;
  clearTimeout: (timer: unknown) => void;
  setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => GuestTimerHandle;
  clearImmediate: (timer: unknown) => void;
  setInterval: (
    fn: (...args: unknown[]) => void,
    delay?: unknown,
    ...args: unknown[]
  ) => GuestTimerHandle;
  clearInterval: (timer: unknown) => void;
}

export interface TimersBuiltinDeps<T extends GuestTimersShape = GuestTimersShape> {
  guestTimers: T;
  guestSetTimeout: T['setTimeout'];
  guestClearTimeout: T['clearTimeout'];
  kCustomPromisifiedSymbol: symbol;
}

export function createTimersBuiltins<T extends GuestTimersShape>({
  guestTimers,
  guestSetTimeout,
  guestClearTimeout,
  kCustomPromisifiedSymbol,
}: TimersBuiltinDeps<T>) {
  const timerPromises = createTimerPromises(guestSetTimeout, guestClearTimeout, {
    scheduleImmediate: (cb) => guestTimers.setImmediate(cb),
    cancelImmediate: (timer) => guestTimers.clearImmediate(timer),
    scheduleInterval: (cb, delay) => guestTimers.setInterval(cb, delay),
    cancelInterval: (timer) => guestTimers.clearInterval(timer),
  });
  // `util.promisify(setTimeout)` and `util.promisify(setImmediate)` resolve through `timers/promises`, as in Node.
  Object.defineProperty(guestSetTimeout, kCustomPromisifiedSymbol, {
    configurable: true,
    enumerable: true,
    value: timerPromises.setTimeout,
  });
  Object.defineProperty(guestTimers.setImmediate, kCustomPromisifiedSymbol, {
    configurable: true,
    enumerable: true,
    value: timerPromises.setImmediate,
  });
  return {
    timers: guestTimers,
    'timers/promises': timerPromises,
  };
}
