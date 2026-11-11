import { Buffer } from 'buffer';
import type { Transform } from 'stream';
import { StringDecoder } from 'string_decoder/';
import {
  decodeText,
  invalidArgType,
  received,
  stringBytes,
  textEncoding,
  typeList,
  unknownEncoding,
  validateString,
  viewBytes,
} from './crypto-args';
import { timingSafeEqual } from './crypto-compare';
import { fipsDigestError, fipsEnabled } from './crypto-fips';
import { extractSecretKeyBytes } from './crypto-keys';
import {
  invalidArgValue,
  invalidArgType as nodeInvalidArgType,
  validateInteger as nodeValidateInteger,
  validateObject,
} from './node-errors';
import { fault } from './protocol';

// Symmetric ciphers (AES-128/192/256 CBC/CTR/GCM and ChaCha20-Poly1305)
// matching Node 22.18.0 lib/internal/crypto/cipher.js and OpenSSL 3 EVP.

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

type CipherMode = 'cbc' | 'ctr' | 'gcm' | 'chacha20-poly1305';

interface CipherSpec {
  /** Canonical name listed by getCiphers(). */
  canonical: string;
  /** Lowercase OpenSSL SN/LN name returned by getCipherInfo(). */
  infoName: string;
  /** OpenSSL NID returned by getCipherInfo(). */
  nid: number;
  mode: CipherMode;
  infoMode: 'cbc' | 'ctr' | 'gcm' | 'stream';
  keyLength: number;
  ivLength: number;
  blockSize?: number;
}

const CANONICAL_SPECS: readonly CipherSpec[] = [
  {
    canonical: 'aes-128-cbc',
    infoName: 'aes-128-cbc',
    nid: 419,
    mode: 'cbc',
    infoMode: 'cbc',
    keyLength: 16,
    ivLength: 16,
    blockSize: 16,
  },
  {
    canonical: 'aes-128-ctr',
    infoName: 'aes-128-ctr',
    nid: 904,
    mode: 'ctr',
    infoMode: 'ctr',
    keyLength: 16,
    ivLength: 16,
    blockSize: 1,
  },
  {
    canonical: 'aes-128-gcm',
    infoName: 'id-aes128-gcm',
    nid: 895,
    mode: 'gcm',
    infoMode: 'gcm',
    keyLength: 16,
    ivLength: 12,
    blockSize: 1,
  },
  {
    canonical: 'aes-192-cbc',
    infoName: 'aes-192-cbc',
    nid: 423,
    mode: 'cbc',
    infoMode: 'cbc',
    keyLength: 24,
    ivLength: 16,
    blockSize: 16,
  },
  {
    canonical: 'aes-192-ctr',
    infoName: 'aes-192-ctr',
    nid: 905,
    mode: 'ctr',
    infoMode: 'ctr',
    keyLength: 24,
    ivLength: 16,
    blockSize: 1,
  },
  {
    canonical: 'aes-192-gcm',
    infoName: 'id-aes192-gcm',
    nid: 898,
    mode: 'gcm',
    infoMode: 'gcm',
    keyLength: 24,
    ivLength: 12,
    blockSize: 1,
  },
  {
    canonical: 'aes-256-cbc',
    infoName: 'aes-256-cbc',
    nid: 427,
    mode: 'cbc',
    infoMode: 'cbc',
    keyLength: 32,
    ivLength: 16,
    blockSize: 16,
  },
  {
    canonical: 'aes-256-ctr',
    infoName: 'aes-256-ctr',
    nid: 906,
    mode: 'ctr',
    infoMode: 'ctr',
    keyLength: 32,
    ivLength: 16,
    blockSize: 1,
  },
  {
    canonical: 'aes-256-gcm',
    infoName: 'id-aes256-gcm',
    nid: 901,
    mode: 'gcm',
    infoMode: 'gcm',
    keyLength: 32,
    ivLength: 12,
    blockSize: 1,
  },
  {
    canonical: 'chacha20-poly1305',
    infoName: 'chacha20-poly1305',
    nid: 1018,
    mode: 'chacha20-poly1305',
    infoMode: 'stream',
    keyLength: 32,
    ivLength: 12,
  },
];

const BY_NAME = new Map<string, CipherSpec>();
const BY_NID = new Map<number, CipherSpec>();
for (const spec of CANONICAL_SPECS) {
  BY_NAME.set(spec.canonical, spec);
  BY_NAME.set(spec.infoName, spec);
  BY_NID.set(spec.nid, spec);
}
BY_NAME.set('aes128', BY_NAME.get('aes-128-cbc')!);
BY_NAME.set('aes192', BY_NAME.get('aes-192-cbc')!);
BY_NAME.set('aes256', BY_NAME.get('aes-256-cbc')!);

// OpenSSL 3 cipher names Node 22.18.0 knows that this runtime does not implement.
// Rejected with ENOSYS rather than ERR_CRYPTO_UNKNOWN_CIPHER per architecture policy.
const NATIVE_ONLY_CIPHERS = new Set(
  (
    'aes-128-ccm aes-128-cfb aes-128-cfb1 aes-128-cfb8 aes-128-ecb aes-128-ocb aes-128-ofb ' +
    'aes-128-wrap aes-128-wrap-inv aes-128-wrap-pad aes-128-wrap-pad-inv aes-128-xts ' +
    'aes-192-ccm aes-192-cfb aes-192-cfb1 aes-192-cfb8 aes-192-ecb aes-192-ocb aes-192-ofb ' +
    'aes-192-wrap aes-192-wrap-inv aes-192-wrap-pad aes-192-wrap-pad-inv ' +
    'aes-256-ccm aes-256-cfb aes-256-cfb1 aes-256-cfb8 aes-256-ecb aes-256-ocb aes-256-ofb ' +
    'aes-256-wrap aes-256-wrap-inv aes-256-wrap-pad aes-256-wrap-pad-inv aes-256-xts ' +
    'aes128-wrap aes192-wrap aes256-wrap ' +
    'aria-128-cbc aria-128-ccm aria-128-cfb aria-128-cfb1 aria-128-cfb8 aria-128-ctr aria-128-ecb ' +
    'aria-128-gcm aria-128-ofb aria-192-cbc aria-192-ccm aria-192-cfb aria-192-cfb1 aria-192-cfb8 ' +
    'aria-192-ctr aria-192-ecb aria-192-gcm aria-192-ofb aria-256-cbc aria-256-ccm aria-256-cfb ' +
    'aria-256-cfb1 aria-256-cfb8 aria-256-ctr aria-256-ecb aria-256-gcm aria-256-ofb ' +
    'aria128 aria192 aria256 bf bf-cbc bf-cfb bf-ecb bf-ofb blowfish ' +
    'camellia-128-cbc camellia-128-cfb camellia-128-cfb1 camellia-128-cfb8 camellia-128-ctr ' +
    'camellia-128-ecb camellia-128-ofb camellia-192-cbc camellia-192-cfb camellia-192-cfb1 ' +
    'camellia-192-cfb8 camellia-192-ctr camellia-192-ecb camellia-192-ofb camellia-256-cbc ' +
    'camellia-256-cfb camellia-256-cfb1 camellia-256-cfb8 camellia-256-ctr camellia-256-ecb ' +
    'camellia-256-ofb camellia128 camellia192 camellia256 cast cast-cbc cast5-cbc cast5-cfb ' +
    'cast5-ecb cast5-ofb chacha20 des des-cbc des-cfb des-cfb1 des-cfb8 des-ecb des-ede ' +
    'des-ede-cbc des-ede-cfb des-ede-ecb des-ede-ofb des-ede3 des-ede3-cbc des-ede3-cfb ' +
    'des-ede3-cfb1 des-ede3-cfb8 des-ede3-ecb des-ede3-ofb des-ofb des3 des3-wrap desx desx-cbc ' +
    'id-aes128-ccm id-aes128-wrap id-aes128-wrap-pad id-aes192-ccm id-aes192-wrap ' +
    'id-aes192-wrap-pad id-aes256-ccm id-aes256-wrap id-aes256-wrap-pad ' +
    'id-smime-alg-cms3deswrap idea idea-cbc idea-cfb idea-ecb idea-ofb ' +
    'rc2 rc2-128 rc2-40 rc2-40-cbc rc2-64 rc2-64-cbc rc2-cbc rc2-cfb rc2-ecb rc2-ofb ' +
    'rc4 rc4-40 rc4-hmac-md5 seed seed-cbc seed-cfb seed-ecb seed-ofb ' +
    'sm4 sm4-cbc sm4-cfb sm4-cfb1 sm4-cfb8 sm4-ctr sm4-ecb sm4-gcm sm4-ccm sm4-ofb'
  ).split(' '),
);

