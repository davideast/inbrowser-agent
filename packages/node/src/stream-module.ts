// The guest `stream` module: readable-stream 4.7.0's lib/stream.js (a mirror of
// Node 18.19's streams) brought to Node 22.18's surface. Each adjustment below is a
// Node 18 to 22 difference or a bundling artifact; the stream machinery itself is
// the library's, unmodified.
import browserProcess from 'process/browser';
import * as stream from 'readable-stream/lib/stream.js';
import { installReadableWebAdapters } from './stream-web-adapters';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- prototype surgery on the library's classes

const kCallback = Symbol('Callback');
const kInitOtherSide = Symbol('InitOtherSide');

// Node 22.18 lib/internal/streams/duplexpair.js (Copyright Node.js contributors, MIT).
class DuplexSide extends stream.Duplex {
  #otherSide: DuplexSide | null = null;
  [kCallback]: (() => void) | null = null;

  [kInitOtherSide](otherSide: DuplexSide) {
    // Set once, to enforce encapsulation (Node asserts the same).
    if (this.#otherSide !== null) throw new Error('DuplexSide is already paired');
    this.#otherSide = otherSide;
  }

  _read() {
    const callback = this[kCallback];
    if (callback) {
      this[kCallback] = null;
      callback();
    }
  }

  _write(chunk: { length: number }, _encoding: string, callback: () => void) {
    // Invariant: both sides are paired before duplexPair returns them.
    const other = this.#otherSide as DuplexSide;
    if (chunk.length === 0) {
      browserProcess.nextTick(callback);
    } else {
      other.push(chunk);
      other[kCallback] = callback;
    }
  }

  _final(callback: () => void) {
    const other = this.#otherSide as DuplexSide;
    other.on('end', callback);
    other.push(null);
  }
}

function duplexPair(options?: ConstructorParameters<typeof stream.Duplex>[0]) {
  const side0 = new DuplexSide(options);
  const side1 = new DuplexSide(options);
  side0[kInitOtherSide](side1);
  side1[kInitOtherSide](side0);
  return [side0, side1];
}

/**
 * The bundler suffixes a function's name with a number when another bundled
 * symbol has the same name (`Readable9`). Restores the name when the suffix is
 * the only difference from the property that holds the function, as in Node.
 */
function restoreNames(target: object) {
  for (const key of Object.getOwnPropertyNames(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const value: unknown = descriptor?.value;
    if (typeof value !== 'function' || value.name === key) continue;
    if (value.name.replace(/\d+$/, '') === key)
      Object.defineProperty(value, 'name', { value: key, configurable: true });
  }
}

/** Shapes the library module as Node 22.18's `stream` module and returns it. */
export function installNodeStream() {
  const module = stream.Stream as Any;
  installReadableWebAdapters(stream);
  // Node 22 raised the default byte high-water mark from 16 KiB to 64 KiB.
  stream.setDefaultHighWaterMark(false, 65536);
  // events 3.3.0 has no captureRejectionSymbol, so the library keyed its rejection
  // handlers by the string 'undefined'; Node keys them by Symbol.for('nodejs.rejection').
  for (const proto of [stream.Readable.prototype, stream.Writable.prototype] as Any[]) {
    const handler = Object.getOwnPropertyDescriptor(proto, 'undefined');
    if (!handler) continue;
    delete proto.undefined;
    Object.defineProperty(proto, Symbol.for('nodejs.rejection'), handler);
  }
  // Node 22 removed the deprecated Readable.prototype.asIndexedPairs operator.
  delete (stream.Readable.prototype as Any).asIndexedPairs;
  Object.assign(module, { duplexPair, _isArrayBufferView: ArrayBuffer.isView });
  restoreNames(module);
  restoreNames(module.promises);
  return module;
}
