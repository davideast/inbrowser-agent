// The guest `process` lifecycle events: `beforeExit`, `exit`, `uncaughtException`
// (with its monitor and capture callback), `unhandledRejection`,
// `rejectionHandled` and the rejection warnings. The process bootstrap owns the
// Worker, stdio and handle accounting and passes them in; this module owns only
// the order in which Node 22 consults listeners and what each outcome exits with.

export type RejectionMode = 'throw' | 'strict' | 'warn' | 'none' | 'warn-with-error-code';
export type ExceptionOrigin = 'uncaughtException' | 'unhandledRejection';

/** The part of the guest `process` object the lifecycle reads and writes. */
export interface LifecycleProcess {
  emit(name: string, ...args: unknown[]): boolean;
  on(name: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(name: string): number;
  /** Replaced here by Node's validating accessor. */
  exitCode: number | undefined;
  pid: number;
  _exiting: boolean;
}

export interface LifecycleHost {
  process: LifecycleProcess;
  /** Read when a rejection is reported: NODE_OPTIONS is parsed after the bootstrap. */
  mode(): RejectionMode;
  /** Reports the status to the host. No guest frame runs after it. */
  terminate(code: number): never;
  /** Prints a fatal error: stderr for a process, the error channel for a thread. */
  report(error: unknown): void;
  /** Writes a diagnostic to stderr; a closed stderr is not an error. */
  diagnostic(text: string): void;
  /** Node's unsettled top-level await warning, on the entry's own stderr binding. */
  unsettled(): void;
  /** A referenced handle or timer exists. */
  alive(): boolean;
  /** The entry module has not finished evaluating. */
  evaluating(): boolean;
  /** Queues another drain check behind the current task and its reactions. */
  recheck(): void;
  /** Resumes unreferenced timers parked during drain when loop work wakes the process. */
  wake?(): void;
  /** Records natural event-loop drain before `exit` listeners run. */
  loopExit?(): void;
  /** Releases parked unreferenced timer bookkeeping once natural exit finishes. */
  finish?(): void;
  /** Runs `fn` in a host task after the engine has reported rejections from this one. */
  later(fn: () => void): void;
  /** Runs `fn` after the reactions that are already queued. */
  microtask(fn: () => void): void;
  /** The guest's `process.nextTick`. */
  tick(fn: () => void): void;
  /** Experimental async context: the frames Node runs these listeners in. */
  context?: {
    /** No context: where Node emits `beforeExit` and a natural `exit`. */
    root(fn: () => void): void;
    /** The frame of the timer, tick or host callback that `error` escaped from. */
    thrown(error: unknown, fn: () => void): void;
    /** The guest promise behind an engine promise and the frame that created it. */
    promise(native: object): { promise: object; run(fn: () => void): void } | undefined;
  };
}

const ORIGINATED =
  'This error originated either by throwing inside of an async function without a catch block, ' +
  'or by rejecting a promise which was not handled with .catch().';

/** A data property found on `value` or its prototypes, without running an accessor. */
function dataProperty(value: object, key: string): unknown {
  for (let owner: object | null = value; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return descriptor.value;
  }
  return undefined;
}

/**
 * V8's side-effect-free description of a value, which Node prints for a
 * rejection reason: `name: message` for an error, `#<Constructor>` for an object
 * that still has the default `toString` and a named constructor, and the
 * builtin tag otherwise.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'function') return Function.prototype.toString.call(value);
  if (typeof value !== 'object' || value === null) return String(value);
  if (value instanceof Error) {
    const name = dataProperty(value, 'name');
    const message = dataProperty(value, 'message');
    const head = typeof name === 'string' ? name : 'Error';
    return typeof message === 'string' && message ? `${head}: ${message}` : head;
  }
  if (dataProperty(value, 'toString') === Object.prototype.toString) {
    const ctor = dataProperty(value, 'constructor');
    if (typeof ctor === 'function') {
      const name = Object.getOwnPropertyDescriptor(ctor, 'name')?.value;
      if (typeof name === 'string' && name) return `#<${name}>`;
    }
  }
  return Object.prototype.toString.call(value);
}

/** The text of a thrown value for a fatal report; never throws. */
export function printable(value: unknown): string {
  try {
    return String(value);
  } catch {
    return describe(value);
  }
}

/** What Node raises for an unhandled rejection whose reason is not error-like. */
class UnhandledPromiseRejection extends Error {
  code = 'ERR_UNHANDLED_REJECTION';
  constructor(reason: unknown) {
    super(`${ORIGINATED} The promise rejected with the reason "${describe(reason)}".`);
  }
}
Object.defineProperty(UnhandledPromiseRejection.prototype, 'name', {
  configurable: true,
  writable: true,
  value: 'UnhandledPromiseRejection',
});

/** Node's `isErrorLike`: an object with its own `stack`. */
function errorLike(value: unknown): value is { stack: unknown } {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'stack');
}

