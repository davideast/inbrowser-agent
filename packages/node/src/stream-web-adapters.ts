import { Buffer } from 'buffer';
import { Duplex, Readable, Writable, finished } from 'readable-stream/lib/stream.js';
import { inspect } from 'util/';
import { abortError, invalidArgType, invalidArgValue, nodeError } from './node-errors';
import { record } from './protocol';

// Node 22.18's Web <-> Node stream adapters (lib/internal/webstreams/adapters.js),
// ReadableStream.from (lib/internal/webstreams/readablestream.js), and
// Writable.prototype[Symbol.asyncDispose] (lib/internal/streams/writable.js),
// layered over bundled readable-stream 4.7.0.

type ReadableState = {
  destroyed?: boolean;
  endEmitted?: boolean;
  objectMode?: boolean;
  highWaterMark?: number;
};

type WritableState = {
  destroyed?: boolean;
  errored?: Error | null;
  ended?: boolean;
  ending?: boolean;
  finished?: boolean;
  objectMode?: boolean;
  highWaterMark?: number;
};

const invalidState = (message: string) => nodeError(TypeError, 'ERR_INVALID_STATE', message);

const notIterable = (value: unknown) =>
  nodeError(TypeError, 'ERR_ARG_NOT_ITERABLE', `${inspect(value)} must be iterable`);

function hasReadableState(value: unknown): value is Readable & {
  _readableState: ReadableState;
  readable?: boolean;
} {
  return record(value) && record(value._readableState);
}

function hasWritableState(value: unknown): value is Writable & {
  _writableState: WritableState;
  writable?: boolean;
  writableNeedDrain?: boolean;
  writableFinished?: boolean;
  writableObjectMode?: boolean;
  writableHighWaterMark?: number;
} {
  return record(value) && record(value._writableState);
}

function wireAbortSignal(
  signal: unknown,
  argName: string,
  target: {
    destroy: (error?: Error) => unknown;
    once: (event: string, listener: () => void) => unknown;
  },
): void {
  if (signal === undefined) return;
  if (!(signal instanceof AbortSignal)) {
    throw invalidArgType(argName, 'AbortSignal', signal);
  }
  const onAbort = () => {
    target.destroy(abortError(undefined, { cause: signal.reason }));
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
    target.once('close', () => signal.removeEventListener('abort', onAbort));
  }
}

function invokeCallbackSafely(callback: (error?: Error | null) => void, error?: Error | null) {
  try {
    callback(error);
  } catch (thrown) {
    // Escape promise handlers so synchronous callback throws surface as uncaught exceptions.
    queueMicrotask(() => {
      throw thrown;
    });
  }
}

type IteratorLike = {
  next: () => unknown;
  return?: (value?: unknown) => unknown;
};