const GCM_TAG_LENGTHS = new Set([4, 8, 12, 13, 14, 15, 16]);

export function getCiphers(): string[] {
  return CANONICAL_SPECS.map((s) => s.canonical);
}

export function getCipherInfo(
  nameOrNid: unknown,
  options?: unknown,
): Record<string, unknown> | undefined {
  if (typeof nameOrNid !== 'string' && typeof nameOrNid !== 'number') {
    throw nodeInvalidArgType('nameOrNid', ['string', 'number'], nameOrNid);
  }
  if (typeof nameOrNid === 'number') {
    nodeValidateInteger(nameOrNid, 'nameOrNid', INT32_MIN, INT32_MAX);
  }
  let reqKeyLength: number | undefined;
  let reqIvLength: number | undefined;
  if (options !== undefined) {
    validateObject(options, 'options');
    if (options.keyLength !== undefined) {
      nodeValidateInteger(options.keyLength, 'options.keyLength', INT32_MIN, INT32_MAX);
      if (typeof options.keyLength === 'number') reqKeyLength = options.keyLength;
    }
    if (options.ivLength !== undefined) {
      nodeValidateInteger(options.ivLength, 'options.ivLength', INT32_MIN, INT32_MAX);
      if (typeof options.ivLength === 'number') reqIvLength = options.ivLength;
    }
  }

  const spec =
    typeof nameOrNid === 'number' ? BY_NID.get(nameOrNid) : BY_NAME.get(nameOrNid.toLowerCase());
  if (!spec) {
    if (typeof nameOrNid === 'string' && NATIVE_ONLY_CIPHERS.has(nameOrNid.toLowerCase())) {
      throw fault('ENOSYS', `Cipher ${nameOrNid} is outside the supported cipher set`);
    }
    return undefined;
  }

  if (reqKeyLength !== undefined && reqKeyLength !== spec.keyLength) {
    return undefined;
  }
  let effectiveIvLen = spec.ivLength;
  if (reqIvLength !== undefined) {
    if (spec.mode === 'gcm') {
      if (reqIvLength < 1 || reqIvLength > 128) return undefined;
      effectiveIvLen = reqIvLength;
    } else if (reqIvLength !== spec.ivLength) {
      return undefined;
    }
  }

  const info: Record<string, unknown> = {
    mode: spec.infoMode,
    name: spec.infoName,
    nid: spec.nid,
  };
  if (spec.blockSize !== undefined) info.blockSize = spec.blockSize;
  info.ivLength = effectiveIvLen;
  info.keyLength = spec.keyLength;
  return info;
}

// --- Lazy AES (FIPS 197) lookup tables ---

interface AesTables {
  sbox: Uint8Array;
  invSbox: Uint8Array;
  mul2: Uint8Array;
  mul3: Uint8Array;
  mul9: Uint8Array;
  mul11: Uint8Array;
  mul13: Uint8Array;
  mul14: Uint8Array;
}

let cachedAesTables: AesTables | undefined;

function gfMul(a: number, b: number): number {
  let p = 0;
  let x = a & 0xff;
  let y = b & 0xff;
  for (let i = 0; i < 8; i++) {
    if ((y & 1) !== 0) p ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xff;
    if (hi !== 0) x ^= 0x1b;
    y >>>= 1;
  }
  return p;
}

function getAesTables(): AesTables {
  if (cachedAesTables !== undefined) return cachedAesTables;
  const sbox = new Uint8Array(256);
  const invSbox = new Uint8Array(256);
  const mul2 = new Uint8Array(256);
  const mul3 = new Uint8Array(256);
  const mul9 = new Uint8Array(256);
  const mul11 = new Uint8Array(256);
  const mul13 = new Uint8Array(256);
  const mul14 = new Uint8Array(256);

  for (let a = 0; a < 256; a++) {
    // Multiplicative inverse in GF(2^8): a^254 (with 0 -> 0).
    let inv = a === 0 ? 0 : 1;
    let base = a;
    let exp = 254;
    while (exp > 0) {
      if ((exp & 1) !== 0) inv = gfMul(inv, base);
      base = gfMul(base, base);
      exp >>>= 1;
    }
    const rot1 = ((inv << 1) | (inv >>> 7)) & 0xff;
    const rot2 = ((inv << 2) | (inv >>> 6)) & 0xff;
    const rot3 = ((inv << 3) | (inv >>> 5)) & 0xff;
    const rot4 = ((inv << 4) | (inv >>> 4)) & 0xff;
    const s = (inv ^ rot1 ^ rot2 ^ rot3 ^ rot4 ^ 0x63) & 0xff;
    sbox[a] = s;
    invSbox[s] = a;

    mul2[a] = gfMul(a, 2);
    mul3[a] = gfMul(a, 3);
    mul9[a] = gfMul(a, 9);
    mul11[a] = gfMul(a, 11);
    mul13[a] = gfMul(a, 13);
    mul14[a] = gfMul(a, 14);
  }

  cachedAesTables = { sbox, invSbox, mul2, mul3, mul9, mul11, mul13, mul14 };
  return cachedAesTables;
}

interface AesSchedule {
  rk: Uint8Array;
  rounds: number;
  tables: AesTables;
}

function expandAesKey(key: Uint8Array): AesSchedule {
  const tables = getAesTables();
  const { sbox, mul2 } = tables;
  const nk = key.byteLength >>> 2; // 4, 6, or 8
  const rounds = nk + 6; // 10, 12, or 14
  const totalWords = 4 * (rounds + 1);
  const rk = new Uint8Array(totalWords * 4);
  rk.set(key);

  let rcon = 1;
  for (let w = nk; w < totalWords; w++) {
    const prevOff = (w - 1) * 4;
    let t0 = rk[prevOff];
    let t1 = rk[prevOff + 1];
    let t2 = rk[prevOff + 2];
    let t3 = rk[prevOff + 3];

    if (w % nk === 0) {
      const rot0 = sbox[t1] ^ rcon;
      const rot1 = sbox[t2];
      const rot2 = sbox[t3];
      const rot3 = sbox[t0];
      t0 = rot0;
      t1 = rot1;
      t2 = rot2;
      t3 = rot3;
      rcon = mul2[rcon];
    } else if (nk === 8 && w % 8 === 4) {
      t0 = sbox[t0];
      t1 = sbox[t1];
      t2 = sbox[t2];
      t3 = sbox[t3];
    }

    const baseOff = (w - nk) * 4;
    const dstOff = w * 4;
    rk[dstOff] = rk[baseOff] ^ t0;
    rk[dstOff + 1] = rk[baseOff + 1] ^ t1;
    rk[dstOff + 2] = rk[baseOff + 2] ^ t2;
    rk[dstOff + 3] = rk[baseOff + 3] ^ t3;
  }

  return { rk, rounds, tables };
}

