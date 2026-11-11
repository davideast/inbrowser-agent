// KeyObject, SecretKeyObject, PublicKeyObject, PrivateKeyObject, KeyObject.from,
// KeyObject.prototype.toCryptoKey, createSecretKey, createPublicKey,
// createPrivateKey, generateKey, and generateKeyPair for Node 22.18.0.
//
// Derivative work of Node.js lib/internal/crypto/keys.js,
// lib/internal/crypto/keygen.js, lib/internal/crypto/webcrypto.js,
// lib/internal/crypto/mac.js, lib/internal/crypto/aes.js,
// lib/internal/crypto/rsa.js, lib/internal/crypto/ec.js, and
// lib/internal/crypto/cfrg.js, retained under the Node.js MIT license
// (also vendor/node-v22.18.0/LICENSE):
//
//   Copyright Node.js contributors. All rights reserved.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to
//   deal in the Software without restriction, including without limitation the
//   rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
//   sell copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.
import { Buffer } from 'buffer';
import { captured } from './context-hook';
import {
  invalidArgType,
  stringBytes,
  typeList,
  validateInteger,
  validateString,
  viewBytes,
} from './crypto-args';
import {
  type AsymmetricKeyTypeName,
  EC_CURVE_INFO,
  type EcCurveName,
  type ParsedPrivateKey,
  type ParsedPublicKey,
  bigIntToUnsignedBytes,
  bitLengthBigInt,
  bytesEqual,
  bytesToBigInt,
  decodeEcPoint,
  decodePkcs8Der,
  decodePrivateKeyDer,
  decodePublicKeyDer,
  decodeSpkiDer,
  deriveEd25519PublicKey,
  deriveX25519PublicKey,
  encodePrivateKeyDer,
  encodePublicKeyDer,
  fromBase64Url,
  invalidJwkError,
  isValidEcPoint,
  normalizeEcCurveName,
  publicFromPrivateData,
  resolveRsaPssKeygenParams,
  toBase64Url,
  unwrapPem,
  wrapPem,
} from './crypto-asn1';
import { invalidArgValue, nodeError, validateObject } from './node-errors';
import { fault, record } from './protocol';
import { kCustomPromisifyArgsSymbol } from './util-promisify';

const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;

function validateOneOf<T>(value: unknown, name: string, valid: readonly T[]): T {
  for (const candidate of valid) {
    if (Object.is(value, candidate)) return candidate;
  }
  const formatted = valid.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ');
  throw invalidArgValue(name, value, `must be one of: ${formatted}`);
}

function incompatibleKeyOptions(optionValue: string, detail: string): Error {
  return Object.assign(new Error(`The selected key encoding ${optionValue} ${detail}.`), {
    code: 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS',
  });
}

function invalidKeyObjectType(actual: string, expected: string): TypeError {
  return Object.assign(new TypeError(`Invalid key object type ${actual}, expected ${expected}.`), {
    code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE',
  });
}

function invalidThisError(expected: string): TypeError {
  return Object.assign(new TypeError(`Value of "this" must be of type ${expected}`), {
    code: 'ERR_INVALID_THIS',
  });
}

function unsupportedJwkKeyType(): Error {
  return Object.assign(new Error('Unsupported JWK Key Type.'), {
    code: 'ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE',
  });
}

// --- Internal handle discriminated union ---

interface SecretKeyHandle {
  kind: 'secret';
  bytes: Uint8Array | undefined;
  byteLength: number;
  cryptoKey?: CryptoKey;
}

interface PublicKeyHandle {
  kind: 'public';
  data: ParsedPublicKey | undefined;
  nonExtractableMeta?: {
    keyType: AsymmetricKeyTypeName;
    details: Record<string, unknown>;
  };
  cryptoKey?: CryptoKey;
}

interface PrivateKeyHandle {
  kind: 'private';
  data: ParsedPrivateKey | undefined;
  nonExtractableMeta?: {
    keyType: AsymmetricKeyTypeName;
    details: Record<string, unknown>;
    pairedPublic?: PublicKeyHandle;
  };
  cryptoKey?: CryptoKey;
}

type KeyHandle = SecretKeyHandle | PublicKeyHandle | PrivateKeyHandle;

interface SyntheticCryptoKeySlot {
  type: KeyType;
  extractable: boolean;
  algorithm: Record<string, unknown>;
  usages: KeyUsage[];
  importFormat: 'raw' | 'spki' | 'pkcs8';
  importData: Uint8Array<ArrayBuffer>;
  importAlgorithm:
    | AlgorithmIdentifier
    | RsaHashedImportParams
    | EcKeyImportParams
    | HmacImportParams
    | AesKeyAlgorithm;
  materialized?: Promise<CryptoKey>;
}

const internalHandles = new WeakSet<object>();
const keySlots = new WeakMap<object, KeyHandle>();
const detailsCache = new WeakMap<object, Record<string, unknown>>();
const cryptoKeyCache = new WeakMap<CryptoKey, KeyObject>();
const syntheticCryptoKeys = new WeakMap<object, SyntheticCryptoKeySlot>();
let nativeCryptoKeyTypeGetter: ((this: unknown) => KeyType) | undefined;
let anyTrackedCryptoKeyCreated = false;

function cacheCryptoKey(ck: CryptoKey, ko: KeyObject): void {
  anyTrackedCryptoKeyCreated = true;
  cryptoKeyCache.set(ck, ko);
}

function makeSecretHandle(bytes: Uint8Array, cryptoKey?: CryptoKey): SecretKeyHandle {
  const handle: SecretKeyHandle = {
    kind: 'secret',
    bytes: Uint8Array.from(bytes),
    byteLength: bytes.byteLength,
    cryptoKey,
  };
  internalHandles.add(handle);
  return handle;
}

function makeNonExtractableSecretHandle(byteLength: number, cryptoKey: CryptoKey): SecretKeyHandle {
  const handle: SecretKeyHandle = {
    kind: 'secret',
    bytes: undefined,
    byteLength,
    cryptoKey,
  };
  internalHandles.add(handle);
  return handle;
}

function makePublicHandle(data: ParsedPublicKey, cryptoKey?: CryptoKey): PublicKeyHandle {
  const handle: PublicKeyHandle = { kind: 'public', data, cryptoKey };
  internalHandles.add(handle);
  return handle;
}

function makeNonExtractablePublicHandle(
  keyType: AsymmetricKeyTypeName,
  details: Record<string, unknown>,
  cryptoKey: CryptoKey,
): PublicKeyHandle {
  const handle: PublicKeyHandle = {
    kind: 'public',
    data: undefined,
    nonExtractableMeta: { keyType, details },
    cryptoKey,
  };
  internalHandles.add(handle);
  return handle;
}

function makePrivateHandle(data: ParsedPrivateKey, cryptoKey?: CryptoKey): PrivateKeyHandle {
  const handle: PrivateKeyHandle = { kind: 'private', data, cryptoKey };
  internalHandles.add(handle);
  return handle;
}

function makeNonExtractablePrivateHandle(
  keyType: AsymmetricKeyTypeName,
  details: Record<string, unknown>,
  cryptoKey: CryptoKey,
  pairedPublic?: PublicKeyHandle,
): PrivateKeyHandle {
  const handle: PrivateKeyHandle = {
    kind: 'private',
    data: undefined,
    nonExtractableMeta: { keyType, details, pairedPublic },
    cryptoKey,
  };
  internalHandles.add(handle);
  return handle;
}

function requireKeySlot(self: unknown, expectedName = 'KeyObject'): KeyHandle {
  const slot = typeof self === 'object' && self !== null ? keySlots.get(self) : undefined;
  if (!slot) throw invalidThisError(expectedName);
  return slot;
}

export function isKeyObject(value: unknown): value is KeyObject {
  return typeof value === 'object' && value !== null && keySlots.has(value);
}

export function isCryptoKey(value: unknown): value is CryptoKey {
  if (typeof value !== 'object' || value === null) return false;
  if (syntheticCryptoKeys.has(value)) return true;
  if (nativeCryptoKeyTypeGetter !== undefined) {
    try {
      Reflect.apply(nativeCryptoKeyTypeGetter, value, []);
      return true;
    } catch {
      return false;
    }
  }
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey;
}

function publicKeyEquals(a: ParsedPublicKey, b: ParsedPublicKey): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === 'rsa' || a.kind === 'rsa-pss') && (b.kind === 'rsa' || b.kind === 'rsa-pss')) {
    return (
      a.n === b.n && a.e === b.e && JSON.stringify(a.pss ?? null) === JSON.stringify(b.pss ?? null)
    );
  }
  if (a.kind === 'ec' && b.kind === 'ec') {
    return a.namedCurve === b.namedCurve && bytesEqual(a.x, b.x) && bytesEqual(a.y, b.y);
  }
  if (
    (a.kind === 'ed25519' || a.kind === 'x25519') &&
    (b.kind === 'ed25519' || b.kind === 'x25519')
  ) {
    return bytesEqual(a.x, b.x);
  }
  if (a.kind === 'dh' && b.kind === 'dh') {
    return a.p === b.p && a.g === b.g && a.y === b.y;
  }
  return false;
}

function privateKeyEquals(a: ParsedPrivateKey, b: ParsedPrivateKey): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === 'rsa' || a.kind === 'rsa-pss') && (b.kind === 'rsa' || b.kind === 'rsa-pss')) {
    return (
      a.n === b.n &&
      a.e === b.e &&
      a.d === b.d &&
      JSON.stringify(a.pss ?? null) === JSON.stringify(b.pss ?? null)
    );
  }
  if (a.kind === 'ec' && b.kind === 'ec') {
    return a.namedCurve === b.namedCurve && bytesEqual(a.d, b.d);
  }
  if (
    (a.kind === 'ed25519' || a.kind === 'x25519') &&
    (b.kind === 'ed25519' || b.kind === 'x25519')
  ) {
    return bytesEqual(a.d, b.d);
  }
  if (a.kind === 'dh' && b.kind === 'dh') {
    return a.p === b.p && a.g === b.g && a.x === b.x;
  }
  return false;
}

function computeAsymmetricDetails(
  data: ParsedPublicKey | ParsedPrivateKey,
): Record<string, unknown> {
  if (data.kind === 'rsa') {
    return {
      modulusLength: bitLengthBigInt(data.n),
      publicExponent: data.e,
    };
  }
  if (data.kind === 'rsa-pss') {
    const base: Record<string, unknown> = {
      modulusLength: bitLengthBigInt(data.n),
      publicExponent: data.e,
    };
    if (data.pss !== undefined) {
      base.hashAlgorithm = data.pss.hashAlgorithm;
      base.mgf1HashAlgorithm = data.pss.mgf1HashAlgorithm;
      base.saltLength = data.pss.saltLength;
    }
    return base;
  }
  if (data.kind === 'ec') {
    return { namedCurve: data.namedCurve };
  }
  return {};
}

function exportPublicJwk(data: ParsedPublicKey): Record<string, string> {
  switch (data.kind) {
    case 'rsa-pss':
    case 'dh':
      throw unsupportedJwkKeyType();
    case 'rsa':
      return {
        kty: 'RSA',
        n: toBase64Url(bigIntToUnsignedBytes(data.n)),
        e: toBase64Url(bigIntToUnsignedBytes(data.e)),
      };
    case 'ec':
      return {
        kty: 'EC',
        crv: EC_CURVE_INFO[data.namedCurve].jwkCrv,
        x: toBase64Url(data.x),
        y: toBase64Url(data.y),
      };
    case 'ed25519':
    case 'x25519':
      return {
        crv: data.kind === 'ed25519' ? 'Ed25519' : 'X25519',
        x: toBase64Url(data.x),
        kty: 'OKP',
      };
  }
}

function exportPrivateJwk(data: ParsedPrivateKey): Record<string, string> {
  switch (data.kind) {
    case 'rsa-pss':
    case 'dh':
      throw unsupportedJwkKeyType();
    case 'rsa':
      return {
        kty: 'RSA',
        n: toBase64Url(bigIntToUnsignedBytes(data.n)),
        e: toBase64Url(bigIntToUnsignedBytes(data.e)),
        d: toBase64Url(bigIntToUnsignedBytes(data.d)),
        p: toBase64Url(bigIntToUnsignedBytes(data.p)),
        q: toBase64Url(bigIntToUnsignedBytes(data.q)),
        dp: toBase64Url(bigIntToUnsignedBytes(data.dp)),
        dq: toBase64Url(bigIntToUnsignedBytes(data.dq)),
        qi: toBase64Url(bigIntToUnsignedBytes(data.qi)),
      };
    case 'ec':
      return {
        kty: 'EC',
        x: toBase64Url(data.x),
        y: toBase64Url(data.y),
        crv: EC_CURVE_INFO[data.namedCurve].jwkCrv,
        d: toBase64Url(data.d),
      };
    case 'ed25519':
    case 'x25519':
      return {
        crv: data.kind === 'ed25519' ? 'Ed25519' : 'X25519',
        d: toBase64Url(data.d),
        x: toBase64Url(data.x),
        kty: 'OKP',
      };
  }
}

