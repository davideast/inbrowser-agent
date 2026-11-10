import { Buffer } from 'buffer';
import type { Transform } from 'stream';
import * as stream from 'readable-stream/lib/stream.js';
import shaHash from 'sha.js';
import {
  decodeText,
  invalidArgType,
  resolveDigest,
  stringBytes,
  textEncoding,
  typeList,
  validateInteger,
  validateString,
  viewBytes,
} from './crypto-args';
import { fipsDigestError, fipsEnabled } from './crypto-fips';
import { encodeOutput } from './crypto-hmac';
import { fault } from './protocol';

type ShaHandle = ReturnType<typeof shaHash>;
const algorithms: shaHash.Algorithm[] = ['sha1', 'sha224', 'sha256', 'sha384', 'sha512'];
const dataTypes = typeList(['string'], ['Buffer', 'TypedArray', 'DataView']);

function finalizedError(): Error {
  return Object.assign(new Error('Digest already called'), {
    code: 'ERR_CRYPTO_HASH_FINALIZED',
  });
}

function updateBytes(data: unknown, encoding: unknown): Buffer {
  if (typeof data === 'string') {
    const name = textEncoding(encoding);
    if (name === 'hex' && data.length % 2 !== 0) {
      throw Object.assign(
        new TypeError(
          `The argument 'encoding' is invalid for data of length ${data.length}. Received '${String(encoding)}'`,
        ),
        { code: 'ERR_INVALID_ARG_VALUE' },
      );
    }
    return decodeText(data, name ?? 'utf8');
  }
  if (!ArrayBuffer.isView(data)) {
    throw invalidArgType('data', dataTypes, data);
  }
  const bytes = viewBytes(data);
  if (!bytes) {
    throw invalidArgType('data', dataTypes, data);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function cloneShaState(algName: shaHash.Algorithm, source: ShaHandle): ShaHandle {
  const cloned = shaHash(algName);
  for (const key of Object.keys(source)) {
    if (key === '_w') continue;
    const val: unknown = Reflect.get(source, key);
    if (Buffer.isBuffer(val)) {
      Reflect.set(cloned, key, Buffer.from(val));
    } else if (val instanceof Uint8Array) {
      Reflect.set(cloned, key, Buffer.from(val.buffer, val.byteOffset, val.byteLength));
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      Reflect.set(cloned, key, val);
    }
  }
  return cloned;
}

class CloneSource {
  constructor(
    readonly algName: shaHash.Algorithm,
    readonly handle: ShaHandle,
  ) {}
}

interface HashState {
  algName: shaHash.Algorithm;
  handle: ShaHandle;
  finalized: boolean;
}

export interface HashInstance extends Transform {
  update(data: string | ArrayBufferView, inputEncoding?: BufferEncoding): this;
  digest(): Buffer;
  digest(encoding: BufferEncoding): string;
  digest(encoding?: unknown): Buffer | string;
  copy(options?: unknown): HashInstance;
}

export interface HashConstructor {
  new (algorithm: string, options?: unknown): HashInstance;
  (algorithm: string, options?: unknown): HashInstance;
  prototype: HashInstance;
}

export function createHashClass(
  TransformClass: typeof Transform,
  onDeprecatedHashCtor?: () => void,
): {
  Hash: HashConstructor;
  createHash: (algorithm: string, options?: unknown) => HashInstance;
} {
  let internalCall = false;
  const states = new WeakMap<object, HashState>();
  const stateOf = (self: object): HashState => {
    const s = states.get(self);
    if (!s) {
      throw Object.assign(new TypeError('The "this" argument must be an instance of Hash'), {
        code: 'ERR_INVALID_THIS',
      });
    }
    return s;
  };

  const HashFn = function Hash(this: unknown, algorithm: unknown, options?: unknown) {
    const isCopy = algorithm instanceof CloneSource;
    if (!internalCall && !isCopy) {
      onDeprecatedHashCtor?.();
    }
    if (!(this instanceof HashFn)) {
      const prev = internalCall;
      internalCall = true;
      try {
        // Invariant: HashFn is a callable constructor function.
        return new (HashFn as unknown as new (alg: unknown, opts?: unknown) => HashInstance)(
          algorithm,
          options,
        );
      } finally {
        internalCall = prev;
      }
    }
    let algName: shaHash.Algorithm;
    let handle: ShaHandle;

    const xofLen =
      typeof options === 'object' && options !== null && 'outputLength' in options
        ? Reflect.get(options, 'outputLength')
        : undefined;
    if (xofLen !== undefined) {
      validateInteger(xofLen, 'options.outputLength', 0, 0xffffffff);
    }

    if (isCopy) {
      algName = algorithm.algName;
      handle = cloneShaState(algName, algorithm.handle);
    } else {
      const rawAlg = validateString(algorithm, 'algorithm');
      const digest = resolveDigest(rawAlg);
      if (fipsEnabled()) {
        throw fipsDigestError('hash');
      }
      if (xofLen !== undefined && xofLen !== digest.size) {
        throw Object.assign(
          new Error('error:030000BE:digital envelope routines::not XOF or invalid length'),
          {
            code: 'ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH',
          },
        );
      }
      algName = digest.name;
      handle = shaHash(algName);
    }

    states.set(this, { algName, handle, finalized: false });

    const encodingOpt =
      typeof options === 'object' && options !== null && 'encoding' in options
        ? Reflect.get(options, 'encoding')
        : undefined;
    const streamOpts =
      encodingOpt === 'buffer' && typeof options === 'object' && options !== null
        ? { ...options, encoding: undefined }
        : options;

    // Invariant: TransformClass is the bundled stream Transform constructor.
    (TransformClass as unknown as (this: object, opts?: unknown) => void).call(this, streamOpts);
    const writableState = Reflect.get(this, '_writableState');
    if (typeof writableState === 'object' && writableState !== null) {
      Reflect.set(writableState, 'decodeStrings', false);
      if (typeof options !== 'object' || options === null || !('defaultEncoding' in options)) {
        Reflect.set(writableState, 'defaultEncoding', 'buffer');
      }
    }
  };

  Object.setPrototypeOf(HashFn.prototype, TransformClass.prototype);
  Object.setPrototypeOf(HashFn, TransformClass);

  // Invariant: HashFn has prototype methods attached below matching HashInstance.
  const Hash = HashFn as unknown as HashConstructor;

  Object.defineProperties(Hash.prototype, {
    update: {
      writable: true,
      configurable: true,
      value: function update(this: object, data: unknown, encoding?: unknown) {
        const state = stateOf(this);
        if (state.finalized) throw finalizedError();
        state.handle.update(updateBytes(data, encoding));
        return this;
      },
    },
    digest: {
      writable: true,
      configurable: true,
      value: function digest(this: object, outputEncoding?: unknown) {
        const state = stateOf(this);
        if (state.finalized) throw finalizedError();
        const bytes = Buffer.from(state.handle.digest());
        state.finalized = true;
        return encodeOutput(bytes, outputEncoding || undefined);
      },
    },
    copy: {
      writable: true,
      configurable: true,
      value: function copy(this: object, options?: unknown): HashInstance {
        const state = stateOf(this);
        if (state.finalized) throw finalizedError();
        // Invariant: CloneSource is accepted internally by HashFn.
        return new (HashFn as unknown as new (alg: unknown, opts?: unknown) => HashInstance)(
          new CloneSource(state.algName, state.handle),
          options,
        );
      },
    },
    _transform: {
      writable: true,
      configurable: true,
      value: function _transform(
        this: object,
        chunk: unknown,
        encoding: unknown,
        callback: (err?: Error | null) => void,
      ) {
        try {
          const state = stateOf(this);
          if (state.finalized) throw finalizedError();
          const buf =
            typeof chunk === 'string'
              ? stringBytes(chunk, encoding)
              : updateBytes(chunk, undefined);
          state.handle.update(buf);
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    },
    _flush: {
      writable: true,
      configurable: true,
      value: function _flush(
        this: { push(chunk: Buffer): void },
        callback: (err?: Error | null) => void,
      ) {
        try {
          const state = stateOf(this);
          if (!state.finalized) {
            const bytes = Buffer.from(state.handle.digest());
            state.finalized = true;
            this.push(bytes);
          }
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    },
  });

  const createHashFn = function createHash(algorithm: string, options?: unknown): HashInstance {
    const prev = internalCall;
    internalCall = true;
    try {
      return new Hash(algorithm, options);
    } finally {
      internalCall = prev;
    }
  };

  return { Hash, createHash: createHashFn };
}

const defaultHash = createHashClass(stream.Transform);

/** sha.js's createHash behind Node's Hash Transform class and FIPS-mode refusal. */
export const Hash = defaultHash.Hash;
export const createHash = defaultHash.createHash;

export function getHashes() {
  return [...algorithms];
}

export function hash(algorithm: unknown, data: unknown, outputEncoding: unknown = 'hex') {
  if (typeof algorithm !== 'string' || (typeof data !== 'string' && !ArrayBuffer.isView(data)))
    throw Object.assign(new TypeError('Hash requires an algorithm and string or binary view'), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
  if (typeof outputEncoding !== 'string')
    throw Object.assign(new TypeError('Hash output encoding must be a string'), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
  if (outputEncoding !== 'buffer' && !Buffer.isEncoding(outputEncoding))
    throw Object.assign(new TypeError('Unknown hash output encoding'), {
      code: 'ERR_INVALID_ARG_VALUE',
    });
  if (fipsEnabled()) throw fipsDigestError('hash');
  const name = algorithm.toLowerCase();
  const supported = algorithms.find((alg) => alg === name);
  if (!supported) throw fault('ENOSYS', 'Hash algorithm is outside the supported SHA family');
  const input =
    typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const digest = shaHash(supported).update(input).digest();
  return outputEncoding === 'buffer' ? digest : digest.toString(outputEncoding);
}
