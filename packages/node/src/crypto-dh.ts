// Pure TypeScript / BigInt Diffie-Hellman (DiffieHellman, DiffieHellmanGroup,
// createDiffieHellman, createDiffieHellmanGroup, getDiffieHellman,
// diffieHellman) and Elliptic-Curve Diffie-Hellman (ECDH, createECDH,
// ECDH.convertKey, getCurves) matching Node 22.18.0.
import { Buffer } from 'buffer';
import {
  invalidArgType,
  stringBytes,
  typeList,
  validateInteger,
  validateString,
  viewBytes,
} from './crypto-args';
import { bigIntToUnsignedBytes, bitLengthBigInt, bytesToBigInt, modPow } from './crypto-asn1';
import { encodeOutput } from './crypto-hmac';
import { inspectKeyObjectSlot, isKeyObject } from './crypto-keys';
import { isProbablePrime } from './crypto-prime';
import {
  EC_FULL_CURVES,
  type FullEcCurveName,
  decodeEcPointAnyCurve,
  encodeEcPointBytes,
  jacobianMul,
  mod,
  modInvPrime,
} from './crypto-rsa-sync';
import { invalidArgValue, nodeError, validateObject } from './node-errors';

const DH_CHECK_P_NOT_PRIME = 1;
const DH_CHECK_P_NOT_SAFE_PRIME = 2;
const DH_UNABLE_TO_CHECK_GENERATOR = 4;
const DH_NOT_SUITABLE_GENERATOR = 8;

const P25519 = (1n << 255n) - 19n;

const MODP_GROUP_PRIMES_HEX: Record<string, string> = {
  modp1:
    'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a3620ffffffffffffffff',
  modp2:
    'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece65381ffffffffffffffff',
  modp5:
    'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca237327ffffffffffffffff',
  modp14:
    'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aacaa68ffffffffffffffff',
  modp15:
    'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200cbbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a93ad2caffffffffffffffff',
  modp16:
    'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200cbbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a92108011a723c12a787e6d788719a10bdba5b2699c327186af4e23c1a946834b6150bda2583e9ca2ad44ce8dbbbc2db04de8ef92e8efc141fbecaa6287c59474e6bc05d99b2964fa090c3a2233ba186515be7ed1f612970cee2d7afb81bdd762170481cd0069127d5b05aa993b4ea988d8fddc186ffb7dc90a6c08f4df435c934063199ffffffffffffffff',
  modp17:
    'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200cbbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a92108011a723c12a787e6d788719a10bdba5b2699c327186af4e23c1a946834b6150bda2583e9ca2ad44ce8dbbbc2db04de8ef92e8efc141fbecaa6287c59474e6bc05d99b2964fa090c3a2233ba186515be7ed1f612970cee2d7afb81bdd762170481cd0069127d5b05aa993b4ea988d8fddc186ffb7dc90a6c08f4df435c93402849236c3fab4d27c7026c1d4dcb2602646dec9751e763dba37bdf8ff9406ad9e530ee5db382f413001aeb06a53ed9027d831179727b0865a8918da3edbebcf9b14ed44ce6cbaced4bb1bdb7f1447e6cc254b332051512bd7af426fb8f401378cd2bf5983ca01c64b92ecf032ea15d1721d03f482d7ce6e74fef6d55e702f46980c82b5a84031900b1c9e59e7c97fbec7e8f323a97a7e36cc88be0f1d45b7ff585ac54bd407b22b4154aacc8f6d7ebf48e1d814cc5ed20f8037e0a79715eef29be32806a1d58bb7c5da76f550aa3d8a1fbff0eb19ccb1a313d55cda56c9ec2ef29632387fe8d76e3c0468043e8f663f4860ee12bf2d5b0b7474d6e694f91e6dcc4024ffffffffffffffff',
  modp18:
    'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200cbbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a92108011a723c12a787e6d788719a10bdba5b2699c327186af4e23c1a946834b6150bda2583e9ca2ad44ce8dbbbc2db04de8ef92e8efc141fbecaa6287c59474e6bc05d99b2964fa090c3a2233ba186515be7ed1f612970cee2d7afb81bdd762170481cd0069127d5b05aa993b4ea988d8fddc186ffb7dc90a6c08f4df435c93402849236c3fab4d27c7026c1d4dcb2602646dec9751e763dba37bdf8ff9406ad9e530ee5db382f413001aeb06a53ed9027d831179727b0865a8918da3edbebcf9b14ed44ce6cbaced4bb1bdb7f1447e6cc254b332051512bd7af426fb8f401378cd2bf5983ca01c64b92ecf032ea15d1721d03f482d7ce6e74fef6d55e702f46980c82b5a84031900b1c9e59e7c97fbec7e8f323a97a7e36cc88be0f1d45b7ff585ac54bd407b22b4154aacc8f6d7ebf48e1d814cc5ed20f8037e0a79715eef29be32806a1d58bb7c5da76f550aa3d8a1fbff0eb19ccb1a313d55cda56c9ec2ef29632387fe8d76e3c0468043e8f663f4860ee12bf2d5b0b7474d6e694f91e6dbe115974a3926f12fee5e438777cb6a932df8cd8bec4d073b931ba3bc832b68d9dd300741fa7bf8afc47ed2576f6936ba424663aab639c5ae4f5683423b4742bf1c978238f16cbe39d652de3fdb8befc848ad922222e04a4037c0713eb57a81a23f0c73473fc646cea306b4bcbc8862f8385ddfa9d4b7fa2c087e879683303ed5bdd3a062b3cf5b3a278a66d2a13f83f44f82ddf310ee074ab6a364597e899a0255dc164f31cc50846851df9ab48195ded7ea1b1d510bd7ee74d73faf36bc31ecfa268359046f4eb879f924009438b481c6cd7889a002ed5ee382bc9190da6fc026e479558e4475677e9aa9e3050e2765694dfc81f56e880b96e7160c980dd98edd3dfffffffffffffffff',
};

