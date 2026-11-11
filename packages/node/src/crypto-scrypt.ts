import { Buffer } from 'buffer';
import createShaHash from 'sha.js';
import { captured } from './context-hook';
import { invalidArgType, stringBytes, typeList, validateInteger, viewBytes } from './crypto-args';
import { fipsEnabled } from './crypto-fips';

// RFC 7914 scrypt (Salsa20/8 + PBKDF2-HMAC-SHA256) matching Node 22.18.0
// lib/internal/crypto/scrypt.js and OpenSSL 3 providers/implementations/kdfs/scrypt.c.

const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;
const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const DEFAULT_MAXMEM = 32 * 1024 * 1024; // 32 MiB (SCRYPT_MAX_MEM)

const DEFAULTS: unique symbol = Symbol('scryptDefaults');

const byteTypes = typeList(['string'], ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView']);

function byteSource(value: unknown, name: string): Uint8Array {
  if (typeof value === 'string') return stringBytes(value, undefined);
  const bytes = viewBytes(value);
  if (bytes === undefined) throw invalidArgType(name, byteTypes, value);
  return bytes;
}

function invalidScryptParameter(): Error {
  return Object.assign(new Error('Invalid scrypt parameter'), {
    code: 'ERR_CRYPTO_SCRYPT_INVALID_PARAMETER',
  });
}

function invalidScryptParams(detail?: string): RangeError {
  const message =
    detail === undefined ? 'Invalid scrypt params' : `Invalid scrypt params: ${detail}`;
  return Object.assign(new RangeError(message), {
    code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS',
  });
}

interface CheckedScrypt {
  password: Uint8Array;
  salt: Uint8Array;
  keylen: number;
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

function check(password: unknown, salt: unknown, keylen: unknown, options: unknown): CheckedScrypt {
  const passwordBytes = byteSource(password, 'password');
  const saltBytes = byteSource(salt, 'salt');
  const derivedLen = validateInteger(keylen, 'keylen', 0, INT32_MAX);

  let N = DEFAULT_N;
  let r = DEFAULT_R;
  let p = DEFAULT_P;
  let maxmem = DEFAULT_MAXMEM;

  if (Boolean(options) && options !== DEFAULTS) {
    const opts: object = Object(options);
    const optN: unknown = Reflect.get(opts, 'N');
    const optCost: unknown = Reflect.get(opts, 'cost');
    const optR: unknown = Reflect.get(opts, 'r');
    const optBlockSize: unknown = Reflect.get(opts, 'blockSize');
    const optP: unknown = Reflect.get(opts, 'p');
    const optParallelization: unknown = Reflect.get(opts, 'parallelization');
    const optMaxmem: unknown = Reflect.get(opts, 'maxmem');

    const hasN = optN !== undefined;
    if (hasN) {
      N = validateInteger(optN, 'N', 0, UINT32_MAX);
    }
    if (optCost !== undefined) {
      if (hasN) throw invalidScryptParameter();
      N = validateInteger(optCost, 'cost', 0, UINT32_MAX);
    }
    const hasR = optR !== undefined;
    if (hasR) {
      r = validateInteger(optR, 'r', 0, UINT32_MAX);
    }
    if (optBlockSize !== undefined) {
      if (hasR) throw invalidScryptParameter();
      r = validateInteger(optBlockSize, 'blockSize', 0, UINT32_MAX);
    }
    const hasP = optP !== undefined;
    if (hasP) {
      p = validateInteger(optP, 'p', 0, UINT32_MAX);
    }
    if (optParallelization !== undefined) {
      if (hasP) throw invalidScryptParameter();
      p = validateInteger(optParallelization, 'parallelization', 0, UINT32_MAX);
    }
    if (optMaxmem !== undefined) {
      maxmem = validateInteger(optMaxmem, 'maxmem', 0, Number.MAX_SAFE_INTEGER);
    }
    if (N === 0) N = DEFAULT_N;
    if (r === 0) r = DEFAULT_R;
    if (p === 0) p = DEFAULT_P;
    if (maxmem === 0) maxmem = DEFAULT_MAXMEM;
  }

  return { password: passwordBytes, salt: saltBytes, keylen: derivedLen, N, r, p, maxmem };
}

function validateScryptJobParams(N: number, r: number, p: number, maxmem: number): void {
  if (fipsEnabled()) {
    throw invalidScryptParams('error:0308010C:digital envelope routines::unsupported');
  }
  // OpenSSL 3 scrypt_alg checks: N > 1 power of 2, p * 128 * r <= (2^32 - 1) * 32,
  // log2(N) < 16 * r, and B + XY + V <= maxmem (128*r*p + 256*r + 128*r*N <= maxmem).
  if (N <= 1 || (N & (N - 1)) !== 0 || r < 1 || p < 1) {
    throw invalidScryptParams();
  }
  if (p > Math.floor((UINT32_MAX * 32) / (128 * r))) {
    throw invalidScryptParams();
  }
  if (16 * r <= 52 && N >= 2 ** (16 * r)) {
    throw invalidScryptParams();
  }
  const requiredMem =
    BigInt(128) * BigInt(r) * BigInt(N) +
    BigInt(256) * BigInt(r) +
    BigInt(128) * BigInt(r) * BigInt(p);
  if (requiredMem > BigInt(maxmem)) {
    throw invalidScryptParams('error:030000AC:digital envelope routines::memory limit exceeded');
  }
}

/** Single-iteration PBKDF2-HMAC-SHA256 (c = 1) used at the start and end of RFC 7914 scrypt. */
function pbkdf2Sha256Single(password: Uint8Array, salt: Uint8Array, outLen: number): Buffer {
  const out = Buffer.alloc(outLen);
  if (outLen === 0) return out;

  const pwBuf = Buffer.from(password.buffer, password.byteOffset, password.byteLength);
  const keyBytes =
    password.byteLength > 64 ? createShaHash('sha256').update(pwBuf).digest() : pwBuf;
  const innerPad = Buffer.alloc(64, 0x36);
  const outerPad = Buffer.alloc(64, 0x5c);
  for (let i = 0; i < keyBytes.length; i++) {
    innerPad[i] ^= keyBytes[i];
    outerPad[i] ^= keyBytes[i];
  }

  const saltBuf = Buffer.from(salt.buffer, salt.byteOffset, salt.byteLength);
  const counterBuf = Buffer.alloc(4);

  for (let block = 1, offset = 0; offset < outLen; block++, offset += 32) {
    counterBuf.writeUInt32BE(block, 0);
    const innerDigest = createShaHash('sha256')
      .update(innerPad)
      .update(saltBuf)
      .update(counterBuf)
      .digest();
    const mac = createShaHash('sha256').update(outerPad).update(innerDigest).digest();
    const take = Math.min(32, outLen - offset);
    mac.copy(out, offset, 0, take);
  }
  return out;
}

/** In-place Salsa20/8 core on 16 uint32 words (RFC 7914 §3). */
function salsa20Core8(b: Uint32Array): void {
  let x0 = b[0];
  let x1 = b[1];
  let x2 = b[2];
  let x3 = b[3];
  let x4 = b[4];
  let x5 = b[5];
  let x6 = b[6];
  let x7 = b[7];
  let x8 = b[8];
  let x9 = b[9];
  let x10 = b[10];
  let x11 = b[11];
  let x12 = b[12];
  let x13 = b[13];
  let x14 = b[14];
  let x15 = b[15];

  for (let round = 0; round < 4; round++) {
    let u = (x0 + x12) | 0;
    x4 ^= (u << 7) | (u >>> 25);
    u = (x4 + x0) | 0;
    x8 ^= (u << 9) | (u >>> 23);
    u = (x8 + x4) | 0;
    x12 ^= (u << 13) | (u >>> 19);
    u = (x12 + x8) | 0;
    x0 ^= (u << 18) | (u >>> 14);

    u = (x5 + x1) | 0;
    x9 ^= (u << 7) | (u >>> 25);
    u = (x9 + x5) | 0;
    x13 ^= (u << 9) | (u >>> 23);
    u = (x13 + x9) | 0;
    x1 ^= (u << 13) | (u >>> 19);
    u = (x1 + x13) | 0;
    x5 ^= (u << 18) | (u >>> 14);

    u = (x10 + x6) | 0;
    x14 ^= (u << 7) | (u >>> 25);
    u = (x14 + x10) | 0;
    x2 ^= (u << 9) | (u >>> 23);
    u = (x2 + x14) | 0;
    x6 ^= (u << 13) | (u >>> 19);
    u = (x6 + x2) | 0;
    x10 ^= (u << 18) | (u >>> 14);

    u = (x15 + x11) | 0;
    x3 ^= (u << 7) | (u >>> 25);
    u = (x3 + x15) | 0;
    x7 ^= (u << 9) | (u >>> 23);
    u = (x7 + x3) | 0;
    x11 ^= (u << 13) | (u >>> 19);
    u = (x11 + x7) | 0;
    x15 ^= (u << 18) | (u >>> 14);

    u = (x0 + x3) | 0;
    x1 ^= (u << 7) | (u >>> 25);
    u = (x1 + x0) | 0;
    x2 ^= (u << 9) | (u >>> 23);
    u = (x2 + x1) | 0;
    x3 ^= (u << 13) | (u >>> 19);
    u = (x3 + x2) | 0;
    x0 ^= (u << 18) | (u >>> 14);

    u = (x5 + x4) | 0;
    x6 ^= (u << 7) | (u >>> 25);
    u = (x6 + x5) | 0;
    x7 ^= (u << 9) | (u >>> 23);
    u = (x7 + x6) | 0;
    x4 ^= (u << 13) | (u >>> 19);
    u = (x4 + x7) | 0;
    x5 ^= (u << 18) | (u >>> 14);

    u = (x10 + x9) | 0;
    x11 ^= (u << 7) | (u >>> 25);
    u = (x11 + x10) | 0;
    x8 ^= (u << 9) | (u >>> 23);
    u = (x8 + x11) | 0;
    x9 ^= (u << 13) | (u >>> 19);
    u = (x9 + x8) | 0;
    x10 ^= (u << 18) | (u >>> 14);

    u = (x15 + x14) | 0;
    x12 ^= (u << 7) | (u >>> 25);
    u = (x12 + x15) | 0;
    x13 ^= (u << 9) | (u >>> 23);
    u = (x13 + x12) | 0;
    x14 ^= (u << 13) | (u >>> 19);
    u = (x14 + x13) | 0;
    x15 ^= (u << 18) | (u >>> 14);
  }

  b[0] = (b[0] + x0) >>> 0;
  b[1] = (b[1] + x1) >>> 0;
  b[2] = (b[2] + x2) >>> 0;
  b[3] = (b[3] + x3) >>> 0;
  b[4] = (b[4] + x4) >>> 0;
  b[5] = (b[5] + x5) >>> 0;
  b[6] = (b[6] + x6) >>> 0;
  b[7] = (b[7] + x7) >>> 0;
  b[8] = (b[8] + x8) >>> 0;
  b[9] = (b[9] + x9) >>> 0;
  b[10] = (b[10] + x10) >>> 0;
  b[11] = (b[11] + x11) >>> 0;
  b[12] = (b[12] + x12) >>> 0;
  b[13] = (b[13] + x13) >>> 0;
  b[14] = (b[14] + x14) >>> 0;
  b[15] = (b[15] + x15) >>> 0;
}

/** RFC 7914 §4 scryptBlockMix from `src` (32*r words) into `dst` (32*r words). */
function blockMix(src: Uint32Array, dst: Uint32Array, r: number, scratch: Uint32Array): void {
  const lastBlockOffset = (2 * r - 1) * 16;
  for (let k = 0; k < 16; k++) {
    scratch[k] = src[lastBlockOffset + k];
  }
  for (let i = 0; i < 2 * r; i++) {
    const srcOff = i * 16;
    for (let k = 0; k < 16; k++) {
      scratch[k] ^= src[srcOff + k];
    }
    salsa20Core8(scratch);
    const dstOff = ((i & 1) === 0 ? i >>> 1 : r + (i >>> 1)) * 16;
    for (let k = 0; k < 16; k++) {
      dst[dstOff + k] = scratch[k];
    }
  }
}

function deriveScrypt(
  password: Uint8Array,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  keylen: number,
): Buffer {
  if (keylen === 0) return Buffer.alloc(0);

  const blockBytes = 128 * r;
  const blockWords = 32 * r;
  const bBytes = pbkdf2Sha256Single(password, salt, p * blockBytes);

  const V = new Uint32Array(blockWords * N);
  const X = new Uint32Array(blockWords);
  const Y = new Uint32Array(blockWords);
  const scratch = new Uint32Array(16);
  const mask = N - 1;
  const intOffset = (2 * r - 1) * 16;

  for (let lane = 0; lane < p; lane++) {
    const laneByteOff = lane * blockBytes;
    for (let w = 0; w < blockWords; w++) {
      const idx = laneByteOff + w * 4;
      X[w] =
        (bBytes[idx] |
          (bBytes[idx + 1] << 8) |
          (bBytes[idx + 2] << 16) |
          (bBytes[idx + 3] << 24)) >>>
        0;
    }

    // N >= 2 is a power of 2, so N is always even: unroll pairs X -> Y -> X.
    for (let i = 0; i < N; i += 2) {
      V.set(X, i * blockWords);
      blockMix(X, Y, r, scratch);
      V.set(Y, (i + 1) * blockWords);
      blockMix(Y, X, r, scratch);
    }

    for (let i = 0; i < N; i += 2) {
      const j0 = (X[intOffset] & mask) >>> 0;
      const vOff0 = j0 * blockWords;
      for (let k = 0; k < blockWords; k++) X[k] ^= V[vOff0 + k];
      blockMix(X, Y, r, scratch);

      const j1 = (Y[intOffset] & mask) >>> 0;
      const vOff1 = j1 * blockWords;
      for (let k = 0; k < blockWords; k++) Y[k] ^= V[vOff1 + k];
      blockMix(Y, X, r, scratch);
    }

    for (let w = 0; w < blockWords; w++) {
      const word = X[w];
      const idx = laneByteOff + w * 4;
      bBytes[idx] = word & 0xff;
      bBytes[idx + 1] = (word >>> 8) & 0xff;
      bBytes[idx + 2] = (word >>> 16) & 0xff;
      bBytes[idx + 3] = (word >>> 24) & 0xff;
    }
  }

  return pbkdf2Sha256Single(password, bBytes, keylen);
}

export function scryptSync(
  password: unknown,
  salt: unknown,
  keylen: unknown,
  options: unknown = DEFAULTS,
): Buffer {
  const params = check(password, salt, keylen, options);
  validateScryptJobParams(params.N, params.r, params.p, params.maxmem);
  return deriveScrypt(params.password, params.salt, params.N, params.r, params.p, params.keylen);
}

export function createScrypt(retain: () => () => void, schedule: (callback: () => void) => void) {
  function scrypt(
    password: unknown,
    salt: unknown,
    keylen: unknown,
    options: unknown,
    callback: unknown = DEFAULTS,
  ): void {
    let actualOptions = options;
    let actualCallback = callback;
    if (actualCallback === DEFAULTS) {
      actualCallback = actualOptions;
      actualOptions = DEFAULTS;
    }
    const params = check(password, salt, keylen, actualOptions);
    if (typeof actualCallback !== 'function') {
      throw invalidArgType('callback', 'of type function', actualCallback);
    }
    validateScryptJobParams(params.N, params.r, params.p, params.maxmem);

    // Invariant: typeof actualCallback === 'function' was verified immediately above.
    const done = captured(
      actualCallback as (this: object, err: Error | null, derivedKey?: Buffer) => void,
    );
    const passwordCopy = Uint8Array.from(params.password);
    const saltCopy = Uint8Array.from(params.salt);
    const release = retain();
    const job = {};

    schedule(() => {
      let derived: Buffer | undefined;
      let failure: Error | null = null;
      try {
        derived = deriveScrypt(passwordCopy, saltCopy, params.N, params.r, params.p, params.keylen);
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

  return { scrypt, scryptSync };
}