function aesEncryptBlock(sched: AesSchedule, input: Uint8Array, out: Uint8Array): void {
  const { rk, rounds, tables } = sched;
  const { sbox, mul2, mul3 } = tables;

  let s0 = input[0] ^ rk[0];
  let s1 = input[1] ^ rk[1];
  let s2 = input[2] ^ rk[2];
  let s3 = input[3] ^ rk[3];
  let s4 = input[4] ^ rk[4];
  let s5 = input[5] ^ rk[5];
  let s6 = input[6] ^ rk[6];
  let s7 = input[7] ^ rk[7];
  let s8 = input[8] ^ rk[8];
  let s9 = input[9] ^ rk[9];
  let s10 = input[10] ^ rk[10];
  let s11 = input[11] ^ rk[11];
  let s12 = input[12] ^ rk[12];
  let s13 = input[13] ^ rk[13];
  let s14 = input[14] ^ rk[14];
  let s15 = input[15] ^ rk[15];

  for (let r = 1; r < rounds; r++) {
    // SubBytes + ShiftRows
    const a0 = sbox[s0];
    const a1 = sbox[s5];
    const a2 = sbox[s10];
    const a3 = sbox[s15];
    const a4 = sbox[s4];
    const a5 = sbox[s9];
    const a6 = sbox[s14];
    const a7 = sbox[s3];
    const a8 = sbox[s8];
    const a9 = sbox[s13];
    const a10 = sbox[s2];
    const a11 = sbox[s7];
    const a12 = sbox[s12];
    const a13 = sbox[s1];
    const a14 = sbox[s6];
    const a15 = sbox[s11];

    const kOff = r * 16;
    s0 = mul2[a0] ^ mul3[a1] ^ a2 ^ a3 ^ rk[kOff];
    s1 = a0 ^ mul2[a1] ^ mul3[a2] ^ a3 ^ rk[kOff + 1];
    s2 = a0 ^ a1 ^ mul2[a2] ^ mul3[a3] ^ rk[kOff + 2];
    s3 = mul3[a0] ^ a1 ^ a2 ^ mul2[a3] ^ rk[kOff + 3];

    s4 = mul2[a4] ^ mul3[a5] ^ a6 ^ a7 ^ rk[kOff + 4];
    s5 = a4 ^ mul2[a5] ^ mul3[a6] ^ a7 ^ rk[kOff + 5];
    s6 = a4 ^ a5 ^ mul2[a6] ^ mul3[a7] ^ rk[kOff + 6];
    s7 = mul3[a4] ^ a5 ^ a6 ^ mul2[a7] ^ rk[kOff + 7];

    s8 = mul2[a8] ^ mul3[a9] ^ a10 ^ a11 ^ rk[kOff + 8];
    s9 = a8 ^ mul2[a9] ^ mul3[a10] ^ a11 ^ rk[kOff + 9];
    s10 = a8 ^ a9 ^ mul2[a10] ^ mul3[a11] ^ rk[kOff + 10];
    s11 = mul3[a8] ^ a9 ^ a10 ^ mul2[a11] ^ rk[kOff + 11];

    s12 = mul2[a12] ^ mul3[a13] ^ a14 ^ a15 ^ rk[kOff + 12];
    s13 = a12 ^ mul2[a13] ^ mul3[a14] ^ a15 ^ rk[kOff + 13];
    s14 = a12 ^ a13 ^ mul2[a14] ^ mul3[a15] ^ rk[kOff + 14];
    s15 = mul3[a12] ^ a13 ^ a14 ^ mul2[a15] ^ rk[kOff + 15];
  }

  const fOff = rounds * 16;
  out[0] = sbox[s0] ^ rk[fOff];
  out[1] = sbox[s5] ^ rk[fOff + 1];
  out[2] = sbox[s10] ^ rk[fOff + 2];
  out[3] = sbox[s15] ^ rk[fOff + 3];
  out[4] = sbox[s4] ^ rk[fOff + 4];
  out[5] = sbox[s9] ^ rk[fOff + 5];
  out[6] = sbox[s14] ^ rk[fOff + 6];
  out[7] = sbox[s3] ^ rk[fOff + 7];
  out[8] = sbox[s8] ^ rk[fOff + 8];
  out[9] = sbox[s13] ^ rk[fOff + 9];
  out[10] = sbox[s2] ^ rk[fOff + 10];
  out[11] = sbox[s7] ^ rk[fOff + 11];
  out[12] = sbox[s12] ^ rk[fOff + 12];
  out[13] = sbox[s1] ^ rk[fOff + 13];
  out[14] = sbox[s6] ^ rk[fOff + 14];
  out[15] = sbox[s11] ^ rk[fOff + 15];
}

function aesDecryptBlock(sched: AesSchedule, input: Uint8Array, out: Uint8Array): void {
  const { rk, rounds, tables } = sched;
  const { invSbox, mul9, mul11, mul13, mul14 } = tables;

  const initOff = rounds * 16;
  let s0 = input[0] ^ rk[initOff];
  let s1 = input[1] ^ rk[initOff + 1];
  let s2 = input[2] ^ rk[initOff + 2];
  let s3 = input[3] ^ rk[initOff + 3];
  let s4 = input[4] ^ rk[initOff + 4];
  let s5 = input[5] ^ rk[initOff + 5];
  let s6 = input[6] ^ rk[initOff + 6];
  let s7 = input[7] ^ rk[initOff + 7];
  let s8 = input[8] ^ rk[initOff + 8];
  let s9 = input[9] ^ rk[initOff + 9];
  let s10 = input[10] ^ rk[initOff + 10];
  let s11 = input[11] ^ rk[initOff + 11];
  let s12 = input[12] ^ rk[initOff + 12];
  let s13 = input[13] ^ rk[initOff + 13];
  let s14 = input[14] ^ rk[initOff + 14];
  let s15 = input[15] ^ rk[initOff + 15];

  for (let r = rounds - 1; r >= 1; r--) {
    const kOff = r * 16;
    // InvShiftRows + InvSubBytes + AddRoundKey
    const a0 = invSbox[s0] ^ rk[kOff];
    const a1 = invSbox[s13] ^ rk[kOff + 1];
    const a2 = invSbox[s10] ^ rk[kOff + 2];
    const a3 = invSbox[s7] ^ rk[kOff + 3];
    const a4 = invSbox[s4] ^ rk[kOff + 4];
    const a5 = invSbox[s1] ^ rk[kOff + 5];
    const a6 = invSbox[s14] ^ rk[kOff + 6];
    const a7 = invSbox[s11] ^ rk[kOff + 7];
    const a8 = invSbox[s8] ^ rk[kOff + 8];
    const a9 = invSbox[s5] ^ rk[kOff + 9];
    const a10 = invSbox[s2] ^ rk[kOff + 10];
    const a11 = invSbox[s15] ^ rk[kOff + 11];
    const a12 = invSbox[s12] ^ rk[kOff + 12];
    const a13 = invSbox[s9] ^ rk[kOff + 13];
    const a14 = invSbox[s6] ^ rk[kOff + 14];
    const a15 = invSbox[s3] ^ rk[kOff + 15];

    // InvMixColumns
    s0 = mul14[a0] ^ mul11[a1] ^ mul13[a2] ^ mul9[a3];
    s1 = mul9[a0] ^ mul14[a1] ^ mul11[a2] ^ mul13[a3];
    s2 = mul13[a0] ^ mul9[a1] ^ mul14[a2] ^ mul11[a3];
    s3 = mul11[a0] ^ mul13[a1] ^ mul9[a2] ^ mul14[a3];

    s4 = mul14[a4] ^ mul11[a5] ^ mul13[a6] ^ mul9[a7];
    s5 = mul9[a4] ^ mul14[a5] ^ mul11[a6] ^ mul13[a7];
    s6 = mul13[a4] ^ mul9[a5] ^ mul14[a6] ^ mul11[a7];
    s7 = mul11[a4] ^ mul13[a5] ^ mul9[a6] ^ mul14[a7];

    s8 = mul14[a8] ^ mul11[a9] ^ mul13[a10] ^ mul9[a11];
    s9 = mul9[a8] ^ mul14[a9] ^ mul11[a10] ^ mul13[a11];
    s10 = mul13[a8] ^ mul9[a9] ^ mul14[a10] ^ mul11[a11];
    s11 = mul11[a8] ^ mul13[a9] ^ mul9[a10] ^ mul14[a11];

    s12 = mul14[a12] ^ mul11[a13] ^ mul13[a14] ^ mul9[a15];
    s13 = mul9[a12] ^ mul14[a13] ^ mul11[a14] ^ mul13[a15];
    s14 = mul13[a12] ^ mul9[a13] ^ mul14[a14] ^ mul11[a15];
    s15 = mul11[a12] ^ mul13[a13] ^ mul9[a14] ^ mul14[a15];
  }

  out[0] = invSbox[s0] ^ rk[0];
  out[1] = invSbox[s13] ^ rk[1];
  out[2] = invSbox[s10] ^ rk[2];
  out[3] = invSbox[s7] ^ rk[3];
  out[4] = invSbox[s4] ^ rk[4];
  out[5] = invSbox[s1] ^ rk[5];
  out[6] = invSbox[s14] ^ rk[6];
  out[7] = invSbox[s11] ^ rk[7];
  out[8] = invSbox[s8] ^ rk[8];
  out[9] = invSbox[s5] ^ rk[9];
  out[10] = invSbox[s2] ^ rk[10];
  out[11] = invSbox[s15] ^ rk[11];
  out[12] = invSbox[s12] ^ rk[12];
  out[13] = invSbox[s9] ^ rk[13];
  out[14] = invSbox[s6] ^ rk[14];
  out[15] = invSbox[s3] ^ rk[15];
}

