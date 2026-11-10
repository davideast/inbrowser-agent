import { Buffer } from 'buffer';
import { captured } from './context-hook';
import {
  invalidArgType,
  resolveDigest,
  stringBytes,
  typeList,
  validateInteger,
  validateString,
  viewBytes,
} from './crypto-args';
import { fipsEnabled } from './crypto-fips';
import { hmac } from './crypto-hmac';
import { fault } from './protocol';

// PBKDF2 (RFC 8018 §5.2) matching Node 22.18 lib/internal/crypto/pbkdf2.js:
// WebCrypto SubtleCrypto PBKDF2 for async SHA-1/256/384/512 with non-empty
// keys, and RFC 8018 HMAC iteration over sha.js for pbkdf2Sync, SHA-224, and
// zero-length passwords (which Chromium WebCrypto importKey rejects).

const INT32_MAX = 2147483647;
// WebCrypto deriveBits bit length must fit signed 31-bit integer (<= 0x7fff_ffff bits)
// and avoid WebIDL ToUint32 wrap at 2^29 bytes (keylen * 8 === 2^32 -> 0).
const MAX_WEBCRYPTO_KEYLEN = 0x0fff_ffff;

const byteTypes = typeList(['string'], ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView']);

const WEBCRYPTO_HASHES: Partial<Record<ReturnType<typeof resolveDigest>['name'], string>> = {
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
};

function byteSource(value: unknown, name: string): Uint8Array {
  if (typeof value === 'string') return stringBytes(value, undefined);
  const bytes = viewBytes(value);
  if (bytes === undefined) throw invalidArgType(name, byteTypes, value);
  return bytes;
}

interface CheckedPbkdf2 {
  password: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  keylen: number;
  digest: string;
}

function check(
  password: unknown,
  salt: unknown,
  iterations: unknown,
  keylen: unknown,
  digest: unknown,
): CheckedPbkdf2 {
  const digestName = validateString(digest, 'digest');
  const passwordBytes = byteSource(password, 'password');
  const saltBytes = byteSource(salt, 'salt');
  const iterCount = validateInteger(iterations, 'iterations', 1, INT32_MAX);
  const derivedLength = validateInteger(keylen, 'keylen', 0, INT32_MAX);
  return {
    password: passwordBytes,
    salt: saltBytes,
    iterations: iterCount,
    keylen: derivedLength,
    digest: digestName,
  };
}

function deriveHmacPbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keylen: number,
  digest: ReturnType<typeof resolveDigest>,
): Buffer {
  const blockSize = digest.size;
  const output = Buffer.alloc(keylen);
  const saltWithIndex = new Uint8Array(salt.byteLength + 4);
  saltWithIndex.set(salt, 0);
  const indexView = new DataView(saltWithIndex.buffer, salt.byteLength, 4);

  for (let block = 1, offset = 0; offset < keylen; block++, offset += blockSize) {
    indexView.setUint32(0, block, false);
    let u = hmac(digest, password, saltWithIndex);
    const accumulator = Buffer.from(u);
    for (let iter = 1; iter < iterations; iter++) {
      u = hmac(digest, password, u);
      for (let i = 0; i < blockSize; i++) {
        accumulator[i] ^= u[i];
      }
    }
    const take = Math.min(blockSize, keylen - offset);
    output.set(accumulator.subarray(0, take), offset);
  }
  return output;
}

export function pbkdf2Sync(
  password: unknown,
  salt: unknown,
  iterations: unknown,
  keylen: unknown,
  digest: unknown,
): Buffer {
  const params = check(password, salt, iterations, keylen, digest);
  const resolved = resolveDigest(params.digest);
  if (params.keylen === 0 || fipsEnabled()) {
    throw new Error('Deriving bits failed');
  }
  if (params.keylen > MAX_WEBCRYPTO_KEYLEN) {
    throw fault('E2BIG', 'PBKDF2 derived key length exceeds 268435455 bytes', {
      limit: MAX_WEBCRYPTO_KEYLEN,
      actual: params.keylen,
    });
  }
  return deriveHmacPbkdf2(params.password, params.salt, params.iterations, params.keylen, resolved);
}

export function createPbkdf2(retain: () => () => void, schedule: (callback: () => void) => void) {
  function pbkdf2(
    password: unknown,
    salt: unknown,
    iterations: unknown,
    keylen: unknown,
    digest: unknown,
    callback: unknown,
  ): void {
    let actualDigest = digest;
    let actualCallback = callback;
    if (typeof actualDigest === 'function') {
      actualCallback = actualDigest;
      actualDigest = undefined;
    }
    const params = check(password, salt, iterations, keylen, actualDigest);
    if (typeof actualCallback !== 'function') {
      throw invalidArgType('callback', 'of type function', actualCallback);
    }
    const resolved = resolveDigest(params.digest);
    const fipsAtStart = fipsEnabled();
    if (params.keylen > 0 && !fipsAtStart && params.keylen > MAX_WEBCRYPTO_KEYLEN) {
      throw fault('E2BIG', 'PBKDF2 derived key length exceeds 268435455 bytes', {
        limit: MAX_WEBCRYPTO_KEYLEN,
        actual: params.keylen,
      });
    }

    // Checked `typeof actualCallback === 'function'` above.
    const done = captured(
      actualCallback as (this: object, err: Error | null, derivedKey?: Buffer) => void,
    );
    const passwordCopy = Uint8Array.from(params.password);
    const saltCopy = Uint8Array.from(params.salt);
    const release = retain();
    const job = {};

    if (params.keylen === 0 || fipsAtStart) {
      schedule(() => {
        try {
          Reflect.apply(done, job, [new Error('Deriving bits failed')]);
        } finally {
          release();
        }
      });
      return;
    }

    const webCryptoHash = WEBCRYPTO_HASHES[resolved.name];
    if (
      webCryptoHash !== undefined &&
      passwordCopy.byteLength > 0 &&
      params.keylen * 8 <= 0x7fff_ffff
    ) {
      const subtle = globalThis.crypto.subtle;
      subtle
        .importKey('raw', passwordCopy, 'PBKDF2', false, ['deriveBits'])
        .then((baseKey) =>
          subtle.deriveBits(
            {
              name: 'PBKDF2',
              salt: saltCopy,
              iterations: params.iterations,
              hash: webCryptoHash,
            },
            baseKey,
            params.keylen * 8,
          ),
        )
        .then(
          (bits) => {
            queueMicrotask(() => {
              try {
                Reflect.apply(done, job, [null, Buffer.from(bits)]);
              } finally {
                release();
              }
            });
          },
          () => {
            queueMicrotask(() => {
              try {
                Reflect.apply(done, job, [new Error('Deriving bits failed')]);
              } finally {
                release();
              }
            });
          },
        );
      return;
    }

    schedule(() => {
      let derived: Buffer | undefined;
      let failure: Error | null = null;
      try {
        derived = deriveHmacPbkdf2(
          passwordCopy,
          saltCopy,
          params.iterations,
          params.keylen,
          resolved,
        );
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      }
      try {
        if (failure !== null) Reflect.apply(done, job, [failure]);
        else Reflect.apply(done, job, [null, derived]);
      } finally {
        release();
      }
    });
  }

  return { pbkdf2, pbkdf2Sync };
}
