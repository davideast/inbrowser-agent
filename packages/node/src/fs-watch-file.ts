import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import path from 'path-browserify';
import { invalidArgType, validateObject, validatedPath } from './arg-errors';
import { BigIntStats, Stats } from './fs-stats';
import { record } from './protocol';

function makeEmptyStat(bigint: boolean): Stats | BigIntStats {
  if (bigint) return new BigIntStats();
  return new Stats(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
}

function statsChanged(a: Stats | BigIntStats, b: Stats | BigIntStats): boolean {
  return (
    a.mtimeMs !== b.mtimeMs ||
    a.size !== b.size ||
    a.mode !== b.mode ||
    a.nlink !== b.nlink ||
    a.ino !== b.ino ||
    a.ctimeMs !== b.ctimeMs
  );
}

export class StatWatcher extends EventEmitter {
  #stopFn: () => void;
  #refFn: () => void;
  #unrefFn: () => void;

  constructor(stopFn: () => void, refFn: () => void, unrefFn: () => void) {
    super();
    this.#stopFn = stopFn;
    this.#refFn = refFn;
    this.#unrefFn = unrefFn;
  }

  ref(): this {
    this.#refFn();
    return this;
  }

  unref(): this {
    this.#unrefFn();
    return this;
  }

  stop(): void {
    this.#stopFn();
    this.emit('stop');
  }
}

export function createWatchFile(
  statSync: (target: string, options: { bigint: boolean; throwIfNoEntry: boolean }) => unknown,
  cwd: () => string,
  retain: () => void,
  release: () => void,
  setIntervalFn: (fn: () => void, delay: number) => unknown = (fn, delay) =>
    globalThis.setInterval(fn, delay),
  clearIntervalFn: (timer: unknown) => void = (t) =>
    // Narrowed: default `t` is the interval handle returned by `setIntervalFn` above.
    globalThis.clearInterval(t as ReturnType<typeof setInterval>),
) {
  const watchers = new Map<string, StatWatcher>();

  function sampleStat(resolved: string, bigint: boolean): Stats | BigIntStats {
    try {
      const res = statSync(resolved, { bigint, throwIfNoEntry: false });
      if (res instanceof Stats || res instanceof BigIntStats) return res;
    } catch {
      // Missing or inaccessible entry maps to zeroed Stats in fs.watchFile.
    }
    return makeEmptyStat(bigint);
  }

  function watchFile(filename: unknown, options?: unknown, listener?: unknown): StatWatcher {
    const rawPath = String(Buffer.from(validatedPath(filename, 'filename')));
    const resolved = path.resolve(cwd(), rawPath);

    let opts: Record<string, unknown> = {};
    let cb: unknown = listener;
    if (typeof options === 'function') {
      cb = options;
    } else if (options !== undefined) {
      validateObject(options, 'options');
      if (record(options)) opts = options;
    }
    if (typeof cb !== 'function') {
      throw invalidArgType('listener', 'of type function', cb);
    }

    const bigint = Boolean(opts.bigint);
    const persistent = opts.persistent !== false;
    const interval =
      typeof opts.interval === 'number' && Number.isFinite(opts.interval) && opts.interval >= 1
        ? Math.trunc(opts.interval)
        : 5007;

    let watcher = watchers.get(resolved);
    if (!watcher) {
      let stopped = false;
      let holding = false;
      let prev = sampleStat(resolved, bigint);

      const timer = setIntervalFn(() => {
        if (stopped) return;
        const curr = sampleStat(resolved, bigint);
        if (statsChanged(curr, prev)) {
          const prior = prev;
          prev = curr;
          watcher?.emit('change', curr, prior);
        }
      }, interval);
      if (record(timer) && typeof timer.unref === 'function') {
        timer.unref();
      }

      const refFn = () => {
        if (!stopped && !holding) {
          holding = true;
          retain();
        }
      };
      const unrefFn = () => {
        if (!stopped && holding) {
          holding = false;
          release();
        }
      };
      const stopFn = () => {
        if (stopped) return;
        stopped = true;
        clearIntervalFn(timer);
        watchers.delete(resolved);
        if (holding) {
          holding = false;
          release();
        }
      };

      watcher = new StatWatcher(stopFn, refFn, unrefFn);
      if (persistent) refFn();
      watchers.set(resolved, watcher);
    }

    // Verified typeof cb === 'function' above.
    watcher.addListener('change', cb as (...args: unknown[]) => void);
    return watcher;
  }

  function unwatchFile(filename: unknown, listener?: unknown): void {
    const rawPath = String(Buffer.from(validatedPath(filename, 'filename')));
    const resolved = path.resolve(cwd(), rawPath);
    const watcher = watchers.get(resolved);
    if (!watcher) return;
    if (typeof listener === 'function') {
      // Verified typeof listener === 'function' just above.
      watcher.removeListener('change', listener as (...args: unknown[]) => void);
    } else {
      watcher.removeAllListeners('change');
    }
    if (watcher.listenerCount('change') === 0) {
      watcher.stop();
    }
  }

  return { StatWatcher, watchFile, unwatchFile };
}

function makeAbortError(cause?: unknown): Error {
  const err = Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
  if (cause !== undefined) {
    Object.defineProperty(err, 'cause', {
      value: cause,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
  return err;
}

export function createPromisesWatch(
  watchFn: (
    filename: unknown,
    options?: unknown,
    listener?: (eventType: string, filename: string | Buffer | null) => void,
  ) => EventEmitter & { close(): void },
) {
  return async function* watch(
    filename: unknown,
    options: unknown = {},
  ): AsyncGenerator<{ eventType: string; filename: string | Buffer | null }, void, unknown> {
    let opts: Record<string, unknown> = {};
    if (typeof options === 'string') {
      opts = { encoding: options };
    } else if (options !== undefined) {
      validateObject(options, 'options');
      if (record(options)) opts = options;
    }

    const rawSignal = opts.signal;
    let signal: AbortSignal | undefined;
    if (rawSignal !== undefined) {
      if (
        !record(rawSignal) ||
        typeof rawSignal.aborted !== 'boolean' ||
        typeof rawSignal.addEventListener !== 'function' ||
        typeof rawSignal.removeEventListener !== 'function'
      ) {
        throw invalidArgType('options.signal', 'an instance of AbortSignal', rawSignal);
      }
      // Validated AbortSignal duck-shape (`aborted`, `addEventListener`, `removeEventListener`) above.
      signal = rawSignal as unknown as AbortSignal;
      if (signal.aborted) {
        throw makeAbortError(signal.reason);
      }
    }

    const forwardOpts: Record<string, unknown> = {};
    if (opts.persistent !== undefined) forwardOpts.persistent = opts.persistent;
    if (opts.recursive !== undefined) forwardOpts.recursive = opts.recursive;
    if (opts.encoding !== undefined) forwardOpts.encoding = opts.encoding;

    const queue: Array<{ eventType: string; filename: string | Buffer | null }> = [];
    let pendingError: unknown = undefined;
    let closed = false;
    let notify: (() => void) | undefined;

    const wake = () => {
      const fn = notify;
      notify = undefined;
      fn?.();
    };

    const watcher = watchFn(filename, forwardOpts, (eventType, changedName) => {
      queue.push({ eventType, filename: changedName });
      wake();
    });

    watcher.on('error', (err: unknown) => {
      pendingError = err;
      closed = true;
      wake();
    });
    watcher.on('close', () => {
      closed = true;
      wake();
    });

    const onAbort = () => {
      pendingError = makeAbortError(signal?.reason);
      closed = true;
      watcher.close();
      wake();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        let next = queue.shift();
        while (next !== undefined) {
          yield next;
          next = queue.shift();
        }
        if (pendingError !== undefined) {
          throw pendingError;
        }
        if (closed) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      watcher.close();
    }
  };
}