// --- GHASH (NIST SP 800-38D §6.3) ---

function readU32BE(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

function writeU32BE(b: Uint8Array, off: number, val: number): void {
  b[off] = (val >>> 24) & 0xff;
  b[off + 1] = (val >>> 16) & 0xff;
  b[off + 2] = (val >>> 8) & 0xff;
  b[off + 3] = val & 0xff;
}

function writeBitLengthBE64(b: Uint8Array, off: number, byteLen: bigint): void {
  const bits = byteLen * 8n;
  writeU32BE(b, off, Number((bits >> 32n) & 0xffff_ffffn));
  writeU32BE(b, off + 4, Number(bits & 0xffff_ffffn));
}

/** Updates 128-bit GHASH accumulator `acc` in-place with `(acc XOR block) * H` in GF(2^128). */
function ghashBlock(acc: Uint8Array, block: Uint8Array, hWords: Uint32Array): void {
  for (let i = 0; i < 16; i++) acc[i] ^= block[i];

  let z0 = 0;
  let z1 = 0;
  let z2 = 0;
  let z3 = 0;
  let v0 = hWords[0];
  let v1 = hWords[1];
  let v2 = hWords[2];
  let v3 = hWords[3];

  for (let byteIdx = 0; byteIdx < 16; byteIdx++) {
    const xByte = acc[byteIdx];
    for (let bit = 7; bit >= 0; bit--) {
      if (((xByte >>> bit) & 1) !== 0) {
        z0 = (z0 ^ v0) >>> 0;
        z1 = (z1 ^ v1) >>> 0;
        z2 = (z2 ^ v2) >>> 0;
        z3 = (z3 ^ v3) >>> 0;
      }
      const lsb = v3 & 1;
      v3 = ((v3 >>> 1) | ((v2 & 1) << 31)) >>> 0;
      v2 = ((v2 >>> 1) | ((v1 & 1) << 31)) >>> 0;
      v1 = ((v1 >>> 1) | ((v0 & 1) << 31)) >>> 0;
      v0 = ((v0 >>> 1) ^ (lsb !== 0 ? 0xe1000000 : 0)) >>> 0;
    }
  }

  writeU32BE(acc, 0, z0);
  writeU32BE(acc, 4, z1);
  writeU32BE(acc, 8, z2);
  writeU32BE(acc, 12, z3);
}

function inc32(counter: Uint8Array): void {
  const next = (readU32BE(counter, 12) + 1) >>> 0;
  writeU32BE(counter, 12, next);
}

function inc128(counter: Uint8Array): void {
  for (let i = 15; i >= 0; i--) {
    const next = (counter[i] + 1) & 0xff;
    counter[i] = next;
    if (next !== 0) break;
  }
}

// --- ChaCha20-Poly1305 (RFC 8439) ---

function readU32LE(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function writeU32LE(b: Uint8Array, off: number, val: number): void {
  b[off] = val & 0xff;
  b[off + 1] = (val >>> 8) & 0xff;
  b[off + 2] = (val >>> 16) & 0xff;
  b[off + 3] = (val >>> 24) & 0xff;
}

function chacha20Block(
  keyWords: Uint32Array,
  counter: number,
  nonceWords: Uint32Array,
  out: Uint8Array,
): void {
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  s.set(keyWords, 4);
  s[12] = counter >>> 0;
  s[13] = nonceWords[0];
  s[14] = nonceWords[1];
  s[15] = nonceWords[2];

  const w = new Uint32Array(s);
  const qr = (a: number, b: number, c: number, d: number) => {
    w[a] = (w[a] + w[b]) >>> 0;
    let x = w[d] ^ w[a];
    w[d] = ((x << 16) | (x >>> 16)) >>> 0;
    w[c] = (w[c] + w[d]) >>> 0;
    x = w[b] ^ w[c];
    w[b] = ((x << 12) | (x >>> 20)) >>> 0;
    w[a] = (w[a] + w[b]) >>> 0;
    x = w[d] ^ w[a];
    w[d] = ((x << 8) | (x >>> 24)) >>> 0;
    w[c] = (w[c] + w[d]) >>> 0;
    x = w[b] ^ w[c];
    w[b] = ((x << 7) | (x >>> 25)) >>> 0;
  };

  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12);
    qr(1, 5, 9, 13);
    qr(2, 6, 10, 14);
    qr(3, 7, 11, 15);
    qr(0, 5, 10, 15);
    qr(1, 6, 11, 12);
    qr(2, 7, 8, 13);
    qr(3, 4, 9, 14);
  }

  for (let i = 0; i < 16; i++) {
    writeU32LE(out, i * 4, (w[i] + s[i]) >>> 0);
  }
}

const POLY1305_P = (1n << 130n) - 5n;
const POLY1305_HIBIT = 1n << 128n;
const POLY1305_MASK128 = (1n << 128n) - 1n;

function readLE128(b: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) {
    v = (v << 8n) | BigInt(b[off + i]);
  }
  return v;
}

// --- Mode engines implementing a uniform CipherEngine interface ---

interface CipherEngine {
  readonly isAead: boolean;
  setAutoPadding(autoPad: boolean): boolean;
  setAAD(aad: Uint8Array): boolean;
  setAuthTag(tag: Uint8Array): boolean;
  getAuthTag(): Buffer | undefined;
  update(data: Uint8Array): Buffer;
  final(): Buffer;
}

function invalidStateError(op?: string): Error {
  return Object.assign(
    new Error(op === undefined ? 'Invalid state' : `Invalid state for operation ${op}`),
    { code: 'ERR_CRYPTO_INVALID_STATE' },
  );
}

function invalidAuthTagLengthError(len: number): TypeError {
  return Object.assign(new TypeError(`Invalid authentication tag length: ${len}`), {
    code: 'ERR_CRYPTO_INVALID_AUTH_TAG',
  });
}

function wrongFinalBlockLengthError(): Error {
  return Object.assign(new Error('error:1C80006B:Provider routines::wrong final block length'), {
    code: 'ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH',
  });
}

function badDecryptError(): Error {
  return Object.assign(new Error('error:1C800064:Provider routines::bad decrypt'), {
    code: 'ERR_OSSL_BAD_DECRYPT',
  });
}

function authFailedError(): Error {
  return new Error('Unsupported state or unable to authenticate data');
}