const bufOrStringTypes = typeList(['string'], ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView']);

function toInputBytes(value: unknown, name: string, encoding?: unknown): Uint8Array {
  if (typeof value === 'string') {
    return stringBytes(value, encoding);
  }
  const view = viewBytes(value);
  if (view !== undefined) return view;
  throw invalidArgType(name, bufOrStringTypes, value);
}

function checkDhParams(p: bigint, g: bigint): number {
  let flags = 0;
  if (p < 3n || (p & 1n) === 0n || !isProbablePrime(p, 16)) {
    flags |= DH_CHECK_P_NOT_PRIME;
  } else {
    const q = (p - 1n) >> 1n;
    if (!isProbablePrime(q, 16)) {
      flags |= DH_CHECK_P_NOT_SAFE_PRIME;
    }
  }
  if (g <= 1n || g >= p - 1n) {
    flags |= DH_NOT_SUITABLE_GENERATOR;
  } else if (g === 2n) {
    if (p % 24n !== 11n && p % 24n !== 23n) {
      flags |= DH_NOT_SUITABLE_GENERATOR;
    }
  } else if (g === 5n) {
    const r = p % 10n;
    if (r !== 3n && r !== 7n) {
      flags |= DH_NOT_SUITABLE_GENERATOR;
    }
  } else {
    flags |= DH_UNABLE_TO_CHECK_GENERATOR;
  }
  return flags;
}

const SMALL_ODD_PRIMES: readonly bigint[] = [
  3n,
  5n,
  7n,
  11n,
  13n,
  17n,
  19n,
  23n,
  29n,
  31n,
  37n,
  41n,
  43n,
  47n,
  53n,
  59n,
  61n,
  67n,
  71n,
  73n,
  79n,
  83n,
  89n,
  97n,
  101n,
  103n,
  107n,
  109n,
  113n,
  127n,
  131n,
  137n,
  139n,
];

function generateDhSafePrime(bits: number, g: bigint): bigint {
  if (bits < 2) {
    throw Object.assign(new Error('bits too small'), { code: 'ERR_OSSL_BN_BITS_TOO_SMALL' });
  }
  const byteLen = Math.ceil(bits / 8);
  const topBitOffset = (bits - 1) % 8;
  const topByteMask = (1 << (topBitOffset + 1)) - 1;
  const topTwoBits =
    topBitOffset >= 1 ? (1 << topBitOffset) | (1 << (topBitOffset - 1)) : 1 << topBitOffset;
  const buf = new Uint8Array(byteLen);

  let modulus = 2n;
  let targetRem = 1n;
  if (g === 2n) {
    modulus = 24n;
    targetRem = 11n;
  } else if (g === 5n) {
    modulus = 10n;
    targetRem = 3n;
  }

  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    buf[0] = (buf[0] & topByteMask) | topTwoBits;
    buf[byteLen - 1] |= 1;
    let p = bytesToBigInt(buf);
    const rem = p % modulus;
    const delta = (targetRem - rem + modulus) % modulus;
    p += delta;
    if ((p & 1n) === 0n) p += modulus;
    if (bitLengthBigInt(p) !== bits) continue;

    let composite = false;
    const q = (p - 1n) >> 1n;
    for (const sp of SMALL_ODD_PRIMES) {
      if ((p > sp && p % sp === 0n) || (q > sp && q % sp === 0n)) {
        composite = true;
        break;
      }
    }
    if (composite) continue;
    if (!isProbablePrime(q, 8)) continue;
    if (!isProbablePrime(p, 8)) continue;
    return p;
  }
}

function randomPrivateExponent(p: bigint): bigint {
  const bits = bitLengthBigInt(p);
  const byteLen = Math.ceil(bits / 8);
  const topBits = byteLen * 8 - bits;
  const topMask = topBits > 0 ? 0xff >>> topBits : 0xff;
  const buf = new Uint8Array(byteLen);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    buf[0] &= topMask;
    const x = bytesToBigInt(buf);
    if (x >= 2n && x < p - 1n) return x;
  }
}

