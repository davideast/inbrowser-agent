import { Buffer } from 'buffer';
import { Writable } from 'readable-stream/lib/stream.js';
import type { createFs } from './fs';
import { fault, record } from './protocol';

const supportedOptions = [
  'flags',
  'encoding',
  'mode',
  'autoClose',
  'emitClose',
  'start',
  'flush',
  'highWaterMark',
  'signal',
  'fd',
  'fs',
];

const invalidType = (message: string) =>
  fault('ERR_INVALID_ARG_TYPE', message) as Error & { code: string };

function modeOf(mode: unknown) {
  if (mode === undefined || mode === null) return 0o666;
  const value = typeof mode === 'string' && /^[0-7]+$/.test(mode) ? Number.parseInt(mode, 8) : mode;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw fault('ERR_INVALID_ARG_VALUE', 'The write stream mode is invalid');
  return value;
}

function abortError(signal: AbortSignal) {
  return Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

type Done = (error?: Error | null) => void;

const kState = Symbol('kWriteStreamState');

/** Internal per-stream state, kept off the guest-visible own properties. */
interface StreamState {
  position: number | undefined;
  opening: boolean;
  waiting: (() => void)[];
  deferredDestroy: ((error: Error | null) => void) | null;
  deferredAbort: Error | null;
}

interface WriteStreamInstance extends Writable {
  fd: number | null;
  bytesWritten: number;
  path: unknown;
  flags: string | number;
  mode: number;
  start: number | undefined;
  autoClose: boolean;
  open(): void;
  [kState]: StreamState;
}

/**
 * Node's fs.WriteStream is a function constructor (lib/internal/fs/streams.js):
 * callable without `new`, applicable to an object that already inherits its
 * prototype (graceful-fs subclasses it this way), and a replaced `open()` is
 * called instead of the built-in open, with writes held until it emits 'open'.
 */
export function createWriteStreamClass(
  fs: ReturnType<typeof createFs>,
  retain: () => void,
  release: () => void,
) {
  // Node's own prototype.open is a deprecated no-op; only a replacement opens.
  const defaultOpen = function open() {};

  function settle(stream: WriteStreamInstance, failure: Error | null, emitOpen: boolean) {
    const state = stream[kState];
    state.opening = false;
    const deferred = state.deferredDestroy;
    if (failure) {
      state.waiting = [];
      if (deferred) deferred(failure);
      else stream.destroy(failure);
      return;
    }
    // A destroy that arrived while opening still reports open and ready.
    if (emitOpen) {
      stream.emit('open', stream.fd);
      stream.emit('ready');
    }
    if (deferred) {
      deferred(null);
      return;
    }
    if (state.deferredAbort) {
      state.waiting = [];
      stream.destroy(state.deferredAbort);
      return;
    }
    const tasks = state.waiting;
    state.waiting = [];
    for (const task of tasks) task();
  }

  function openReplaced(stream: WriteStreamInstance) {
    // Node's backwards-compatible path for a monkey-patched open(): intercept the
    // stream's own 'open' or 'error' event to learn the outcome. That 'error'
    // event is consumed; the stream's destroy reports the failure.
    const original = stream.emit;
    const intercept = function (
      this: WriteStreamInstance,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === 'open') {
        this.emit = original;
        settle(this, null, false);
        return Reflect.apply(original, this, [event, ...args]);
      }
      if (event === 'error') {
        this.emit = original;
        const error = args[0];
        settle(this, error instanceof Error ? error : new Error(String(error)), false);
        return true;
      }
      return Reflect.apply(original, this, [event, ...args]);
    };
    // Invariant: intercept forwards every other event unchanged to the original.
    stream.emit = intercept as WriteStreamInstance['emit'];
    stream.open();
  }

  function openDescriptor(
    stream: WriteStreamInstance,
    flags: string | number,
    mode: number,
    modeFailure: Error | null,
  ) {
    let failure: Error | null = null;
    try {
      if (modeFailure) throw modeFailure;
      const fd = fs.openSync(stream.path, flags, mode);
      if (typeof fd !== 'number') throw fault('EPROTO', 'Invalid stream descriptor');
      stream.fd = fd;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      // Kernel faults carry the code; Node adds the failing syscall and path.
      if (typeof (failure as { code?: unknown }).code === 'string' && !('syscall' in failure))
        Object.assign(failure, { syscall: 'open', path: stream.path });
    }
    settle(stream, failure, true);
  }

  function WriteStream(this: unknown, path: unknown, options: unknown = {}): unknown {
    if (!(this instanceof WriteStream)) return Reflect.construct(WriteStream, [path, options]);
    // Invariant: `this` inherits WriteStream.prototype (checked above) and is
    // initialized below as a WriteStream instance.
    const stream = this as WriteStreamInstance;
    if (typeof options === 'string') options = { encoding: options };
    if (options === null || options === undefined) options = {};
    if (!record(options))
      throw invalidType('The "options" argument must be one of type string or object');
    if (typeof path !== 'string' && !(path instanceof URL))
      throw invalidType('The "path" argument must be of type string or an instance of URL');
    if (
      Object.keys(options).some((key) => !supportedOptions.includes(key)) ||
      (options.fd !== undefined && options.fd !== null) ||
      (options.fs !== undefined && options.fs !== null) ||
      options.flush === true ||
      options.autoClose === false ||
      options.emitClose === false
    )
      throw fault('ENOSYS', 'Unsupported write stream option');
    const flags = options.flags ?? 'w';
    const start = options.start;
    const highWaterMark = options.highWaterMark ?? 64 * 1024;
    const encoding = options.encoding;
    const signal = options.signal;
    if (typeof flags !== 'string' && typeof flags !== 'number')
      throw fault('ERR_INVALID_ARG_VALUE', 'The write stream flags are invalid');
    if (
      start !== undefined &&
      (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0)
    )
      throw fault('ERR_OUT_OF_RANGE', 'The "start" option must be a non-negative safe integer');
    if (
      typeof highWaterMark !== 'number' ||
      !Number.isSafeInteger(highWaterMark) ||
      highWaterMark < 0
    )
      throw fault('ERR_INVALID_ARG_VALUE', 'The write stream highWaterMark is invalid');
    if (encoding != null && (typeof encoding !== 'string' || !Buffer.isEncoding(encoding)))
      throw fault('ERR_INVALID_ARG_VALUE', 'The write stream encoding is invalid');
    if (options.autoClose !== undefined && typeof options.autoClose !== 'boolean')
      throw invalidType('The "options.autoClose" property must be of type boolean');
    if (options.emitClose !== undefined && typeof options.emitClose !== 'boolean')
      throw invalidType('The "options.emitClose" property must be of type boolean');
    if (options.flush !== undefined && typeof options.flush !== 'boolean')
      throw invalidType('The "options.flush" property must be of type boolean');
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw invalidType('The "options.signal" property must be an instance of AbortSignal');
    // Node validates the mode when it opens the file, as an 'error' event.
    let mode = 0o666;
    let modeFailure: Error | null = null;
    try {
      mode = modeOf(options.mode);
    } catch (error) {
      modeFailure = error instanceof Error ? error : new Error(String(error));
    }
    // Invariant: readable-stream 4's Writable is a function constructor that
    // initializes the object it is applied to when it inherits Writable.prototype,
    // as Node's Writable does.
    Reflect.apply(Writable as unknown as (options: object) => void, stream, [
      {
        highWaterMark,
        autoDestroy: true,
        emitClose: true,
        decodeStrings: true,
        defaultEncoding: typeof encoding === 'string' ? encoding : 'utf8',
      },
    ]);
    stream.fd = null;
    stream.bytesWritten = 0;
    stream.path = path;
    stream.flags = flags;
    stream.mode = mode;
    stream.start = start;
    stream.autoClose = true;
    const state: StreamState = {
      position: start,
      opening: true,
      waiting: [],
      deferredDestroy: null,
      deferredAbort: null,
    };
    Object.defineProperty(stream, kState, { value: state });
    retain();
    stream.once('close', release);
    if (signal) {
      const onAbort = () => {
        const error = abortError(signal);
        // Node finishes opening before an abort destroys the stream.
        if (state.opening) state.deferredAbort = error;
        else stream.destroy(error);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      stream.once('close', () => signal.removeEventListener('abort', onAbort));
    }
    queueMicrotask(() => {
      if (stream.open !== defaultOpen) openReplaced(stream);
      else openDescriptor(stream, flags, mode, modeFailure);
    });
    return undefined;
  }

  function submit(stream: WriteStreamInstance, chunks: Uint8Array[], done: Done) {
    const state = stream[kState];
    const task = () =>
      queueMicrotask(() => {
        if (stream.destroyed || stream.fd === null) return;
        try {
          const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
          let offset = 0;
          do {
            const count = fs.writeSync(
              stream.fd,
              bytes,
              offset,
              bytes.length - offset,
              state.position === undefined ? null : state.position + offset,
            );
            if (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
              throw fault('EPROTO', 'Invalid stream write');
            if (count === 0 && offset < bytes.length) throw fault('EIO', 'Stream write stalled');
            offset += count;
          } while (offset < bytes.length);
          if (state.position !== undefined) state.position += bytes.length;
          stream.bytesWritten += bytes.length;
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        done();
      });
    if (state.opening) state.waiting.push(task);
    else task();
  }

  const methods: ThisType<WriteStreamInstance> & Record<string, unknown> = {
    open: defaultOpen,
    _final(done: Done) {
      // An empty stream still opens (and creates or truncates) before it finishes.
      if (this[kState].opening) this[kState].waiting.push(() => done());
      else done();
    },
    _write(chunk: Uint8Array, _encoding: string, done: Done) {
      submit(this, [chunk], done);
    },
    _writev(entries: { chunk: Uint8Array }[], done: Done) {
      submit(
        this,
        entries.map((entry) => entry.chunk),
        done,
      );
    },
    _destroy(error: Error | null, done: Done) {
      const finish = (cause: Error | null) => {
        // Node closes the descriptor asynchronously, so 'close' follows 'finish' and
        // 'end' callbacks by a macrotask. Close the descriptor on the same schedule.
        setTimeout(() => {
          let failure = cause;
          try {
            if (this.fd !== null) fs.closeSync(this.fd);
          } catch (closeError) {
            failure ??= closeError instanceof Error ? closeError : new Error(String(closeError));
          } finally {
            this.fd = null;
            // The Writable marks itself closed when this callback runs, as Node's does.
            done(failure);
          }
        }, 0);
      };
      if (this[kState].opening)
        this[kState].deferredDestroy = (openError) => finish(error ?? openError);
      else finish(error);
    },
    close(callback?: Done) {
      if (callback) {
        if (this.closed) queueMicrotask(() => callback());
        else this.once('close', () => callback());
      }
      this.end();
    },
    destroySoon() {
      this.end();
    },
  };
  Object.setPrototypeOf(WriteStream.prototype, Writable.prototype);
  Object.setPrototypeOf(WriteStream, Writable);
  for (const [name, value] of Object.entries(methods))
    Object.defineProperty(WriteStream.prototype, name, {
      value,
      writable: true,
      configurable: true,
    });
  Object.defineProperty(WriteStream.prototype, 'pending', {
    get(this: WriteStreamInstance) {
      return this.fd === null;
    },
    configurable: true,
  });
  // Invariant: WriteStream is a function constructor whose prototype chain was
  // set to Writable above; callers construct it with `new` or call it directly.
  return WriteStream as unknown as new (
    path: unknown,
    options?: unknown,
  ) => WriteStreamInstance;
}