function createCbcEngine(key: Uint8Array, iv: Uint8Array, encrypt: boolean): CipherEngine {
  const sched = expandAesKey(key);
  const prev = Uint8Array.from(iv);
  const blockBuf = new Uint8Array(16);
  let blockLen = 0;
  let autoPad = true;
  let finalized = false;

  return {
    isAead: false,
    setAutoPadding(ap) {
      if (finalized) return false;
      autoPad = ap;
      return true;
    },
    setAAD() {
      return false;
    },
    setAuthTag() {
      return false;
    },
    getAuthTag() {
      return undefined;
    },
    update(data) {
      if (finalized) throw new Error('Trying to add data in unsupported state');
      if (data.byteLength === 0) return Buffer.alloc(0);

      const total = blockLen + data.byteLength;
      if (encrypt) {
        const emitBlocks = total >>> 4;
        const out = Buffer.alloc(emitBlocks * 16);
        let outOff = 0;
        let inOff = 0;

        if (blockLen > 0 && total >= 16) {
          const need = 16 - blockLen;
          blockBuf.set(data.subarray(0, need), blockLen);
          for (let i = 0; i < 16; i++) blockBuf[i] ^= prev[i];
          aesEncryptBlock(sched, blockBuf, prev);
          out.set(prev, 0);
          outOff = 16;
          inOff = need;
          blockLen = 0;
        }
        while (inOff + 16 <= data.byteLength) {
          for (let i = 0; i < 16; i++) blockBuf[i] = data[inOff + i] ^ prev[i];
          aesEncryptBlock(sched, blockBuf, prev);
          out.set(prev, outOff);
          outOff += 16;
          inOff += 16;
        }
        if (inOff < data.byteLength) {
          const rem = data.subarray(inOff);
          blockBuf.set(rem, blockLen);
          blockLen += rem.byteLength;
        }
        return out;
      }

      // Decrypt: when autoPad is enabled, keep 1..16 trailing bytes for PKCS#7 check in final().
      const holdBack = autoPad ? 16 : 0;
      if (total <= holdBack) {
        blockBuf.set(data, blockLen);
        blockLen = total;
        return Buffer.alloc(0);
      }
      const processable = total - (autoPad ? ((total - 1) & 15) + 1 : total & 15);
      const out = Buffer.alloc(processable);
      let outOff = 0;
      let inOff = 0;
      const decScratch = new Uint8Array(16);

      if (blockLen > 0 && processable >= 16) {
        const need = 16 - blockLen;
        blockBuf.set(data.subarray(0, need), blockLen);
        aesDecryptBlock(sched, blockBuf, decScratch);
        for (let i = 0; i < 16; i++) out[i] = decScratch[i] ^ prev[i];
        prev.set(blockBuf);
        outOff = 16;
        inOff = need;
        blockLen = 0;
      }
      while (outOff < processable) {
        const cBlock = data.subarray(inOff, inOff + 16);
        aesDecryptBlock(sched, cBlock, decScratch);
        for (let i = 0; i < 16; i++) out[outOff + i] = decScratch[i] ^ prev[i];
        prev.set(cBlock);
        outOff += 16;
        inOff += 16;
      }
      if (inOff < data.byteLength) {
        const rem = data.subarray(inOff);
        blockBuf.set(rem, blockLen);
        blockLen += rem.byteLength;
      }
      return out;
    },
    final() {
      if (finalized) throw invalidStateError();
      finalized = true;
      if (encrypt) {
        if (!autoPad) {
          if (blockLen !== 0) throw wrongFinalBlockLengthError();
          return Buffer.alloc(0);
        }
        const pad = 16 - blockLen;
        blockBuf.fill(pad, blockLen, 16);
        for (let i = 0; i < 16; i++) blockBuf[i] ^= prev[i];
        const out = Buffer.alloc(16);
        aesEncryptBlock(sched, blockBuf, out);
        return out;
      }

      if (!autoPad) {
        if (blockLen === 0) return Buffer.alloc(0);
        if (blockLen !== 16) throw wrongFinalBlockLengthError();
        const out = Buffer.alloc(16);
        aesDecryptBlock(sched, blockBuf, out);
        for (let i = 0; i < 16; i++) out[i] ^= prev[i];
        return out;
      }

      if (blockLen !== 16) throw badDecryptError();
      const plain = new Uint8Array(16);
      aesDecryptBlock(sched, blockBuf, plain);
      for (let i = 0; i < 16; i++) plain[i] ^= prev[i];
      const pad = plain[15];
      if (pad < 1 || pad > 16) throw badDecryptError();
      let diff = 0;
      for (let i = 16 - pad; i < 16; i++) diff |= plain[i] ^ pad;
      if (diff !== 0) throw badDecryptError();
      return Buffer.from(plain.subarray(0, 16 - pad));
    },
  };
}

function createCtrEngine(key: Uint8Array, iv: Uint8Array): CipherEngine {
  const sched = expandAesKey(key);
  const counter = Uint8Array.from(iv);
  const ksBlock = new Uint8Array(16);
  let ksPos = 16;
  let finalized = false;

  return {
    isAead: false,
    setAutoPadding() {
      return !finalized;
    },
    setAAD() {
      return false;
    },
    setAuthTag() {
      return false;
    },
    getAuthTag() {
      return undefined;
    },
    update(data) {
      if (finalized) throw new Error('Trying to add data in unsupported state');
      const out = Buffer.alloc(data.byteLength);
      for (let i = 0; i < data.byteLength; i++) {
        if (ksPos === 16) {
          aesEncryptBlock(sched, counter, ksBlock);
          inc128(counter);
          ksPos = 0;
        }
        out[i] = data[i] ^ ksBlock[ksPos++];
      }
      return out;
    },
    final() {
      if (finalized) throw invalidStateError();
      finalized = true;
      return Buffer.alloc(0);
    },
  };
}

