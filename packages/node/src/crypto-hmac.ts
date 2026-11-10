import { Buffer } from 'buffer';
import type { Transform } from 'stream';
import createHash from 'sha.js';
import {
  decodeText,
  encodeText,
  invalidArgType,
  received,
  resolveDigest,
  stringBytes,
  textEncoding,
  typeList,
  validateString,
  viewBytes,
} from './crypto-args';
import { fipsDigestError, fipsEnabled } from './crypto-fips';
import { extractSecretKeyBytes } from './crypto-keys';

// HMAC (RFC 2104) over the pinned sha.js digests, and the Node `Hmac` class.

type DigestInfo = ReturnType<typeof resolveDigest>;

export interface HmacCore {
  update(data: Uint8Array): void;
  /** The MAC; every later call returns an empty Buffer, as Node's handle does. */
  digest(): Buffer;
}

const asBuffer = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function createHmacCore(digest: DigestInfo, key: Uint8Array): HmacCore {
  // A key longer than the block is replaced by its digest; a shorter one is
  // zero-padded. Both then XOR into the inner and outer pads.
  const reduced =
    key.length > digest.block ? createHash(digest.name).update(asBuffer(key)).digest() : key;
  const inner = Buffer.alloc(digest.block, 0x36);
  const outer = Buffer.alloc(digest.block, 0x5c);
  for (let index = 0; index < reduced.length; index++) {
    inner[index] ^= reduced[index];
    outer[index] ^= reduced[index];
  }
  const hash = createHash(digest.name).update(inner);
  let finished = false;
  return {
    update: (data) => {
      hash.update(asBuffer(data));
    },
    digest: () => {
      if (finished) return Buffer.alloc(0);
      finished = true;
      return Buffer.from(createHash(digest.name).update(outer).update(hash.digest()).digest());
    },
  };
}

/** One-shot HMAC for callers that already hold bytes (HKDF). */
export function hmac(digest: DigestInfo, key: Uint8Array, ...parts: Uint8Array[]): Buffer {
  const core = createHmacCore(digest, key);
  for (const part of parts) core.update(part);
  return core.digest();
}

function secretKeyBytes(key: unknown, encoding: unknown): Uint8Array {
  return extractSecretKeyBytes(key, encoding);
}

function stringOption(options: unknown, name: string): string | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const value = (options as Record<string, unknown>)[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw Object.assign(
      new TypeError(`The "options.${name}" property must be of type string. ${received(value)}`),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
  return value;
}

const dataTypes = typeList(['string'], ['Buffer', 'TypedArray', 'DataView']);

function finalized() {
  return Object.assign(new Error('Digest already called'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
}

function updateBytes(data: unknown, encoding: unknown): Uint8Array {
  if (typeof data === 'string') {
    const name = textEncoding(encoding);
    if (name === 'hex' && data.length % 2 !== 0)
      throw Object.assign(
        new TypeError(
          `The argument 'encoding' is invalid for data of length ${data.length}. Received '${String(encoding)}'`,
        ),
        { code: 'ERR_INVALID_ARG_VALUE' },
      );
    // An unrecognized encoding name silently means UTF-8 in Node's native update.
    return decodeText(data, name ?? 'utf8');
  }
  if (!ArrayBuffer.isView(data)) throw invalidArgType('data', dataTypes, data);
  return viewBytes(data) as Uint8Array;
}

/** Output as Node's digest(): a Buffer unless a known text encoding is named. */
export function encodeOutput(bytes: Buffer, encoding: unknown): Buffer | string {
  const name = textEncoding(
    encoding === undefined || encoding === null ? undefined : `${encoding as string}`,
  );
  return name === undefined || name === 'buffer' ? bytes : encodeText(bytes, name);
}

interface HmacState {
  core: HmacCore;
  finalized: boolean;
}

export function createHmacClass(TransformClass: typeof Transform) {
  const states = new WeakMap<object, HmacState>();
  const stateOf = (self: object) => states.get(self) as HmacState;

  // A plain function (not an ES class) because Node's Hmac is callable
  // without `new`.
  const Hmac = function Hmac(this: unknown, algorithm: unknown, key: unknown, options?: unknown) {
    if (!(this instanceof Hmac))
      return new (Hmac as unknown as new (...args: unknown[]) => object)(algorithm, key, options);
    const algorithmName = validateString(algorithm, 'hmac');
    const keyEncoding = stringOption(options, 'encoding');
    const bytes = secretKeyBytes(key, keyEncoding);
    const digest = resolveDigest(algorithmName);
    if (fipsEnabled()) throw fipsDigestError('hmac');
    states.set(this as object, { core: createHmacCore(digest, bytes), finalized: false });
    // Invariant: Transform is the bundled stream implementation, a callable
    // constructor that initializes `this` when applied.
    (TransformClass as unknown as (this: object, options?: unknown) => void).call(
      this as object,
      // The bundled StringDecoder rejects the pseudo-encoding 'buffer' that Node accepts.
      keyEncoding === 'buffer' ? { ...(options as object), encoding: undefined } : options,
    );
    // Node writes strings through undecoded and defaults their encoding to 'buffer'.
    const writable = (
      this as { _writableState: { decodeStrings: boolean; defaultEncoding: string } }
    )._writableState;
    writable.decodeStrings = false;
    if (typeof options !== 'object' || options === null || !('defaultEncoding' in options))
      writable.defaultEncoding = 'buffer';
    (this as { _options?: unknown })._options = options;
  } as unknown as {
    new (algorithm: unknown, key: unknown, options?: unknown): object;
    (algorithm: unknown, key: unknown, options?: unknown): object;
    prototype: Record<string, unknown>;
  };
  Object.setPrototypeOf(Hmac.prototype, TransformClass.prototype);
  Object.setPrototypeOf(Hmac, TransformClass);

  Object.defineProperties(Hmac.prototype, {
    update: {
      writable: true,
      configurable: true,
      value: function update(this: object, data: unknown, encoding?: unknown) {
        const state = stateOf(this);
        if (state.finalized) throw finalized();
        state.core.update(updateBytes(data, encoding));
        return this;
      },
    },
    digest: {
      writable: true,
      configurable: true,
      value: function digest(this: object, outputEncoding?: unknown) {
        const state = stateOf(this);
        if (state.finalized) {
          // Node returns '' for any named text encoding and an empty Buffer otherwise.
          return outputEncoding && outputEncoding !== 'buffer' ? '' : Buffer.alloc(0);
        }
        const bytes = state.core.digest();
        state.finalized = true;
        return encodeOutput(bytes, outputEncoding || undefined);
      },
    },
    _flush: {
      writable: true,
      configurable: true,
      value: function _flush(this: { push(chunk: Buffer): void }, callback: () => void) {
        this.push(stateOf(this).core.digest());
        callback();
      },
    },
    _transform: {
      writable: true,
      configurable: true,
      value: function _transform(
        this: object,
        chunk: unknown,
        encoding: unknown,
        callback: () => void,
      ) {
        stateOf(this).core.update(
          typeof chunk === 'string'
            ? stringBytes(chunk, encoding)
            : (viewBytes(chunk) as Uint8Array),
        );
        callback();
      },
    },
  });

  const createHmac = function createHmac(algorithm: unknown, key: unknown, options?: unknown) {
    return new Hmac(algorithm, key, options);
  };
  return { Hmac, createHmac };
}