function bigIntFixedPaddedBuffer(value: bigint, byteLen: number): Buffer {
  const out = new Uint8Array(byteLen);
  let rem = value;
  for (let i = byteLen - 1; i >= 0; i--) {
    out[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  return Buffer.from(out);
}

interface DhSlot {
  p: bigint;
  g: bigint;
  priv: bigint | undefined;
  pub: bigint | undefined;
  verifyError: number;
}

export interface DiffieHellmanGroupInstance {
  readonly verifyError: number;
  generateKeys(): Buffer;
  generateKeys(encoding: BufferEncoding): string;
  generateKeys(encoding?: unknown): Buffer | string;
  computeSecret(otherPublicKey: ArrayBufferView): Buffer;
  computeSecret(otherPublicKey: string, inputEncoding: BufferEncoding): Buffer;
  computeSecret(
    otherPublicKey: ArrayBufferView,
    inputEncoding: undefined | null,
    outputEncoding: BufferEncoding,
  ): string;
  computeSecret(
    otherPublicKey: string,
    inputEncoding: BufferEncoding,
    outputEncoding: BufferEncoding,
  ): string;
  computeSecret(
    otherPublicKey: unknown,
    inputEncoding?: unknown,
    outputEncoding?: unknown,
  ): Buffer | string;
  getPrime(): Buffer;
  getPrime(encoding: BufferEncoding): string;
  getPrime(encoding?: unknown): Buffer | string;
  getGenerator(): Buffer;
  getGenerator(encoding: BufferEncoding): string;
  getGenerator(encoding?: unknown): Buffer | string;
  getPublicKey(): Buffer;
  getPublicKey(encoding: BufferEncoding): string;
  getPublicKey(encoding?: unknown): Buffer | string;
  getPrivateKey(): Buffer;
  getPrivateKey(encoding: BufferEncoding): string;
  getPrivateKey(encoding?: unknown): Buffer | string;
}

export interface DiffieHellmanInstance extends DiffieHellmanGroupInstance {
  setPublicKey(publicKey: ArrayBufferView): this;
  setPublicKey(publicKey: string, encoding?: BufferEncoding): this;
  setPublicKey(publicKey: unknown, encoding?: unknown): this;
  setPrivateKey(privateKey: ArrayBufferView): this;
  setPrivateKey(privateKey: string, encoding?: BufferEncoding): this;
  setPrivateKey(privateKey: unknown, encoding?: unknown): this;
}

export interface DiffieHellmanGroupConstructor {
  new (name: string): DiffieHellmanGroupInstance;
  (name: string): DiffieHellmanGroupInstance;
  prototype: DiffieHellmanGroupInstance;
}

export interface DiffieHellmanConstructor {
  new (
    sizeOrKey: number | string | ArrayBufferView,
    keyEncoding?: unknown,
    generator?: unknown,
    genEncoding?: unknown,
  ): DiffieHellmanInstance;
  (
    sizeOrKey: number | string | ArrayBufferView,
    keyEncoding?: unknown,
    generator?: unknown,
    genEncoding?: unknown,
  ): DiffieHellmanInstance;
  prototype: DiffieHellmanInstance;
}

function dhComputeSecret(
  slot: DhSlot,
  otherPublicKey: unknown,
  inputEncoding?: unknown,
  outputEncoding?: unknown,
): Buffer | string {
  if (slot.priv === undefined) {
    throw Object.assign(new Error('Supplied key is too small'), {
      code: 'ERR_CRYPTO_INVALID_KEYLEN',
    });
  }
  const peerBytes = toInputBytes(otherPublicKey, 'otherPublicKey', inputEncoding);
  const peerY = bytesToBigInt(peerBytes);
  if (peerY <= 1n || peerY >= slot.p - 1n) {
    throw Object.assign(new Error('Supplied key is invalid for this prime'), {
      code: 'ERR_OSSL_DH_INVALID_PUBKEY',
    });
  }
  const secret = modPow(peerY, slot.priv, slot.p);
  const pByteLen = Math.ceil(bitLengthBigInt(slot.p) / 8);
  const buf = bigIntFixedPaddedBuffer(secret, pByteLen);
  return encodeOutput(buf, outputEncoding || undefined);
}

// --- X25519 Scalar Multiplication (RFC 7748 §5) for stateless crypto.diffieHellman ---

function x25519SharedSecret(seed: Uint8Array, peerUBytes: Uint8Array): Buffer {
  const kBytes = Uint8Array.from(seed);
  kBytes[0] &= 248;
  kBytes[31] &= 127;
  kBytes[31] |= 64;
  let scalar = 0n;
  for (let i = 0; i < 32; i++) scalar |= BigInt(kBytes[i]) << BigInt(8 * i);

  const uCopy = Uint8Array.from(peerUBytes);
  uCopy[31] &= 127;
  let u = 0n;
  for (let i = 0; i < 32; i++) u |= BigInt(uCopy[i]) << BigInt(8 * i);
  const x1 = mod(u, P25519);

  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  for (let bit = 254n; bit >= 0n; bit--) {
    const kt = (scalar >> bit) & 1n;
    swap ^= kt;
    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;
    const a = mod(x2 + z2, P25519);
    const aa = mod(a * a, P25519);
    const b = mod(x2 - z2, P25519);
    const bb = mod(b * b, P25519);
    const e = mod(aa - bb, P25519);
    const c = mod(x3 + z3, P25519);
    const d = mod(x3 - z3, P25519);
    const da = mod(d * a, P25519);
    const cb = mod(c * b, P25519);
    x3 = mod((da + cb) * (da + cb), P25519);
    z3 = mod(x1 * mod((da - cb) * (da - cb), P25519), P25519);
    x2 = mod(aa * bb, P25519);
    z2 = mod(e * mod(aa + 121665n * e, P25519), P25519);
  }
  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  const shared = mod(x2 * modInvPrime(z2, P25519), P25519);
  const out = Buffer.alloc(32);
  let rem = shared;
  let allZero = true;
  for (let i = 0; i < 32; i++) {
    const byte = Number(rem & 0xffn);
    if (byte !== 0) allZero = false;
    out[i] = byte;
    rem >>= 8n;
  }
  if (allZero) {
    throw Object.assign(new Error('error:0300009A:digital envelope routines::peer error'), {
      code: 'ERR_OSSL_EVP_PEER_ERROR',
    });
  }
  return out;
}

// --- ECDH (createECDH, ECDH, ECDH.convertKey, getCurves) ---

const SUPPORTED_ECDH_CURVES: readonly FullEcCurveName[] = [
  'prime256v1',
  'secp256k1',
  'secp384r1',
  'secp521r1',
];

function resolveStrictEcdhCurve(curveName: unknown): FullEcCurveName {
  const raw = validateString(curveName, 'curve');
  for (const c of SUPPORTED_ECDH_CURVES) {
    if (c === raw) return c;
  }
  throw Object.assign(new TypeError('Invalid EC curve name'), {
    code: 'ERR_CRYPTO_INVALID_CURVE',
  });
}

function resolvePointFormat(format: unknown): 'uncompressed' | 'compressed' | 'hybrid' {
  if (format === undefined || format === 'uncompressed') return 'uncompressed';
  if (format === 'compressed' || format === 'hybrid') return format;
  if (typeof format !== 'string') {
    throw invalidArgType('format', typeList(['string', 'undefined'], []), format);
  }
  throw invalidArgValue('format', format, `must be one of: 'compressed', 'hybrid', 'uncompressed'`);
}

interface EcdhSlot {
  curveName: FullEcCurveName;
  priv: bigint | undefined;
  pub: [bigint, bigint] | undefined;
}

export interface ECDHInstance {
  generateKeys(
    encoding?: BufferEncoding,
    format?: 'uncompressed' | 'compressed' | 'hybrid',
  ): Buffer | string;
  computeSecret(
    otherPublicKey: string | ArrayBufferView,
    inputEncoding?: BufferEncoding,
    outputEncoding?: BufferEncoding,
  ): Buffer | string;
  getPublicKey(
    encoding?: BufferEncoding | null,
    format?: 'uncompressed' | 'compressed' | 'hybrid',
  ): Buffer | string;
  getPrivateKey(encoding?: BufferEncoding): Buffer | string;
  setPublicKey(publicKey: string | ArrayBufferView, encoding?: BufferEncoding): this;
  setPrivateKey(privateKey: string | ArrayBufferView, encoding?: BufferEncoding): this;
}

export interface ECDHConstructor {
  new (curve: string): ECDHInstance;
  (curve: string): ECDHInstance;
  prototype: ECDHInstance;
  convertKey(
    key: string | ArrayBufferView,
    curve: string,
    inputEncoding?: BufferEncoding,
    outputEncoding?: BufferEncoding | 'buffer',
    format?: 'uncompressed' | 'compressed' | 'hybrid',
  ): Buffer | string;
}

export function createDiffieHellmanExports() {
  const dhSlots = new WeakMap<object, DhSlot>();
  const dhgSlots = new WeakMap<object, DhSlot>();

  const requireDh = (map: WeakMap<object, DhSlot>, self: object, cls: string): DhSlot => {
    const s = map.get(self);
    if (!s) {
      throw Object.assign(new TypeError(`The "this" argument must be an instance of ${cls}`), {
        code: 'ERR_INVALID_THIS',
      });
    }
    return s;
  };

  function installSharedDhPrototype(
    proto: object,
    map: WeakMap<object, DhSlot>,
    clsName: string,
  ): void {
    Object.defineProperties(proto, {
      generateKeys: {
        writable: true,
        configurable: true,
        value: function generateKeys(this: object, encoding?: unknown) {
          const slot = requireDh(map, this, clsName);
          if (slot.priv === undefined) {
            slot.priv = randomPrivateExponent(slot.p);
          }
          slot.pub = modPow(slot.g, slot.priv, slot.p);
          const pubBuf = Buffer.from(bigIntToUnsignedBytes(slot.pub));
          return encodeOutput(pubBuf, encoding || undefined);
        },
      },
      computeSecret: {
        writable: true,
        configurable: true,
        value: function computeSecret(
          this: object,
          otherPublicKey: unknown,
          inputEncoding?: unknown,
          outputEncoding?: unknown,
        ) {
          const slot = requireDh(map, this, clsName);
          return dhComputeSecret(slot, otherPublicKey, inputEncoding, outputEncoding);
        },
      },
      getPrime: {
        writable: true,
        configurable: true,
        value: function getPrime(this: object, encoding?: unknown) {
          const slot = requireDh(map, this, clsName);
          return encodeOutput(Buffer.from(bigIntToUnsignedBytes(slot.p)), encoding || undefined);
        },
      },
      getGenerator: {
        writable: true,
        configurable: true,
        value: function getGenerator(this: object, encoding?: unknown) {
          const slot = requireDh(map, this, clsName);
          return encodeOutput(Buffer.from(bigIntToUnsignedBytes(slot.g)), encoding || undefined);
        },
      },
      getPublicKey: {
        writable: true,
        configurable: true,
        value: function getPublicKey(this: object, encoding?: unknown) {
          const slot = requireDh(map, this, clsName);
          if (slot.pub === undefined) {
            throw Object.assign(new Error('No public key - did you forget to generate one?'), {
              code: 'ERR_CRYPTO_INVALID_STATE',
            });
          }
          return encodeOutput(Buffer.from(bigIntToUnsignedBytes(slot.pub)), encoding || undefined);
        },
      },
      getPrivateKey: {
        writable: true,
        configurable: true,
        value: function getPrivateKey(this: object, encoding?: unknown) {
          const slot = requireDh(map, this, clsName);
          if (slot.priv === undefined) {
            throw Object.assign(new Error('No private key - did you forget to generate one?'), {
              code: 'ERR_CRYPTO_INVALID_STATE',
            });
          }
          return encodeOutput(Buffer.from(bigIntToUnsignedBytes(slot.priv)), encoding || undefined);
        },
      },
    });
  }

  const DiffieHellmanGroupFn = function DiffieHellmanGroup(this: unknown, name: unknown) {
    if (!(this instanceof DiffieHellmanGroupFn)) {
      // Invariant: DiffieHellmanGroupFn is a callable constructor function.
      return new (
        DiffieHellmanGroupFn as unknown as new (
          n: unknown,
        ) => DiffieHellmanGroupInstance
      )(name);
    }
    const groupName = validateString(name, 'groupName');
    if (!Object.prototype.hasOwnProperty.call(MODP_GROUP_PRIMES_HEX, groupName)) {
      throw Object.assign(new Error('Unknown group'), {
        code: 'ERR_CRYPTO_UNKNOWN_DH_GROUP',
      });
    }
    const p = BigInt(`0x${MODP_GROUP_PRIMES_HEX[groupName]}`);
    dhgSlots.set(this, { p, g: 2n, priv: undefined, pub: undefined, verifyError: 0 });
    Object.defineProperty(this, 'verifyError', {
      value: 0,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  };
  installSharedDhPrototype(DiffieHellmanGroupFn.prototype, dhgSlots, 'DiffieHellmanGroup');

  // Invariant: prototype methods defined above match DiffieHellmanGroupInstance.
  const DiffieHellmanGroup = DiffieHellmanGroupFn as unknown as DiffieHellmanGroupConstructor;

  const DiffieHellmanFn = function DiffieHellman(
    this: unknown,
    sizeOrKey: unknown,
    keyEncoding?: unknown,
    generator?: unknown,
    genEncoding?: unknown,
  ) {
    if (!(this instanceof DiffieHellmanFn)) {
      // Invariant: DiffieHellmanFn is a callable constructor function.
      return new (
        DiffieHellmanFn as unknown as new (
          s: unknown,
          ke?: unknown,
          g?: unknown,
          ge?: unknown,
        ) => DiffieHellmanInstance
      )(sizeOrKey, keyEncoding, generator, genEncoding);
    }

    if (
      typeof sizeOrKey !== 'number' &&
      typeof sizeOrKey !== 'string' &&
      viewBytes(sizeOrKey) === undefined
    ) {
      throw invalidArgType(
        'sizeOrKey',
        typeList(['number', 'string'], ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView']),
        sizeOrKey,
      );
    }

    let actualKeyEnc = keyEncoding;
    let actualGen = generator;
    let actualGenEnc = genEncoding;

    if (typeof sizeOrKey === 'number') {
      validateInteger(sizeOrKey, 'sizeOrKey', 0, 0x7fffffff);
      actualGenEnc = actualGen;
      actualGen = actualKeyEnc;
      actualKeyEnc = undefined;
    } else if (
      actualKeyEnc !== undefined &&
      typeof actualKeyEnc !== 'string' &&
      !Buffer.isEncoding(String(actualKeyEnc))
    ) {
      actualGenEnc = actualGen;
      actualGen = actualKeyEnc;
      actualKeyEnc = undefined;
    } else if (typeof actualKeyEnc === 'string' && !Buffer.isEncoding(actualKeyEnc)) {
      actualGenEnc = actualGen;
      actualGen = actualKeyEnc;
      actualKeyEnc = undefined;
    }

    let g = 2n;
    if (actualGen !== undefined) {
      if (typeof actualGen === 'number') {
        validateInteger(actualGen, 'generator', 0, 0x7fffffff);
        g = BigInt(actualGen);
      } else if (typeof actualGen === 'string' || viewBytes(actualGen) !== undefined) {
        g = bytesToBigInt(toInputBytes(actualGen, 'generator', actualGenEnc));
      } else {
        throw invalidArgType(
          'generator',
          typeList(['number', 'string'], ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView']),
          actualGen,
        );
      }
    }
    if (g < 2n) {
      throw Object.assign(new Error('generator must be >= 2'), {
        code: 'ERR_OSSL_DH_BAD_GENERATOR',
      });
    }

    let p: bigint;
    let verifyError: number;
    if (typeof sizeOrKey === 'number') {
      p = generateDhSafePrime(sizeOrKey, g);
      verifyError = 0;
    } else {
      const pBytes = toInputBytes(sizeOrKey, 'sizeOrKey', actualKeyEnc);
      p = bytesToBigInt(pBytes);
      if (p < 2n) {
        throw Object.assign(new Error('modulus too small'), {
          code: 'ERR_OSSL_DH_MODULUS_TOO_SMALL',
        });
      }
      verifyError = checkDhParams(p, g);
    }

    dhSlots.set(this, { p, g, priv: undefined, pub: undefined, verifyError });
    Object.defineProperty(this, 'verifyError', {
      value: verifyError,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  };

  installSharedDhPrototype(DiffieHellmanFn.prototype, dhSlots, 'DiffieHellman');
  Object.defineProperties(DiffieHellmanFn.prototype, {
    setPublicKey: {
      writable: true,
      configurable: true,
      value: function setPublicKey(this: object, publicKey: unknown, encoding?: unknown) {
        const slot = requireDh(dhSlots, this, 'DiffieHellman');
        const bytes = toInputBytes(publicKey, 'publicKey', encoding);
        slot.pub = bytesToBigInt(bytes);
        return this;
      },
    },
    setPrivateKey: {
      writable: true,
      configurable: true,
      value: function setPrivateKey(this: object, privateKey: unknown, encoding?: unknown) {
        const slot = requireDh(dhSlots, this, 'DiffieHellman');
        const bytes = toInputBytes(privateKey, 'privateKey', encoding);
        slot.priv = bytesToBigInt(bytes);
        return this;
      },
    },
  });

  // Invariant: prototype methods defined above match DiffieHellmanInstance.
  const DiffieHellman = DiffieHellmanFn as unknown as DiffieHellmanConstructor;

  function createDiffieHellman(
    sizeOrKey: number | string | ArrayBufferView,
    keyEncoding?: unknown,
    generator?: unknown,
    genEncoding?: unknown,
  ): DiffieHellmanInstance {
    return new DiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding);
  }

  function createDiffieHellmanGroup(name: string): DiffieHellmanGroupInstance {
    return new DiffieHellmanGroup(name);
  }

  function getDiffieHellman(groupName: string): DiffieHellmanGroupInstance {
    return new DiffieHellmanGroup(groupName);
  }

  function diffieHellman(options: unknown): Buffer {
    validateObject(options, 'options');
    const privObj = options.privateKey;
    const pubObj = options.publicKey;
    if (!isKeyObject(privObj)) {
      throw invalidArgType('options.privateKey', 'KeyObject', privObj);
    }
    if (!isKeyObject(pubObj)) {
      throw invalidArgType('options.publicKey', 'KeyObject', pubObj);
    }
    const privInsp = inspectKeyObjectSlot(privObj);
    const pubInsp = inspectKeyObjectSlot(pubObj);
    if (privInsp.kind !== 'private') {
      throw Object.assign(
        new TypeError(`Invalid key object type ${privInsp.kind}, expected private.`),
        { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' },
      );
    }
    if (pubInsp.kind !== 'public') {
      throw Object.assign(
        new TypeError(`Invalid key object type ${pubInsp.kind}, expected public.`),
        { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' },
      );
    }
    const privData = privInsp.privateData;
    const pubData = pubInsp.publicData;
    const privType = privData?.kind ?? privInsp.nonExtractableType ?? 'unknown';
    const pubType = pubData?.kind ?? pubInsp.nonExtractableType ?? 'unknown';

    const dhTypes = new Set(['dh', 'ec', 'x25519', 'x448']);
    if (privType !== pubType || !dhTypes.has(privType)) {
      throw nodeError(
        Error,
        'ERR_CRYPTO_INCOMPATIBLE_KEY',
        `Incompatible key types for Diffie-Hellman: ${privType} and ${pubType}`,
      );
    }
    if (!privData || !pubData) {
      throw Object.assign(
        new Error('Synchronous crypto.diffieHellman requires extractable KeyObjects'),
        { code: 'ENOSYS' },
      );
    }

    if (privData.kind === 'x25519' && pubData.kind === 'x25519') {
      return x25519SharedSecret(privData.d, pubData.x);
    }

    if (privData.kind === 'ec' && pubData.kind === 'ec') {
      if (privData.namedCurve !== pubData.namedCurve) {
        throw Object.assign(
          new Error('error:1C8000CB:Provider routines::mismatching domain parameters'),
          { code: 'ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS' },
        );
      }
      const curve = EC_FULL_CURVES[privData.namedCurve];
      const d = bytesToBigInt(privData.d);
      const qx = bytesToBigInt(pubData.x);
      const qy = bytesToBigInt(pubData.y);
      const shared = jacobianMul(curve, qx, qy, d);
      if (!shared) {
        throw Object.assign(new Error('Failed to compute ECDH key'), {
          code: 'ERR_CRYPTO_OPERATION_FAILED',
        });
      }
      return Buffer.from(bigIntToUnsignedBytes(shared[0], curve.coordBytes));
    }

    if (privData.kind === 'dh' && pubData.kind === 'dh') {
      if (privData.p !== pubData.p || privData.g !== pubData.g) {
        throw Object.assign(
          new Error('error:1C8000CB:Provider routines::mismatching domain parameters'),
          { code: 'ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS' },
        );
      }
      if (pubData.y <= 1n || pubData.y >= privData.p - 1n) {
        throw Object.assign(new Error('Supplied key is invalid for this prime'), {
          code: 'ERR_OSSL_DH_INVALID_PUBKEY',
        });
      }
      const secret = modPow(pubData.y, privData.x, privData.p);
      const pByteLen = Math.ceil(bitLengthBigInt(privData.p) / 8);
      return bigIntFixedPaddedBuffer(secret, pByteLen);
    }

    throw nodeError(
      Error,
      'ERR_CRYPTO_INCOMPATIBLE_KEY',
      `Incompatible key types for Diffie-Hellman: ${privType} and ${pubType}`,
    );
  }

  // --- ECDH ---
  const ecdhSlots = new WeakMap<object, EcdhSlot>();
  const requireEcdh = (self: object): EcdhSlot => {
    const s = ecdhSlots.get(self);
    if (!s) {
      throw Object.assign(new TypeError('The "this" argument must be an instance of ECDH'), {
        code: 'ERR_INVALID_THIS',
      });
    }
    return s;
  };

  const ECDHFn = function ECDH(this: unknown, curve: unknown) {
    if (!(this instanceof ECDHFn)) {
      // Invariant: ECDHFn is a callable constructor function.
      return new (ECDHFn as unknown as new (c: unknown) => ECDHInstance)(curve);
    }
    const curveName = resolveStrictEcdhCurve(curve);
    ecdhSlots.set(this, { curveName, priv: undefined, pub: undefined });
  };

  Object.defineProperties(ECDHFn.prototype, {
    computeSecret: {
      writable: true,
      configurable: true,
      value: function computeSecret(
        this: object,
        otherPublicKey: unknown,
        inputEncoding?: unknown,
        outputEncoding?: unknown,
      ) {
        const slot = requireEcdh(this);
        if (slot.priv === undefined) {
          throw Object.assign(new Error('Failed to compute ECDH key'), {
            code: 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY',
          });
        }
        const curve = EC_FULL_CURVES[slot.curveName];
        const peerBytes = toInputBytes(otherPublicKey, 'otherPublicKey', inputEncoding);
        const [qx, qy] = decodeEcPointAnyCurve(curve, peerBytes);
        const shared = jacobianMul(curve, qx, qy, slot.priv);
        if (!shared) {
          throw Object.assign(new Error('Failed to compute ECDH key'), {
            code: 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY',
          });
        }
        const out = Buffer.from(bigIntToUnsignedBytes(shared[0], curve.coordBytes));
        return encodeOutput(out, outputEncoding || undefined);
      },
    },
    setPrivateKey: {
      writable: true,
      configurable: true,
      value: function setPrivateKey(this: object, privateKey: unknown, encoding?: unknown) {
        const slot = requireEcdh(this);
        const curve = EC_FULL_CURVES[slot.curveName];
        const bytes = toInputBytes(privateKey, 'privateKey', encoding);
        const d = bytesToBigInt(bytes);
        if (d < 1n || d >= curve.n) {
          throw Object.assign(new Error('Private key is not valid for specified curve.'), {
            code: 'ERR_CRYPTO_OPERATION_FAILED',
          });
        }
        const pub = jacobianMul(curve, curve.gx, curve.gy, d);
        if (!pub) {
          throw Object.assign(new Error('Private key is not valid for specified curve.'), {
            code: 'ERR_CRYPTO_OPERATION_FAILED',
          });
        }
        slot.priv = d;
        slot.pub = pub;
        return this;
      },
    },
    setPublicKey: {
      writable: true,
      configurable: true,
      value: function setPublicKey(this: object, publicKey: unknown, encoding?: unknown) {
        const slot = requireEcdh(this);
        const curve = EC_FULL_CURVES[slot.curveName];
        const bytes = toInputBytes(publicKey, 'publicKey', encoding);
        slot.pub = decodeEcPointAnyCurve(curve, bytes);
        return this;
      },
    },
    getPrivateKey: {
      writable: true,
      configurable: true,
      value: function getPrivateKey(this: object, encoding?: unknown) {
        const slot = requireEcdh(this);
        if (slot.priv === undefined) {
          throw Object.assign(new Error('Failed to get ECDH private key'), {
            code: 'ERR_CRYPTO_OPERATION_FAILED',
          });
        }
        return encodeOutput(Buffer.from(bigIntToUnsignedBytes(slot.priv)), encoding || undefined);
      },
    },
    generateKeys: {
      writable: true,
      configurable: true,
      value: function generateKeys(this: object, encoding?: unknown, format?: unknown) {
        const slot = requireEcdh(this);
        const fmt = resolvePointFormat(format);
        const curve = EC_FULL_CURVES[slot.curveName];
        const byteLen = curve.coordBytes;
        const topBits = byteLen * 8 - bitLengthBigInt(curve.n);
        const topMask = topBits > 0 ? 0xff >>> topBits : 0xff;
        const buf = new Uint8Array(byteLen);
        for (;;) {
          globalThis.crypto.getRandomValues(buf);
          buf[0] &= topMask;
          const d = bytesToBigInt(buf);
          if (d >= 1n && d < curve.n) {
            const pub = jacobianMul(curve, curve.gx, curve.gy, d);
            if (pub) {
              slot.priv = d;
              slot.pub = pub;
              const encoded = encodeEcPointBytes(curve, pub[0], pub[1], fmt);
              return encodeOutput(encoded, encoding || undefined);
            }
          }
        }
      },
    },
    getPublicKey: {
      writable: true,
      configurable: true,
      value: function getPublicKey(this: object, encoding?: unknown, format?: unknown) {
        const slot = requireEcdh(this);
        const fmt = resolvePointFormat(format);
        if (!slot.pub) {
          throw Object.assign(new Error('Failed to get ECDH public key'), {
            code: 'ERR_CRYPTO_OPERATION_FAILED',
          });
        }
        const curve = EC_FULL_CURVES[slot.curveName];
        const encoded = encodeEcPointBytes(curve, slot.pub[0], slot.pub[1], fmt);
        return encodeOutput(encoded, encoding || undefined);
      },
    },
  });

  Object.defineProperty(ECDHFn, 'convertKey', {
    writable: true,
    configurable: true,
    enumerable: true,
    value: function convertKey(
      key: unknown,
      curve: unknown,
      inputEncoding?: unknown,
      outputEncoding?: unknown,
      format?: unknown,
    ): Buffer | string {
      if (typeof key !== 'string' && viewBytes(key) === undefined) {
        throw invalidArgType('key', bufOrStringTypes, key);
      }
      const curveName = resolveStrictEcdhCurve(curve);
      const fmt = resolvePointFormat(format);
      const curveParams = EC_FULL_CURVES[curveName];
      const inBytes = toInputBytes(key, 'key', inputEncoding);
      const [x, y] = decodeEcPointAnyCurve(curveParams, inBytes);
      const out = encodeEcPointBytes(curveParams, x, y, fmt);
      if (outputEncoding === undefined || outputEncoding === 'buffer') return out;
      return encodeOutput(out, outputEncoding);
    },
  });

  // Invariant: prototype and static convertKey defined above match ECDHConstructor.
  const ECDH = ECDHFn as unknown as ECDHConstructor;

  function createECDH(curve: string): ECDHInstance {
    return new ECDH(curve);
  }

  function getCurves(): string[] {
    return [...SUPPORTED_ECDH_CURVES];
  }

  return {
    DiffieHellman,
    DiffieHellmanGroup,
    createDiffieHellman,
    createDiffieHellmanGroup,
    getDiffieHellman,
    diffieHellman,
    ECDH,
    createECDH,
    getCurves,
  };
}