function createGcmEngine(
  key: Uint8Array,
  iv: Uint8Array,
  encrypt: boolean,
  configuredTagLength: number,
): CipherEngine {
  const sched = expandAesKey(key);
  const hBytes = new Uint8Array(16);
  aesEncryptBlock(sched, new Uint8Array(16), hBytes);
  const hWords = new Uint32Array([
    readU32BE(hBytes, 0),
    readU32BE(hBytes, 4),
    readU32BE(hBytes, 8),
    readU32BE(hBytes, 12),
  ]);

  const j0 = new Uint8Array(16);
  if (iv.byteLength === 12) {
    j0.set(iv, 0);
    j0[15] = 1;
  } else {
    const ivPad = new Uint8Array(16);
    let off = 0;
    while (off + 16 <= iv.byteLength) {
      ghashBlock(j0, iv.subarray(off, off + 16), hWords);
      off += 16;
    }
    if (off < iv.byteLength) {
      ivPad.set(iv.subarray(off), 0);
      ghashBlock(j0, ivPad, hWords);
    }
    const lenBlock = new Uint8Array(16);
    writeBitLengthBE64(lenBlock, 8, BigInt(iv.byteLength));
    ghashBlock(j0, lenBlock, hWords);
  }

  const counter = Uint8Array.from(j0);
  inc32(counter);
  const ksBlock = new Uint8Array(16);
  let ksPos = 16;

  const ghashAcc = new Uint8Array(16);
  const aadTail = new Uint8Array(16);
  let aadTailLen = 0;
  let aadBytes = 0n;
  let aadFlushed = false;

  const ctTail = new Uint8Array(16);
  let ctTailLen = 0;
  let ctBytes = 0n;

  let dataStarted = false;
  let finalized = false;
  let computedTag: Buffer | undefined;
  let expectedTag: Uint8Array | undefined;

  const flushAad = () => {
    if (aadFlushed) return;
    aadFlushed = true;
    if (aadTailLen > 0) {
      aadTail.fill(0, aadTailLen, 16);
      ghashBlock(ghashAcc, aadTail, hWords);
      aadTailLen = 0;
    }
  };

  const feedCtToGhash = (ct: Uint8Array) => {
    ctBytes += BigInt(ct.byteLength);
    let off = 0;
    if (ctTailLen > 0 && ctTailLen + ct.byteLength >= 16) {
      const need = 16 - ctTailLen;
      ctTail.set(ct.subarray(0, need), ctTailLen);
      ghashBlock(ghashAcc, ctTail, hWords);
      ctTailLen = 0;
      off = need;
    }
    while (off + 16 <= ct.byteLength) {
      ghashBlock(ghashAcc, ct.subarray(off, off + 16), hWords);
      off += 16;
    }
    if (off < ct.byteLength) {
      const rem = ct.subarray(off);
      ctTail.set(rem, ctTailLen);
      ctTailLen += rem.byteLength;
    }
  };

  return {
    isAead: true,
    setAutoPadding() {
      return !finalized;
    },
    setAAD(aad) {
      if (finalized || dataStarted) return false;
      aadBytes += BigInt(aad.byteLength);
      let off = 0;
      if (aadTailLen > 0 && aadTailLen + aad.byteLength >= 16) {
        const need = 16 - aadTailLen;
        aadTail.set(aad.subarray(0, need), aadTailLen);
        ghashBlock(ghashAcc, aadTail, hWords);
        aadTailLen = 0;
        off = need;
      }
      while (off + 16 <= aad.byteLength) {
        ghashBlock(ghashAcc, aad.subarray(off, off + 16), hWords);
        off += 16;
      }
      if (off < aad.byteLength) {
        const rem = aad.subarray(off);
        aadTail.set(rem, aadTailLen);
        aadTailLen += rem.byteLength;
      }
      return true;
    },
    setAuthTag(tag) {
      if (encrypt || finalized || expectedTag !== undefined) return false;
      const len = tag.byteLength;
      if (configuredTagLength !== -1) {
        if (len !== configuredTagLength) throw invalidAuthTagLengthError(len);
      } else if (!GCM_TAG_LENGTHS.has(len)) {
        throw invalidAuthTagLengthError(len);
      }
      expectedTag = Uint8Array.from(tag);
      return true;
    },
    getAuthTag() {
      return encrypt && finalized ? computedTag : undefined;
    },
    update(data) {
      if (finalized) throw new Error('Trying to add data in unsupported state');
      dataStarted = true;
      flushAad();
      const out = Buffer.alloc(data.byteLength);
      if (!encrypt) feedCtToGhash(data);
      for (let i = 0; i < data.byteLength; i++) {
        if (ksPos === 16) {
          aesEncryptBlock(sched, counter, ksBlock);
          inc32(counter);
          ksPos = 0;
        }
        out[i] = data[i] ^ ksBlock[ksPos++];
      }
      if (encrypt) feedCtToGhash(out);
      return out;
    },
    final() {
      if (finalized) throw invalidStateError();
      finalized = true;
      flushAad();
      if (ctTailLen > 0) {
        ctTail.fill(0, ctTailLen, 16);
        ghashBlock(ghashAcc, ctTail, hWords);
        ctTailLen = 0;
      }
      const lenBlock = new Uint8Array(16);
      writeBitLengthBE64(lenBlock, 0, aadBytes);
      writeBitLengthBE64(lenBlock, 8, ctBytes);
      ghashBlock(ghashAcc, lenBlock, hWords);

      const s0Block = new Uint8Array(16);
      aesEncryptBlock(sched, j0, s0Block);
      for (let i = 0; i < 16; i++) s0Block[i] ^= ghashAcc[i];

      if (encrypt) {
        const tagLen = configuredTagLength === -1 ? 16 : configuredTagLength;
        computedTag = Buffer.from(s0Block.subarray(0, tagLen));
        return Buffer.alloc(0);
      }

      if (expectedTag === undefined) throw authFailedError();
      const candidate = s0Block.subarray(0, expectedTag.byteLength);
      if (!timingSafeEqual(candidate, expectedTag)) throw authFailedError();
      return Buffer.alloc(0);
    },
  };
}

function createChaCha20Poly1305Engine(
  key: Uint8Array,
  iv: Uint8Array,
  encrypt: boolean,
  configuredTagLength: number,
): CipherEngine {
  const keyWords = new Uint32Array(8);
  for (let i = 0; i < 8; i++) keyWords[i] = readU32LE(key, i * 4);
  const nonceWords = new Uint32Array([readU32LE(iv, 0), readU32LE(iv, 4), readU32LE(iv, 8)]);

  // Block 0 derives the Poly1305 one-time key (r || s).
  const block0 = new Uint8Array(64);
  chacha20Block(keyWords, 0, nonceWords, block0);
  const rBytes = block0.subarray(0, 16);
  rBytes[3] &= 15;
  rBytes[7] &= 15;
  rBytes[11] &= 15;
  rBytes[15] &= 15;
  rBytes[4] &= 252;
  rBytes[8] &= 252;
  rBytes[12] &= 252;
  const polyR = readLE128(rBytes, 0);
  const polyS = readLE128(block0, 16);
  let polyAcc = 0n;

  const feedPolyBlock16 = (block: Uint8Array, off: number) => {
    const n = readLE128(block, off) + POLY1305_HIBIT;
    polyAcc = ((polyAcc + n) * polyR) % POLY1305_P;
  };

  let counter = 1;
  const ksBlock = new Uint8Array(64);
  let ksPos = 64;

  const aadTail = new Uint8Array(16);
  let aadTailLen = 0;
  let aadBytes = 0n;
  let aadFlushed = false;

  const ctTail = new Uint8Array(16);
  let ctTailLen = 0;
  let ctBytes = 0n;

  let dataStarted = false;
  let finalized = false;
  let computedTag: Buffer | undefined;
  let expectedTag: Uint8Array | undefined;

  const flushAad = () => {
    if (aadFlushed) return;
    aadFlushed = true;
    if (aadTailLen > 0) {
      aadTail.fill(0, aadTailLen, 16);
      feedPolyBlock16(aadTail, 0);
      aadTailLen = 0;
    }
  };

  const feedCtToPoly = (ct: Uint8Array) => {
    ctBytes += BigInt(ct.byteLength);
    let off = 0;
    if (ctTailLen > 0 && ctTailLen + ct.byteLength >= 16) {
      const need = 16 - ctTailLen;
      ctTail.set(ct.subarray(0, need), ctTailLen);
      feedPolyBlock16(ctTail, 0);
      ctTailLen = 0;
      off = need;
    }
    while (off + 16 <= ct.byteLength) {
      feedPolyBlock16(ct, off);
      off += 16;
    }
    if (off < ct.byteLength) {
      const rem = ct.subarray(off);
      ctTail.set(rem, ctTailLen);
      ctTailLen += rem.byteLength;
    }
  };

  return {
    isAead: true,
    setAutoPadding() {
      return !finalized;
    },
    setAAD(aad) {
      if (finalized || dataStarted) return false;
      aadBytes += BigInt(aad.byteLength);
      let off = 0;
      if (aadTailLen > 0 && aadTailLen + aad.byteLength >= 16) {
        const need = 16 - aadTailLen;
        aadTail.set(aad.subarray(0, need), aadTailLen);
        feedPolyBlock16(aadTail, 0);
        aadTailLen = 0;
        off = need;
      }
      while (off + 16 <= aad.byteLength) {
        feedPolyBlock16(aad, off);
        off += 16;
      }
      if (off < aad.byteLength) {
        const rem = aad.subarray(off);
        aadTail.set(rem, aadTailLen);
        aadTailLen += rem.byteLength;
      }
      return true;
    },
    setAuthTag(tag) {
      if (encrypt || finalized || expectedTag !== undefined) return false;
      const len = tag.byteLength;
      const requiredLen = configuredTagLength === -1 ? 16 : configuredTagLength;
      if (len !== requiredLen) throw invalidAuthTagLengthError(len);
      expectedTag = Uint8Array.from(tag);
      return true;
    },
    getAuthTag() {
      return encrypt && finalized ? computedTag : undefined;
    },
    update(data) {
      if (finalized) throw new Error('Trying to add data in unsupported state');
      dataStarted = true;
      flushAad();
      const out = Buffer.alloc(data.byteLength);
      if (!encrypt) feedCtToPoly(data);
      for (let i = 0; i < data.byteLength; i++) {
        if (ksPos === 64) {
          chacha20Block(keyWords, counter, nonceWords, ksBlock);
          counter = (counter + 1) >>> 0;
          ksPos = 0;
        }
        out[i] = data[i] ^ ksBlock[ksPos++];
      }
      if (encrypt) feedCtToPoly(out);
      return out;
    },
    final() {
      if (finalized) throw invalidStateError();
      finalized = true;
      flushAad();
      if (ctTailLen > 0) {
        ctTail.fill(0, ctTailLen, 16);
        feedPolyBlock16(ctTail, 0);
        ctTailLen = 0;
      }

      const lenBlock = new Uint8Array(16);
      writeU32LE(lenBlock, 0, Number(aadBytes & 0xffff_ffffn));
      writeU32LE(lenBlock, 4, Number((aadBytes >> 32n) & 0xffff_ffffn));
      writeU32LE(lenBlock, 8, Number(ctBytes & 0xffff_ffffn));
      writeU32LE(lenBlock, 12, Number((ctBytes >> 32n) & 0xffff_ffffn));
      feedPolyBlock16(lenBlock, 0);

      let tagInt = (polyAcc + polyS) & POLY1305_MASK128;
      const fullTag = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        fullTag[i] = Number(tagInt & 0xffn);
        tagInt >>= 8n;
      }

      if (encrypt) {
        const tagLen = configuredTagLength === -1 ? 16 : configuredTagLength;
        computedTag = Buffer.from(fullTag.subarray(0, tagLen));
        return Buffer.alloc(0);
      }

      if (expectedTag === undefined) throw authFailedError();
      const candidate = fullTag.subarray(0, expectedTag.byteLength);
      if (!timingSafeEqual(candidate, expectedTag)) throw authFailedError();
      return Buffer.alloc(0);
    },
  };
}