function received(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value !== null) {
    const ctor: unknown = Reflect.get(value, 'constructor');
    return typeof ctor === 'function' && ctor.name
      ? `an instance of ${ctor.name}`
      : 'an instance of Object';
  }
  if (typeof value === 'string') return `type string ('${value}')`;
  return `type ${typeof value} (${String(value)}${typeof value === 'bigint' ? 'n' : ''})`;
}

/** Node's validation of `process.exitCode` and the `process.exit()` argument. */
function exitStatus(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const code =
    typeof value === 'string' && value !== '' && Number.isInteger(Number(value))
      ? Number(value)
      : value;
  if (typeof code !== 'number')
    throw Object.assign(
      new TypeError(`The "code" argument must be of type number. Received ${received(value)}`),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
  if (!Number.isInteger(code))
    throw Object.assign(
      new RangeError(
        `The value of "code" is out of range. It must be an integer. Received ${code}`,
      ),
      { code: 'ERR_OUT_OF_RANGE' },
    );
  // Node keeps the status in a 32-bit field.
  return code | 0;
}

export function createLifecycle(host: LifecycleHost) {
  const { process } = host;
  // The capture callback takes an error and nothing else.
  let capture: ((error: unknown) => unknown) | null = null;
  // `exit` has been emitted, or is being emitted: process.exit() and a fatal
  // error do not emit it a second time.
  let exiting = false;
  // A natural `exit` has been emitted and the status is reported by a later task.
  let finishing = false;
  // `beforeExit` has completed without throwing since the last loop work.
  let drained = false;
  // `beforeExit` has begun and no referenced handle or loop work has woken the loop since.
  let quiescent = false;
  let rejections = 0;
  const reported = new WeakMap<object, { id: number; promise: object }>();

  // `process.exitCode` is an accessor in Node: an assignment is validated, so
  // the status reported to the host is always an integer.
  let exitCode = exitStatus(process.exitCode);
  Object.defineProperty(process, 'exitCode', {
    enumerable: true,
    configurable: false,
    get: () => exitCode,
    set(value: unknown) {
      exitCode = exitStatus(value);
    },
  });
  // The rejection warnings are printed by the process's `warning` reporter
  // (process-warning.ts), the first `warning` listener.

  const root = (fn: () => void) => (host.context ? host.context.root(fn) : fn());
  const status = () => (host.evaluating() ? exitCode || 13 : (exitCode ?? 0));
  /** Prints a fatal error and ends the process, whatever the print does. */
  const fatal = (error: unknown, code: () => number): never => {
    try {
      host.report(error);
    } finally {
      host.terminate(code());
    }
    // Unreachable: `terminate` does not return. This satisfies the checker.
    return host.terminate(code());
  };

  function beginExit() {
    exiting = true;
    process._exiting = true;
  }

  /**
   * Node's fatal exception path. Returns when a capture callback or an
   * `uncaughtException` listener took the error; otherwise the process ends here.
   */
  function uncaught(error: unknown, origin: ExceptionOrigin): void {
    let delivered = false;
    const deliver = () => {
      try {
        process.emit('uncaughtExceptionMonitor', error, origin);
        if (capture) {
          capture(error);
          delivered = true;
        } else delivered = process.emit('uncaughtException', error, origin);
      } catch (inner) {
        // A throw from the handler itself ends the process without `exit`.
        fatal(inner, () => 7);
      }
      if (delivered || exiting) return;
      beginExit();
      exitCode = 1;
      try {
        process.emit('exit', 1);
      } catch {
        // Node discards a throw from `exit` while it is already failing.
      }
    };
    if (host.context) host.context.thrown(error, deliver);
    else deliver();
    if (delivered) return;
    // An `exit` listener may have replaced the status; an exit already in
    // progress keeps the status it had.
    fatal(error, () => exitCode ?? 1);
  }

  /** Runs listeners; a throw from one is an uncaught exception like any other. */
  function guarded(fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (error) {
      uncaught(error, 'uncaughtException');
      return false;
    }
  }

  function exit(args: unknown[]): never {
    // Node assigns the argument, so `process.exit(undefined)` clears a pending
    // code and an invalid one throws to the caller before anything is emitted.
    if (args.length !== 0) exitCode = exitStatus(args[0]);
    if (!exiting) {
      beginExit();
      // Synchronous, in the caller's frame. A throwing listener propagates to
      // the caller of process.exit(), as in Node.
      process.emit('exit', exitCode || 0);
    }
    return host.terminate(exitCode || 0);
  }

  function wake() {
    const wasQuiescent = quiescent;
    drained = false;
    quiescent = false;
    if (wasQuiescent) host.wake?.();
  }

  /** Called when the handle accounting has been idle for two queued checks. */
  function drain(): void {
    if (finishing) return;
    if (host.alive()) {
      wake();
      return;
    }
    quiescent = true;
    if (!drained) {
      drained = true;
      // Emitted through `process.emit` even with no listener, so a guest that
      // wraps `emit` observes it. Only a listener can leave work behind.
      const listening = process.listenerCount('beforeExit') > 0;
      let completed = false;
      root(() => {
        completed = guarded(() => process.emit('beforeExit', exitCode ?? 0));
      });
      if (listening || !completed || host.alive()) {
        // Node emits again after a handled throw, and after any drain that
        // followed work the listener started. Reactions it queued run before
        // liveness is sampled.
        if (!completed) drained = false;
        if (host.alive()) wake();
        host.microtask(() => {
          if (host.alive()) wake();
        });
        host.recheck();
        return;
      }
    }
    if (host.evaluating() && !exitCode) {
      host.unsettled();
      exitCode = 13;
    }
    // The end of the loop always emits `exit`, even when a listener's throw
    // under process.exit() was taken by `uncaughtException` and the process went on.
    beginExit();
    host.loopExit?.();
    const listening = process.listenerCount('exit') > 0;
    const code = status();
    root(() => {
      guarded(() => process.emit('exit', code));
    });
    if (!listening) {
      host.finish?.();
      host.terminate(status());
    }
    // Node drains reactions once more after `exit`; timers and ticks stay dead.
    finishing = true;
    host.finish?.();
    host.later(() => host.terminate(status()));
  }

  function emitWarning(name: string, message: string) {
    const warning = Object.assign(new Error(message), { name });
    host.tick(() => {
      guarded(() => process.emit('warning', warning));
    });
  }

  function warnUnhandled(id: number, reason: unknown) {
    emitWarning(
      'UnhandledPromiseRejectionWarning',
      errorLike(reason) && typeof reason.stack === 'string' ? reason.stack : describe(reason),
    );
    emitWarning(
      'UnhandledPromiseRejectionWarning',
      `Unhandled promise rejection. ${ORIGINATED} To terminate the node process on unhandled ` +
        'promise rejection, use the CLI flag `--unhandled-rejections=strict` (see ' +
        `https://nodejs.org/api/cli.html#cli_unhandled_rejections_mode). (rejection id: ${id})`,
    );
  }

  /** The engine reported `native` as rejected with no handler. */
  function rejected(reason: unknown, native: object): void {
    const owner = host.context?.promise(native);
    const promise = owner?.promise ?? native;
    const id = ++rejections;
    reported.set(native, { id, promise });
    const emit = () => process.emit('unhandledRejection', reason, promise);
    const raise = () =>
      uncaught(
        errorLike(reason) ? reason : new UnhandledPromiseRejection(reason),
        'unhandledRejection',
      );
    const mode = host.mode();
    const consult = () =>
      guarded(() => {
        if (mode === 'strict') {
          raise();
          if (!emit()) warnUnhandled(id, reason);
        } else if (mode === 'none') emit();
        else if (mode === 'warn') {
          emit();
          warnUnhandled(id, reason);
        } else if (mode === 'warn-with-error-code') {
          if (!emit()) {
            warnUnhandled(id, reason);
            exitCode = 1;
          }
        } else if (!emit()) raise();
      });
    if (owner) owner.run(consult);
    else consult();
  }

  /** A handler was attached to a promise already reported as unhandled. */
  function handled(native: object): void {
    const report = reported.get(native);
    if (!report) return;
    reported.delete(native);
    // Node emits this from its rejection queue, outside any context.
    root(() => {
      guarded(() => {
        if (!process.emit('rejectionHandled', report.promise))
          emitWarning(
            'PromiseRejectionHandledWarning',
            `Promise rejection was handled asynchronously (rejection id: ${report.id})`,
          );
      });
    });
  }

  return {
    exit,
    drain,
    uncaught,
    rejected,
    handled,
    /**
     * For a caller that would otherwise absorb a guest throw: delivers it when
     * the guest has a capture callback or an `uncaughtException` listener.
     */
    offer(error: unknown): boolean {
      if (!capture && process.listenerCount('uncaughtException') === 0) return false;
      uncaught(error, 'uncaughtException');
      return true;
    },
    /** A natural `exit` has been emitted: Node runs no timer after it. */
    finishing: () => finishing,
    /** `beforeExit` has begun with no referenced work having woken the loop since. */
    draining: () => quiescent && !host.alive(),
    /** Loop work happened, so the next drain emits `beforeExit` again. */
    worked: wake,
    setUncaughtExceptionCaptureCallback(fn: unknown): void {
      if (fn === null) {
        capture = null;
        return;
      }
      if (typeof fn !== 'function')
        throw Object.assign(
          new TypeError(
            `The "fn" argument must be of type function or null. Received ${received(fn)}`,
          ),
          { code: 'ERR_INVALID_ARG_TYPE' },
        );
      if (capture !== null)
        throw Object.assign(
          new Error(
            '`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active',
          ),
          { code: 'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET' },
        );
      // Checked callable above; Node calls it with the error alone.
      capture = fn as (error: unknown) => unknown;
    },
    hasUncaughtExceptionCaptureCallback: () => capture !== null,
  };
}
