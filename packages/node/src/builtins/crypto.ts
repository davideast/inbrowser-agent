import type { EventEmitter } from 'events';
import * as stream from 'readable-stream/lib/stream.js';
import { createCipherClasses } from '../crypto-cipher';
import { timingSafeEqual } from '../crypto-compare';
import { createDiffieHellmanExports } from '../crypto-dh';
import { installFips } from '../crypto-fips';
import { createHashClass, getHashes, hash } from '../crypto-hash';
import { createHkdf } from '../crypto-hkdf';
import { createHmacClass } from '../crypto-hmac';
import {
  KeyObject,
  createKeyGen,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  installSubtleCryptoKeyCapture,
} from '../crypto-keys';
import { createPbkdf2 } from '../crypto-pbkdf2';
import { createPrimes } from '../crypto-prime';
import { createRandomBytes, createRandomFill, createRandomInt } from '../crypto-random';
import { createRsaCipher, createStreamingSignVerify } from '../crypto-rsa-sync';
import { createScrypt } from '../crypto-scrypt';
import { createCryptoConstants, createSignVerify } from '../crypto-sign';
import { Certificate, X509Certificate } from '../crypto-x509';
import { fault } from '../protocol';

const browserRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);

function getRandomValues<T extends ArrayBufferView>(array: T): T {
  return globalThis.crypto.getRandomValues(array);
}

export interface CryptoBuiltinDeps {
  retain: () => () => void;
  setImmediate: (callback: () => void) => unknown;
  schedule: (callback: () => void) => void;
  process?: EventEmitter;
  stream?: unknown;
}

export function createCryptoBuiltin({
  retain,
  setImmediate,
  schedule,
  process,
}: CryptoBuiltinDeps) {
  installSubtleCryptoKeyCapture(retain);
  let hashWarned = false;
  const { Hash, createHash } = createHashClass(stream.Transform, () => {
    if (hashWarned || !process) return;
    hashWarned = true;
    const emitWarning = Reflect.get(process, 'emitWarning');
    if (typeof emitWarning === 'function') {
      Reflect.apply(emitWarning, process, [
        'crypto.Hash constructor is deprecated.',
        'DeprecationWarning',
        'DEP0179',
      ]);
    }
  });
  const { Hmac, createHmac } = createHmacClass(stream.Transform);
  const ciphers = createCipherClasses(stream.Transform);
  const streamingSignVerify = createStreamingSignVerify(stream.Writable);
  const rsaCipher = createRsaCipher();
  const dhExports = createDiffieHellmanExports();
  const randomBytes = createRandomBytes(retain);
  const randomInt = createRandomInt(retain);

  let prngFn: unknown = randomBytes;
  let pseudoRandomBytesFn: unknown = randomBytes;
  let rngFn: unknown = randomBytes;

  const base = {
    constants: createCryptoConstants(),
    KeyObject,
    X509Certificate,
    Certificate,
    createSecretKey,
    createPublicKey,
    createPrivateKey,
    ...createKeyGen(retain, schedule),
    ...createSignVerify(retain),
    ...streamingSignVerify,
    ...rsaCipher,
    ...dhExports,
    ...ciphers,
    Hash,
    createHash,
    createHmac,
    Hmac,
    getHashes,
    hash,
    ...createHkdf(setImmediate),
    ...createPbkdf2(retain, schedule),
    ...createScrypt(retain, schedule),
    timingSafeEqual,
    randomBytes,
    randomInt,
    ...createPrimes(retain),
    ...createRandomFill(retain),
    randomUUID: (options?: unknown) => {
      if (options !== undefined)
        throw fault('ENOSYS', 'UUID entropy-cache options are unsupported');
      return browserRandomUUID();
    },
    // Invariant: Object.defineProperties below defines webcrypto, subtle, getRandomValues, prng, pseudoRandomBytes, and rng.
  } as {
    readonly webcrypto: Crypto;
    readonly subtle: SubtleCrypto;
    readonly getRandomValues: typeof getRandomValues;
    constants: ReturnType<typeof createCryptoConstants>;
    KeyObject: typeof KeyObject;
    X509Certificate: typeof X509Certificate;
    Certificate: typeof Certificate;
    createSecretKey: typeof createSecretKey;
    createPublicKey: typeof createPublicKey;
    createPrivateKey: typeof createPrivateKey;
    Hash: typeof Hash;
    createHash: typeof createHash;
    createHmac: typeof createHmac;
    Hmac: typeof Hmac;
    getHashes: typeof getHashes;
    hash: typeof hash;
    timingSafeEqual: typeof timingSafeEqual;
    randomBytes: typeof randomBytes;
    randomInt: typeof randomInt;
    randomUUID: (options?: unknown) => string;
    prng: typeof randomBytes;
    pseudoRandomBytes: typeof randomBytes;
    rng: typeof randomBytes;
  } & ReturnType<typeof createKeyGen> &
    ReturnType<typeof createSignVerify> &
    ReturnType<typeof createStreamingSignVerify> &
    ReturnType<typeof createRsaCipher> &
    ReturnType<typeof createDiffieHellmanExports> &
    ReturnType<typeof createCipherClasses> &
    ReturnType<typeof createHkdf> &
    ReturnType<typeof createPbkdf2> &
    ReturnType<typeof createScrypt> &
    ReturnType<typeof createPrimes> &
    ReturnType<typeof createRandomFill>;

  Object.defineProperties(base, {
    webcrypto: {
      get() {
        return globalThis.crypto;
      },
      set: undefined,
      enumerable: true,
      configurable: false,
    },
    subtle: {
      get() {
        return globalThis.crypto.subtle;
      },
      set: undefined,
      enumerable: true,
      configurable: false,
    },
    getRandomValues: {
      get() {
        return getRandomValues;
      },
      set: undefined,
      enumerable: true,
      configurable: false,
    },
    prng: {
      get() {
        return prngFn;
      },
      set(val: unknown) {
        prngFn = val;
      },
      enumerable: false,
      configurable: true,
    },
    pseudoRandomBytes: {
      get() {
        return pseudoRandomBytesFn;
      },
      set(val: unknown) {
        pseudoRandomBytesFn = val;
      },
      enumerable: false,
      configurable: true,
    },
    rng: {
      get() {
        return rngFn;
      },
      set(val: unknown) {
        rngFn = val;
      },
      enumerable: false,
      configurable: true,
    },
  });

  return installFips(base);
}
