// One-shot asynchronous crypto.sign / crypto.verify backed by WebCrypto
// SubtleCrypto, plus Node 22.18 crypto.constants.
//
// Derivative work of Node.js lib/internal/crypto/sig.js, retained under the
// Node.js MIT license (also vendor/node-v22.18.0/LICENSE):
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
import createShaHash from 'sha.js';
import { captured } from './context-hook';
import { invalidArgType, stringBytes, typeList, validateString, viewBytes } from './crypto-args';
import {
  EC_CURVE_INFO,
  type EcCurveName,
  type ParsedPrivateKey,
  type ParsedPublicKey,
  type RsaPrivateData,
  type RsaPublicData,
  bigIntToUnsignedBytes,
  bitLengthBigInt,
  bytesToBigInt,
  ecdsaDerToP1363,
  ecdsaP1363ToDer,
  encodePrivateKeyDer,
  encodePublicKeyDer,
  modPow,
  publicFromPrivateData,
} from './crypto-asn1';
import { fipsEnabled } from './crypto-fips';
import {
  inspectKeyObjectSlot,
  resolvePrivateForSign,
  resolvePublicOrPrivateForVerify,
} from './crypto-keys';
import { invalidArgValue } from './node-errors';
import { fault, record } from './protocol';

const RSA_PKCS1_PADDING = 1;
const RSA_NO_PADDING = 3;
const RSA_PKCS1_OAEP_PADDING = 4;
const RSA_X931_PADDING = 5;
const RSA_PKCS1_PSS_PADDING = 6;
const RSA_PSS_SALTLEN_DIGEST = -1;
const RSA_PSS_SALTLEN_MAX_SIGN = -2;
const RSA_PSS_SALTLEN_AUTO = -2;

const DEFAULT_CIPHER_LIST =
  'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:' +
  'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:' +
  'ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:' +
  'DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:' +
  'ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';

export function createCryptoConstants(): Record<string, number | string> {
  let cipherList = DEFAULT_CIPHER_LIST;
  // Safe: Object.create(null) constructs a clean dictionary populated exclusively with number | string values.
  const constants = Object.assign(Object.create(null) as Record<string, number | string>, {
    OPENSSL_VERSION_NUMBER: 805306624,
    SSL_OP_ALL: 2147485776,
    SSL_OP_ALLOW_NO_DHE_KEX: 1024,
    SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144,
    SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304,
    SSL_OP_CISCO_ANYCONNECT: 32768,
    SSL_OP_COOKIE_EXCHANGE: 8192,
    SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648,
    SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048,
    SSL_OP_LEGACY_SERVER_CONNECT: 4,
    SSL_OP_NO_COMPRESSION: 131072,
    SSL_OP_NO_ENCRYPT_THEN_MAC: 524288,
    SSL_OP_NO_QUERY_MTU: 4096,
    SSL_OP_NO_RENEGOTIATION: 1073741824,
    SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536,
    SSL_OP_NO_SSLv2: 0,
    SSL_OP_NO_SSLv3: 33554432,
    SSL_OP_NO_TICKET: 16384,
    SSL_OP_NO_TLSv1: 67108864,
    SSL_OP_NO_TLSv1_1: 268435456,
    SSL_OP_NO_TLSv1_2: 134217728,
    SSL_OP_NO_TLSv1_3: 536870912,
    SSL_OP_PRIORITIZE_CHACHA: 2097152,
    SSL_OP_TLS_ROLLBACK_BUG: 8388608,
    ENGINE_METHOD_RSA: 1,
    ENGINE_METHOD_DSA: 2,
    ENGINE_METHOD_DH: 4,
    ENGINE_METHOD_RAND: 8,
    ENGINE_METHOD_EC: 2048,
    ENGINE_METHOD_CIPHERS: 64,
    ENGINE_METHOD_DIGESTS: 128,
    ENGINE_METHOD_PKEY_METHS: 512,
    ENGINE_METHOD_PKEY_ASN1_METHS: 1024,
    ENGINE_METHOD_ALL: 65535,
    ENGINE_METHOD_NONE: 0,
    DH_CHECK_P_NOT_SAFE_PRIME: 2,
    DH_CHECK_P_NOT_PRIME: 1,
    DH_UNABLE_TO_CHECK_GENERATOR: 4,
    DH_NOT_SUITABLE_GENERATOR: 8,
    RSA_PKCS1_PADDING,
    RSA_NO_PADDING,
    RSA_PKCS1_OAEP_PADDING,
    RSA_X931_PADDING,
    RSA_PKCS1_PSS_PADDING,
    RSA_PSS_SALTLEN_DIGEST,
    RSA_PSS_SALTLEN_MAX_SIGN,
    RSA_PSS_SALTLEN_AUTO,
    defaultCoreCipherList: DEFAULT_CIPHER_LIST,
    TLS1_VERSION: 769,
    TLS1_1_VERSION: 770,
    TLS1_2_VERSION: 771,
    TLS1_3_VERSION: 772,
    POINT_CONVERSION_COMPRESSED: 2,
    POINT_CONVERSION_UNCOMPRESSED: 4,
    POINT_CONVERSION_HYBRID: 6,
  });
  Object.defineProperty(constants, 'defaultCipherList', {
    get() {
      return cipherList;
    },
    set(val: string) {
      cipherList = val;
    },
    enumerable: true,
    configurable: true,
  });
  return constants;
}

