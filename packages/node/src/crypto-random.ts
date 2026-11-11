import { Buffer } from 'buffer';
import { captured } from './context-hook';
import { invalidArgType, outOfRange } from './crypto-args';
import { fault } from './protocol';
import { resourceLimits } from './resource-policy';

const fill = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
const RAND_MAX = 0xffff_ffff_ffff;

export function createRandomBytes(retain: () => () => void) {
  return function randomBytes(size: unknown, callback?: unknown) {
    if (typeof size !== 'number')
      throw Object.assign(new TypeError('size must be a number'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (!Number.isFinite(size) || size < 0 || size > 0x7fffffff)
      throw Object.assign(new RangeError('size is outside the byte allocation range'), {
        code: 'ERR_OUT_OF_RANGE',
      });
    if (callback !== undefined && typeof callback !== 'function')
      throw Object.assign(new TypeError('callback must be a function'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    const length = Math.floor(size);
    if (length > resourceLimits().child.randomAllocationBytes)
      throw fault('E2BIG', 'Random byte allocation exceeds 32 MiB');
    const generate = () => {
      const bytes = Buffer.alloc(length);
      for (let offset = 0; offset < length; offset += 65536)
        fill(bytes.subarray(offset, Math.min(offset + 65536, length)));
      return bytes;
    };
    if (callback === undefined) return generate();
    // Invariant: typeof callback === 'function' was validated above when callback !== undefined.
    const done = captured(callback as (err: Error | null, buf?: Buffer) => void);
    if (length === 0) {
      done(null, Buffer.alloc(0));
      return;
    }
    const release = retain();
    queueMicrotask(() => {
      let bytes: Buffer | undefined;
      let error: Error | null = null;
      try {
        bytes = generate();
      } catch (cause) {
        error = cause instanceof Error ? cause : fault('EIO', String(cause));
      }
      try {
        done(error, bytes);
      } finally {
        release();
      }
    });
  };
}

export function createRandomInt(retain: () => () => void) {
  const sampleBuf = Buffer.alloc(6);

  function drawUnbiased(min: number, range: number): number {
    const randLimit = RAND_MAX - (RAND_MAX % range);
    for (;;) {
      fill(sampleBuf);
      const x = sampleBuf.readUIntBE(0, 6);
      if (x < randLimit) {
        return (x % range) + min;
      }
    }
  }

  return function randomInt(
    minArg: unknown,
    maxArg?: unknown,
    callbackArg?: unknown,
  ): number | undefined {
    const minNotSpecified = maxArg === undefined || typeof maxArg === 'function';
    let min: unknown = minArg;
    let max: unknown = maxArg;
    let callback: unknown = callbackArg;

    if (minNotSpecified) {
      callback = maxArg;
      max = minArg;
      min = 0;
    }

    const isSync = callback === undefined;
    if (!isSync && typeof callback !== 'function') {
      throw invalidArgType('callback', 'of type function', callback);
    }
    if (typeof min !== 'number' || !Number.isSafeInteger(min)) {
      throw invalidArgType('min', 'a safe integer', min);
    }
    if (typeof max !== 'number' || !Number.isSafeInteger(max)) {
      throw invalidArgType('max', 'a safe integer', max);
    }
    if (max <= min) {
      throw outOfRange('max', `greater than the value of "min" (${min})`, max);
    }

    const range = max - min;
    if (!(range <= RAND_MAX)) {
      throw outOfRange(minNotSpecified ? 'max' : 'max - min', `<= ${RAND_MAX}`, range);
    }

    const n = drawUnbiased(min, range);
    if (isSync) {
      return n;
    }

    // Invariant: !isSync verified typeof callback === 'function' above.
    const done = captured(callback as (err: Error | undefined, value: number) => void);
    const release = retain();
    queueMicrotask(() => {
      try {
        done(undefined, n);
      } finally {
        release();
      }
    });
  };
}

const typeError = (message: string) =>
  Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
const rangeError = (message: string) =>
  Object.assign(new RangeError(message), { code: 'ERR_OUT_OF_RANGE' });

/** The target as bytes, or a TypeError for anything but an ArrayBuffer or view. */
function targetBytes(target: unknown): { bytes: Uint8Array; elementSize: number } {
  if (target instanceof ArrayBuffer || target instanceof SharedArrayBuffer)
    return { bytes: new Uint8Array(target), elementSize: 1 };
  if (ArrayBuffer.isView(target)) {
    const perElement = (target as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT;
    return {
      bytes: new Uint8Array(target.buffer, target.byteOffset, target.byteLength),
      elementSize: typeof perElement === 'number' ? perElement : 1,
    };
  }
  throw typeError(
    'The "buf" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.',
  );
}

// Node's assertOffset and assertSize (lib/internal/crypto/random.js): counts are in
// elements of the view, converted to bytes, then truncated to an unsigned integer.
function byteOffset(offset: unknown, elementSize: number, length: number) {
  if (typeof offset !== 'number') throw typeError('The "offset" argument must be of type number');
  const bytes = offset * elementSize;
  if (Number.isNaN(bytes) || bytes > length || bytes < 0)
    throw rangeError('The value of "offset" is out of range');
  return bytes >>> 0;
}
function byteSize(size: unknown, elementSize: number, offset: number, length: number) {
  if (typeof size !== 'number') throw typeError('The "size" argument must be of type number');
  const bytes = size * elementSize;
  if (Number.isNaN(bytes) || bytes > 0x7fffffff || bytes < 0 || bytes + offset > length)
    throw rangeError('The value of "size" is out of range');
  return bytes >>> 0;
}
function fillRange(bytes: Uint8Array, offset: number, size: number) {
  if (size > resourceLimits().child.randomAllocationBytes)
    throw fault('E2BIG', 'Random byte allocation exceeds 32 MiB');
  for (let start = offset; start < offset + size; start += 65536)
    fill(bytes.subarray(start, Math.min(start + 65536, offset + size)));
}

/** crypto.randomFillSync and crypto.randomFill over the browser's CSPRNG. */
export function createRandomFill(retain: () => () => void) {
  const randomFillSync = (target: unknown, offset: unknown = 0, size?: unknown) => {
    const { bytes, elementSize } = targetBytes(target);
    const start = byteOffset(offset, elementSize, bytes.byteLength);
    const length =
      size === undefined
        ? bytes.byteLength - start
        : byteSize(size, elementSize, start, bytes.byteLength);
    fillRange(bytes, start, length);
    return target;
  };
  const randomFill = (target: unknown, offset?: unknown, size?: unknown, callback?: unknown) => {
    const { bytes, elementSize } = targetBytes(target);
    let done = callback;
    let start = 0;
    let length = bytes.byteLength;
    if (typeof offset === 'function') done = offset;
    else if (typeof size === 'function') {
      done = size;
      start = byteOffset(offset, elementSize, bytes.byteLength);
      length = bytes.byteLength - start;
    } else {
      if (typeof done !== 'function')
        throw typeError('The "callback" argument must be of type function');
      start = byteOffset(offset, elementSize, bytes.byteLength);
      length =
        size === undefined
          ? bytes.byteLength - start
          : byteSize(size, elementSize, start, bytes.byteLength);
    }
    // Invariant: each branch above leaves a function in `done` or has thrown.
    const callbackFunction = captured(done as (error: Error | null, value?: unknown) => void);
    const release = retain();
    queueMicrotask(() => {
      let error: Error | null = null;
      try {
        fillRange(bytes, start, length);
      } catch (cause) {
        error = cause instanceof Error ? cause : fault('EIO', String(cause));
      }
      try {
        if (error) callbackFunction(error);
        else callbackFunction(null, target);
      } finally {
        release();
      }
    });
  };
  return { randomFillSync, randomFill };
}