function from(iterable: unknown): ReadableStream<unknown> {
  if (iterable === undefined) {
    throw new TypeError(
      "Cannot read properties of undefined (reading 'Symbol(Symbol.asyncIterator)')",
    );
  }
  if (iterable === null) {
    throw new TypeError("Cannot read properties of null (reading 'Symbol(Symbol.asyncIterator)')");
  }
  // Invariant: Object(iterable) boxes non-nullish primitives into an object supporting symbol lookup.
  const target = Object(iterable) as Record<symbol, unknown>;
  const asyncMethod = target[Symbol.asyncIterator];
  let iterator: unknown;
  let isAsync = false;
  if (asyncMethod !== undefined && asyncMethod !== null) {
    if (typeof asyncMethod !== 'function') throw notIterable(iterable);
    iterator = Reflect.apply(asyncMethod, iterable, []);
    isAsync = true;
  } else {
    const syncMethod = target[Symbol.iterator];
    if (typeof syncMethod !== 'function') throw notIterable(iterable);
    iterator = Reflect.apply(syncMethod, iterable, []);
  }
  if (!record(iterator) || typeof iterator.next !== 'function') {
    throw new TypeError('Iterator result is not an object');
  }
  // Invariant: iterator is verified above as an object with a callable next method.
  const iter = iterator as IteratorLike;
  let reading = false;
  return new ReadableStream<unknown>(
    {
      async pull(controller) {
        if (reading) return;
        reading = true;
        try {
          const step: unknown = await Reflect.apply(iter.next, iter, []);
          if (!record(step)) {
            throw new TypeError('Iterator.next() returned a non-object value');
          }
          if (step.done) {
            controller.close();
          } else {
            const resolvedValue = isAsync ? step.value : await step.value;
            controller.enqueue(resolvedValue);
          }
        } catch (err) {
          controller.error(err);
        } finally {
          reading = false;
        }
      },
      async cancel(reason) {
        if (typeof iter.return === 'function') {
          const result: unknown = await Reflect.apply(iter.return, iter, [reason]);
          if (!record(result)) {
            throw new TypeError('Iterator.return() returned a non-object value');
          }
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function readableToWeb(streamReadable: unknown, options: unknown = {}): ReadableStream {
  if (!hasReadableState(streamReadable)) {
    throw invalidArgType('streamReadable', 'stream.Readable', streamReadable);
  }
  const source = streamReadable;
  const readableState = source._readableState;
  if (readableState.destroyed || readableState.endEmitted || source.readable === false) {
    const closed = new ReadableStream();
    void closed.cancel();
    return closed;
  }
  if (options !== undefined) {
    if (!record(options)) {
      throw invalidArgType('options', 'Object', options);
    }
  }
  const objectMode = readableState.objectMode === true;
  const highWaterMark = readableState.highWaterMark ?? (objectMode ? 16 : 16 * 1024);
  // Invariant: options is narrowed by record(options) and strategy is an optional QueuingStrategy.
  const supplied = record(options) ? (options.strategy as QueuingStrategy | undefined) : undefined;
  const strategy: QueuingStrategy =
    supplied ??
    (objectMode
      ? new CountQueuingStrategy({ highWaterMark })
      : new ByteLengthQueuingStrategy({ highWaterMark }));
  let controller!: ReadableStreamDefaultController;
  let canceled = false;
  const onData = (chunk: unknown) => {
    // Copy a Buffer so the web chunk is a plain, detached Uint8Array, as Node does.
    const value = Buffer.isBuffer(chunk) && !objectMode ? new Uint8Array(chunk) : chunk;
    controller.enqueue(value);
    if ((controller.desiredSize ?? 0) <= 0) source.pause();
  };
  source.pause();
  const cleanup = finished(source, (error?: Error | null) => {
    cleanup();
    // Legacy streams may emit 'error' again after finishing.
    source.on('error', () => {});
    let failure: Error | null | undefined = error;
    if (failure && record(failure) && failure.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      failure = abortError(undefined, { cause: failure });
    }
    if (failure) return controller.error(failure);
    if (!canceled) controller.close();
  });
  source.on('data', onData);
  return new ReadableStream(
    {
      start(c) {
        controller = c;
      },
      pull() {
        source.resume();
      },
      cancel(reason) {
        canceled = true;
        source.destroy(reason instanceof Error ? reason : undefined);
      },
    },
    strategy,
  );
}

function readableFromWeb(readableStream: unknown, options: unknown = {}): Readable {
  if (!(readableStream instanceof ReadableStream)) {
    throw invalidArgType('readableStream', 'ReadableStream', readableStream);
  }
  if (!record(options)) {
    throw invalidArgType('options', 'Object', options);
  }
  const { highWaterMark, encoding, objectMode = false, signal } = options;
  if (encoding !== undefined && (typeof encoding !== 'string' || !Buffer.isEncoding(encoding))) {
    throw invalidArgValue('options.encoding', encoding);
  }
  if (typeof objectMode !== 'boolean') {
    throw invalidArgType('options.objectMode', 'boolean', objectMode);
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidArgType('options.signal', 'AbortSignal', signal);
  }
  if (readableStream.locked) {
    throw invalidState('Invalid state: ReadableStream is locked');
  }
  const reader = readableStream.getReader();
  let closed = false;
  const readable: Readable = new Readable({
    objectMode,
    highWaterMark: typeof highWaterMark === 'number' ? highWaterMark : undefined,
    // Invariant: Buffer.isEncoding(encoding) above verified encoding is a valid BufferEncoding.
    encoding: typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined,
    read() {
      reader.read().then(
        (chunk) => {
          if (chunk.done) readable.push(null);
          else readable.push(chunk.value);
        },
        (error) => readable.destroy(error),
      );
    },
    destroy(error, callback) {
      const done = () => invokeCallbackSafely(callback, error);
      if (!closed) {
        reader.cancel(error).then(done, done);
        return;
      }
      done();
    },
  });
  reader.closed.then(
    () => {
      closed = true;
    },
    (error) => {
      closed = true;
      readable.destroy(error);
    },
  );
  wireAbortSignal(signal, 'options.signal', readable);
  return readable;
}

function writableToWeb(streamWritable: unknown): WritableStream {
  if (!hasWritableState(streamWritable)) {
    throw invalidArgType('streamWritable', 'stream.Writable', streamWritable);
  }
  const sink = streamWritable;
  const writableState = sink._writableState;
  if (
    writableState.destroyed ||
    writableState.errored ||
    writableState.ended ||
    writableState.finished ||
    sink.writable === false
  ) {
    const closed = new WritableStream();
    void closed.close();
    return closed;
  }
  const highWaterMark =
    sink.writableHighWaterMark ??
    writableState.highWaterMark ??
    (writableState.objectMode ? 16 : 16 * 1024);

  let controller!: WritableStreamDefaultController;
  let backpressure: Promise<void> | undefined;
  let resolveBackpressure: (() => void) | null = null;
  let rejectBackpressure: ((reason?: unknown) => void) | null = null;

  const waitForDrain = (): Promise<void> => {
    if (!backpressure) {
      backpressure = new Promise<void>((resolve, reject) => {
        resolveBackpressure = () => {
          backpressure = undefined;
          resolveBackpressure = null;
          rejectBackpressure = null;
          resolve();
        };
        rejectBackpressure = (err) => {
          backpressure = undefined;
          resolveBackpressure = null;
          rejectBackpressure = null;
          reject(err);
        };
      });
    }
    return backpressure;
  };

  const onDrain = () => {
    resolveBackpressure?.();
  };
  sink.on('drain', onDrain);

  const cleanup = finished(sink, (error?: Error | null) => {
    cleanup();
    sink.removeListener('drain', onDrain);
    sink.on('error', () => {});
    let failure: Error | null | undefined = error;
    if (failure && record(failure) && failure.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      failure = abortError(undefined, { cause: failure });
    }
    if (failure) {
      rejectBackpressure?.(failure);
      controller.error(failure);
      return;
    }
    resolveBackpressure?.();
  });

  return new WritableStream(
    {
      start(c) {
        controller = c;
      },
      write(chunk) {
        if (sink.writableNeedDrain || !sink.write(chunk)) {
          return waitForDrain();
        }
        return undefined;
      },
      close() {
        return new Promise<void>((resolve, reject) => {
          let settled = false;
          const cleanupClose = finished(sink, (err?: Error | null) => {
            if (!settled) {
              settled = true;
              cleanupClose();
            }
            if (err) reject(err);
            else resolve();
          });
          sink.end();
        });
      },
      abort(reason) {
        sink.destroy(reason instanceof Error ? reason : undefined);
      },
    },
    new CountQueuingStrategy({ highWaterMark }),
  );
}

function writableFromWeb(writableStream: unknown, options: unknown = {}): Writable {
  if (!(writableStream instanceof WritableStream)) {
    throw invalidArgType('writableStream', 'WritableStream', writableStream);
  }
  if (!record(options)) {
    throw invalidArgType('options', 'Object', options);
  }
  const { highWaterMark, decodeStrings = true, objectMode = false, signal } = options;
  if (typeof objectMode !== 'boolean') {
    throw invalidArgType('options.objectMode', 'boolean', objectMode);
  }
  if (typeof decodeStrings !== 'boolean') {
    throw invalidArgType('options.decodeStrings', 'boolean', decodeStrings);
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidArgType('signal', 'AbortSignal', signal);
  }
  if (writableStream.locked) {
    throw invalidState('Invalid state: WritableStream is locked');
  }
  const writer = writableStream.getWriter();
  let closed = false;
  const writable = new Writable({
    objectMode,
    decodeStrings,
    highWaterMark: typeof highWaterMark === 'number' ? highWaterMark : undefined,
    writev(chunks, callback) {
      const writeAll = async () => {
        for (const item of chunks) {
          await writer.ready;
          await writer.write(item.chunk);
        }
      };
      writeAll().then(
        () => callback(),
        (error) => callback(error),
      );
    },
    write(chunk, _encoding, callback) {
      writer.ready
        .then(() => writer.write(chunk))
        .then(
          () => callback(),
          (error) => callback(error),
        );
    },
    final(callback) {
      if (closed) {
        callback();
        return;
      }
      writer.close().then(
        () => {
          closed = true;
          callback();
        },
        (error) => {
          closed = true;
          callback(error);
        },
      );
    },
    destroy(error, callback) {
      const done = () => invokeCallbackSafely(callback, error);
      if (!closed) {
        closed = true;
        writer.abort(error ?? undefined).then(done, done);
        return;
      }
      done();
    },
  });
  writer.closed.then(
    () => {
      closed = true;
    },
    (error) => {
      closed = true;
      if (!writable.destroyed && !writable.writableEnded) {
        writable.destroy(error);
      }
    },
  );
  wireAbortSignal(signal, 'signal', writable);
  return writable;
}

function duplexToWeb(duplex: unknown): { writable: WritableStream; readable: ReadableStream } {
  if (!hasReadableState(duplex) || !hasWritableState(duplex)) {
    throw invalidArgType('duplex', 'stream.Duplex', duplex);
  }
  return {
    writable: writableToWeb(duplex),
    readable: readableToWeb(duplex),
  };
}

function duplexFromWeb(pair: unknown, options: unknown = {}): Duplex {
  if (!record(pair)) {
    throw invalidArgType('pair', 'Object', pair);
  }
  const { readable: readableStream, writable: writableStream } = pair;
  if (!(readableStream instanceof ReadableStream)) {
    throw invalidArgType('pair.readable', 'ReadableStream', readableStream);
  }
  if (!(writableStream instanceof WritableStream)) {
    throw invalidArgType('pair.writable', 'WritableStream', writableStream);
  }
  if (!record(options)) {
    throw invalidArgType('options', 'Object', options);
  }
  const {
    allowHalfOpen = false,
    objectMode = false,
    encoding,
    decodeStrings = true,
    highWaterMark,
    signal,
  } = options;
  if (typeof objectMode !== 'boolean') {
    throw invalidArgType('options.objectMode', 'boolean', objectMode);
  }
  if (typeof decodeStrings !== 'boolean') {
    throw invalidArgType('options.decodeStrings', 'boolean', decodeStrings);
  }
  if (encoding !== undefined && (typeof encoding !== 'string' || !Buffer.isEncoding(encoding))) {
    throw invalidArgValue('options.encoding', encoding);
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidArgType('signal', 'AbortSignal', signal);
  }
  if (readableStream.locked) {
    throw invalidState('Invalid state: ReadableStream is locked');
  }
  if (writableStream.locked) {
    throw invalidState('Invalid state: WritableStream is locked');
  }

  const reader = readableStream.getReader();
  const writer = writableStream.getWriter();
  let readableClosed = false;
  let writableClosed = false;

  const duplex: Duplex = new Duplex({
    allowHalfOpen: Boolean(allowHalfOpen),
    objectMode,
    decodeStrings,
    highWaterMark: typeof highWaterMark === 'number' ? highWaterMark : undefined,
    // Invariant: Buffer.isEncoding(encoding) above verified encoding is a valid BufferEncoding.
    encoding: typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined,
    read() {
      reader.read().then(
        (chunk) => {
          if (chunk.done) duplex.push(null);
          else duplex.push(chunk.value);
        },
        (error) => duplex.destroy(error),
      );
    },
    writev(chunks, callback) {
      const writeAll = async () => {
        for (const item of chunks) {
          await writer.ready;
          await writer.write(item.chunk);
        }
      };
      writeAll().then(
        () => callback(),
        (error) => callback(error),
      );
    },
    write(chunk, _enc, callback) {
      writer.ready
        .then(() => writer.write(chunk))
        .then(
          () => callback(),
          (error) => callback(error),
        );
    },
    final(callback) {
      if (writableClosed) {
        callback();
        return;
      }
      writer.close().then(
        () => {
          writableClosed = true;
          callback();
        },
        (error) => {
          writableClosed = true;
          callback(error);
        },
      );
    },
    destroy(error, callback) {
      const done = () => invokeCallbackSafely(callback, error);
      const pending: Promise<unknown>[] = [];
      if (!readableClosed) {
        readableClosed = true;
        pending.push(reader.cancel(error ?? undefined));
      }
      if (!writableClosed) {
        writableClosed = true;
        pending.push(writer.abort(error ?? undefined));
      }
      if (pending.length > 0) {
        Promise.allSettled(pending).then(done);
        return;
      }
      done();
    },
  });

  reader.closed.then(
    () => {
      readableClosed = true;
    },
    (error) => {
      readableClosed = true;
      writableClosed = true;
      writer.abort(error).catch(() => {});
      duplex.destroy(error);
    },
  );

  writer.closed.then(
    () => {
      writableClosed = true;
    },
    (error) => {
      writableClosed = true;
      readableClosed = true;
      reader.cancel(error).catch(() => {});
      duplex.destroy(error);
    },
  );

  wireAbortSignal(signal, 'signal', duplex);
  return duplex;
}

async function writableAsyncDispose(
  this: Writable & { destroyed?: boolean; writableFinished?: boolean },
): Promise<void> {
  if (!this.destroyed) {
    const error = this.writableFinished ? null : abortError();
    this.destroy(error ?? undefined);
  }
  await new Promise<void>((resolve, reject) => {
    finished(this, (err?: Error | null) => {
      if (err && err.name !== 'AbortError') reject(err);
      else resolve();
    });
  });
}

/**
 * Installs Node 22.18's Web <-> Node stream adapters on Readable, Writable, and Duplex,
 * installs ReadableStream.from on globalThis.ReadableStream, and defines
 * Writable.prototype[Symbol.asyncDispose].
 */
export function installReadableWebAdapters(target: {
  Readable: typeof Readable;
  Writable: typeof Writable;
  Duplex: typeof Duplex;
}) {
  if (typeof globalThis.ReadableStream === 'function') {
    Object.defineProperty(globalThis.ReadableStream, 'from', {
      value: from,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  Object.assign(target.Readable, { toWeb: readableToWeb, fromWeb: readableFromWeb });
  Object.assign(target.Writable, { toWeb: writableToWeb, fromWeb: writableFromWeb });
  Object.assign(target.Duplex, { toWeb: duplexToWeb, fromWeb: duplexFromWeb });

  if (typeof Symbol.asyncDispose === 'symbol') {
    Object.defineProperty(target.Writable.prototype, Symbol.asyncDispose, {
      value: writableAsyncDispose,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}