interface SignDigestInfo {
  shaName: 'sha1' | 'sha256' | 'sha384' | 'sha512';
  webHash: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
  size: number;
}

const SIGN_DIGESTS: Record<string, SignDigestInfo> = {
  sha1: { shaName: 'sha1', webHash: 'SHA-1', size: 20 },
  'sha-1': { shaName: 'sha1', webHash: 'SHA-1', size: 20 },
  'rsa-sha1': { shaName: 'sha1', webHash: 'SHA-1', size: 20 },
  'rsa-sha1-2': { shaName: 'sha1', webHash: 'SHA-1', size: 20 },
  sha1withrsaencryption: { shaName: 'sha1', webHash: 'SHA-1', size: 20 },
  'ssl3-sha1': { shaName: 'sha1', webHash: 'SHA-1', size: 20 },
  sha256: { shaName: 'sha256', webHash: 'SHA-256', size: 32 },
  'sha-256': { shaName: 'sha256', webHash: 'SHA-256', size: 32 },
  'sha2-256': { shaName: 'sha256', webHash: 'SHA-256', size: 32 },
  'rsa-sha256': { shaName: 'sha256', webHash: 'SHA-256', size: 32 },
  sha256withrsaencryption: { shaName: 'sha256', webHash: 'SHA-256', size: 32 },
  sha384: { shaName: 'sha384', webHash: 'SHA-384', size: 48 },
  'sha-384': { shaName: 'sha384', webHash: 'SHA-384', size: 48 },
  'sha2-384': { shaName: 'sha384', webHash: 'SHA-384', size: 48 },
  'rsa-sha384': { shaName: 'sha384', webHash: 'SHA-384', size: 48 },
  sha384withrsaencryption: { shaName: 'sha384', webHash: 'SHA-384', size: 48 },
  sha512: { shaName: 'sha512', webHash: 'SHA-512', size: 64 },
  'sha-512': { shaName: 'sha512', webHash: 'SHA-512', size: 64 },
  'sha2-512': { shaName: 'sha512', webHash: 'SHA-512', size: 64 },
  'rsa-sha512': { shaName: 'sha512', webHash: 'SHA-512', size: 64 },
  sha512withrsaencryption: { shaName: 'sha512', webHash: 'SHA-512', size: 64 },
};

const NATIVE_ONLY_SIGN_DIGESTS = new Set(
  (
    'sha224 sha-224 sha2-224 rsa-sha224 sha224withrsaencryption ' +
    'md5 rsa-md5 md5withrsaencryption ssl3-md5 md5-sha1 ' +
    'ripemd ripemd160 rmd160 rsa-ripemd160 ripemd160withrsa ' +
    'sha3-224 sha3-256 sha3-384 sha3-512 rsa-sha3-224 rsa-sha3-256 rsa-sha3-384 rsa-sha3-512 ' +
    'id-rsassa-pkcs1-v1_5-with-sha3-224 id-rsassa-pkcs1-v1_5-with-sha3-256 ' +
    'id-rsassa-pkcs1-v1_5-with-sha3-384 id-rsassa-pkcs1-v1_5-with-sha3-512 ' +
    'sha512-224 sha512/224 sha-512/224 sha2-512/224 rsa-sha512/224 sha512-224withrsaencryption ' +
    'sha512-256 sha512/256 sha-512/256 sha2-512/256 rsa-sha512/256 sha512-256withrsaencryption ' +
    'blake2b512 blake2s256 shake128 shake256 sm3 rsa-sm3 sm3withrsaencryption'
  ).split(' '),
);