// --- Argument helpers & Transform stream wrappers (Cipheriv / Decipheriv) ---

const ivTypes = typeList(['string'], ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView']);
const dataTypes = typeList(['string'], ['Buffer', 'TypedArray', 'DataView']);

function getStringOption(options: unknown, key: string): string | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const value: unknown = Reflect.get(options, key);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw Object.assign(
      new TypeError(`The "options.${key}" property must be of type string. ${received(value)}`),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
  }
  return value;
}

function getUIntOption(options: unknown, key: string): number {
  if (options !== null && options !== undefined && typeof options === 'object') {
    const value: unknown = Reflect.get(options, key);
    if (value !== undefined && value !== null) {
      if (typeof value !== 'number' || value >>> 0 !== value) {
        throw invalidArgValue(`options.${key}`, value);
      }
      return value;
    }
  }
  return -1;
}

function arrayBufferOrViewBytes(value: unknown, name: string, encoding?: unknown): Uint8Array {
  if (typeof value === 'string') return stringBytes(value, encoding);
  const bytes = viewBytes(value);
  if (bytes === undefined) throw invalidArgType(name, ivTypes, value);
  return bytes;
}

function updateInputBytes(data: unknown, inputEncoding: unknown): Uint8Array {
  if (typeof data === 'string') {
    const name = textEncoding(inputEncoding);
    if (name === 'hex' && data.length % 2 !== 0) {
      throw Object.assign(
        new TypeError(
          `The argument 'encoding' is invalid for data of length ${data.length}. Received '${String(inputEncoding)}'`,
        ),
        { code: 'ERR_INVALID_ARG_VALUE' },
      );
    }
    return decodeText(data, name ?? 'utf8');
  }
  if (!ArrayBuffer.isView(data)) throw invalidArgType('data', dataTypes, data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

interface DecoderHandle {
  encoding: string;
  write(buf: Buffer): string;
  end(buf?: Buffer): string;
}

type CanonicalOutputEncoding =
  | 'utf8'
  | 'utf16le'
  | 'latin1'
  | 'ascii'
  | 'hex'
  | 'base64'
  | 'base64url';

function canonicalizeOutputEncoding(enc: BufferEncoding | 'base64url'): CanonicalOutputEncoding {
  switch (enc) {
    case 'utf-8':
    case 'utf8':
      return 'utf8';
    case 'ucs-2':
    case 'ucs2':
    case 'utf-16le':
    case 'utf16le':
      return 'utf16le';
    case 'binary':
    case 'latin1':
      return 'latin1';
    default:
      return enc;
  }
}

function resolveOutputDecoder(
  existing: DecoderHandle | null,
  outputEncoding: unknown,
): DecoderHandle {
  const normalized = textEncoding(
    outputEncoding === undefined || outputEncoding === null
      ? undefined
      : typeof outputEncoding === 'string'
        ? outputEncoding
        : String(outputEncoding),
  );
  if (normalized === undefined || normalized === 'buffer') {
    throw unknownEncoding(String(outputEncoding));
  }
  const canonical = canonicalizeOutputEncoding(normalized);
  if (existing !== null) {
    if (existing.encoding !== canonical) {
      throw Object.assign(
        new Error(
          'Cannot change encoding\nThis is caused by either a bug in Node.js or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n',
        ),
        { code: 'ERR_INTERNAL_ASSERTION' },
      );
    }
    return existing;
  }
  if (canonical === 'base64url') {
    let rem: Buffer = Buffer.alloc(0);
    const toUrl = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return {
      encoding: 'base64url',
      write(buf: Buffer) {
        const combined = rem.length > 0 ? Buffer.concat([rem, buf]) : buf;
        const fullLen = combined.length - (combined.length % 3);
        rem = combined.subarray(fullLen);
        return fullLen > 0 ? toUrl(combined.subarray(0, fullLen).toString('base64')) : '';
      },
      end(buf?: Buffer) {
        const combined =
          buf && buf.length > 0 ? (rem.length > 0 ? Buffer.concat([rem, buf]) : buf) : rem;
        rem = Buffer.alloc(0);
        return combined.length > 0 ? toUrl(combined.toString('base64')) : '';
      },
    };
  }
  const sd = new StringDecoder(canonical);
  return {
    encoding: canonical,
    write: (buf: Buffer) => sd.write(buf),
    end: (buf?: Buffer) => sd.end(buf),
  };
}

function initCipherEngine(
  cipherName: string,
  keyBytes: Uint8Array,
  ivBytes: Uint8Array | null,
  authTagLength: number,
  encrypt: boolean,
): CipherEngine {
  if (fipsEnabled()) throw fipsDigestError('hmac');

  const lower = cipherName.toLowerCase();
  const spec = BY_NAME.get(lower);
  if (!spec) {
    if (NATIVE_ONLY_CIPHERS.has(lower)) {
      throw fault('ENOSYS', `Cipher ${cipherName} is outside the supported cipher set`);
    }
    throw Object.assign(new Error('Unknown cipher'), { code: 'ERR_CRYPTO_UNKNOWN_CIPHER' });
  }

  if (authTagLength !== -1) {
    if (spec.mode === 'gcm' && !GCM_TAG_LENGTHS.has(authTagLength)) {
      throw invalidAuthTagLengthError(authTagLength);
    }
    if (spec.mode === 'chacha20-poly1305' && (authTagLength < 1 || authTagLength > 16)) {
      throw invalidAuthTagLengthError(authTagLength);
    }
  }

  // OpenSSL EVP_CipherInit_ex validates IV length before key length (GCM_IV_MAX_SIZE = 128).
  if (spec.mode === 'gcm') {
    if (ivBytes === null || ivBytes.byteLength === 0 || ivBytes.byteLength > 128) {
      throw Object.assign(new TypeError('Invalid initialization vector'), {
        code: 'ERR_CRYPTO_INVALID_IV',
      });
    }
  } else {
    if (ivBytes === null || ivBytes.byteLength !== spec.ivLength) {
      throw Object.assign(new TypeError('Invalid initialization vector'), {
        code: 'ERR_CRYPTO_INVALID_IV',
      });
    }
  }

  if (keyBytes.byteLength !== spec.keyLength) {
    throw Object.assign(new RangeError('Invalid key length'), {
      code: 'ERR_CRYPTO_INVALID_KEYLEN',
    });
  }

  switch (spec.mode) {
    case 'cbc':
      return createCbcEngine(keyBytes, ivBytes, encrypt);
    case 'ctr':
      return createCtrEngine(keyBytes, ivBytes);
    case 'gcm':
      return createGcmEngine(keyBytes, ivBytes, encrypt, authTagLength);
    case 'chacha20-poly1305':
      return createChaCha20Poly1305Engine(keyBytes, ivBytes, encrypt, authTagLength);
  }
}

interface CipherInstanceState {
  engine: CipherEngine;
  decoder: DecoderHandle | null;
}

export function createCipherClasses(TransformClass: typeof Transform) {
  const states = new WeakMap<object, CipherInstanceState>();
  const stateOf = (self: unknown): CipherInstanceState => {
    const st = typeof self === 'object' && self !== null ? states.get(self) : undefined;
    if (!st) {
      throw Object.assign(new TypeError('Value of "this" must be of type CipherBase'), {
        code: 'ERR_INVALID_THIS',
      });
    }
    return st;
  };

  function setupInstance(
    self: object,
    cipher: unknown,
    key: unknown,
    iv: unknown,
    options: unknown,
    encrypt: boolean,
  ): void {
    const cipherName = validateString(cipher, 'cipher');
    const encoding = getStringOption(options, 'encoding');
    const keyBytes = extractSecretKeyBytes(key, encoding);
    const ivBytes = iv === null ? null : arrayBufferOrViewBytes(iv, 'iv');
    const authTagLength = getUIntOption(options, 'authTagLength');
    const engine = initCipherEngine(cipherName, keyBytes, ivBytes, authTagLength, encrypt);

    states.set(self, { engine, decoder: null });

    const streamOptions =
      encoding === 'buffer' && typeof options === 'object' && options !== null
        ? Object.assign({}, options, { encoding: undefined })
        : options;
    // Invariant: TransformClass is the bundled stream.Transform constructor, which initializes `self` in place.
    (TransformClass as unknown as (this: object, opts?: unknown) => void).call(self, streamOptions);
    const writable: unknown = Reflect.get(self, '_writableState');
    if (typeof writable === 'object' && writable !== null) {
      Reflect.set(writable, 'decodeStrings', false);
      if (typeof options !== 'object' || options === null || !('defaultEncoding' in options)) {
        Reflect.set(writable, 'defaultEncoding', 'buffer');
      }
    }
  }

  type CipherConstructor = {
    new (cipher: unknown, key: unknown, iv: unknown, options?: unknown): object;
    (cipher: unknown, key: unknown, iv: unknown, options?: unknown): object;
    prototype: Record<string, unknown>;
  };

  function CipherivImpl(
    this: unknown,
    cipher: unknown,
    key: unknown,
    iv: unknown,
    options?: unknown,
  ): object | undefined {
    if (!(this instanceof CipherivImpl)) {
      return Reflect.construct(CipherivImpl, [cipher, key, iv, options]);
    }
    setupInstance(this, cipher, key, iv, options, true);
  }

  function DecipherivImpl(
    this: unknown,
    cipher: unknown,
    key: unknown,
    iv: unknown,
    options?: unknown,
  ): object | undefined {
    if (!(this instanceof DecipherivImpl)) {
      return Reflect.construct(DecipherivImpl, [cipher, key, iv, options]);
    }
    setupInstance(this, cipher, key, iv, options, false);
  }

  Object.defineProperty(CipherivImpl, 'name', { value: 'Cipheriv', configurable: true });
  Object.defineProperty(DecipherivImpl, 'name', { value: 'Decipheriv', configurable: true });

  // Invariant: CipherivImpl is a plain function supporting both `new Cipheriv(...)` and `Cipheriv(...)` calls.
  const Cipheriv = CipherivImpl as unknown as CipherConstructor;
  // Invariant: DecipherivImpl is a plain function supporting both `new Decipheriv(...)` and `Decipheriv(...)` calls.
  const Decipheriv = DecipherivImpl as unknown as CipherConstructor;

  Object.setPrototypeOf(Cipheriv.prototype, TransformClass.prototype);
  Object.setPrototypeOf(Cipheriv, TransformClass);
  Object.setPrototypeOf(Decipheriv.prototype, TransformClass.prototype);
  Object.setPrototypeOf(Decipheriv, TransformClass);

  const sharedMethods: PropertyDescriptorMap = {
    update: {
      writable: true,
      configurable: true,
      value: function update(
        this: unknown,
        data: unknown,
        inputEncoding?: unknown,
        outputEncoding?: unknown,
      ) {
        const st = stateOf(this);
        const bytes = updateInputBytes(data, inputEncoding);
        const ret = st.engine.update(bytes);
        if (Boolean(outputEncoding) && outputEncoding !== 'buffer') {
          st.decoder = resolveOutputDecoder(st.decoder, outputEncoding);
          return st.decoder.write(ret);
        }
        return ret;
      },
    },
    final: {
      writable: true,
      configurable: true,
      value: function final(this: unknown, outputEncoding?: unknown) {
        const st = stateOf(this);
        const ret = st.engine.final();
        if (Boolean(outputEncoding) && outputEncoding !== 'buffer') {
          st.decoder = resolveOutputDecoder(st.decoder, outputEncoding);
          return st.decoder.end(ret);
        }
        return ret;
      },
    },
    setAutoPadding: {
      writable: true,
      configurable: true,
      value: function setAutoPadding(this: unknown, autoPadding: unknown = true) {
        const st = stateOf(this);
        if (!st.engine.setAutoPadding(Boolean(autoPadding))) {
          throw invalidStateError('setAutoPadding');
        }
        return this;
      },
    },
    setAAD: {
      writable: true,
      configurable: true,
      value: function setAAD(this: unknown, aadbuf: unknown, options?: unknown) {
        const st = stateOf(this);
        const encoding = getStringOption(options, 'encoding');
        getUIntOption(options, 'plaintextLength');
        const aadBytes = arrayBufferOrViewBytes(aadbuf, 'aadbuf', encoding);
        if (!st.engine.setAAD(aadBytes)) {
          throw invalidStateError('setAAD');
        }
        return this;
      },
    },
    _transform: {
      writable: true,
      configurable: true,
      value: function _transform(
        this: { push(chunk: Buffer): void },
        chunk: unknown,
        encoding: unknown,
        callback: (err?: Error | null) => void,
      ) {
        try {
          const st = stateOf(this);
          const bytes =
            typeof chunk === 'string'
              ? stringBytes(chunk, encoding)
              : (viewBytes(chunk) ?? updateInputBytes(chunk, encoding));
          this.push(st.engine.update(bytes));
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
          const st = stateOf(this);
          this.push(st.engine.final());
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    },
  };

  Object.defineProperties(Cipheriv.prototype, {
    ...sharedMethods,
    getAuthTag: {
      writable: true,
      configurable: true,
      value: function getAuthTag(this: unknown) {
        const st = stateOf(this);
        const tag = st.engine.getAuthTag();
        if (tag === undefined) throw invalidStateError('getAuthTag');
        return tag;
      },
    },
  });

  Object.defineProperties(Decipheriv.prototype, {
    ...sharedMethods,
    setAuthTag: {
      writable: true,
      configurable: true,
      value: function setAuthTag(this: unknown, buffer: unknown, encoding?: unknown) {
        const st = stateOf(this);
        const tagBytes = arrayBufferOrViewBytes(buffer, 'buffer', encoding);
        if (!st.engine.setAuthTag(tagBytes)) {
          throw invalidStateError('setAuthTag');
        }
        return this;
      },
    },
  });

  const createCipheriv = function createCipheriv(
    cipher: unknown,
    key: unknown,
    iv: unknown,
    options?: unknown,
  ) {
    return new Cipheriv(cipher, key, iv, options);
  };

  const createDecipheriv = function createDecipheriv(
    cipher: unknown,
    key: unknown,
    iv: unknown,
    options?: unknown,
  ) {
    return new Decipheriv(cipher, key, iv, options);
  };

  return {
    Cipheriv,
    Decipheriv,
    createCipheriv,
    createDecipheriv,
    getCiphers,
    getCipherInfo,
  };
}