// --- WebIDL / Algorithm normalization for synchronous KeyObject#toCryptoKey ---

const VALID_KEY_USAGES: readonly KeyUsage[] = [
  'encrypt',
  'decrypt',
  'sign',
  'verify',
  'deriveKey',
  'deriveBits',
  'wrapKey',
  'unwrapKey',
];

const WEBCRYPTO_IMPORT_ALGORITHMS = [
  'RSASSA-PKCS1-v1_5',
  'RSA-PSS',
  'RSA-OAEP',
  'ECDSA',
  'ECDH',
  'HMAC',
  'HKDF',
  'PBKDF2',
  'AES-CTR',
  'AES-CBC',
  'AES-GCM',
  'AES-KW',
  'Ed25519',
  'X25519',
  'Ed448',
  'X448',
] as const;

const WEBCRYPTO_DIGEST_NAMES = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const;

function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function convertKeyUsagesSequence(value: unknown): KeyUsage[] {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'Value can not be converted to sequence.');
  }
  // Safe: value is a non-null object or function, so Reflect.get can probe Symbol.iterator.
  const iterMethod: unknown = Reflect.get(value, Symbol.iterator);
  if (typeof iterMethod !== 'function') {
    throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'Value can not be converted to sequence.');
  }
  // Safe: iterMethod was just verified callable on value.
  const iter = Reflect.apply(iterMethod, value, []) as Iterator<unknown>;
  const out: KeyUsage[] = [];
  for (;;) {
    const step = iter.next();
    if (step.done) break;
    const str = `${String(step.value)}`;
    const matched = VALID_KEY_USAGES.find((u) => u === str);
    if (matched === undefined) {
      const formatted = VALID_KEY_USAGES.map((u) => `'${u}'`).join(', ');
      throw invalidArgValue(
        'keyUsages',
        str,
        `must be one of: ${formatted} (failed to convert value to 'KeyUsage')`,
      );
    }
    out.push(matched);
  }
  return out;
}

type DigestAlgorithmName = (typeof WEBCRYPTO_DIGEST_NAMES)[number];

type NormalizedImportAlgorithm =
  | {
      kind: 'hmac';
      name: 'HMAC';
      hash: { name: DigestAlgorithmName };
      length: number | undefined;
    }
  | {
      kind: 'rsa-hashed';
      name: 'RSASSA-PKCS1-v1_5' | 'RSA-PSS' | 'RSA-OAEP';
      hash: { name: DigestAlgorithmName };
    }
  | {
      kind: 'ec';
      name: 'ECDSA' | 'ECDH';
      namedCurve: 'P-256' | 'P-384' | 'P-521';
    }
  | {
      kind: 'simple';
      name:
        | 'HKDF'
        | 'PBKDF2'
        | 'AES-CTR'
        | 'AES-CBC'
        | 'AES-GCM'
        | 'AES-KW'
        | 'Ed25519'
        | 'X25519'
        | 'Ed448'
        | 'X448';
    };

function convertWebIdlDomString(value: unknown, fieldDesc?: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'symbol') {
    throw nodeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      fieldDesc !== undefined
        ? `${fieldDesc} is a Symbol and cannot be converted to a string.`
        : 'Value is a Symbol and cannot be converted to a string.',
    );
  }
  return String(value);
}

function convertWebIdlEnforceRangeUnsignedLong(value: unknown, fieldDesc: string): number {
  if (typeof value === 'bigint') {
    throw nodeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      `${fieldDesc} is a BigInt and cannot be converted to a number.`,
    );
  }
  if (typeof value === 'symbol') {
    throw nodeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      `${fieldDesc} is a Symbol and cannot be converted to a number.`,
    );
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `${fieldDesc} is not a finite number.`);
  }
  const x = Math.trunc(num);
  if (x < 0 || x > UINT32_MAX) {
    throw nodeError(
      TypeError,
      'ERR_OUT_OF_RANGE',
      `${fieldDesc} is outside the expected range of 0 to 4294967295.`,
    );
  }
  return x === 0 ? 0 : x;
}

function normalizeAlgorithmIdentifier(
  val: unknown,
  fieldDesc?: string,
): string | Record<string, unknown> {
  if ((typeof val === 'object' && val !== null) || typeof val === 'function') {
    // Safe: non-null object or function supports property lookup per WebIDL Type(V) === 'Object'.
    return val as Record<string, unknown>;
  }
  return convertWebIdlDomString(val, fieldDesc);
}

function normalizeDigestAlgorithmFromId(hashId: string | Record<string, unknown>): {
  name: DigestAlgorithmName;
} {
  let rawName: string;
  if (typeof hashId === 'string') {
    rawName = hashId;
  } else {
    if (hashId.name === undefined) {
      throw nodeError(
        TypeError,
        'ERR_MISSING_OPTION',
        "Failed to normalize algorithm: passed algorithm can not be converted to 'Algorithm' because 'name' is required in 'Algorithm'.",
      );
    }
    rawName = convertWebIdlDomString(
      hashId.name,
      "Failed to normalize algorithm: 'name' of 'Algorithm' (passed algorithm)",
    );
  }
  const upper = rawName.toUpperCase();
  for (const candidate of WEBCRYPTO_DIGEST_NAMES) {
    if (candidate === upper) return { name: candidate };
  }
  throw new DOMException('Unrecognized algorithm name', 'NotSupportedError');
}

function normalizeImportAlgorithm(algorithm: unknown): NormalizedImportAlgorithm {
  const algId = normalizeAlgorithmIdentifier(algorithm);
  const dict: Record<string, unknown> = typeof algId === 'string' ? { name: algId } : algId;
  if (dict.name === undefined) {
    throw nodeError(
      TypeError,
      'ERR_MISSING_OPTION',
      "Failed to normalize algorithm: passed algorithm can not be converted to 'Algorithm' because 'name' is required in 'Algorithm'.",
    );
  }
  const rawName = convertWebIdlDomString(
    dict.name,
    "Failed to normalize algorithm: 'name' of 'Algorithm' (passed algorithm)",
  );
  const upper = rawName.toUpperCase();
  let canonicalName: (typeof WEBCRYPTO_IMPORT_ALGORITHMS)[number] | undefined;
  for (const candidate of WEBCRYPTO_IMPORT_ALGORITHMS) {
    if (candidate.toUpperCase() === upper) {
      canonicalName = candidate;
      break;
    }
  }
  if (canonicalName === undefined) {
    throw new DOMException('Unrecognized algorithm name', 'NotSupportedError');
  }

  switch (canonicalName) {
    case 'HMAC': {
      if (dict.hash === undefined) {
        throw nodeError(
          TypeError,
          'ERR_MISSING_OPTION',
          "Failed to normalize algorithm: passed algorithm can not be converted to 'HmacImportParams' because 'hash' is required in 'HmacImportParams'.",
        );
      }
      const hashId = normalizeAlgorithmIdentifier(
        dict.hash,
        "Failed to normalize algorithm: 'hash' of 'HmacImportParams' (passed algorithm)",
      );
      let hmacLength: number | undefined;
      if (dict.length !== undefined) {
        hmacLength = convertWebIdlEnforceRangeUnsignedLong(
          dict.length,
          "Failed to normalize algorithm: 'length' of 'HmacImportParams' (passed algorithm)",
        );
        if (hmacLength === 0) {
          throw new DOMException('Zero-length key is not supported', 'DataError');
        }
        if (hmacLength % 8 !== 0) {
          throw new DOMException('Unsupported algorithm.length', 'NotSupportedError');
        }
      }
      const hash = normalizeDigestAlgorithmFromId(hashId);
      return { kind: 'hmac', name: 'HMAC', hash, length: hmacLength };
    }
    case 'RSASSA-PKCS1-v1_5':
    case 'RSA-PSS':
    case 'RSA-OAEP': {
      if (dict.hash === undefined) {
        throw nodeError(
          TypeError,
          'ERR_MISSING_OPTION',
          "Failed to normalize algorithm: passed algorithm can not be converted to 'RsaHashedImportParams' because 'hash' is required in 'RsaHashedImportParams'.",
        );
      }
      const hashId = normalizeAlgorithmIdentifier(
        dict.hash,
        "Failed to normalize algorithm: 'hash' of 'RsaHashedImportParams' (passed algorithm)",
      );
      const hash = normalizeDigestAlgorithmFromId(hashId);
      return { kind: 'rsa-hashed', name: canonicalName, hash };
    }
    case 'ECDSA':
    case 'ECDH': {
      if (dict.namedCurve === undefined) {
        throw nodeError(
          TypeError,
          'ERR_MISSING_OPTION',
          "Failed to normalize algorithm: passed algorithm can not be converted to 'EcKeyImportParams' because 'namedCurve' is required in 'EcKeyImportParams'.",
        );
      }
      const namedCurve = convertWebIdlDomString(
        dict.namedCurve,
        "Failed to normalize algorithm: 'namedCurve' of 'EcKeyImportParams' (passed algorithm)",
      );
      if (namedCurve !== 'P-256' && namedCurve !== 'P-384' && namedCurve !== 'P-521') {
        throw new DOMException('Unrecognized namedCurve', 'NotSupportedError');
      }
      return { kind: 'ec', name: canonicalName, namedCurve };
    }
    case 'HKDF':
    case 'PBKDF2':
    case 'AES-CTR':
    case 'AES-CBC':
    case 'AES-GCM':
    case 'AES-KW':
    case 'Ed25519':
    case 'X25519':
    case 'Ed448':
    case 'X448':
      return { kind: 'simple', name: canonicalName };
  }
}

function hasAnyUsageOutside(usages: readonly KeyUsage[], allowed: readonly KeyUsage[]): boolean {
  for (const u of usages) {
    if (!allowed.includes(u)) return true;
  }
  return false;
}

function cloneAlgorithmMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v instanceof Uint8Array) {
      out[k] = new Uint8Array(v);
    } else if (record(v)) {
      out[k] = cloneAlgorithmMeta(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function makeSyntheticCryptoKey(owner: KeyObject, spec: SyntheticCryptoKeySlot): CryptoKey {
  if (typeof CryptoKey === 'undefined') {
    throw fault('ENOSYS', 'WebCrypto CryptoKey is unavailable in this environment');
  }
  anyTrackedCryptoKeyCreated = true;
  // Safe: CryptoKey.prototype getters are interposed in installSubtleCryptoKeyCapture to read
  // syntheticCryptoKeys, and SubtleCrypto methods lazily materialize via rawImportKey.
  const ck = Object.create(CryptoKey.prototype) as CryptoKey;
  syntheticCryptoKeys.set(ck, spec);
  cacheCryptoKey(ck, owner);
  return ck;
}

// --- Key encoding option validation (matches keys.js lines 350-471) ---

function optionPath(name: string, objName?: string): string {
  return objName === undefined ? `options.${name}` : `options.${objName}.${name}`;
}

function isStringOrBuffer(val: unknown): boolean {
  return typeof val === 'string' || viewBytes(val) !== undefined;
}

function parseKeyFormat(
  formatStr: unknown,
  defaultFormat: 'pem' | undefined,
  optName: string,
): 'pem' | 'der' | 'jwk' {
  if (formatStr === undefined && defaultFormat !== undefined) return defaultFormat;
  if (formatStr === 'pem' || formatStr === 'der' || formatStr === 'jwk') return formatStr;
  throw invalidArgValue(optName, formatStr);
}

function parseKeyTypeOption(
  typeStr: unknown,
  required: boolean,
  keyType: string | undefined,
  isPublic: boolean | undefined,
  optName: string,
): 'pkcs1' | 'pkcs8' | 'spki' | 'sec1' | undefined {
  if (typeStr === undefined && !required) return undefined;
  if (typeStr === 'pkcs1') {
    if (keyType !== undefined && keyType !== 'rsa') {
      throw incompatibleKeyOptions('pkcs1', 'can only be used for RSA keys');
    }
    return 'pkcs1';
  }
  if (typeStr === 'spki' && isPublic !== false) return 'spki';
  if (typeStr === 'pkcs8' && isPublic !== true) return 'pkcs8';
  if (typeStr === 'sec1' && isPublic !== true) {
    if (keyType !== undefined && keyType !== 'ec') {
      throw incompatibleKeyOptions('sec1', 'can only be used for EC keys');
    }
    return 'sec1';
  }
  throw invalidArgValue(optName, typeStr);
}

interface ParsedEncodingOptions {
  format: 'pem' | 'der' | 'jwk';
  type: 'pkcs1' | 'pkcs8' | 'spki' | 'sec1' | undefined;
}

function parseKeyEncodingOptions(
  enc: unknown,
  keyType: string | undefined,
  isPublic: boolean | undefined,
  objName?: string,
): ParsedEncodingOptions {
  validateObject(enc, 'options');
  const isInput = keyType === undefined;
  const format = parseKeyFormat(
    enc.format,
    isInput ? 'pem' : undefined,
    optionPath('format', objName),
  );
  const isRequired = (!isInput || format === 'der') && format !== 'jwk';
  const type = parseKeyTypeOption(
    enc.type,
    isRequired,
    keyType,
    isPublic,
    optionPath('type', objName),
  );

  if (isPublic !== true) {
    const { cipher, passphrase } = enc;
    if (!isInput) {
      if (cipher != null) {
        if (typeof cipher !== 'string') {
          throw invalidArgValue(optionPath('cipher', objName), cipher);
        }
        if (format === 'der' && (type === 'pkcs1' || type === 'sec1')) {
          throw incompatibleKeyOptions(type, 'does not support encryption');
        }
      } else if (passphrase !== undefined) {
        throw invalidArgValue(optionPath('cipher', objName), cipher);
      }
    }
    if (
      (isInput && passphrase !== undefined && !isStringOrBuffer(passphrase)) ||
      (!isInput && cipher != null && !isStringOrBuffer(passphrase))
    ) {
      throw invalidArgValue(optionPath('passphrase', objName), passphrase);
    }
    if (cipher != null || passphrase !== undefined) {
      throw fault(
        'ENOSYS',
        'Encrypted private keys and passphrases are not supported in WebCrypto',
      );
    }
  }
  return { format, type };
}

// --- Public KeyObject classes ---

export class KeyObject {
  constructor(type?: unknown, handle?: unknown) {
    if (type !== 'secret' && type !== 'public' && type !== 'private') {
      throw invalidArgValue('type', type);
    }
    if (typeof handle !== 'object' || handle === null || !internalHandles.has(handle)) {
      throw invalidArgType('handle', 'of type object', handle);
    }
    // Safe: internalHandles only ever registers SecretKeyHandle | PublicKeyHandle | PrivateKeyHandle.
    keySlots.set(this, handle as KeyHandle);
  }

  get type(): 'secret' | 'public' | 'private' {
    return requireKeySlot(this).kind;
  }

  static from(key: unknown): KeyObject {
    if (!isCryptoKey(key)) {
      throw invalidArgType('key', 'an instance of CryptoKey', key);
    }
    return keyObjectFromCryptoKey(key);
  }

  equals(otherKeyObject: unknown): boolean {
    const selfSlot = requireKeySlot(this);
    if (!isKeyObject(otherKeyObject)) {
      throw invalidArgType('otherKeyObject', 'an instance of KeyObject', otherKeyObject);
    }
    const otherSlot = requireKeySlot(otherKeyObject);
    if (selfSlot.kind !== otherSlot.kind) return false;
    if (selfSlot.kind === 'secret' && otherSlot.kind === 'secret') {
      if (selfSlot.bytes && otherSlot.bytes) return bytesEqual(selfSlot.bytes, otherSlot.bytes);
      return selfSlot.cryptoKey !== undefined && selfSlot.cryptoKey === otherSlot.cryptoKey;
    }
    if (selfSlot.kind === 'public' && otherSlot.kind === 'public') {
      if (selfSlot.data && otherSlot.data) return publicKeyEquals(selfSlot.data, otherSlot.data);
      return selfSlot.cryptoKey !== undefined && selfSlot.cryptoKey === otherSlot.cryptoKey;
    }
    if (selfSlot.kind === 'private' && otherSlot.kind === 'private') {
      if (selfSlot.data && otherSlot.data) return privateKeyEquals(selfSlot.data, otherSlot.data);
      return selfSlot.cryptoKey !== undefined && selfSlot.cryptoKey === otherSlot.cryptoKey;
    }
    return false;
  }
}

Object.defineProperty(KeyObject.prototype, Symbol.toStringTag, {
  value: 'KeyObject',
  configurable: true,
});
Object.defineProperty(KeyObject, 'name', { value: 'KeyObject', configurable: true });

export class SecretKeyObject extends KeyObject {
  constructor(handle: SecretKeyHandle) {
    super('secret', handle);
  }

  get symmetricKeySize(): number {
    const slot = requireKeySlot(this, 'SecretKeyObject');
    if (slot.kind !== 'secret') throw invalidThisError('SecretKeyObject');
    return slot.byteLength;
  }

  export(options?: unknown): Buffer | Record<string, string> {
    const slot = requireKeySlot(this, 'SecretKeyObject');
    if (slot.kind !== 'secret') throw invalidThisError('SecretKeyObject');
    let format: undefined | 'buffer' | 'jwk';
    if (options !== undefined) {
      validateObject(options, 'options');
      format = validateOneOf(options.format, 'options.format', [
        undefined,
        'buffer',
        'jwk',
      ] as const);
    }
    if (!slot.bytes) {
      throw fault(
        'ENOSYS',
        'Exporting a non-extractable WebCrypto secret key synchronously is unsupported',
      );
    }
    if (format === 'jwk') {
      return { kty: 'oct', k: toBase64Url(slot.bytes) };
    }
    return Buffer.from(slot.bytes);
  }

  toCryptoKey(algorithm: unknown, extractable: unknown, keyUsages: unknown): CryptoKey {
    const slot = requireKeySlot(this, 'SecretKeyObject');
    if (slot.kind !== 'secret') throw invalidThisError('SecretKeyObject');
    const normAlg = normalizeImportAlgorithm(algorithm);
    const ext = Boolean(extractable);
    const usages = convertKeyUsagesSequence(keyUsages);

    let algMeta: Record<string, unknown>;
    let importAlg: AlgorithmIdentifier | HmacImportParams | AesKeyAlgorithm;

    switch (normAlg.name) {
      case 'HMAC': {
        if (normAlg.kind !== 'hmac') {
          throw new DOMException('Unrecognized algorithm name', 'NotSupportedError');
        }
        if (hasAnyUsageOutside(usages, ['sign', 'verify'])) {
          throw new DOMException('Unsupported key usage for an HMAC key', 'SyntaxError');
        }
        const bitLen = slot.byteLength * 8;
        if (bitLen === 0) {
          throw new DOMException('Zero-length key is not supported', 'DataError');
        }
        if (normAlg.length !== undefined && normAlg.length !== bitLen) {
          throw new DOMException('Invalid key length', 'DataError');
        }
        algMeta = { name: 'HMAC', hash: normAlg.hash, length: bitLen };
        importAlg = { name: 'HMAC', hash: normAlg.hash, length: bitLen };
        break;
      }
      case 'AES-CTR':
      case 'AES-CBC':
      case 'AES-GCM':
      case 'AES-KW': {
        const allowed: KeyUsage[] =
          normAlg.name === 'AES-KW'
            ? ['wrapKey', 'unwrapKey']
            : ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt'];
        if (hasAnyUsageOutside(usages, allowed)) {
          throw new DOMException('Unsupported key usage for an AES key', 'SyntaxError');
        }
        const bitLen = slot.byteLength * 8;
        if (bitLen !== 128 && bitLen !== 192 && bitLen !== 256) {
          throw new DOMException('Invalid key length', 'DataError');
        }
        algMeta = { name: normAlg.name, length: bitLen };
        importAlg = { name: normAlg.name };
        break;
      }
      case 'HKDF':
      case 'PBKDF2': {
        if (ext) {
          throw new DOMException(`${normAlg.name} keys are not extractable`, 'SyntaxError');
        }
        if (hasAnyUsageOutside(usages, ['deriveKey', 'deriveBits'])) {
          throw new DOMException(`Unsupported key usage for a ${normAlg.name} key`, 'SyntaxError');
        }
        algMeta = { name: normAlg.name };
        importAlg = { name: normAlg.name };
        break;
      }
      default:
        throw new DOMException('Unrecognized algorithm name', 'NotSupportedError');
    }

    if (usages.length === 0) {
      throw new DOMException('Usages cannot be empty when importing a secret key.', 'SyntaxError');
    }
    if (!slot.bytes) {
      throw fault(
        'ENOSYS',
        'Converting a non-extractable WebCrypto secret KeyObject via toCryptoKey is unsupported',
      );
    }

    return makeSyntheticCryptoKey(this, {
      type: 'secret',
      extractable: ext,
      algorithm: algMeta,
      usages,
      importFormat: 'raw',
      importData: toBufferSource(slot.bytes),
      importAlgorithm: importAlg,
    });
  }
}
Object.defineProperty(SecretKeyObject, 'name', { value: 'SecretKeyObject', configurable: true });

class AsymmetricKeyObject extends KeyObject {
  get asymmetricKeyType(): AsymmetricKeyTypeName {
    const slot = requireKeySlot(this);
    if (slot.kind === 'public' || slot.kind === 'private') {
      return slot.data ? slot.data.kind : slot.nonExtractableMeta!.keyType;
    }
    throw invalidThisError('AsymmetricKeyObject');
  }

  get asymmetricKeyDetails(): Record<string, unknown> {
    const slot = requireKeySlot(this);
    if (slot.kind === 'secret') throw invalidThisError('AsymmetricKeyObject');
    const data = slot.data;
    if (!data) {
      return { ...slot.nonExtractableMeta!.details };
    }
    if (data.kind === 'ed25519' || data.kind === 'x25519') return {};
    let cached = detailsCache.get(this);
    if (!cached) {
      cached = computeAsymmetricDetails(data);
      detailsCache.set(this, cached);
    }
    return cached;
  }

  toCryptoKey(algorithm: unknown, extractable: unknown, keyUsages: unknown): CryptoKey {
    const slot = requireKeySlot(this, 'AsymmetricKeyObject');
    if (slot.kind === 'secret') throw invalidThisError('AsymmetricKeyObject');
    const isPublic = slot.kind === 'public';
    const normAlg = normalizeImportAlgorithm(algorithm);
    const ext = Boolean(extractable);
    const usages = convertKeyUsagesSequence(keyUsages);
    const keyType = slot.data ? slot.data.kind : slot.nonExtractableMeta!.keyType;

    let algMeta: Record<string, unknown>;
    let importFormat: 'spki' | 'pkcs8' = isPublic ? 'spki' : 'pkcs8';
    let importData: Uint8Array<ArrayBuffer>;
    let importAlg: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams;

    switch (normAlg.kind) {
      case 'rsa-hashed': {
        const canonicalName = normAlg.name;
        const hash = normAlg.hash;
        const allowed: KeyUsage[] =
          canonicalName === 'RSA-OAEP'
            ? isPublic
              ? ['encrypt', 'wrapKey']
              : ['decrypt', 'unwrapKey']
            : isPublic
              ? ['verify']
              : ['sign'];
        if (hasAnyUsageOutside(usages, allowed)) {
          throw new DOMException(
            `Unsupported key usage for an ${canonicalName} key`,
            'SyntaxError',
          );
        }
        if (keyType !== 'rsa') {
          throw new DOMException('Invalid key type', 'DataError');
        }
        if (slot.kind === 'private' && usages.length === 0) {
          throw new DOMException(
            'Usages cannot be empty when importing a private key.',
            'SyntaxError',
          );
        }
        if (!slot.data || slot.data.kind !== 'rsa') {
          throw fault(
            'ENOSYS',
            'Converting a non-extractable WebCrypto asymmetric KeyObject via toCryptoKey is unsupported',
          );
        }
        algMeta = {
          name: canonicalName,
          modulusLength: bitLengthBigInt(slot.data.n),
          publicExponent: new Uint8Array(bigIntToUnsignedBytes(slot.data.e)),
          hash,
        };
        importAlg = { name: canonicalName, hash };
        importData =
          slot.kind === 'public'
            ? toBufferSource(encodePublicKeyDer(slot.data, 'spki'))
            : toBufferSource(encodePrivateKeyDer(slot.data, 'pkcs8'));
        break;
      }
      case 'ec': {
        const canonicalName = normAlg.name;
        const namedCurve = normAlg.namedCurve;
        const allowed: KeyUsage[] =
          canonicalName === 'ECDH'
            ? isPublic
              ? []
              : ['deriveKey', 'deriveBits']
            : isPublic
              ? ['verify']
              : ['sign'];
        if (hasAnyUsageOutside(usages, allowed)) {
          throw new DOMException(`Unsupported key usage for a ${canonicalName} key`, 'SyntaxError');
        }
        if (keyType !== 'ec') {
          throw new DOMException('Invalid key type', 'DataError');
        }
        const actualCrv =
          slot.data && slot.data.kind === 'ec'
            ? EC_CURVE_INFO[slot.data.namedCurve].jwkCrv
            : slot.nonExtractableMeta?.details.namedCurve &&
                typeof slot.nonExtractableMeta.details.namedCurve === 'string' &&
                slot.nonExtractableMeta.details.namedCurve in EC_CURVE_INFO
              ? // Safe: `in EC_CURVE_INFO` guarantees namedCurve is an EcCurveName key.
                EC_CURVE_INFO[slot.nonExtractableMeta.details.namedCurve as EcCurveName].jwkCrv
              : undefined;
        if (actualCrv !== namedCurve) {
          throw new DOMException('Named curve mismatch', 'DataError');
        }
        if (slot.kind === 'private' && usages.length === 0) {
          throw new DOMException(
            'Usages cannot be empty when importing a private key.',
            'SyntaxError',
          );
        }
        if (!slot.data || slot.data.kind !== 'ec') {
          throw fault(
            'ENOSYS',
            'Converting a non-extractable WebCrypto asymmetric KeyObject via toCryptoKey is unsupported',
          );
        }
        algMeta = { name: canonicalName, namedCurve };
        importAlg = { name: canonicalName, namedCurve };
        importData =
          slot.kind === 'public'
            ? toBufferSource(encodePublicKeyDer(slot.data, 'spki'))
            : toBufferSource(encodePrivateKeyDer(slot.data, 'pkcs8'));
        break;
      }
      case 'simple': {
        const canonicalName = normAlg.name;
        if (canonicalName === 'Ed25519' || canonicalName === 'X25519') {
          const allowed: KeyUsage[] =
            canonicalName === 'X25519'
              ? isPublic
                ? []
                : ['deriveKey', 'deriveBits']
              : isPublic
                ? ['verify']
                : ['sign'];
          if (hasAnyUsageOutside(usages, allowed)) {
            throw new DOMException(
              `Unsupported key usage for a ${canonicalName} key`,
              'SyntaxError',
            );
          }
          const expectedKind = canonicalName === 'Ed25519' ? 'ed25519' : 'x25519';
          if (keyType !== expectedKind) {
            throw new DOMException('Invalid key type', 'DataError');
          }
          if (slot.kind === 'private' && usages.length === 0) {
            throw new DOMException(
              'Usages cannot be empty when importing a private key.',
              'SyntaxError',
            );
          }
          if (!slot.data || slot.data.kind !== expectedKind) {
            throw fault(
              'ENOSYS',
              'Converting a non-extractable WebCrypto asymmetric KeyObject via toCryptoKey is unsupported',
            );
          }
          algMeta = { name: canonicalName };
          importAlg = { name: canonicalName };
          importFormat = slot.kind === 'public' ? 'spki' : 'pkcs8';
          importData =
            slot.kind === 'public'
              ? toBufferSource(encodePublicKeyDer(slot.data, 'spki'))
              : toBufferSource(encodePrivateKeyDer(slot.data, 'pkcs8'));
          break;
        }
        if (canonicalName === 'Ed448' || canonicalName === 'X448') {
          throw fault('ENOSYS', `${canonicalName} keys are not supported in WebCrypto`);
        }
        throw new DOMException('Unrecognized algorithm name', 'NotSupportedError');
      }
      case 'hmac':
        throw new DOMException('Unrecognized algorithm name', 'NotSupportedError');
    }

    return makeSyntheticCryptoKey(this, {
      type: slot.kind,
      extractable: ext,
      algorithm: algMeta,
      usages,
      importFormat,
      importData,
      importAlgorithm: importAlg,
    });
  }
}

export class PublicKeyObject extends AsymmetricKeyObject {
  constructor(handle: PublicKeyHandle) {
    super('public', handle);
  }

  export(options?: unknown): string | Buffer | Record<string, string> {
    const slot = requireKeySlot(this, 'PublicKeyObject');
    if (slot.kind !== 'public') throw invalidThisError('PublicKeyObject');
    const keyType = slot.data ? slot.data.kind : slot.nonExtractableMeta!.keyType;
    if (record(options) && options.format === 'jwk') {
      if (!slot.data) {
        throw fault(
          'ENOSYS',
          'Exporting a non-extractable WebCrypto public key synchronously is unsupported',
        );
      }
      return exportPublicJwk(slot.data);
    }
    const { format, type } = parseKeyEncodingOptions(options, keyType, true);
    if (!slot.data) {
      throw fault(
        'ENOSYS',
        'Exporting a non-extractable WebCrypto public key synchronously is unsupported',
      );
    }
    if (format === 'jwk') return exportPublicJwk(slot.data);
    const encType: 'spki' | 'pkcs1' = type === 'pkcs1' ? 'pkcs1' : 'spki';
    const der = encodePublicKeyDer(slot.data, encType);
    if (format === 'der') return der;
    return wrapPem(encType === 'pkcs1' ? 'RSA PUBLIC KEY' : 'PUBLIC KEY', der);
  }
}
Object.defineProperty(PublicKeyObject, 'name', { value: 'PublicKeyObject', configurable: true });

export class PrivateKeyObject extends AsymmetricKeyObject {
  constructor(handle: PrivateKeyHandle) {
    super('private', handle);
  }

  export(options?: unknown): string | Buffer | Record<string, string> {
    const slot = requireKeySlot(this, 'PrivateKeyObject');
    if (slot.kind !== 'private') throw invalidThisError('PrivateKeyObject');
    const keyType = slot.data ? slot.data.kind : slot.nonExtractableMeta!.keyType;
    if (record(options) && options.format === 'jwk') {
      if (options.passphrase !== undefined) {
        throw incompatibleKeyOptions('jwk', 'does not support encryption');
      }
      if (!slot.data) {
        throw fault(
          'ENOSYS',
          'Exporting a non-extractable WebCrypto private key synchronously is unsupported',
        );
      }
      return exportPrivateJwk(slot.data);
    }
    const { format, type } = parseKeyEncodingOptions(options, keyType, false);
    if (!slot.data) {
      throw fault(
        'ENOSYS',
        'Exporting a non-extractable WebCrypto private key synchronously is unsupported',
      );
    }
    if (format === 'jwk') return exportPrivateJwk(slot.data);
    const encType: 'pkcs8' | 'pkcs1' | 'sec1' =
      type === 'pkcs1' || type === 'sec1' ? type : 'pkcs8';
    const der = encodePrivateKeyDer(slot.data, encType);
    if (format === 'der') return der;
    const label =
      encType === 'pkcs1'
        ? 'RSA PRIVATE KEY'
        : encType === 'sec1'
          ? 'EC PRIVATE KEY'
          : 'PRIVATE KEY';
    return wrapPem(label, der);
  }
}
Object.defineProperty(PrivateKeyObject, 'name', { value: 'PrivateKeyObject', configurable: true });

// --- Internal accessors for crypto-hmac, crypto-hkdf, and crypto-sign ---

const secretBufferTypes = typeList([], ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView']);
const hmacKeyTypes = typeList(
  ['string'],
  ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView', 'KeyObject', 'CryptoKey'],
);

export function extractSecretKeyBytes(key: unknown, encoding: unknown): Uint8Array {
  if (isKeyObject(key)) {
    const slot = requireKeySlot(key);
    if (slot.kind !== 'secret') throw invalidKeyObjectType(slot.kind, 'secret');
    if (!slot.bytes) {
      throw fault('ENOSYS', 'HMAC with a non-extractable WebCrypto key is unsupported');
    }
    return slot.bytes;
  }
  if (isCryptoKey(key)) {
    if (key.type !== 'secret') throw invalidKeyObjectType(key.type, 'secret');
    const ko = keyObjectFromCryptoKey(key);
    const slot = requireKeySlot(ko);
    if (slot.kind !== 'secret' || !slot.bytes) {
      throw fault('ENOSYS', 'HMAC with a non-extractable WebCrypto key is unsupported');
    }
    return slot.bytes;
  }
  if (typeof key === 'string') return stringBytes(key, encoding);
  const bytes = viewBytes(key);
  if (bytes === undefined) throw invalidArgType('key', hmacKeyTypes, key);
  return bytes;
}

export function extractHkdfSecretKeyBytes(ikm: unknown): Uint8Array | undefined {
  if (!isKeyObject(ikm)) return undefined;
  const slot = requireKeySlot(ikm);
  if (slot.kind !== 'secret') return undefined;
  if (!slot.bytes) {
    throw fault('ENOSYS', 'HKDF with a non-extractable WebCrypto key is unsupported');
  }
  return slot.bytes;
}

export function inspectKeyObjectSlot(keyObj: KeyObject): {
  kind: 'secret' | 'public' | 'private';
  publicData?: ParsedPublicKey;
  privateData?: ParsedPrivateKey;
  cryptoKey?: CryptoKey;
  nonExtractableType?: AsymmetricKeyTypeName;
  nonExtractableDetails?: Record<string, unknown>;
  pairedPublicData?: ParsedPublicKey;
  pairedPublicCryptoKey?: CryptoKey;
} {
  const slot = requireKeySlot(keyObj);
  if (slot.kind === 'secret') {
    return { kind: 'secret', cryptoKey: slot.cryptoKey };
  }
  if (slot.kind === 'public') {
    return {
      kind: 'public',
      publicData: slot.data,
      cryptoKey: slot.cryptoKey,
      nonExtractableType: slot.nonExtractableMeta?.keyType,
      nonExtractableDetails: slot.nonExtractableMeta?.details,
    };
  }
  return {
    kind: 'private',
    privateData: slot.data,
    cryptoKey: slot.cryptoKey,
    nonExtractableType: slot.nonExtractableMeta?.keyType,
    nonExtractableDetails: slot.nonExtractableMeta?.details,
    pairedPublicData: slot.nonExtractableMeta?.pairedPublic?.data,
    pairedPublicCryptoKey: slot.nonExtractableMeta?.pairedPublic?.cryptoKey,
  };
}

// --- JWK input parsing (matches keys.js lines 512-620) ---

function parseJwkInput(jwk: unknown, isPublic: true): ParsedPublicKey;
function parseJwkInput(jwk: unknown, isPublic: false): ParsedPrivateKey;
function parseJwkInput(jwk: unknown, isPublic: boolean): ParsedPublicKey | ParsedPrivateKey {
  validateObject(jwk, 'key');
  const kty = validateOneOf(jwk.kty, 'key.kty', ['RSA', 'EC', 'OKP'] as const);

  if (kty === 'OKP') {
    const crvStr = validateString(jwk.crv, 'key.crv');
    const crv = validateOneOf(crvStr, 'key.crv', ['Ed25519', 'Ed448', 'X25519', 'X448'] as const);
    const xStr = validateString(jwk.x, 'key.x');
    if (isPublic) {
      if (crv === 'Ed448' || crv === 'X448') {
        throw fault('ENOSYS', `${crv} keys are not supported in WebCrypto`);
      }
      const kind = crv === 'Ed25519' ? 'ed25519' : 'x25519';
      const x = fromBase64Url(xStr);
      if (x.byteLength !== 32) throw invalidJwkError();
      return { kind, x };
    }
    const dStr = validateString(jwk.d, 'key.d');
    if (crv === 'Ed448' || crv === 'X448') {
      throw fault('ENOSYS', `${crv} keys are not supported in WebCrypto`);
    }
    const kind = crv === 'Ed25519' ? 'ed25519' : 'x25519';
    const d = fromBase64Url(dStr);
    if (d.byteLength !== 32) throw invalidJwkError();
    const x = kind === 'ed25519' ? deriveEd25519PublicKey(d) : deriveX25519PublicKey(d);
    return { kind, d, x };
  }

  if (kty === 'EC') {
    const crvStr = validateString(jwk.crv, 'key.crv');
    validateOneOf(crvStr, 'key.crv', ['P-256', 'secp256k1', 'P-384', 'P-521'] as const);
    const xStr = validateString(jwk.x, 'key.x');
    const yStr = validateString(jwk.y, 'key.y');
    const dStr = isPublic ? undefined : validateString(jwk.d, 'key.d');
    const normalized = normalizeEcCurveName(crvStr);
    if (!normalized || normalized === 'secp256k1') {
      throw fault('ENOSYS', 'EC curve secp256k1 is not supported in WebCrypto');
    }
    const coordLen = EC_CURVE_INFO[normalized].coordBytes;
    const x = fromBase64Url(xStr);
    const y = fromBase64Url(yStr);
    if (!isValidEcPoint(normalized, x, y)) throw invalidJwkError();
    if (dStr === undefined) return { kind: 'ec', namedCurve: normalized, x, y };
    const rawD = fromBase64Url(dStr);
    if (rawD.byteLength !== coordLen) throw invalidJwkError();
    return { kind: 'ec', namedCurve: normalized, d: rawD, x, y };
  }

  // RSA
  const nStr = validateString(jwk.n, 'key.n');
  const eStr = validateString(jwk.e, 'key.e');
  const nBytes = fromBase64Url(nStr);
  const eBytes = fromBase64Url(eStr);
  if (nBytes.byteLength === 0 || eBytes.byteLength === 0) throw invalidJwkError();
  const n = bytesToBigInt(nBytes);
  const e = bytesToBigInt(eBytes);
  if (n <= 0n || e <= 0n) throw invalidJwkError();
  if (isPublic) return { kind: 'rsa', n, e };

  const dStr = validateString(jwk.d, 'key.d');
  const pStr = validateString(jwk.p, 'key.p');
  const qStr = validateString(jwk.q, 'key.q');
  const dpStr = validateString(jwk.dp, 'key.dp');
  const dqStr = validateString(jwk.dq, 'key.dq');
  const qiStr = validateString(jwk.qi, 'key.qi');
  return {
    kind: 'rsa',
    n,
    e,
    d: bytesToBigInt(fromBase64Url(dStr)),
    p: bytesToBigInt(fromBase64Url(pStr)),
    q: bytesToBigInt(fromBase64Url(qStr)),
    dp: bytesToBigInt(fromBase64Url(dpStr)),
    dq: bytesToBigInt(fromBase64Url(dqStr)),
    qi: bytesToBigInt(fromBase64Url(qiStr)),
  };
}

// --- PEM & DER asymmetric input parsing ---

function parsePemAsPublic(pemText: string): ParsedPublicKey {
  const { label, der } = unwrapPem(pemText);
  switch (label) {
    case 'PUBLIC KEY':
      return decodeSpkiDer(der);
    case 'RSA PUBLIC KEY':
      return decodePublicKeyDer(der, 'pkcs1');
    case 'PRIVATE KEY':
      return publicFromPrivateData(decodePkcs8Der(der));
    case 'RSA PRIVATE KEY':
      return publicFromPrivateData(decodePrivateKeyDer(der, 'pkcs1'));
    case 'EC PRIVATE KEY':
      return publicFromPrivateData(decodePrivateKeyDer(der, 'sec1'));
    default:
      throw Object.assign(new Error('error:1E08010C:DECODER routines::unsupported'), {
        code: 'ERR_OSSL_UNSUPPORTED',
      });
  }
}

function parsePemAsPrivate(pemText: string): ParsedPrivateKey {
  const { label, der } = unwrapPem(pemText);
  switch (label) {
    case 'PRIVATE KEY':
      return decodePkcs8Der(der);
    case 'RSA PRIVATE KEY':
      return decodePrivateKeyDer(der, 'pkcs1');
    case 'EC PRIVATE KEY':
      return decodePrivateKeyDer(der, 'sec1');
    default:
      throw Object.assign(new Error('error:1E08010C:DECODER routines::unsupported'), {
        code: 'ERR_OSSL_UNSUPPORTED',
      });
  }
}

function bytesToUtf8(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

const createPrivateAllowedTypes = typeList(
  ['string'],
  ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView'],
);
const createPublicAllowedTypes = typeList(
  ['string'],
  ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView', 'KeyObject', 'CryptoKey'],
);

// --- Public createSecretKey / createPublicKey / createPrivateKey ---

export function createSecretKey(key: unknown, encoding?: unknown): SecretKeyObject {
  let bytes: Uint8Array;
  if (typeof key === 'string') {
    bytes = stringBytes(key, encoding);
  } else {
    const view = viewBytes(key);
    if (view === undefined) {
      throw invalidArgType('key', secretBufferTypes, key);
    }
    bytes = view;
  }
  return new SecretKeyObject(makeSecretHandle(bytes));
}

function derivePublicFromPrivateSlot(slot: PrivateKeyHandle): PublicKeyObject {
  if (slot.data) {
    return new PublicKeyObject(makePublicHandle(publicFromPrivateData(slot.data)));
  }
  if (slot.nonExtractableMeta?.pairedPublic) {
    return new PublicKeyObject(slot.nonExtractableMeta.pairedPublic);
  }
  throw fault(
    'ENOSYS',
    'Deriving a public key from an uncaptured non-extractable WebCrypto private key is unsupported',
  );
}

export function createPublicKey(key: unknown): PublicKeyObject {
  if (isKeyObject(key)) {
    const slot = requireKeySlot(key);
    if (slot.kind !== 'private') throw invalidKeyObjectType(slot.kind, 'private');
    return derivePublicFromPrivateSlot(slot);
  }
  if (isCryptoKey(key)) {
    const ko = keyObjectFromCryptoKey(key);
    const slot = requireKeySlot(ko);
    if (slot.kind !== 'private') throw invalidKeyObjectType(slot.kind, 'private');
    return derivePublicFromPrivateSlot(slot);
  }
  if (typeof key === 'string') {
    return new PublicKeyObject(makePublicHandle(parsePemAsPublic(key)));
  }
  const directBytes = viewBytes(key);
  if (directBytes !== undefined) {
    return new PublicKeyObject(makePublicHandle(parsePemAsPublic(bytesToUtf8(directBytes))));
  }
  if (record(key)) {
    const inner = key.key;
    if (isKeyObject(inner)) {
      const slot = requireKeySlot(inner);
      if (slot.kind !== 'private') throw invalidKeyObjectType(slot.kind, 'private');
      return derivePublicFromPrivateSlot(slot);
    }
    if (isCryptoKey(inner)) {
      const ko = keyObjectFromCryptoKey(inner);
      const slot = requireKeySlot(ko);
      if (slot.kind !== 'private') throw invalidKeyObjectType(slot.kind, 'private');
      return derivePublicFromPrivateSlot(slot);
    }
    if (key.format === 'jwk') {
      validateObject(inner, 'key.key');
      return new PublicKeyObject(makePublicHandle(parseJwkInput(inner, true)));
    }
    let rawBytes: Uint8Array;
    if (typeof inner === 'string') {
      rawBytes = stringBytes(inner, key.encoding);
    } else {
      const view = viewBytes(inner);
      if (view === undefined) {
        throw invalidArgType('key.key', createPublicAllowedTypes, inner);
      }
      rawBytes = view;
    }
    const { format, type } = parseKeyEncodingOptions(key, undefined, undefined);
    if (format === 'pem') {
      return new PublicKeyObject(makePublicHandle(parsePemAsPublic(bytesToUtf8(rawBytes))));
    }
    if (type === 'spki' || type === 'pkcs1') {
      try {
        return new PublicKeyObject(makePublicHandle(decodePublicKeyDer(rawBytes, type)));
      } catch (err) {
        if (type === 'pkcs1') {
          return new PublicKeyObject(
            makePublicHandle(publicFromPrivateData(decodePrivateKeyDer(rawBytes, 'pkcs1'))),
          );
        }
        throw err;
      }
    }
    const privType: 'pkcs8' | 'sec1' = type === 'sec1' ? 'sec1' : 'pkcs8';
    const privParsed = decodePrivateKeyDer(rawBytes, privType);
    return new PublicKeyObject(makePublicHandle(publicFromPrivateData(privParsed)));
  }
  throw invalidArgType('key', createPublicAllowedTypes, key);
}

export function createPrivateKey(key: unknown): PrivateKeyObject {
  if (isKeyObject(key) || isCryptoKey(key)) {
    throw invalidArgType('key', createPrivateAllowedTypes, key);
  }
  if (typeof key === 'string') {
    return new PrivateKeyObject(makePrivateHandle(parsePemAsPrivate(key)));
  }
  const directBytes = viewBytes(key);
  if (directBytes !== undefined) {
    return new PrivateKeyObject(makePrivateHandle(parsePemAsPrivate(bytesToUtf8(directBytes))));
  }
  if (record(key)) {
    const inner = key.key;
    if (isKeyObject(inner) || isCryptoKey(inner)) {
      throw invalidArgType('key', createPrivateAllowedTypes, inner);
    }
    if (key.format === 'jwk') {
      validateObject(inner, 'key.key');
      return new PrivateKeyObject(makePrivateHandle(parseJwkInput(inner, false)));
    }
    let rawBytes: Uint8Array;
    if (typeof inner === 'string') {
      rawBytes = stringBytes(inner, key.encoding);
    } else {
      const view = viewBytes(inner);
      if (view === undefined) {
        throw invalidArgType('key.key', createPrivateAllowedTypes, inner);
      }
      rawBytes = view;
    }
    const { format, type } = parseKeyEncodingOptions(key, undefined, false);
    if (format === 'pem') {
      return new PrivateKeyObject(makePrivateHandle(parsePemAsPrivate(bytesToUtf8(rawBytes))));
    }
    const privType: 'pkcs8' | 'pkcs1' | 'sec1' =
      type === 'pkcs1' || type === 'sec1' ? type : 'pkcs8';
    return new PrivateKeyObject(makePrivateHandle(decodePrivateKeyDer(rawBytes, privType)));
  }
  throw invalidArgType('key', createPrivateAllowedTypes, key);
}

// --- Asymmetric key input helper for crypto.sign / crypto.verify ---

export function resolvePublicOrPrivateForVerify(key: unknown): {
  keyObject: PublicKeyObject | PrivateKeyObject;
  options: Record<string, unknown>;
} {
  if (isKeyObject(key)) {
    const slot = requireKeySlot(key);
    if (slot.kind === 'secret') throw invalidKeyObjectType('secret', 'private or public');
    // Safe: KeyObject slots with kind !== 'secret' are exclusively PublicKeyObject | PrivateKeyObject.
    return { keyObject: key as PublicKeyObject | PrivateKeyObject, options: {} };
  }
  if (isCryptoKey(key)) {
    const ko = keyObjectFromCryptoKey(key);
    const slot = requireKeySlot(ko);
    if (slot.kind === 'secret') throw invalidKeyObjectType('secret', 'private or public');
    // Safe: keyObjectFromCryptoKey returns PublicKeyObject | PrivateKeyObject when slot.kind !== 'secret'.
    return { keyObject: ko as PublicKeyObject | PrivateKeyObject, options: {} };
  }
  if (typeof key === 'string' || viewBytes(key) !== undefined) {
    return { keyObject: createPublicKey(key), options: {} };
  }
  if (record(key)) {
    const inner = key.key;
    if (isKeyObject(inner)) {
      const slot = requireKeySlot(inner);
      if (slot.kind === 'secret') throw invalidKeyObjectType('secret', 'private or public');
      // Safe: KeyObject slots with kind !== 'secret' are exclusively PublicKeyObject | PrivateKeyObject.
      return { keyObject: inner as PublicKeyObject | PrivateKeyObject, options: key };
    }
    if (isCryptoKey(inner)) {
      const ko = keyObjectFromCryptoKey(inner);
      const slot = requireKeySlot(ko);
      if (slot.kind === 'secret') throw invalidKeyObjectType('secret', 'private or public');
      // Safe: keyObjectFromCryptoKey returns PublicKeyObject | PrivateKeyObject when slot.kind !== 'secret'.
      return { keyObject: ko as PublicKeyObject | PrivateKeyObject, options: key };
    }
    return { keyObject: createPublicKey(key), options: key };
  }
  throw invalidArgType('key', createPublicAllowedTypes, key);
}

export function resolvePrivateForSign(key: unknown): {
  keyObject: PrivateKeyObject;
  options: Record<string, unknown>;
} {
  if (isKeyObject(key)) {
    const slot = requireKeySlot(key);
    if (slot.kind !== 'private') throw invalidKeyObjectType(slot.kind, 'private');
    // Safe: KeyObject slots with kind === 'private' are exclusively PrivateKeyObject instances.
    return { keyObject: key as PrivateKeyObject, options: {} };
  }
  if (isCryptoKey(key)) {
    const ko = keyObjectFromCryptoKey(key);
    const slot = requireKeySlot(ko);
    if (slot.kind !== 'private') throw invalidKeyObjectType(slot.kind, 'private');
    // Safe: keyObjectFromCryptoKey returns PrivateKeyObject when slot.kind === 'private'.
    return { keyObject: ko as PrivateKeyObject, options: {} };
  }
  if (typeof key === 'string' || viewBytes(key) !== undefined) {
    return { keyObject: createPrivateKey(key), options: {} };
  }
  if (record(key)) {
    const inner = key.key;
    if (isKeyObject(inner)) {
      const slot = requireKeySlot(inner);
      if (slot.kind !== 'private') throw invalidKeyObjectType(slot.kind, 'private');
      // Safe: KeyObject slots with kind === 'private' are exclusively PrivateKeyObject instances.
      return { keyObject: inner as PrivateKeyObject, options: key };
    }
    if (isCryptoKey(inner)) {
      const ko = keyObjectFromCryptoKey(inner);
      const slot = requireKeySlot(ko);
      if (slot.kind !== 'private') throw invalidKeyObjectType(slot.kind, 'private');
      // Safe: keyObjectFromCryptoKey returns PrivateKeyObject when slot.kind === 'private'.
      return { keyObject: ko as PrivateKeyObject, options: key };
    }
    return { keyObject: createPrivateKey(key), options: key };
  }
  throw invalidArgType('key', createPublicAllowedTypes, key);
}

// --- WebCrypto CryptoKey <-> KeyObject bridge ---

function readAlgorithmRecord(ck: CryptoKey): Record<string, unknown> {
  const raw: unknown = ck.algorithm;
  return record(raw) ? raw : {};
}

function fallbackNonExtractableFromCryptoKey(ck: CryptoKey): KeyObject {
  const alg = readAlgorithmRecord(ck);
  const algName = String(alg.name ?? '');
  if (ck.type === 'secret') {
    const bitLen = typeof alg.length === 'number' ? alg.length : 0;
    const ko = new SecretKeyObject(makeNonExtractableSecretHandle(Math.floor(bitLen / 8), ck));
    cacheCryptoKey(ck, ko);
    return ko;
  }
  let keyType: AsymmetricKeyTypeName = 'rsa';
  const details: Record<string, unknown> = {};
  if (algName.startsWith('RSA')) {
    // Node 22.18 WebCrypto generates RSA keys using rsaEncryption (type 'rsa'), even for RSA-PSS.
    keyType = 'rsa';
    if (typeof alg.modulusLength === 'number') details.modulusLength = alg.modulusLength;
    if (alg.publicExponent instanceof Uint8Array) {
      details.publicExponent = bytesToBigInt(alg.publicExponent);
    }
  } else if (algName === 'ECDSA' || algName === 'ECDH') {
    keyType = 'ec';
    const mapped = normalizeEcCurveName(String(alg.namedCurve ?? ''));
    if (mapped && mapped !== 'secp256k1') details.namedCurve = mapped;
  } else if (algName === 'Ed25519') {
    keyType = 'ed25519';
  } else if (algName === 'X25519') {
    keyType = 'x25519';
  }
  const ko =
    ck.type === 'public'
      ? new PublicKeyObject(makeNonExtractablePublicHandle(keyType, details, ck))
      : new PrivateKeyObject(makeNonExtractablePrivateHandle(keyType, details, ck));
  cacheCryptoKey(ck, ko);
  return ko;
}

function keyObjectFromCryptoKey(ck: CryptoKey): KeyObject {
  const existing = cryptoKeyCache.get(ck);
  if (existing) return existing;
  return fallbackNonExtractableFromCryptoKey(ck);
}

function buildKeyObjectFromImported(
  format: string,
  snapshot: Uint8Array | Record<string, unknown> | undefined,
  ck: CryptoKey,
): KeyObject | undefined {
  if (!snapshot) return undefined;
  try {
    if (ck.type === 'secret') {
      if (format === 'raw' && snapshot instanceof Uint8Array) {
        return new SecretKeyObject(makeSecretHandle(snapshot, ck));
      }
      if (format === 'jwk' && !(snapshot instanceof Uint8Array) && typeof snapshot.k === 'string') {
        return new SecretKeyObject(makeSecretHandle(fromBase64Url(snapshot.k), ck));
      }
    } else if (ck.type === 'public') {
      if (format === 'spki' && snapshot instanceof Uint8Array) {
        return new PublicKeyObject(makePublicHandle(decodeSpkiDer(snapshot), ck));
      }
      if (format === 'raw' && snapshot instanceof Uint8Array) {
        const alg = readAlgorithmRecord(ck);
        if (alg.name === 'Ed25519' || alg.name === 'X25519') {
          return new PublicKeyObject(
            makePublicHandle(
              { kind: alg.name === 'Ed25519' ? 'ed25519' : 'x25519', x: snapshot },
              ck,
            ),
          );
        }
        if ((alg.name === 'ECDSA' || alg.name === 'ECDH') && typeof alg.namedCurve === 'string') {
          const curve = normalizeEcCurveName(alg.namedCurve);
          if (curve && curve !== 'secp256k1') {
            const { x, y } = decodeEcPoint(curve, snapshot, false);
            return new PublicKeyObject(
              makePublicHandle({ kind: 'ec', namedCurve: curve, x, y }, ck),
            );
          }
        }
      }
      if (format === 'jwk' && !(snapshot instanceof Uint8Array)) {
        return new PublicKeyObject(makePublicHandle(parseJwkInput(snapshot, true), ck));
      }
    } else if (ck.type === 'private') {
      if (format === 'pkcs8' && snapshot instanceof Uint8Array) {
        return new PrivateKeyObject(makePrivateHandle(decodePkcs8Der(snapshot), ck));
      }
      if (format === 'jwk' && !(snapshot instanceof Uint8Array)) {
        return new PrivateKeyObject(makePrivateHandle(parseJwkInput(snapshot, false), ck));
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function cloneKeyObjectForClonedCryptoKey(origKo: KeyObject, clonedCk: CryptoKey): KeyObject {
  const slot = keySlots.get(origKo);
  if (!slot) return origKo;
  if (slot.kind === 'secret') {
    if (slot.bytes !== undefined) {
      return new SecretKeyObject(makeSecretHandle(slot.bytes, clonedCk));
    }
    return new SecretKeyObject(makeNonExtractableSecretHandle(slot.byteLength, clonedCk));
  }
  if (slot.kind === 'public') {
    if (slot.data !== undefined) {
      return new PublicKeyObject(makePublicHandle(slot.data, clonedCk));
    }
    const meta = slot.nonExtractableMeta!;
    return new PublicKeyObject(
      makeNonExtractablePublicHandle(meta.keyType, { ...meta.details }, clonedCk),
    );
  }
  if (slot.data !== undefined) {
    return new PrivateKeyObject(makePrivateHandle(slot.data, clonedCk));
  }
  const meta = slot.nonExtractableMeta!;
  return new PrivateKeyObject(
    makeNonExtractablePrivateHandle(meta.keyType, { ...meta.details }, clonedCk, meta.pairedPublic),
  );
}

function cloneSyntheticCryptoKey(origSyn: CryptoKey, spec: SyntheticCryptoKeySlot): CryptoKey {
  // Safe: CryptoKey.prototype getters read syntheticCryptoKeys, and SubtleCrypto materializes lazily.
  const clonedCk = Object.create(CryptoKey.prototype) as CryptoKey;
  const clonedSpec: SyntheticCryptoKeySlot = {
    type: spec.type,
    extractable: spec.extractable,
    algorithm: cloneAlgorithmMeta(spec.algorithm),
    usages: [...spec.usages],
    importFormat: spec.importFormat,
    importData: toBufferSource(spec.importData),
    importAlgorithm: spec.importAlgorithm,
  };
  syntheticCryptoKeys.set(clonedCk, clonedSpec);
  const origKo = cryptoKeyCache.get(origSyn);
  if (origKo) {
    cacheCryptoKey(clonedCk, cloneKeyObjectForClonedCryptoKey(origKo, clonedCk));
  }
  return clonedCk;
}

function isPlainCloneContainer(obj: object): obj is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
}

function installStructuredCloneCapture(): void {
  let owner: object | null = globalThis;
  let origDesc: PropertyDescriptor | undefined;
  while (owner && !(origDesc = Object.getOwnPropertyDescriptor(owner, 'structuredClone'))) {
    owner = Object.getPrototypeOf(owner);
  }
  if (!owner || typeof origDesc?.value !== 'function') return;
  // Safe: origDesc.value was verified callable above.
  const nativeStructuredClone = origDesc.value as (this: unknown, ...args: unknown[]) => unknown;

  const wrapped = {
    structuredClone(this: unknown, value: unknown, options?: unknown): unknown {
      const callArgs =
        arguments.length === 0 ? [] : arguments.length === 1 ? [value] : [value, options];
      if (
        arguments.length === 0 ||
        !anyTrackedCryptoKeyCreated ||
        typeof value !== 'object' ||
        value === null
      ) {
        return Reflect.apply(nativeStructuredClone, this, callArgs);
      }

      const visitedScan = new Set<object>();
      let foundSynthetic = false;
      let foundNativeCached = false;

      const scanGraph = (node: unknown): void => {
        if (typeof node !== 'object' || node === null) return;
        if (syntheticCryptoKeys.has(node)) {
          foundSynthetic = true;
          return;
        }
        // Safe: syntheticCryptoKeys was checked first; cryptoKeyCache only stores CryptoKey keys.
        if (cryptoKeyCache.has(node as CryptoKey)) {
          foundNativeCached = true;
          return;
        }
        if (visitedScan.has(node)) return;
        visitedScan.add(node);
        if (Array.isArray(node)) {
          for (const key of Object.keys(node)) {
            const desc = Object.getOwnPropertyDescriptor(node, key);
            if (desc && 'value' in desc) scanGraph(desc.value);
          }
        } else if (node instanceof Map) {
          for (const [k, v] of node.entries()) {
            scanGraph(k);
            scanGraph(v);
          }
        } else if (node instanceof Set) {
          for (const v of node.values()) {
            scanGraph(v);
          }
        } else if (isPlainCloneContainer(node)) {
          for (const key of Object.keys(node)) {
            const desc = Object.getOwnPropertyDescriptor(node, key);
            if (desc && 'value' in desc) scanGraph(desc.value);
          }
        }
      };

      scanGraph(value);
      if (!foundSynthetic && !foundNativeCached) {
        return Reflect.apply(nativeStructuredClone, this, callArgs);
      }

      const origSynToMarker = new Map<object, object>();
      const markerToOrigSyn = new Map<
        object,
        { origCk: CryptoKey; spec: SyntheticCryptoKeySlot }
      >();
      const origToRep = new WeakMap<object, object>();

      const buildReplaced = (node: unknown): unknown => {
        if (typeof node !== 'object' || node === null) return node;
        const spec = syntheticCryptoKeys.get(node);
        if (spec) {
          let marker = origSynToMarker.get(node);
          if (!marker) {
            marker = {};
            origSynToMarker.set(node, marker);
            // Safe: syntheticCryptoKeys only registers instances created on CryptoKey.prototype.
            markerToOrigSyn.set(marker, { origCk: node as CryptoKey, spec });
          }
          return marker;
        }
        const existingRep = origToRep.get(node);
        if (existingRep) return existingRep;
        if (Array.isArray(node)) {
          const repArr: unknown[] = new Array(node.length);
          origToRep.set(node, repArr);
          // Safe: Array instances are index/property records for own enumerable keys.
          const repRec = repArr as unknown as Record<string, unknown>;
          const srcRec = node as unknown as Record<string, unknown>;
          for (const key of Object.keys(node)) {
            repRec[key] = buildReplaced(srcRec[key]);
          }
          return repArr;
        }
        if (node instanceof Map) {
          const repMap = new Map<unknown, unknown>();
          origToRep.set(node, repMap);
          for (const [k, v] of node.entries()) {
            repMap.set(buildReplaced(k), buildReplaced(v));
          }
          return repMap;
        }
        if (node instanceof Set) {
          const repSet = new Set<unknown>();
          origToRep.set(node, repSet);
          for (const v of node.values()) {
            repSet.add(buildReplaced(v));
          }
          return repSet;
        }
        if (isPlainCloneContainer(node)) {
          // Safe: Object.create(null) constructs an empty null-prototype record.
          const repObj: Record<string, unknown> =
            Object.getPrototypeOf(node) === null
              ? (Object.create(null) as Record<string, unknown>)
              : {};
          origToRep.set(node, repObj);
          for (const key of Object.keys(node)) {
            repObj[key] = buildReplaced(node[key]);
          }
          return repObj;
        }
        return node;
      };

      const repRoot = foundSynthetic ? buildReplaced(value) : value;
      const repArgs = arguments.length > 1 ? [repRoot, options] : [repRoot];
      const clonedRoot = Reflect.apply(nativeStructuredClone, this, repArgs);

      const restoredContainers = new WeakSet<object>();
      const clonedMarkerToSyn = new WeakMap<object, CryptoKey>();

      const restoreCloned = (repNode: unknown, cloneNode: unknown): unknown => {
        if (typeof repNode === 'object' && repNode !== null) {
          const synEntry = markerToOrigSyn.get(repNode);
          if (synEntry && typeof cloneNode === 'object' && cloneNode !== null) {
            let synClone = clonedMarkerToSyn.get(cloneNode);
            if (!synClone) {
              synClone = cloneSyntheticCryptoKey(synEntry.origCk, synEntry.spec);
              clonedMarkerToSyn.set(cloneNode, synClone);
            }
            return synClone;
          }
        }
        if (isCryptoKey(repNode) && isCryptoKey(cloneNode)) {
          const cachedKo = cryptoKeyCache.get(repNode);
          if (cachedKo && !cryptoKeyCache.has(cloneNode)) {
            cacheCryptoKey(cloneNode, cloneKeyObjectForClonedCryptoKey(cachedKo, cloneNode));
          }
          return cloneNode;
        }
        if (typeof cloneNode !== 'object' || cloneNode === null) return cloneNode;
        if (restoredContainers.has(cloneNode)) return cloneNode;
        restoredContainers.add(cloneNode);

        if (Array.isArray(repNode) && Array.isArray(cloneNode)) {
          // Safe: Array instances are index/property records for own enumerable keys.
          const cloneRec = cloneNode as unknown as Record<string, unknown>;
          for (const key of Object.keys(repNode)) {
            const desc = Object.getOwnPropertyDescriptor(repNode, key);
            if (desc && 'value' in desc) {
              cloneRec[key] = restoreCloned(desc.value, cloneRec[key]);
            }
          }
        } else if (repNode instanceof Map && cloneNode instanceof Map) {
          const repEntries = Array.from(repNode.entries());
          const cloneEntries = Array.from(cloneNode.entries());
          cloneNode.clear();
          const count = Math.min(repEntries.length, cloneEntries.length);
          for (let i = 0; i < count; i++) {
            const [rk, rv] = repEntries[i];
            const [ck, cv] = cloneEntries[i];
            cloneNode.set(restoreCloned(rk, ck), restoreCloned(rv, cv));
          }
        } else if (repNode instanceof Set && cloneNode instanceof Set) {
          const repVals = Array.from(repNode.values());
          const cloneVals = Array.from(cloneNode.values());
          cloneNode.clear();
          const count = Math.min(repVals.length, cloneVals.length);
          for (let i = 0; i < count; i++) {
            cloneNode.add(restoreCloned(repVals[i], cloneVals[i]));
          }
        } else if (
          typeof repNode === 'object' &&
          repNode !== null &&
          isPlainCloneContainer(repNode) &&
          isPlainCloneContainer(cloneNode)
        ) {
          for (const key of Object.keys(repNode)) {
            const desc = Object.getOwnPropertyDescriptor(repNode, key);
            if (desc && 'value' in desc) {
              cloneNode[key] = restoreCloned(desc.value, cloneNode[key]);
            }
          }
        }
        return cloneNode;
      };

      return restoreCloned(repRoot, clonedRoot);
    },
  }.structuredClone;

  const lenDesc = Object.getOwnPropertyDescriptor(nativeStructuredClone, 'length');
  if (lenDesc) Object.defineProperty(wrapped, 'length', lenDesc);
  Object.defineProperty(owner, 'structuredClone', { ...origDesc, value: wrapped });
}

const SUBTLE_METHODS = [
  'decrypt',
  'deriveBits',
  'deriveKey',
  'digest',
  'encrypt',
  'exportKey',
  'generateKey',
  'importKey',
  'sign',
  'unwrapKey',
  'verify',
  'wrapKey',
] as const;

let subtleCaptureInstalled = false;

function installCryptoKeyPrototypeGetters(): void {
  if (typeof CryptoKey === 'undefined') return;
  const ckProto = CryptoKey.prototype;
  const typeDesc = Object.getOwnPropertyDescriptor(ckProto, 'type');
  if (typeof typeDesc?.get === 'function') {
    // Safe: CryptoKey.prototype.type is a WebIDL attribute getter returning KeyType.
    const origGet = typeDesc.get as (this: unknown) => KeyType;
    nativeCryptoKeyTypeGetter = origGet;
    Object.defineProperty(ckProto, 'type', {
      ...typeDesc,
      get(this: unknown): KeyType {
        const syn =
          typeof this === 'object' && this !== null ? syntheticCryptoKeys.get(this) : undefined;
        if (syn) return syn.type;
        return Reflect.apply(origGet, this, []);
      },
    });
  }
  for (const prop of ['extractable', 'algorithm', 'usages'] as const) {
    const desc = Object.getOwnPropertyDescriptor(ckProto, prop);
    if (typeof desc?.get !== 'function') continue;
    // Safe: desc.get was verified to be a function above.
    const origGet = desc.get as (this: unknown) => unknown;
    Object.defineProperty(ckProto, prop, {
      ...desc,
      get(this: unknown): unknown {
        const syn =
          typeof this === 'object' && this !== null ? syntheticCryptoKeys.get(this) : undefined;
        if (syn) return syn[prop];
        return Reflect.apply(origGet, this, []);
      },
    });
  }
}

export function installSubtleCryptoKeyCapture(retain: () => () => void): void {
  if (subtleCaptureInstalled || typeof SubtleCrypto === 'undefined') return;
  subtleCaptureInstalled = true;

  installCryptoKeyPrototypeGetters();
  installStructuredCloneCapture();

  const proto = SubtleCrypto.prototype;
  const exportDesc = Object.getOwnPropertyDescriptor(proto, 'exportKey');
  const importDesc = Object.getOwnPropertyDescriptor(proto, 'importKey');
  // Safe: SubtleCrypto.prototype.exportKey/importKey are native WebCrypto methods returning Promises.
  const rawExport =
    typeof exportDesc?.value === 'function'
      ? (exportDesc.value as (this: unknown, format: string, key: CryptoKey) => Promise<unknown>)
      : undefined;
  const rawImport =
    typeof importDesc?.value === 'function'
      ? (importDesc.value as (this: unknown, ...args: unknown[]) => Promise<CryptoKey>)
      : undefined;

  const hasSyntheticKey = (val: unknown): val is object =>
    typeof val === 'object' && val !== null && syntheticCryptoKeys.has(val);

  const materializeSynthetic = (subtleReceiver: unknown, keyObj: object): Promise<CryptoKey> => {
    const spec = syntheticCryptoKeys.get(keyObj)!;
    if (!spec.materialized) {
      if (!rawImport) {
        return Promise.reject(fault('ENOSYS', 'SubtleCrypto.importKey is unavailable'));
      }
      spec.materialized = Reflect.apply(rawImport, subtleReceiver, [
        spec.importFormat,
        spec.importData,
        spec.importAlgorithm,
        spec.extractable,
        spec.usages,
      ]).catch((err: unknown) => {
        spec.materialized = undefined;
        throw err;
      });
    }
    return spec.materialized;
  };

  const captureSingleCryptoKey = async (subtleReceiver: unknown, ck: CryptoKey): Promise<void> => {
    if (!rawExport) return;
    if (ck.extractable) {
      if (ck.type === 'secret') {
        const raw = await Reflect.apply(rawExport, subtleReceiver, ['raw', ck]);
        if (raw instanceof ArrayBuffer) {
          cacheCryptoKey(ck, new SecretKeyObject(makeSecretHandle(new Uint8Array(raw), ck)));
        }
      } else if (ck.type === 'public') {
        const spki = await Reflect.apply(rawExport, subtleReceiver, ['spki', ck]);
        if (spki instanceof ArrayBuffer) {
          cacheCryptoKey(
            ck,
            new PublicKeyObject(makePublicHandle(decodeSpkiDer(new Uint8Array(spki)), ck)),
          );
        }
      } else if (ck.type === 'private') {
        const pkcs8 = await Reflect.apply(rawExport, subtleReceiver, ['pkcs8', ck]);
        if (pkcs8 instanceof ArrayBuffer) {
          cacheCryptoKey(
            ck,
            new PrivateKeyObject(makePrivateHandle(decodePkcs8Der(new Uint8Array(pkcs8)), ck)),
          );
        }
      }
    } else {
      fallbackNonExtractableFromCryptoKey(ck);
    }
  };

  for (const name of SUBTLE_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const original: unknown = descriptor?.value;
    if (!descriptor || typeof original !== 'function') continue;

    const wrapped = {
      [name](this: unknown, ...args: unknown[]): Promise<unknown> {
        let importFormat = '';
        let importSnapshot: Uint8Array | Record<string, unknown> | undefined;
        if (name === 'importKey') {
          importFormat = typeof args[0] === 'string' ? args[0] : '';
          const keyData = args[1];
          const bytes = viewBytes(keyData);
          if (bytes !== undefined) importSnapshot = Uint8Array.from(bytes);
          else if (record(keyData)) importSnapshot = { ...keyData };
        }

        const synArg1 = args.length > 1 && hasSyntheticKey(args[1]) ? args[1] : undefined;
        const synArg2 = args.length > 2 && hasSyntheticKey(args[2]) ? args[2] : undefined;
        const algArg = args[0];
        const synAlgPub =
          record(algArg) && hasSyntheticKey(algArg.public) ? algArg.public : undefined;

        const release = retain();
        let pending: Promise<unknown>;

        if (synArg1 || synArg2 || synAlgPub) {
          pending = (async () => {
            const resolvedArgs = [...args];
            if (synAlgPub && record(algArg)) {
              const realPub = await materializeSynthetic(this, synAlgPub);
              resolvedArgs[0] = {
                ...algArg,
                ...(algArg.name !== undefined ? { name: algArg.name } : {}),
                public: realPub,
              };
            }
            if (synArg1) resolvedArgs[1] = await materializeSynthetic(this, synArg1);
            if (synArg2) resolvedArgs[2] = await materializeSynthetic(this, synArg2);
            const inner: unknown = Reflect.apply(original, this, resolvedArgs);
            if (!(inner instanceof Promise)) {
              throw fault('EPROTO', `SubtleCrypto.${name} did not return a promise`);
            }
            return inner;
          })();
        } else {
          let rawResult: unknown;
          try {
            rawResult = Reflect.apply(original, this, args);
          } catch (error) {
            release();
            throw error;
          }
          if (!(rawResult instanceof Promise)) {
            release();
            throw fault('EPROTO', `SubtleCrypto.${name} did not return a promise`);
          }
          pending = rawResult;
        }

        if (name === 'importKey') {
          return pending
            .then((ck) => {
              if (isCryptoKey(ck)) {
                const ko = buildKeyObjectFromImported(importFormat, importSnapshot, ck);
                if (ko) cacheCryptoKey(ck, ko);
                else if (!ck.extractable) fallbackNonExtractableFromCryptoKey(ck);
              }
              return ck;
            })
            .finally(release);
        }

        if (name === 'generateKey' || name === 'deriveKey' || name === 'unwrapKey') {
          return pending
            .then(async (res) => {
              try {
                if (isCryptoKey(res)) {
                  await captureSingleCryptoKey(this, res);
                } else if (
                  record(res) &&
                  isCryptoKey(res.publicKey) &&
                  isCryptoKey(res.privateKey)
                ) {
                  const pubCk = res.publicKey;
                  const privCk = res.privateKey;
                  let pubHandle: PublicKeyHandle | undefined;
                  if (pubCk.extractable && rawExport) {
                    const spki = await Reflect.apply(rawExport, this, ['spki', pubCk]);
                    if (spki instanceof ArrayBuffer) {
                      pubHandle = makePublicHandle(decodeSpkiDer(new Uint8Array(spki)), pubCk);
                      cacheCryptoKey(pubCk, new PublicKeyObject(pubHandle));
                    }
                  } else {
                    const pubKo = fallbackNonExtractableFromCryptoKey(pubCk);
                    const pubSlot = keySlots.get(pubKo);
                    if (pubSlot && pubSlot.kind === 'public') pubHandle = pubSlot;
                  }
                  if (privCk.extractable) {
                    await captureSingleCryptoKey(this, privCk);
                  } else {
                    const nonExtKo = fallbackNonExtractableFromCryptoKey(privCk);
                    const slot = keySlots.get(nonExtKo);
                    if (slot && slot.kind === 'private' && slot.nonExtractableMeta && pubHandle) {
                      slot.nonExtractableMeta.pairedPublic = pubHandle;
                    }
                  }
                }
              } catch {
                // Preserve WebCrypto's own resolution if export metadata inspection fails.
              }
              return res;
            })
            .finally(release);
        }

        return pending.finally(release);
      },
    }[name];

    Object.defineProperty(wrapped, 'length', { value: original.length });
    Object.defineProperty(proto, name, { ...descriptor, value: wrapped });
  }
}

// --- Async generateKey & generateKeyPair (matches keygen.js) ---

function validateUint32(value: unknown, name: string): number {
  return validateInteger(value, name, 0, UINT32_MAX);
}

function uint32BigEndianBytes(value: number): Uint8Array<ArrayBuffer> {
  if (value === 0) return new Uint8Array([0]);
  const bytes: number[] = [];
  let rem = value >>> 0;
  while (rem > 0) {
    bytes.push(rem & 0xff);
    rem >>>= 8;
  }
  bytes.reverse();
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

export function createKeyGen(retain: () => () => void, schedule: (callback: () => void) => void) {
  function generateKey(type: unknown, options: unknown, callback?: unknown): void {
    let actualOptions = options;
    let actualCallback = callback;
    if (typeof actualOptions === 'function') {
      actualCallback = actualOptions;
      actualOptions = undefined;
    }
    if (typeof actualCallback !== 'function') {
      throw invalidArgType('callback', 'of type function', actualCallback);
    }
    const keyType = validateString(type, 'type');
    validateObject(actualOptions, 'options');
    const lengthVal = actualOptions.length;
    let bitLength: number;
    if (keyType === 'hmac') {
      bitLength = validateInteger(lengthVal, 'options.length', 8, INT32_MAX);
    } else if (keyType === 'aes') {
      bitLength = validateOneOf(lengthVal, 'options.length', [128, 192, 256] as const);
    } else {
      throw invalidArgValue('type', keyType, 'must be a supported key type');
    }

    const byteLength = Math.floor(bitLength / 8);
    // Safe: typeof actualCallback === 'function' was verified above.
    const done = captured(
      actualCallback as (this: object, err: Error | null, key?: SecretKeyObject) => void,
    );
    const release = retain();
    const job = {};

    const subtle = globalThis.crypto.subtle;
    if (
      (keyType === 'aes' && bitLength !== 192) ||
      (keyType === 'hmac' && bitLength % 8 === 0 && bitLength <= 16384)
    ) {
      const alg =
        keyType === 'aes'
          ? { name: 'AES-GCM', length: bitLength }
          : { name: 'HMAC', hash: 'SHA-256', length: bitLength };
      const usages: KeyUsage[] = keyType === 'aes' ? ['encrypt', 'decrypt'] : ['sign', 'verify'];
      subtle
        .generateKey(alg, true, usages)
        .then((ck) => {
          // Safe: AES-GCM and HMAC generateKey always resolve to a single CryptoKey.
          return subtle.exportKey('raw', ck as CryptoKey);
        })
        .then(
          (raw) => {
            queueMicrotask(() => {
              try {
                const keyObj = new SecretKeyObject(makeSecretHandle(new Uint8Array(raw)));
                Reflect.apply(done, job, [null, keyObj]);
              } finally {
                release();
              }
            });
          },
          (err: unknown) => {
            queueMicrotask(() => {
              try {
                Reflect.apply(done, job, [err instanceof Error ? err : new Error(String(err))]);
              } finally {
                release();
              }
            });
          },
        );
      return;
    }

    schedule(() => {
      try {
        const buf = new Uint8Array(byteLength);
        for (let off = 0; off < byteLength; off += 65536) {
          globalThis.crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, byteLength)));
        }
        Reflect.apply(done, job, [null, new SecretKeyObject(makeSecretHandle(buf))]);
      } finally {
        release();
      }
    });
  }

  function generateKeyPair(type: unknown, options: unknown, callback?: unknown): void {
    let actualOptions = options;
    let actualCallback = callback;
    if (typeof actualOptions === 'function') {
      actualCallback = actualOptions;
      actualOptions = undefined;
    }
    if (typeof actualCallback !== 'function') {
      throw invalidArgType('callback', 'of type function', actualCallback);
    }
    const keyType = validateString(type, 'type');

    const optsObj = record(actualOptions) ? actualOptions : undefined;
    const publicKeyEncodingOpt = optsObj?.publicKeyEncoding;
    const privateKeyEncodingOpt = optsObj?.privateKeyEncoding;

    let pubEnc: ParsedEncodingOptions | undefined;
    if (publicKeyEncodingOpt != null) {
      if (typeof publicKeyEncodingOpt !== 'object') {
        throw invalidArgValue('options.publicKeyEncoding', publicKeyEncodingOpt);
      }
      pubEnc = parseKeyEncodingOptions(publicKeyEncodingOpt, keyType, true, 'publicKeyEncoding');
    }
    let privEnc: ParsedEncodingOptions | undefined;
    if (privateKeyEncodingOpt != null) {
      if (typeof privateKeyEncodingOpt !== 'object') {
        throw invalidArgValue('options.privateKeyEncoding', privateKeyEncodingOpt);
      }
      privEnc = parseKeyEncodingOptions(
        privateKeyEncodingOpt,
        keyType,
        false,
        'privateKeyEncoding',
      );
    }
    if (actualOptions !== undefined) {
      validateObject(actualOptions, 'options');
    }

    // Safe: typeof actualCallback === 'function' was verified above.
    const done = captured(
      actualCallback as (
        this: object,
        err: Error | null,
        publicKey?: unknown,
        privateKey?: unknown,
      ) => void,
    );
    const job = {};

    const deliverGenerated = (
      build: () => { pubData: ParsedPublicKey; privData: ParsedPrivateKey },
    ) => {
      let pubOut: unknown;
      let privOut: unknown;
      try {
        const { pubData, privData } = build();
        const pubObj = new PublicKeyObject(makePublicHandle(pubData));
        const privObj = new PrivateKeyObject(makePrivateHandle(privData));
        pubOut = pubEnc ? pubObj.export(publicKeyEncodingOpt) : pubObj;
        privOut = privEnc ? privObj.export(privateKeyEncodingOpt) : privObj;
      } catch (err: unknown) {
        Reflect.apply(done, job, [err instanceof Error ? err : new Error(String(err))]);
        return;
      }
      Reflect.apply(done, job, [null, pubOut, privOut]);
    };

    if (keyType === 'rsa' || keyType === 'rsa-pss') {
      validateObject(actualOptions, 'options');
      const modulusLength = validateUint32(actualOptions.modulusLength, 'options.modulusLength');
      const publicExponent =
        actualOptions.publicExponent == null
          ? 0x10001
          : validateUint32(actualOptions.publicExponent, 'options.publicExponent');

      let pssResolved: ReturnType<typeof resolveRsaPssKeygenParams>;
      if (keyType === 'rsa-pss') {
        const saltLength =
          actualOptions.saltLength === undefined
            ? undefined
            : validateInteger(actualOptions.saltLength, 'options.saltLength', 0, INT32_MAX);
        const hashAlgorithm =
          actualOptions.hashAlgorithm === undefined
            ? undefined
            : validateString(actualOptions.hashAlgorithm, 'options.hashAlgorithm');
        const mgf1HashAlgorithm =
          actualOptions.mgf1HashAlgorithm === undefined
            ? undefined
            : validateString(actualOptions.mgf1HashAlgorithm, 'options.mgf1HashAlgorithm');
        pssResolved = resolveRsaPssKeygenParams({
          hashAlgorithm,
          mgf1HashAlgorithm,
          saltLength,
        });
      }

      const release = retain();
      const subtle = globalThis.crypto.subtle;
      const rsaAlg: RsaHashedKeyGenParams = {
        name: keyType === 'rsa' ? 'RSASSA-PKCS1-v1_5' : 'RSA-PSS',
        modulusLength,
        publicExponent: uint32BigEndianBytes(publicExponent),
        hash: 'SHA-256',
      };
      subtle
        .generateKey(rsaAlg, true, ['sign', 'verify'])
        // Safe: asymmetric RSASSA-PKCS1-v1_5 / RSA-PSS generateKey always resolves to CryptoKeyPair.
        .then((pair) => subtle.exportKey('jwk', (pair as CryptoKeyPair).privateKey))
        .then(
          (jwk) => {
            queueMicrotask(() => {
              try {
                deliverGenerated(() => {
                  const parsed = parseJwkInput(jwk, false);
                  if (parsed.kind !== 'rsa') throw invalidJwkError();
                  const privData: ParsedPrivateKey = {
                    ...parsed,
                    kind: keyType,
                    pss: pssResolved,
                  };
                  return { pubData: publicFromPrivateData(privData), privData };
                });
              } finally {
                release();
              }
            });
          },
          (err: unknown) => {
            queueMicrotask(() => {
              try {
                Reflect.apply(done, job, [err instanceof Error ? err : new Error(String(err))]);
              } finally {
                release();
              }
            });
          },
        );
      return;
    }

    if (keyType === 'ec') {
      validateObject(actualOptions, 'options');
      const rawCurve = validateString(actualOptions.namedCurve, 'options.namedCurve');
      const paramEncoding = actualOptions.paramEncoding;
      if (paramEncoding != null && paramEncoding !== 'named' && paramEncoding !== 'explicit') {
        throw invalidArgValue('options.paramEncoding', paramEncoding);
      }
      if (paramEncoding === 'explicit') {
        throw fault('ENOSYS', 'Explicit EC curve parameter encoding is not supported in WebCrypto');
      }
      const normalized = normalizeEcCurveName(rawCurve);
      if (normalized === undefined) {
        throw Object.assign(new TypeError('Invalid EC curve name'), {
          code: 'ERR_CRYPTO_INVALID_CURVE',
        });
      }
      if (normalized === 'secp256k1') {
        throw fault('ENOSYS', 'EC curve secp256k1 is not supported in WebCrypto');
      }
      const webCrv = EC_CURVE_INFO[normalized].jwkCrv;
      const release = retain();
      const subtle = globalThis.crypto.subtle;
      subtle
        .generateKey({ name: 'ECDSA', namedCurve: webCrv }, true, ['sign', 'verify'])
        // Safe: asymmetric ECDSA generateKey always resolves to CryptoKeyPair.
        .then((pair) => subtle.exportKey('jwk', (pair as CryptoKeyPair).privateKey))
        .then(
          (jwk) => {
            queueMicrotask(() => {
              try {
                deliverGenerated(() => {
                  const privData = parseJwkInput(jwk, false);
                  return { pubData: publicFromPrivateData(privData), privData };
                });
              } finally {
                release();
              }
            });
          },
          (err: unknown) => {
            queueMicrotask(() => {
              try {
                Reflect.apply(done, job, [err instanceof Error ? err : new Error(String(err))]);
              } finally {
                release();
              }
            });
          },
        );
      return;
    }

    if (keyType === 'ed25519' || keyType === 'x25519') {
      const release = retain();
      const subtle = globalThis.crypto.subtle;
      const algName = keyType === 'ed25519' ? 'Ed25519' : 'X25519';
      const usages: KeyUsage[] = keyType === 'ed25519' ? ['sign', 'verify'] : ['deriveBits'];
      subtle
        .generateKey({ name: algName }, true, usages)
        // Safe: asymmetric Ed25519 / X25519 generateKey always resolves to CryptoKeyPair.
        .then((pair) => subtle.exportKey('jwk', (pair as CryptoKeyPair).privateKey))
        .then(
          (jwk) => {
            queueMicrotask(() => {
              try {
                deliverGenerated(() => {
                  const privData = parseJwkInput(jwk, false);
                  return { pubData: publicFromPrivateData(privData), privData };
                });
              } finally {
                release();
              }
            });
          },
          (err: unknown) => {
            queueMicrotask(() => {
              try {
                Reflect.apply(done, job, [err instanceof Error ? err : new Error(String(err))]);
              } finally {
                release();
              }
            });
          },
        );
      return;
    }

    if (keyType === 'ed448' || keyType === 'x448' || keyType === 'dsa' || keyType === 'dh') {
      throw fault('ENOSYS', `Key generation for ${keyType} is not supported in WebCrypto`);
    }

    throw invalidArgValue('type', keyType, 'must be a supported key type');
  }

  Object.defineProperty(generateKeyPair, kCustomPromisifyArgsSymbol, {
    value: ['publicKey', 'privateKey'],
    enumerable: false,
  });

  function generateKeySync(): never {
    throw fault(
      'ENOSYS',
      'Synchronous key generation is unsupported in the browser WebCrypto runtime; use crypto.generateKey',
    );
  }

  function generateKeyPairSync(): never {
    throw fault(
      'ENOSYS',
      'Synchronous keypair generation is unsupported in the browser WebCrypto runtime; use crypto.generateKeyPair',
    );
  }

  return {
    generateKey,
    generateKeySync,
    generateKeyPair,
    generateKeyPairSync,
  };
}