function resolveSignDigest(algorithm: string): SignDigestInfo {
  const lower = algorithm.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SIGN_DIGESTS, lower)) {
    return SIGN_DIGESTS[lower];
  }
  if (NATIVE_ONLY_SIGN_DIGESTS.has(lower)) {
    throw fault(
      'ENOSYS',
      `Digest algorithm '${algorithm}' is not supported by WebCrypto sign/verify`,
    );
  }
  throw Object.assign(new TypeError(`Invalid digest: ${algorithm}`), {
    code: 'ERR_CRYPTO_INVALID_DIGEST',
  });
}

const dataInputTypes = typeList(['string'], ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView']);
const viewOnlyTypes = typeList([], ['Buffer', 'TypedArray', 'DataView']);

function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function getIntOption(name: string, options: unknown): number | undefined {
  if (!record(options)) return undefined;
  const value = options[name];
  if (value !== undefined) {
    if (typeof value === 'number' && value === value >> 0) {
      return value;
    }
    throw invalidArgValue(`options.${name}`, value);
  }
  return undefined;
}

function getDsaEncoding(options: unknown): 'der' | 'ieee-p1363' {
  if (record(options)) {
    const raw = options.dsaEncoding;
    const dsaEncoding = raw === undefined ? 'der' : raw;
    if (dsaEncoding === 'der' || dsaEncoding === 'ieee-p1363') {
      return dsaEncoding;
    }
    throw invalidArgValue('options.dsaEncoding', dsaEncoding);
  }
  return 'der';
}

function mgf1(
  hashName: 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512',
  seed: Uint8Array,
  maskLen: number,
): Uint8Array {
  const out = new Uint8Array(maskLen);
  const seedBuf = Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength);
  const counter = Buffer.alloc(4);
  let offset = 0;
  for (let c = 0; offset < maskLen; c++) {
    counter.writeUInt32BE(c, 0);
    const block = createShaHash(hashName).update(seedBuf).update(counter).digest();
    const take = Math.min(block.length, maskLen - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/**
 * Recovers the exact EMSA-PSS salt length from an RSA-PSS signature using the
 * public key `(n, e)` per RFC 8017 §9.1.2 so `RSA_PSS_SALTLEN_AUTO` (`-2` or
 * omitted in `crypto.verify`) can pass the exact numeric `saltLength` to
 * `crypto.subtle.verify`.
 */
function recoverRsaPssSaltLength(
  pub: RsaPublicData,
  signature: Uint8Array,
  digest: SignDigestInfo,
): number | undefined {
  const modulusBits = bitLengthBigInt(pub.n);
  const k = Math.ceil(modulusBits / 8);
  if (signature.byteLength !== k) return undefined;
  const s = bytesToBigInt(signature);
  if (s < 0n || s >= pub.n) return undefined;
  const m = modPow(s, pub.e, pub.n);
  const emBits = modulusBits - 1;
  if (emBits <= 0) return undefined;
  const emLen = Math.ceil(emBits / 8);
  if (emLen < digest.size + 2) return undefined;
  let em: Uint8Array;
  try {
    em = bigIntToUnsignedBytes(m, emLen);
  } catch {
    return undefined;
  }
  if (em[emLen - 1] !== 0xbc) return undefined;
  const dbLen = emLen - digest.size - 1;
  const maskedDb = em.subarray(0, dbLen);
  const h = em.subarray(dbLen, dbLen + digest.size);
  const topBits = 8 * emLen - emBits;
  const topMask = 0xff >>> topBits;
  if ((maskedDb[0] & ~topMask) !== 0) return undefined;
  const dbMask = mgf1(digest.shaName, h, dbLen);
  const db = new Uint8Array(dbLen);
  for (let i = 0; i < dbLen; i++) db[i] = maskedDb[i] ^ dbMask[i];
  db[0] &= topMask;
  let idx = 0;
  while (idx < dbLen && db[idx] === 0x00) idx++;
  if (idx >= dbLen || db[idx] !== 0x01) return undefined;
  return dbLen - (idx + 1);
}

const ERR_KEYTYPE_UNSUPPORTED =
  'error:03000096:digital envelope routines::operation not supported for this keytype';
const ERR_INVALID_DIGEST_PROVIDER = 'error:1C80007A:Provider routines::invalid digest';
const ERR_DIGEST_NOT_ALLOWED = 'error:1C8000AE:Provider routines::digest not allowed';
const ERR_ILLEGAL_PADDING = 'error:1C8000A5:Provider routines::illegal or unsupported padding mode';
const ERR_PSS_SALTLEN_TOO_SMALL = 'error:1C8000AC:Provider routines::pss saltlen too small';
const ERR_DATA_TOO_LARGE = 'error:0200006E:rsa routines::data too large for key size';

function resolveRsaSignOrVerifyPlan(
  keyKind: 'rsa' | 'rsa-pss',
  modulusBits: number,
  pssConstraint: RsaPublicData['pss'],
  explicitDigest: SignDigestInfo | undefined,
  rsaPadding: number | undefined,
  pssSaltLength: number | undefined,
  mode: 'sign' | 'verify',
): {
  usePss: boolean;
  digest: SignDigestInfo;
  saltLength: number | 'auto';
} {
  if (keyKind === 'rsa-pss') {
    const defaultDigestName = pssConstraint?.hashAlgorithm ?? 'sha256';
    const digest = explicitDigest ?? resolveSignDigest(defaultDigestName);
    if (pssConstraint?.hashAlgorithm && pssConstraint.hashAlgorithm !== digest.shaName) {
      throw new Error(ERR_DIGEST_NOT_ALLOWED);
    }
    if (rsaPadding !== undefined && rsaPadding !== RSA_PKCS1_PSS_PADDING) {
      throw new Error(ERR_ILLEGAL_PADDING);
    }
    if (pssConstraint?.mgf1HashAlgorithm && pssConstraint.mgf1HashAlgorithm !== digest.shaName) {
      throw fault(
        'ENOSYS',
        'RSA-PSS keys with MGF1 hash differing from message hash are unsupported in WebCrypto',
      );
    }
    const maxSalt = Math.ceil((modulusBits - 1) / 8) - digest.size - 2;
    let resolvedSalt: number | 'auto';
    if (pssSaltLength === undefined) {
      if (mode === 'sign') {
        resolvedSalt = pssConstraint?.saltLength ?? maxSalt;
      } else {
        resolvedSalt = pssConstraint?.saltLength ?? 'auto';
      }
    } else if (pssSaltLength === RSA_PSS_SALTLEN_DIGEST) {
      resolvedSalt = digest.size;
    } else if (pssSaltLength === RSA_PSS_SALTLEN_MAX_SIGN) {
      resolvedSalt = mode === 'sign' ? maxSalt : 'auto';
    } else if (pssSaltLength < -2) {
      throw new Error(ERR_PSS_SALTLEN_TOO_SMALL);
    } else {
      resolvedSalt = pssSaltLength;
    }
    if (typeof resolvedSalt === 'number') {
      if (pssConstraint?.saltLength !== undefined && resolvedSalt < pssConstraint.saltLength) {
        throw new Error(ERR_PSS_SALTLEN_TOO_SMALL);
      }
      if (resolvedSalt > maxSalt) {
        throw new Error(ERR_DATA_TOO_LARGE);
      }
    }
    return { usePss: true, digest, saltLength: resolvedSalt };
  }

  // keyKind === 'rsa'
  const digest = explicitDigest ?? SIGN_DIGESTS.sha256;
  const padding = rsaPadding ?? RSA_PKCS1_PADDING;
  if (padding === RSA_PKCS1_PADDING) {
    return { usePss: false, digest, saltLength: 0 };
  }
  if (padding !== RSA_PKCS1_PSS_PADDING) {
    throw new Error(ERR_ILLEGAL_PADDING);
  }
  const maxSalt = Math.ceil((modulusBits - 1) / 8) - digest.size - 2;
  let resolvedSalt: number | 'auto';
  if (pssSaltLength === undefined) {
    resolvedSalt = mode === 'sign' ? maxSalt : 'auto';
  } else if (pssSaltLength === RSA_PSS_SALTLEN_DIGEST) {
    resolvedSalt = digest.size;
  } else if (pssSaltLength === RSA_PSS_SALTLEN_MAX_SIGN) {
    resolvedSalt = mode === 'sign' ? maxSalt : 'auto';
  } else if (pssSaltLength < -2) {
    throw new Error(ERR_PSS_SALTLEN_TOO_SMALL);
  } else {
    resolvedSalt = pssSaltLength;
  }
  if (typeof resolvedSalt === 'number' && resolvedSalt > maxSalt) {
    throw new Error(ERR_DATA_TOO_LARGE);
  }
  return { usePss: true, digest, saltLength: resolvedSalt };
}

async function executeWebCryptoSign(
  inspected: ReturnType<typeof inspectKeyObjectSlot>,
  explicitDigest: SignDigestInfo | undefined,
  dataBytes: Uint8Array<ArrayBuffer>,
  rsaPadding: number | undefined,
  pssSaltLength: number | undefined,
  dsaEncoding: 'der' | 'ieee-p1363',
): Promise<Buffer> {
  if (fipsEnabled()) {
    throw new Error(ERR_KEYTYPE_UNSUPPORTED);
  }
  const subtle = globalThis.crypto.subtle;
  const priv = inspected.privateData;
  const keyKind = priv?.kind ?? inspected.nonExtractableType;

  if (!keyKind || keyKind === 'x25519' || keyKind === 'dh') {
    throw new Error(ERR_KEYTYPE_UNSUPPORTED);
  }

  if (keyKind === 'ed25519') {
    if (explicitDigest !== undefined) {
      throw new Error(ERR_INVALID_DIGEST_PROVIDER);
    }
    let ck: CryptoKey;
    if (priv && priv.kind === 'ed25519') {
      const pkcs8 = encodePrivateKeyDer(priv, 'pkcs8');
      ck = await subtle.importKey('pkcs8', toBufferSource(pkcs8), { name: 'Ed25519' }, false, [
        'sign',
      ]);
    } else if (inspected.cryptoKey) {
      ck = inspected.cryptoKey;
    } else {
      throw new Error(ERR_KEYTYPE_UNSUPPORTED);
    }
    const sig = await subtle.sign({ name: 'Ed25519' }, ck, dataBytes);
    return Buffer.from(sig);
  }

  if (keyKind === 'ec') {
    const digest = explicitDigest ?? SIGN_DIGESTS.sha256;
    const detailCurve = inspected.nonExtractableDetails?.namedCurve;
    const namedCurve: EcCurveName | undefined =
      priv && priv.kind === 'ec'
        ? priv.namedCurve
        : typeof detailCurve === 'string' && detailCurve in EC_CURVE_INFO
          ? (detailCurve as EcCurveName) // Safe: `detailCurve in EC_CURVE_INFO` narrows to EcCurveName.
          : undefined;
    if (!namedCurve) {
      throw new Error(ERR_KEYTYPE_UNSUPPORTED);
    }
    const curveInfo = EC_CURVE_INFO[namedCurve];
    let ck: CryptoKey;
    if (priv && priv.kind === 'ec') {
      const pkcs8 = encodePrivateKeyDer(priv, 'pkcs8');
      ck = await subtle.importKey(
        'pkcs8',
        toBufferSource(pkcs8),
        { name: 'ECDSA', namedCurve: curveInfo.jwkCrv },
        false,
        ['sign'],
      );
    } else if (inspected.cryptoKey) {
      ck = inspected.cryptoKey;
    } else {
      throw new Error(ERR_KEYTYPE_UNSUPPORTED);
    }
    const rawSig = new Uint8Array(
      await subtle.sign({ name: 'ECDSA', hash: digest.webHash }, ck, dataBytes),
    );
    if (dsaEncoding === 'ieee-p1363') return Buffer.from(rawSig);
    return ecdsaP1363ToDer(rawSig, curveInfo.coordBytes);
  }

  // RSA or RSA-PSS
  const rsaPriv: RsaPrivateData | undefined =
    priv && (priv.kind === 'rsa' || priv.kind === 'rsa-pss') ? priv : undefined;
  const modulusBits = rsaPriv
    ? bitLengthBigInt(rsaPriv.n)
    : Number(inspected.nonExtractableDetails?.modulusLength ?? 2048);
  const plan = resolveRsaSignOrVerifyPlan(
    keyKind,
    modulusBits,
    rsaPriv?.pss,
    explicitDigest,
    rsaPadding,
    pssSaltLength,
    'sign',
  );
  let ck: CryptoKey;
  if (rsaPriv) {
    // Chromium's SubtleCrypto PKCS#8 importer requires the rsaEncryption OID.
    const normalizedForImport: ParsedPrivateKey = { ...rsaPriv, kind: 'rsa', pss: undefined };
    const pkcs8 = encodePrivateKeyDer(normalizedForImport, 'pkcs8');
    ck = await subtle.importKey(
      'pkcs8',
      toBufferSource(pkcs8),
      { name: plan.usePss ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5', hash: plan.digest.webHash },
      false,
      ['sign'],
    );
  } else if (inspected.cryptoKey) {
    ck = inspected.cryptoKey;
  } else {
    throw new Error(ERR_KEYTYPE_UNSUPPORTED);
  }
  const signAlg = plan.usePss
    ? // Safe: resolveRsaSignOrVerifyPlan(..., 'sign') always resolves saltLength to a number, never 'auto'.
      { name: 'RSA-PSS', saltLength: plan.saltLength as number }
    : { name: 'RSASSA-PKCS1-v1_5' };
  const sig = await subtle.sign(signAlg, ck, dataBytes);
  return Buffer.from(sig);
}

async function executeWebCryptoVerify(
  inspected: ReturnType<typeof inspectKeyObjectSlot>,
  explicitDigest: SignDigestInfo | undefined,
  dataBytes: Uint8Array<ArrayBuffer>,
  sigBytes: Uint8Array<ArrayBuffer>,
  rsaPadding: number | undefined,
  pssSaltLength: number | undefined,
  dsaEncoding: 'der' | 'ieee-p1363',
): Promise<boolean> {
  if (fipsEnabled()) {
    throw new Error(ERR_KEYTYPE_UNSUPPORTED);
  }
  const subtle = globalThis.crypto.subtle;
  const pub: ParsedPublicKey | undefined =
    inspected.publicData ??
    (inspected.privateData
      ? publicFromPrivateData(inspected.privateData)
      : inspected.pairedPublicData);
  const verifyCk =
    inspected.cryptoKey?.type === 'public' ? inspected.cryptoKey : inspected.pairedPublicCryptoKey;
  const keyKind = pub?.kind ?? inspected.nonExtractableType;

  if (!keyKind || keyKind === 'x25519' || keyKind === 'dh') {
    throw new Error(ERR_KEYTYPE_UNSUPPORTED);
  }

  if (keyKind === 'ed25519') {
    if (explicitDigest !== undefined) {
      throw new Error(ERR_INVALID_DIGEST_PROVIDER);
    }
    let ck: CryptoKey;
    if (pub && pub.kind === 'ed25519') {
      const spki = encodePublicKeyDer(pub, 'spki');
      ck = await subtle.importKey('spki', toBufferSource(spki), { name: 'Ed25519' }, false, [
        'verify',
      ]);
    } else if (verifyCk) {
      ck = verifyCk;
    } else {
      throw fault(
        'ENOSYS',
        'Verifying with an uncaptured non-extractable private CryptoKey is unsupported',
      );
    }
    return subtle.verify({ name: 'Ed25519' }, ck, sigBytes, dataBytes);
  }

  if (keyKind === 'ec') {
    const digest = explicitDigest ?? SIGN_DIGESTS.sha256;
    const detailCurve = inspected.nonExtractableDetails?.namedCurve;
    const namedCurve: EcCurveName | undefined =
      pub && pub.kind === 'ec'
        ? pub.namedCurve
        : typeof detailCurve === 'string' && detailCurve in EC_CURVE_INFO
          ? (detailCurve as EcCurveName) // Safe: `detailCurve in EC_CURVE_INFO` narrows to EcCurveName.
          : undefined;
    if (!namedCurve) {
      throw new Error(ERR_KEYTYPE_UNSUPPORTED);
    }
    const curveInfo = EC_CURVE_INFO[namedCurve];
    let p1363Sig: Uint8Array<ArrayBuffer>;
    if (dsaEncoding === 'der') {
      const decoded = ecdsaDerToP1363(sigBytes, curveInfo.coordBytes);
      if (!decoded) return false;
      p1363Sig = toBufferSource(decoded);
    } else {
      if (sigBytes.byteLength !== curveInfo.coordBytes * 2) return false;
      p1363Sig = sigBytes;
    }
    let ck: CryptoKey;
    if (pub && pub.kind === 'ec') {
      const spki = encodePublicKeyDer(pub, 'spki');
      ck = await subtle.importKey(
        'spki',
        toBufferSource(spki),
        { name: 'ECDSA', namedCurve: curveInfo.jwkCrv },
        false,
        ['verify'],
      );
    } else if (verifyCk) {
      ck = verifyCk;
    } else {
      throw fault(
        'ENOSYS',
        'Verifying with an uncaptured non-extractable private CryptoKey is unsupported',
      );
    }
    return subtle.verify({ name: 'ECDSA', hash: digest.webHash }, ck, p1363Sig, dataBytes);
  }

  // RSA or RSA-PSS
  const rsaPub: RsaPublicData | undefined =
    pub && (pub.kind === 'rsa' || pub.kind === 'rsa-pss') ? pub : undefined;
  const modulusBits = rsaPub
    ? bitLengthBigInt(rsaPub.n)
    : Number(inspected.nonExtractableDetails?.modulusLength ?? 2048);
  const plan = resolveRsaSignOrVerifyPlan(
    keyKind,
    modulusBits,
    rsaPub?.pss,
    explicitDigest,
    rsaPadding,
    pssSaltLength,
    'verify',
  );

  let numericSaltLen: number;
  if (plan.usePss) {
    if (plan.saltLength === 'auto') {
      if (!rsaPub) {
        throw fault(
          'ENOSYS',
          'RSA_PSS_SALTLEN_AUTO verification on a non-extractable CryptoKey requires explicit saltLength',
        );
      }
      const recovered = recoverRsaPssSaltLength(rsaPub, sigBytes, plan.digest);
      if (recovered === undefined) return false;
      if (rsaPub.pss?.saltLength !== undefined && recovered < rsaPub.pss.saltLength) {
        return false;
      }
      numericSaltLen = recovered;
    } else {
      numericSaltLen = plan.saltLength;
    }
  } else {
    numericSaltLen = 0;
  }

  let ck: CryptoKey;
  if (rsaPub) {
    const normalizedForImport: ParsedPublicKey = { ...rsaPub, kind: 'rsa', pss: undefined };
    const spki = encodePublicKeyDer(normalizedForImport, 'spki');
    ck = await subtle.importKey(
      'spki',
      toBufferSource(spki),
      { name: plan.usePss ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5', hash: plan.digest.webHash },
      false,
      ['verify'],
    );
  } else if (verifyCk) {
    ck = verifyCk;
  } else {
    throw fault(
      'ENOSYS',
      'Verifying with an uncaptured non-extractable private CryptoKey is unsupported',
    );
  }
  const verifyAlg = plan.usePss
    ? { name: 'RSA-PSS', saltLength: numericSaltLen }
    : { name: 'RSASSA-PKCS1-v1_5' };
  return subtle.verify(verifyAlg, ck, sigBytes, dataBytes);
}

export function createSignVerify(retain: () => () => void) {
  function signOneShot(algorithm: unknown, data: unknown, key: unknown, callback?: unknown): void {
    let algStr: string | undefined;
    if (algorithm != null) {
      algStr = validateString(algorithm, 'algorithm');
    }
    if (callback !== undefined && typeof callback !== 'function') {
      throw invalidArgType('callback', 'of type function', callback);
    }
    let rawData: Uint8Array;
    if (typeof data === 'string') {
      rawData = stringBytes(data, undefined);
    } else {
      const view = viewBytes(data);
      if (view === undefined) throw invalidArgType('data', dataInputTypes, data);
      rawData = view;
    }
    if (!key) {
      throw Object.assign(new Error('No key provided to sign'), {
        code: 'ERR_CRYPTO_SIGN_KEY_REQUIRED',
      });
    }
    const rsaPadding = getIntOption('padding', key);
    const pssSaltLength = getIntOption('saltLength', key);
    const dsaEncoding = getDsaEncoding(key);
    const { keyObject } = resolvePrivateForSign(key);
    const explicitDigest = algStr !== undefined ? resolveSignDigest(algStr) : undefined;

    if (callback === undefined) {
      throw fault(
        'ENOSYS',
        'Synchronous crypto.sign is unsupported in the browser WebCrypto runtime; pass a callback',
      );
    }

    const dataCopy = toBufferSource(rawData);
    const inspected = inspectKeyObjectSlot(keyObject);
    // Safe: callback !== undefined && typeof callback === 'function' was verified above.
    const done = captured(
      callback as (this: object, err: Error | null, signature?: Buffer) => void,
    );
    const release = retain();
    const job = {};

    executeWebCryptoSign(
      inspected,
      explicitDigest,
      dataCopy,
      rsaPadding,
      pssSaltLength,
      dsaEncoding,
    ).then(
      (sig) => {
        queueMicrotask(() => {
          try {
            Reflect.apply(done, job, [null, sig]);
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
  }

  function verifyOneShot(
    algorithm: unknown,
    data: unknown,
    key: unknown,
    signature: unknown,
    callback?: unknown,
  ): void {
    let algStr: string | undefined;
    if (algorithm != null) {
      algStr = validateString(algorithm, 'algorithm');
    }
    if (callback !== undefined && typeof callback !== 'function') {
      throw invalidArgType('callback', 'of type function', callback);
    }
    let rawData: Uint8Array;
    if (typeof data === 'string') {
      rawData = stringBytes(data, undefined);
    } else if (ArrayBuffer.isView(data)) {
      rawData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
      throw invalidArgType('data', viewOnlyTypes, data);
    } else {
      throw invalidArgType('data', dataInputTypes, data);
    }
    const rsaPadding = getIntOption('padding', key);
    const pssSaltLength = getIntOption('saltLength', key);
    const dsaEncoding = getDsaEncoding(key);
    if (!ArrayBuffer.isView(signature)) {
      throw invalidArgType('signature', viewOnlyTypes, signature);
    }
    const rawSig = new Uint8Array(signature.buffer, signature.byteOffset, signature.byteLength);
    const { keyObject } = resolvePublicOrPrivateForVerify(key);
    const explicitDigest = algStr !== undefined ? resolveSignDigest(algStr) : undefined;

    if (callback === undefined) {
      throw fault(
        'ENOSYS',
        'Synchronous crypto.verify is unsupported in the browser WebCrypto runtime; pass a callback',
      );
    }

    const dataCopy = toBufferSource(rawData);
    const sigCopy = toBufferSource(rawSig);
    const inspected = inspectKeyObjectSlot(keyObject);
    // Safe: callback !== undefined && typeof callback === 'function' was verified above.
    const done = captured(callback as (this: object, err: Error | null, result?: boolean) => void);
    const release = retain();
    const job = {};

    executeWebCryptoVerify(
      inspected,
      explicitDigest,
      dataCopy,
      sigCopy,
      rsaPadding,
      pssSaltLength,
      dsaEncoding,
    ).then(
      (ok) => {
        queueMicrotask(() => {
          try {
            Reflect.apply(done, job, [null, ok]);
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
  }

  Object.defineProperty(signOneShot, 'length', { value: 4, configurable: true });
  Object.defineProperty(signOneShot, 'name', { value: 'signOneShot', configurable: true });
  Object.defineProperty(verifyOneShot, 'length', { value: 5, configurable: true });
  Object.defineProperty(verifyOneShot, 'name', { value: 'verifyOneShot', configurable: true });

  return {
    sign: signOneShot,
    verify: verifyOneShot,
  };
}
