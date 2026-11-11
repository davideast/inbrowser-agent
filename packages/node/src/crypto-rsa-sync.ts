// Synchronous streaming crypto.Sign / crypto.Verify (createSign / createVerify)
// and synchronous RSA encryption/decryption (publicEncrypt, privateDecrypt,
// privateEncrypt, publicDecrypt), plus shared Jacobian Weierstrass & Ed25519
// verification primitives for ECDH and X509Certificate.
import { Buffer } from 'buffer';
import type { Writable } from 'stream';
import shaHash from 'sha.js';
import {
  decodeText,
  invalidArgType,
  stringBytes,
  textEncoding,
  typeList,
  validateString,
  viewBytes,
} from './crypto-args';
import {
  type EcCurveName,
  type ParsedPublicKey,
  type RsaPrivateData,
  type RsaPublicData,
  bigIntToUnsignedBytes,
  bitLengthBigInt,
  bytesEqual,
  bytesToBigInt,
  ecdsaDerToP1363,
  ecdsaP1363ToDer,
  modPow,
  publicFromPrivateData,
} from './crypto-asn1';
import { fipsEnabled } from './crypto-fips';
import { encodeOutput } from './crypto-hmac';
import {
  inspectKeyObjectSlot,
  resolvePrivateForSign,
  resolvePublicOrPrivateForVerify,
} from './crypto-keys';
import { invalidArgValue, nodeError } from './node-errors';
import { fault, record } from './protocol';

const RSA_PKCS1_PADDING = 1;
const RSA_NO_PADDING = 3;
const RSA_PKCS1_OAEP_PADDING = 4;
const RSA_PKCS1_PSS_PADDING = 6;
const RSA_PSS_SALTLEN_DIGEST = -1;
const RSA_PSS_SALTLEN_MAX_SIGN = -2;

export type ShaDigestName = 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512';
export type FullEcCurveName = EcCurveName | 'secp256k1';

export interface FullCurveParams {
  coordBytes: number;
  p: bigint;
  a: bigint;
  b: bigint;
  gx: bigint;
  gy: bigint;
  n: bigint;
}

const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P384_P =
  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffffn;
const P521_P = (1n << 521n) - 1n;
const K256_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

export const EC_FULL_CURVES: Record<FullEcCurveName, FullCurveParams> = {
  prime256v1: {
    coordBytes: 32,
    p: P256_P,
    a: P256_P - 3n,
    b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
    gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
    n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
  },
  secp384r1: {
    coordBytes: 48,
    p: P384_P,
    a: P384_P - 3n,
    b: 0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn,
    gx: 0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7n,
    gy: 0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5fn,
    n: 0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973n,
  },
  secp521r1: {
    coordBytes: 66,
    p: P521_P,
    a: P521_P - 3n,
    b: 0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00n,
    gx: 0x00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66n,
    gy: 0x011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650n,
    n: 0x01fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409n,
  },
  secp256k1: {
    coordBytes: 32,
    p: K256_P,
    a: 0n,
    b: 7n,
    gx: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    gy: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
    n: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  },
};

export function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

export function modInvPrime(a: bigint, prime: bigint): bigint {
  return modPow(mod(a, prime), prime - 2n, prime);
}

// --- Fast Jacobian Weierstrass Arithmetic (1 inversion per scalar mul) ---

type JacobianPoint = [bigint, bigint, bigint];

function jacobianDouble(pt: JacobianPoint, p: bigint, a: bigint): JacobianPoint {
  const [X1, Y1, Z1] = pt;
  if (Z1 === 0n || Y1 === 0n) return [0n, 1n, 0n];
  const Y1Sq = mod(Y1 * Y1, p);
  const S = mod(4n * X1 * Y1Sq, p);
  let M: bigint;
  if (a === 0n) {
    M = mod(3n * X1 * X1, p);
  } else if (a === p - 3n) {
    const Z1Sq = mod(Z1 * Z1, p);
    M = mod(3n * mod(X1 - Z1Sq, p) * mod(X1 + Z1Sq, p), p);
  } else {
    const Z1Pow4 = mod(mod(Z1 * Z1, p) * mod(Z1 * Z1, p), p);
    M = mod(3n * X1 * X1 + a * Z1Pow4, p);
  }
  const X3 = mod(M * M - 2n * S, p);
  const Y3 = mod(M * (S - X3) - 8n * mod(Y1Sq * Y1Sq, p), p);
  const Z3 = mod(2n * Y1 * Z1, p);
  return [X3, Y3, Z3];
}

function jacobianAdd(p1: JacobianPoint, p2: JacobianPoint, p: bigint, a: bigint): JacobianPoint {
  const [X1, Y1, Z1] = p1;
  const [X2, Y2, Z2] = p2;
  if (Z1 === 0n) return p2;
  if (Z2 === 0n) return p1;
  const Z1Z1 = mod(Z1 * Z1, p);
  const Z2Z2 = mod(Z2 * Z2, p);
  const U1 = mod(X1 * Z2Z2, p);
  const U2 = mod(X2 * Z1Z1, p);
  const S1 = mod(Y1 * mod(Z2 * Z2Z2, p), p);
  const S2 = mod(Y2 * mod(Z1 * Z1Z1, p), p);
  if (U1 === U2) {
    if (S1 !== S2) return [0n, 1n, 0n];
    return jacobianDouble(p1, p, a);
  }
  const H = mod(U2 - U1, p);
  const I = mod(4n * H * H, p);
  const J = mod(H * I, p);
  const r = mod(2n * (S2 - S1), p);
  const V = mod(U1 * I, p);
  const X3 = mod(r * r - J - 2n * V, p);
  const Y3 = mod(r * (V - X3) - 2n * S1 * J, p);
  const Z3 = mod(mod((Z1 + Z2) * (Z1 + Z2) - Z1Z1 - Z2Z2, p) * H, p);
  return [X3, Y3, Z3];
}

function jacobianToAffine(pt: JacobianPoint, p: bigint): [bigint, bigint] | null {
  const [X, Y, Z] = pt;
  if (Z === 0n) return null;
  const zInv = modInvPrime(Z, p);
  const zInv2 = mod(zInv * zInv, p);
  const zInv3 = mod(zInv2 * zInv, p);
  return [mod(X * zInv2, p), mod(Y * zInv3, p)];
}

export function jacobianMul(
  curve: FullCurveParams,
  px: bigint,
  py: bigint,
  scalar: bigint,
): [bigint, bigint] | null {
  let k = scalar;
  if (k <= 0n) return null;
  let acc: JacobianPoint = [0n, 1n, 0n];
  let cur: JacobianPoint = [px, py, 1n];
  while (k > 0n) {
    if (k & 1n) acc = jacobianAdd(acc, cur, curve.p, curve.a);
    cur = jacobianDouble(cur, curve.p, curve.a);
    k >>= 1n;
  }
  return jacobianToAffine(acc, curve.p);
}

export function ecPointAdd(
  curve: FullCurveParams,
  first: [bigint, bigint] | null,
  second: [bigint, bigint] | null,
): [bigint, bigint] | null {
  if (!first) return second;
  if (!second) return first;
  const sum = jacobianAdd([first[0], first[1], 1n], [second[0], second[1], 1n], curve.p, curve.a);
  return jacobianToAffine(sum, curve.p);
}

export function isPointOnFullCurve(curve: FullCurveParams, x: bigint, y: bigint): boolean {
  if (x < 0n || x >= curve.p || y < 0n || y >= curve.p) return false;
  const lhs = mod(y * y, curve.p);
  const rhs = mod(
    mod(mod(x * x, curve.p) * x, curve.p) + mod(curve.a * x, curve.p) + curve.b,
    curve.p,
  );
  return lhs === rhs;
}

export function decodeEcPointAnyCurve(
  curve: FullCurveParams,
  pointBytes: Uint8Array,
): [bigint, bigint] {
  const len = curve.coordBytes;
  if (pointBytes.byteLength === 1 + 2 * len) {
    const prefix = pointBytes[0];
    if (prefix === 0x04 || prefix === 0x06 || prefix === 0x07) {
      const x = bytesToBigInt(pointBytes.subarray(1, 1 + len));
      const y = bytesToBigInt(pointBytes.subarray(1 + len));
      if (!isPointOnFullCurve(curve, x, y)) {
        throw Object.assign(new Error('Invalid EC point'), {
          code: 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY',
        });
      }
      if (prefix === 0x06 || prefix === 0x07) {
        const expectedParity = prefix === 0x07 ? 1n : 0n;
        if ((y & 1n) !== expectedParity) {
          throw Object.assign(new Error('Invalid EC point'), {
            code: 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY',
          });
        }
      }
      return [x, y];
    }
  }
  if (pointBytes.byteLength === 1 + len && (pointBytes[0] === 0x02 || pointBytes[0] === 0x03)) {
    const x = bytesToBigInt(pointBytes.subarray(1));
    if (x >= curve.p) {
      throw Object.assign(new Error('Invalid EC point'), {
        code: 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY',
      });
    }
    const rhs = mod(
      mod(mod(x * x, curve.p) * x, curve.p) + mod(curve.a * x, curve.p) + curve.b,
      curve.p,
    );
    // All four supported curves (prime256v1, secp384r1, secp521r1, secp256k1) satisfy p === 3 (mod 4).
    let y = modPow(rhs, (curve.p + 1n) >> 2n, curve.p);
    if (mod(y * y, curve.p) !== rhs) {
      throw Object.assign(new Error('Invalid EC point'), {
        code: 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY',
      });
    }
    const parity = BigInt(pointBytes[0] & 1);
    if ((y & 1n) !== parity) y = y === 0n ? 0n : curve.p - y;
    if ((y & 1n) !== parity || !isPointOnFullCurve(curve, x, y)) {
      throw Object.assign(new Error('Invalid EC point'), {
        code: 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY',
      });
    }
    return [x, y];
  }
  throw Object.assign(new Error('Failed to convert Buffer to EC_POINT'), {
    code: 'ERR_OSSL_EC_INVALID_FORM',
  });
}

export function encodeEcPointBytes(
  curve: FullCurveParams,
  x: bigint,
  y: bigint,
  format: 'uncompressed' | 'compressed' | 'hybrid',
): Buffer {
  const len = curve.coordBytes;
  const xBytes = bigIntToUnsignedBytes(x, len);
  if (format === 'compressed') {
    const out = Buffer.alloc(1 + len);
    out[0] = (y & 1n) === 1n ? 0x03 : 0x02;
    out.set(xBytes, 1);
    return out;
  }
  const yBytes = bigIntToUnsignedBytes(y, len);
  const out = Buffer.alloc(1 + 2 * len);
  out[0] = format === 'hybrid' ? ((y & 1n) === 1n ? 0x07 : 0x06) : 0x04;
  out.set(xBytes, 1);
  out.set(yBytes, 1 + len);
  return out;
}

// --- Synchronous Ed25519 Verification (RFC 8032 §5.1.7) ---

const P25519 = (1n << 255n) - 19n;
const ED_L = (1n << 252n) + 27742317777372353535851937790883648493n;
const ED_D = mod(-121665n * modInvPrime(121666n, P25519), P25519);
const ED_BY = mod(4n * modInvPrime(5n, P25519), P25519);
const ED_BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const ED_SQRT_M1 = modPow(2n, (P25519 - 1n) >> 2n, P25519);

type EdExtPoint = [bigint, bigint, bigint, bigint];

function edAddExt(first: EdExtPoint, second: EdExtPoint): EdExtPoint {
  const [x1, y1, z1, t1] = first;
  const [x2, y2, z2, t2] = second;
  const a = mod((y1 - x1) * (y2 - x2), P25519);
  const b = mod((y1 + x1) * (y2 + x2), P25519);
  const c = mod(2n * ED_D * t1 * t2, P25519);
  const d = mod(2n * z1 * z2, P25519);
  const e = mod(b - a, P25519);
  const f = mod(d - c, P25519);
  const g = mod(d + c, P25519);
  const h = mod(b + a, P25519);
  return [mod(e * f, P25519), mod(g * h, P25519), mod(f * g, P25519), mod(e * h, P25519)];
}

function edScalarMulExt(pt: EdExtPoint, scalar: bigint): EdExtPoint {
  let acc: EdExtPoint = [0n, 1n, 1n, 0n];
  let cur = pt;
  let k = scalar;
  while (k > 0n) {
    if (k & 1n) acc = edAddExt(acc, cur);
    cur = edAddExt(cur, cur);
    k >>= 1n;
  }
  return acc;
}

function edDecompress(enc: Uint8Array): EdExtPoint | null {
  if (enc.byteLength !== 32) return null;
  let y = 0n;
  for (let i = 0; i < 32; i++) {
    const byte = i === 31 ? enc[31] & 0x7f : enc[i];
    y |= BigInt(byte) << BigInt(8 * i);
  }
  if (y >= P25519) return null;
  const xSign = BigInt((enc[31] >>> 7) & 1);
  const y2 = mod(y * y, P25519);
  const u = mod(y2 - 1n, P25519);
  const v = mod(ED_D * y2 + 1n, P25519);
  let x = mod(u * modPow(v, (P25519 + 3n) >> 3n, P25519) * modInvPrime(v, P25519), P25519);
  // Direct RFC 8032 §5.1.3 candidate x = (u / v)^((p + 3) / 8)
  const uOverV = mod(u * modInvPrime(v, P25519), P25519);
  x = modPow(uOverV, (P25519 + 3n) >> 3n, P25519);
  if (mod(x * x, P25519) !== uOverV) {
    x = mod(x * ED_SQRT_M1, P25519);
    if (mod(x * x, P25519) !== uOverV) return null;
  }
  if (x === 0n && xSign === 1n) return null;
  if ((x & 1n) !== xSign) x = P25519 - x;
  return [x, y, 1n, mod(x * y, P25519)];
}

export function ed25519VerifySync(
  pubKeyBytes: Uint8Array,
  message: Uint8Array,
  sigBytes: Uint8Array,
): boolean {
  if (sigBytes.byteLength !== 64 || pubKeyBytes.byteLength !== 32) return false;
  const rEnc = sigBytes.subarray(0, 32);
  const sEnc = sigBytes.subarray(32, 64);
  let S = 0n;
  for (let i = 0; i < 32; i++) S |= BigInt(sEnc[i]) << BigInt(8 * i);
  if (S >= ED_L) return false;
  const A = edDecompress(pubKeyBytes);
  const R = edDecompress(rEnc);
  if (!A || !R) return false;
  const hDigest = shaHash('sha512')
    .update(Buffer.from(rEnc.buffer, rEnc.byteOffset, rEnc.byteLength))
    .update(Buffer.from(pubKeyBytes.buffer, pubKeyBytes.byteOffset, pubKeyBytes.byteLength))
    .update(Buffer.from(message.buffer, message.byteOffset, message.byteLength))
    .digest();
  let k = 0n;
  for (let i = 0; i < 64; i++) k |= BigInt(hDigest[i]) << BigInt(8 * i);
  k %= ED_L;
  const lhs = edScalarMulExt([ED_BX, ED_BY, 1n, mod(ED_BX * ED_BY, P25519)], S);
  const rhs = edAddExt(R, edScalarMulExt(A, k));
  return (
    mod(lhs[0] * rhs[2], P25519) === mod(rhs[0] * lhs[2], P25519) &&
    mod(lhs[1] * rhs[2], P25519) === mod(rhs[1] * lhs[2], P25519)
  );
}

// --- Synchronous ECDSA Sign & Verify ---

function truncateHashForCurve(hashBytes: Uint8Array, n: bigint): bigint {
  const nBits = bitLengthBigInt(n);
  const hBits = hashBytes.byteLength * 8;
  const e = bytesToBigInt(hashBytes);
  return hBits > nBits ? e >> BigInt(hBits - nBits) : e;
}

function randomScalarBelow(n: bigint): bigint {
  const byteLen = Math.ceil(bitLengthBigInt(n) / 8);
  const buf = new Uint8Array(byteLen);
  const topBits = byteLen * 8 - bitLengthBigInt(n);
  const topMask = topBits > 0 ? 0xff >>> topBits : 0xff;
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    buf[0] &= topMask;
    const k = bytesToBigInt(buf);
    if (k >= 1n && k < n) return k;
  }
}

export function ecdsaSignSync(
  curveName: FullEcCurveName,
  dBytes: Uint8Array,
  digestBytes: Uint8Array,
  dsaEncoding: 'der' | 'ieee-p1363',
): Buffer {
  const curve = EC_FULL_CURVES[curveName];
  const d = bytesToBigInt(dBytes);
  const z = truncateHashForCurve(digestBytes, curve.n);
  for (;;) {
    const k = randomScalarBelow(curve.n);
    const pt = jacobianMul(curve, curve.gx, curve.gy, k);
    if (!pt) continue;
    const r = pt[0] % curve.n;
    if (r === 0n) continue;
    const s = mod(modInvPrime(k, curve.n) * mod(z + mod(r * d, curve.n), curve.n), curve.n);
    if (s === 0n) continue;
    const rBytes = bigIntToUnsignedBytes(r, curve.coordBytes);
    const sBytes = bigIntToUnsignedBytes(s, curve.coordBytes);
    const p1363 = new Uint8Array(curve.coordBytes * 2);
    p1363.set(rBytes, 0);
    p1363.set(sBytes, curve.coordBytes);
    return dsaEncoding === 'ieee-p1363'
      ? Buffer.from(p1363)
      : ecdsaP1363ToDer(p1363, curve.coordBytes);
  }
}

export function ecdsaVerifySync(
  curveName: FullEcCurveName,
  xBytes: Uint8Array,
  yBytes: Uint8Array,
  digestBytes: Uint8Array,
  sigBytes: Uint8Array,
  dsaEncoding: 'der' | 'ieee-p1363',
): boolean {
  const curve = EC_FULL_CURVES[curveName];
  let p1363: Uint8Array;
  if (dsaEncoding === 'der') {
    const decoded = ecdsaDerToP1363(sigBytes, curve.coordBytes);
    if (!decoded) return false;
    p1363 = decoded;
  } else {
    if (sigBytes.byteLength !== curve.coordBytes * 2) return false;
    p1363 = sigBytes;
  }
  const r = bytesToBigInt(p1363.subarray(0, curve.coordBytes));
  const s = bytesToBigInt(p1363.subarray(curve.coordBytes));
  if (r < 1n || r >= curve.n || s < 1n || s >= curve.n) return false;
  const qx = bytesToBigInt(xBytes);
  const qy = bytesToBigInt(yBytes);
  if (!isPointOnFullCurve(curve, qx, qy)) return false;
  const z = truncateHashForCurve(digestBytes, curve.n);
  const w = modInvPrime(s, curve.n);
  const u1 = mod(z * w, curve.n);
  const u2 = mod(r * w, curve.n);
  const p1 = jacobianMul(curve, curve.gx, curve.gy, u1);
  const p2 = jacobianMul(curve, qx, qy, u2);
  const sum = ecPointAdd(curve, p1, p2);
  if (!sum) return false;
  return sum[0] % curve.n === r;
}

// --- Synchronous RSA Primitives (CRT, PKCS#1 v1.5, PSS, OAEP) ---

function rsaPrivateExp(priv: RsaPrivateData, c: bigint): bigint {
  if (priv.p > 1n && priv.q > 1n && priv.dp > 0n && priv.dq > 0n && priv.qi > 0n) {
    const m1 = modPow(c % priv.p, priv.dp, priv.p);
    const m2 = modPow(c % priv.q, priv.dq, priv.q);
    const h = mod(mod(m1 - m2, priv.p) * priv.qi, priv.p);
    const m = m2 + h * priv.q;
    if (modPow(m, priv.e, priv.n) === c) {
      return m;
    }
  }
  return modPow(c, priv.d, priv.n);
}

export function mgf1Sha(hashName: ShaDigestName, seed: Uint8Array, maskLen: number): Uint8Array {
  const out = new Uint8Array(maskLen);
  const seedBuf = Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength);
  const counter = Buffer.alloc(4);
  let offset = 0;
  for (let c = 0; offset < maskLen; c++) {
    counter.writeUInt32BE(c, 0);
    const block = shaHash(hashName).update(seedBuf).update(counter).digest();
    const take = Math.min(block.length, maskLen - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

const PKCS1_DIGEST_PREFIX_WITH_NULL: Record<ShaDigestName, Uint8Array> = {
  sha1: Uint8Array.from(Buffer.from('3021300906052b0e03021a05000414', 'hex')),
  sha224: Uint8Array.from(Buffer.from('302d300d06096086480165030402040500041c', 'hex')),
  sha256: Uint8Array.from(Buffer.from('3031300d060960864801650304020105000420', 'hex')),
  sha384: Uint8Array.from(Buffer.from('3041300d060960864801650304020205000430', 'hex')),
  sha512: Uint8Array.from(Buffer.from('3051300d060960864801650304020305000440', 'hex')),
};

const PKCS1_DIGEST_PREFIX_NO_NULL: Record<ShaDigestName, Uint8Array> = {
  sha1: Uint8Array.from(Buffer.from('301f300706052b0e03021a0414', 'hex')),
  sha224: Uint8Array.from(Buffer.from('302b300b0609608648016503040204041c', 'hex')),
  sha256: Uint8Array.from(Buffer.from('302f300b06096086480165030402010420', 'hex')),
  sha384: Uint8Array.from(Buffer.from('303f300b06096086480165030402020430', 'hex')),
  sha512: Uint8Array.from(Buffer.from('304f300b06096086480165030402030440', 'hex')),
};

const DIGEST_BYTE_SIZES: Record<ShaDigestName, number> = {
  sha1: 20,
  sha224: 28,
  sha256: 32,
  sha384: 48,
  sha512: 64,
};

const ERR_KEYTYPE_UNSUPPORTED_MSG =
  'error:03000096:digital envelope routines::operation not supported for this keytype';
const ERR_DIGEST_NOT_ALLOWED = 'error:1C8000AE:Provider routines::digest not allowed';
const ERR_ILLEGAL_PADDING = 'error:1C8000A5:Provider routines::illegal or unsupported padding mode';
const ERR_PSS_SALTLEN_TOO_SMALL = 'error:1C8000AC:Provider routines::pss saltlen too small';
const ERR_DATA_TOO_LARGE = 'error:0200006E:rsa routines::data too large for key size';
const ERR_DATA_TOO_LARGE_MODULUS = 'error:0200006C:rsa routines::data too large for modulus';
const ERR_DATA_NOT_MODULUS_LEN = 'error:0200006B:rsa routines::data greater than mod len';
const ERR_OAEP_DECODING = 'error:02000079:rsa routines::oaep decoding error';
const ERR_PKCS1_DECODING = 'error:02000072:rsa routines::block type is not 01';

function keytypeUnsupportedError(): Error {
  return Object.assign(new Error(ERR_KEYTYPE_UNSUPPORTED_MSG), {
    code: 'ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE',
  });
}

function resolveSyncRsaSignPlan(
  keyKind: 'rsa' | 'rsa-pss',
  modulusBits: number,
  pssConstraint: RsaPublicData['pss'],
  digestName: ShaDigestName,
  rsaPadding: number | undefined,
  pssSaltLength: number | undefined,
  mode: 'sign' | 'verify',
): { usePss: boolean; saltLength: number | 'auto'; mgf1Hash: ShaDigestName } {
  const hLen = DIGEST_BYTE_SIZES[digestName];
  if (keyKind === 'rsa-pss') {
    if (pssConstraint?.hashAlgorithm && pssConstraint.hashAlgorithm !== digestName) {
      throw new Error(ERR_DIGEST_NOT_ALLOWED);
    }
    if (rsaPadding !== undefined && rsaPadding !== RSA_PKCS1_PSS_PADDING) {
      throw new Error(ERR_ILLEGAL_PADDING);
    }
    const mgf1Raw = pssConstraint?.mgf1HashAlgorithm ?? digestName;
    const mgf1Hash: ShaDigestName =
      mgf1Raw === 'sha1' ||
      mgf1Raw === 'sha224' ||
      mgf1Raw === 'sha256' ||
      mgf1Raw === 'sha384' ||
      mgf1Raw === 'sha512'
        ? mgf1Raw
        : digestName;
    const maxSalt = Math.ceil((modulusBits - 1) / 8) - hLen - 2;
    let resolvedSalt: number | 'auto';
    if (pssSaltLength === undefined) {
      resolvedSalt =
        mode === 'sign'
          ? (pssConstraint?.saltLength ?? maxSalt)
          : (pssConstraint?.saltLength ?? 'auto');
    } else if (pssSaltLength === RSA_PSS_SALTLEN_DIGEST) {
      resolvedSalt = hLen;
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
    return { usePss: true, saltLength: resolvedSalt, mgf1Hash };
  }

  const padding = rsaPadding ?? RSA_PKCS1_PADDING;
  if (padding === RSA_PKCS1_PADDING) {
    return { usePss: false, saltLength: 0, mgf1Hash: digestName };
  }
  if (padding !== RSA_PKCS1_PSS_PADDING) {
    throw new Error(ERR_ILLEGAL_PADDING);
  }
  const maxSalt = Math.ceil((modulusBits - 1) / 8) - hLen - 2;
  let resolvedSalt: number | 'auto';
  if (pssSaltLength === undefined) {
    resolvedSalt = mode === 'sign' ? maxSalt : 'auto';
  } else if (pssSaltLength === RSA_PSS_SALTLEN_DIGEST) {
    resolvedSalt = hLen;
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
  return { usePss: true, saltLength: resolvedSalt, mgf1Hash: digestName };
}

export function rsaSignSync(
  priv: RsaPrivateData,
  digestName: ShaDigestName,
  mHash: Uint8Array,
  rsaPadding?: number,
  pssSaltLength?: number,
): Buffer {
  const modulusBits = bitLengthBigInt(priv.n);
  const k = Math.ceil(modulusBits / 8);
  const plan = resolveSyncRsaSignPlan(
    priv.kind,
    modulusBits,
    priv.pss,
    digestName,
    rsaPadding,
    pssSaltLength,
    'sign',
  );

  if (!plan.usePss) {
    const prefix = PKCS1_DIGEST_PREFIX_WITH_NULL[digestName];
    const tLen = prefix.byteLength + mHash.byteLength;
    if (k < tLen + 11) throw new Error(ERR_DATA_TOO_LARGE);
    const em = new Uint8Array(k);
    em[0] = 0x00;
    em[1] = 0x01;
    const psLen = k - tLen - 3;
    em.fill(0xff, 2, 2 + psLen);
    em[2 + psLen] = 0x00;
    em.set(prefix, 3 + psLen);
    em.set(mHash, 3 + psLen + prefix.byteLength);
    const m = bytesToBigInt(em);
    const s = rsaPrivateExp(priv, m);
    return Buffer.from(bigIntToUnsignedBytes(s, k));
  }

  // EMSA-PSS-ENCODE (RFC 8017 §9.1.1)
  const emBits = modulusBits - 1;
  const emLen = Math.ceil(emBits / 8);
  // Safe: resolveSyncRsaSignPlan(..., 'sign') always resolves saltLength to a number.
  const sLen = plan.saltLength as number;
  const hLen = mHash.byteLength;
  if (emLen < hLen + sLen + 2) throw new Error(ERR_DATA_TOO_LARGE);
  const salt = new Uint8Array(sLen);
  if (sLen > 0) globalThis.crypto.getRandomValues(salt);
  const mPrime = new Uint8Array(8 + hLen + sLen);
  mPrime.set(mHash, 8);
  mPrime.set(salt, 8 + hLen);
  const H = shaHash(digestName)
    .update(Buffer.from(mPrime.buffer, mPrime.byteOffset, mPrime.byteLength))
    .digest();
  const dbLen = emLen - hLen - 1;
  const db = new Uint8Array(dbLen);
  db[dbLen - sLen - 1] = 0x01;
  db.set(salt, dbLen - sLen);
  const dbMask = mgf1Sha(plan.mgf1Hash, H, dbLen);
  const maskedDb = new Uint8Array(dbLen);
  for (let i = 0; i < dbLen; i++) maskedDb[i] = db[i] ^ dbMask[i];
  const topBits = 8 * emLen - emBits;
  maskedDb[0] &= 0xff >>> topBits;
  const em = new Uint8Array(emLen);
  em.set(maskedDb, 0);
  em.set(H, dbLen);
  em[emLen - 1] = 0xbc;
  const m = bytesToBigInt(em);
  const s = rsaPrivateExp(priv, m);
  return Buffer.from(bigIntToUnsignedBytes(s, k));
}

export function rsaVerifySync(
  pub: RsaPublicData,
  digestName: ShaDigestName,
  mHash: Uint8Array,
  sigBytes: Uint8Array,
  rsaPadding?: number,
  pssSaltLength?: number,
): boolean {
  const modulusBits = bitLengthBigInt(pub.n);
  const k = Math.ceil(modulusBits / 8);
  const plan = resolveSyncRsaSignPlan(
    pub.kind,
    modulusBits,
    pub.pss,
    digestName,
    rsaPadding,
    pssSaltLength,
    'verify',
  );
  if (sigBytes.byteLength !== k) return false;
  const s = bytesToBigInt(sigBytes);
  if (s < 0n || s >= pub.n) return false;
  const m = modPow(s, pub.e, pub.n);

  if (!plan.usePss) {
    let em: Uint8Array;
    try {
      em = bigIntToUnsignedBytes(m, k);
    } catch {
      return false;
    }
    if (em[0] !== 0x00 || em[1] !== 0x01) return false;
    let idx = 2;
    while (idx < k && em[idx] === 0xff) idx++;
    if (idx < 10 || idx >= k || em[idx] !== 0x00) return false;
    const digestInfo = em.subarray(idx + 1);
    for (const prefix of [
      PKCS1_DIGEST_PREFIX_WITH_NULL[digestName],
      PKCS1_DIGEST_PREFIX_NO_NULL[digestName],
    ]) {
      if (digestInfo.byteLength === prefix.byteLength + mHash.byteLength) {
        if (
          bytesEqual(digestInfo.subarray(0, prefix.byteLength), prefix) &&
          bytesEqual(digestInfo.subarray(prefix.byteLength), mHash)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // EMSA-PSS-VERIFY (RFC 8017 §9.1.2)
  const emBits = modulusBits - 1;
  if (emBits <= 0) return false;
  const emLen = Math.ceil(emBits / 8);
  const hLen = mHash.byteLength;
  if (emLen < hLen + 2) return false;
  let em: Uint8Array;
  try {
    em = bigIntToUnsignedBytes(m, emLen);
  } catch {
    return false;
  }
  if (em[emLen - 1] !== 0xbc) return false;
  const dbLen = emLen - hLen - 1;
  const maskedDb = em.subarray(0, dbLen);
  const H = em.subarray(dbLen, dbLen + hLen);
  const topBits = 8 * emLen - emBits;
  const topMask = 0xff >>> topBits;
  if ((maskedDb[0] & ~topMask) !== 0) return false;
  const dbMask = mgf1Sha(plan.mgf1Hash, H, dbLen);
  const db = new Uint8Array(dbLen);
  for (let i = 0; i < dbLen; i++) db[i] = maskedDb[i] ^ dbMask[i];
  db[0] &= topMask;
  let idx = 0;
  while (idx < dbLen && db[idx] === 0x00) idx++;
  if (idx >= dbLen || db[idx] !== 0x01) return false;
  const recoveredSaltLen = dbLen - (idx + 1);
  if (plan.saltLength === 'auto') {
    if (pub.pss?.saltLength !== undefined && recoveredSaltLen < pub.pss.saltLength) {
      return false;
    }
  } else if (recoveredSaltLen !== plan.saltLength) {
    return false;
  }
  const salt = db.subarray(idx + 1);
  const mPrime = new Uint8Array(8 + hLen + recoveredSaltLen);
  mPrime.set(mHash, 8);
  mPrime.set(salt, 8 + hLen);
  const HPrime = shaHash(digestName)
    .update(Buffer.from(mPrime.buffer, mPrime.byteOffset, mPrime.byteLength))
    .digest();
  return bytesEqual(H, HPrime);
}

// --- Streaming Sign & Verify (createSign / createVerify) ---

const STREAM_SIGN_DIGESTS: Record<string, ShaDigestName> = {
  sha1: 'sha1',
  'sha-1': 'sha1',
  'rsa-sha1': 'sha1',
  'rsa-sha1-2': 'sha1',
  sha1withrsaencryption: 'sha1',
  'ssl3-sha1': 'sha1',
  'ecdsa-with-sha1': 'sha1',
  sha224: 'sha224',
  'sha-224': 'sha224',
  'sha2-224': 'sha224',
  'rsa-sha224': 'sha224',
  sha224withrsaencryption: 'sha224',
  'ecdsa-with-sha224': 'sha224',
  sha256: 'sha256',
  'sha-256': 'sha256',
  'sha2-256': 'sha256',
  'rsa-sha256': 'sha256',
  sha256withrsaencryption: 'sha256',
  'ecdsa-with-sha256': 'sha256',
  sha384: 'sha384',
  'sha-384': 'sha384',
  'sha2-384': 'sha384',
  'rsa-sha384': 'sha384',
  sha384withrsaencryption: 'sha384',
  'ecdsa-with-sha384': 'sha384',
  sha512: 'sha512',
  'sha-512': 'sha512',
  'sha2-512': 'sha512',
  'rsa-sha512': 'sha512',
  sha512withrsaencryption: 'sha512',
  'ecdsa-with-sha512': 'sha512',
};

const NATIVE_ONLY_STREAM_DIGESTS = new Set(
  (
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

function resolveStreamingDigest(algorithm: string): ShaDigestName {
  const lower = algorithm.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(STREAM_SIGN_DIGESTS, lower)) {
    return STREAM_SIGN_DIGESTS[lower];
  }
  if (NATIVE_ONLY_STREAM_DIGESTS.has(lower)) {
    throw fault('ENOSYS', `Digest algorithm '${algorithm}' is not supported`);
  }
  throw Object.assign(new TypeError('Invalid digest'), {
    code: 'ERR_CRYPTO_INVALID_DIGEST',
  });
}

function notInitialisedError(): Error {
  return Object.assign(new Error('Not initialised'), {
    code: 'ERR_CRYPTO_INVALID_STATE',
  });
}

const chunkInputTypes = typeList(['string'], ['Buffer', 'TypedArray', 'DataView']);
const bufferOrStringTypes = typeList(
  ['string'],
  ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView'],
);

function toUpdateBuffer(data: unknown, inputEncoding: unknown): Buffer {
  if (typeof data === 'string') {
    const enc = textEncoding(inputEncoding);
    if (enc === 'hex' && data.length % 2 !== 0) {
      throw Object.assign(
        new TypeError(
          `The argument 'encoding' is invalid for data of length ${data.length}. Received '${String(inputEncoding)}'`,
        ),
        { code: 'ERR_INVALID_ARG_VALUE' },
      );
    }
    return decodeText(data, enc ?? 'utf8');
  }
  if (!ArrayBuffer.isView(data)) {
    throw invalidArgType('data', chunkInputTypes, data);
  }
  const bytes = viewBytes(data);
  if (!bytes) throw invalidArgType('data', chunkInputTypes, data);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function getArrayBufferOrViewBytes(value: unknown, name: string, encoding?: unknown): Uint8Array {
  if (typeof value === 'string') {
    return stringBytes(value, encoding);
  }
  const view = viewBytes(value);
  if (view !== undefined) return view;
  throw invalidArgType(name, bufferOrStringTypes, value);
}

function getIntOpt(name: string, options: unknown): number | undefined {
  if (!record(options)) return undefined;
  const val = options[name];
  if (val !== undefined) {
    if (typeof val === 'number' && val === val >> 0) return val;
    throw invalidArgValue(`options.${name}`, val);
  }
  return undefined;
}

function getDsaEncOpt(options: unknown): 'der' | 'ieee-p1363' {
  if (record(options)) {
    const raw = options.dsaEncoding;
    const enc = raw === undefined ? 'der' : raw;
    if (enc === 'der' || enc === 'ieee-p1363') return enc;
    throw invalidArgValue('options.dsaEncoding', enc);
  }
  return 'der';
}

interface SignVerifyState {
  digestName: ShaDigestName;
  hasher: ReturnType<typeof shaHash>;
  finalized: boolean;
}

export interface SignInstance extends Writable {
  update(data: string | ArrayBufferView, inputEncoding?: BufferEncoding): this;
  sign(privateKey: unknown): Buffer;
  sign(privateKey: unknown, outputEncoding: BufferEncoding): string;
  sign(privateKey: unknown, outputEncoding?: unknown): Buffer | string;
}

export interface SignConstructor {
  new (algorithm: string, options?: unknown): SignInstance;
  (algorithm: string, options?: unknown): SignInstance;
  prototype: SignInstance;
}

export interface VerifyInstance extends Writable {
  update(data: string | ArrayBufferView, inputEncoding?: BufferEncoding): this;
  verify(
    object: unknown,
    signature: string | ArrayBuffer | ArrayBufferView,
    signatureEncoding?: BufferEncoding,
  ): boolean;
}

export interface VerifyConstructor {
  new (algorithm: string, options?: unknown): VerifyInstance;
  (algorithm: string, options?: unknown): VerifyInstance;
  prototype: VerifyInstance;
}

export function createStreamingSignVerify(WritableClass: typeof Writable): {
  Sign: SignConstructor;
  Verify: VerifyConstructor;
  createSign: (algorithm: string, options?: unknown) => SignInstance;
  createVerify: (algorithm: string, options?: unknown) => VerifyInstance;
} {
  const signStates = new WeakMap<object, SignVerifyState>();
  const verifyStates = new WeakMap<object, SignVerifyState>();

  const requireState = (map: WeakMap<object, SignVerifyState>, self: object, clsName: string) => {
    const st = map.get(self);
    if (!st) {
      throw Object.assign(new TypeError(`The "this" argument must be an instance of ${clsName}`), {
        code: 'ERR_INVALID_THIS',
      });
    }
    return st;
  };

  const initStream = (
    self: object,
    map: WeakMap<object, SignVerifyState>,
    algorithm: unknown,
    options: unknown,
  ) => {
    const algStr = validateString(algorithm, 'algorithm');
    const digestName = resolveStreamingDigest(algStr);
    if (fipsEnabled()) {
      throw keytypeUnsupportedError();
    }
    map.set(self, { digestName, hasher: shaHash(digestName), finalized: false });
    // Invariant: WritableClass is the bundled stream Writable constructor.
    (WritableClass as unknown as (this: object, opts?: unknown) => void).call(self, options);
  };

  const SignFn = function Sign(this: unknown, algorithm: unknown, options?: unknown) {
    if (!(this instanceof SignFn)) {
      // Invariant: SignFn is a callable constructor function.
      return new (SignFn as unknown as new (alg: unknown, opts?: unknown) => SignInstance)(
        algorithm,
        options,
      );
    }
    initStream(this, signStates, algorithm, options);
  };
  Object.setPrototypeOf(SignFn.prototype, WritableClass.prototype);
  Object.setPrototypeOf(SignFn, WritableClass);

  // Invariant: SignFn prototype methods defined below implement SignInstance.
  const Sign = SignFn as unknown as SignConstructor;

  Object.defineProperties(Sign.prototype, {
    _write: {
      writable: true,
      configurable: true,
      value: function _write(
        this: object,
        chunk: unknown,
        encoding: unknown,
        callback: (err?: Error | null) => void,
      ) {
        try {
          const st = requireState(signStates, this, 'Sign');
          if (st.finalized) throw notInitialisedError();
          st.hasher.update(toUpdateBuffer(chunk, encoding));
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    },
    update: {
      writable: true,
      configurable: true,
      value: function update(this: object, data: unknown, inputEncoding?: unknown) {
        const st = requireState(signStates, this, 'Sign');
        if (st.finalized) throw notInitialisedError();
        st.hasher.update(toUpdateBuffer(data, inputEncoding));
        return this;
      },
    },
    sign: {
      writable: true,
      configurable: true,
      value: function sign(this: object, privateKey: unknown, outputEncoding?: unknown) {
        const st = requireState(signStates, this, 'Sign');
        if (st.finalized) throw notInitialisedError();
        if (!privateKey) {
          throw Object.assign(new Error('No key provided to sign'), {
            code: 'ERR_CRYPTO_SIGN_KEY_REQUIRED',
          });
        }
        const rsaPadding = getIntOpt('padding', privateKey);
        const pssSaltLength = getIntOpt('saltLength', privateKey);
        const dsaEncoding = getDsaEncOpt(privateKey);
        const { keyObject } = resolvePrivateForSign(privateKey);
        const inspected = inspectKeyObjectSlot(keyObject);
        const priv = inspected.privateData;
        if (!priv) {
          if (inspected.nonExtractableType) {
            throw fault(
              'ENOSYS',
              'Synchronous Sign.prototype.sign on a non-extractable WebCrypto key is unsupported',
            );
          }
          throw keytypeUnsupportedError();
        }
        const mHash = st.hasher.digest();
        st.finalized = true;

        let sig: Buffer;
        if (priv.kind === 'rsa' || priv.kind === 'rsa-pss') {
          sig = rsaSignSync(priv, st.digestName, mHash, rsaPadding, pssSaltLength);
        } else if (priv.kind === 'ec') {
          sig = ecdsaSignSync(priv.namedCurve, priv.d, mHash, dsaEncoding);
        } else {
          throw keytypeUnsupportedError();
        }
        return encodeOutput(sig, outputEncoding || undefined);
      },
    },
  });

  const VerifyFn = function Verify(this: unknown, algorithm: unknown, options?: unknown) {
    if (!(this instanceof VerifyFn)) {
      // Invariant: VerifyFn is a callable constructor function.
      return new (VerifyFn as unknown as new (alg: unknown, opts?: unknown) => VerifyInstance)(
        algorithm,
        options,
      );
    }
    initStream(this, verifyStates, algorithm, options);
  };
  Object.setPrototypeOf(VerifyFn.prototype, WritableClass.prototype);
  Object.setPrototypeOf(VerifyFn, WritableClass);

  // Invariant: VerifyFn prototype methods defined below implement VerifyInstance.
  const Verify = VerifyFn as unknown as VerifyConstructor;

  Object.defineProperties(Verify.prototype, {
    _write: {
      writable: true,
      configurable: true,
      value: function _write(
        this: object,
        chunk: unknown,
        encoding: unknown,
        callback: (err?: Error | null) => void,
      ) {
        try {
          const st = requireState(verifyStates, this, 'Verify');
          if (st.finalized) throw notInitialisedError();
          st.hasher.update(toUpdateBuffer(chunk, encoding));
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    },
    update: {
      writable: true,
      configurable: true,
      value: function update(this: object, data: unknown, inputEncoding?: unknown) {
        const st = requireState(verifyStates, this, 'Verify');
        if (st.finalized) throw notInitialisedError();
        st.hasher.update(toUpdateBuffer(data, inputEncoding));
        return this;
      },
    },
    verify: {
      writable: true,
      configurable: true,
      value: function verify(
        this: object,
        object: unknown,
        signature: unknown,
        signatureEncoding?: unknown,
      ): boolean {
        const st = requireState(verifyStates, this, 'Verify');
        if (st.finalized) throw notInitialisedError();
        const rsaPadding = getIntOpt('padding', object);
        const pssSaltLength = getIntOpt('saltLength', object);
        const dsaEncoding = getDsaEncOpt(object);
        const sigBytes = getArrayBufferOrViewBytes(signature, 'signature', signatureEncoding);
        const { keyObject } = resolvePublicOrPrivateForVerify(object);
        const inspected = inspectKeyObjectSlot(keyObject);
        const pub: ParsedPublicKey | undefined =
          inspected.publicData ??
          (inspected.privateData
            ? publicFromPrivateData(inspected.privateData)
            : inspected.pairedPublicData);
        if (!pub) {
          if (inspected.nonExtractableType) {
            throw fault(
              'ENOSYS',
              'Synchronous Verify.prototype.verify on a non-extractable WebCrypto key is unsupported',
            );
          }
          throw keytypeUnsupportedError();
        }
        const mHash = st.hasher.digest();
        st.finalized = true;

        if (pub.kind === 'rsa' || pub.kind === 'rsa-pss') {
          return rsaVerifySync(pub, st.digestName, mHash, sigBytes, rsaPadding, pssSaltLength);
        }
        if (pub.kind === 'ec') {
          return ecdsaVerifySync(pub.namedCurve, pub.x, pub.y, mHash, sigBytes, dsaEncoding);
        }
        throw keytypeUnsupportedError();
      },
    },
  });

  return {
    Sign,
    Verify,
    createSign(algorithm: string, options?: unknown): SignInstance {
      return new Sign(algorithm, options);
    },
    createVerify(algorithm: string, options?: unknown): VerifyInstance {
      return new Verify(algorithm, options);
    },
  };
}

// --- RSA Asymmetric Encryption & Decryption ---

const OAEP_DIGESTS: Record<string, ShaDigestName> = {
  sha1: 'sha1',
  'sha-1': 'sha1',
  sha224: 'sha224',
  'sha-224': 'sha224',
  sha256: 'sha256',
  'sha-256': 'sha256',
  sha384: 'sha384',
  'sha-384': 'sha384',
  sha512: 'sha512',
  'sha-512': 'sha512',
};

function resolveOaepHash(name: string): ShaDigestName {
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(OAEP_DIGESTS, lower)) {
    return OAEP_DIGESTS[lower];
  }
  throw Object.assign(new TypeError('Invalid digest used'), {
    code: 'ERR_OSSL_EVP_INVALID_DIGEST',
  });
}

function parseRsaCipherOptions(
  keyArg: unknown,
  defaultPadding: number,
  requirePrivate: boolean,
): {
  pub: RsaPublicData;
  priv?: RsaPrivateData;
  padding: number;
  oaepHash: ShaDigestName;
  oaepLabel: Uint8Array;
  encoding?: unknown;
} {
  let padding = defaultPadding;
  let oaepHash: ShaDigestName = 'sha1';
  let oaepLabel: Uint8Array = new Uint8Array(0);
  let encoding: unknown;

  if (record(keyArg)) {
    if (keyArg.padding !== undefined) {
      const p = getIntOpt('padding', keyArg);
      if (p !== undefined) padding = p;
    }
    if (keyArg.oaepHash !== undefined) {
      oaepHash = resolveOaepHash(validateString(keyArg.oaepHash, 'key.oaepHash'));
    }
    if (keyArg.oaepLabel !== undefined) {
      oaepLabel = getArrayBufferOrViewBytes(keyArg.oaepLabel, 'key.oaepLabel', keyArg.encoding);
    }
    encoding = keyArg.encoding;
  }

  if (requirePrivate) {
    const { keyObject } = resolvePrivateForSign(keyArg);
    const inspected = inspectKeyObjectSlot(keyObject);
    const priv = inspected.privateData;
    if (!priv) {
      if (inspected.nonExtractableType) {
        throw fault('ENOSYS', 'RSA private decryption/encryption requires an extractable key');
      }
      throw keytypeUnsupportedError();
    }
    if (priv.kind !== 'rsa') {
      throw keytypeUnsupportedError();
    }
    return { pub: priv, priv, padding, oaepHash, oaepLabel, encoding };
  }

  const { keyObject } = resolvePublicOrPrivateForVerify(keyArg);
  const inspected = inspectKeyObjectSlot(keyObject);
  const pub: ParsedPublicKey | undefined =
    inspected.publicData ??
    (inspected.privateData
      ? publicFromPrivateData(inspected.privateData)
      : inspected.pairedPublicData);
  if (!pub || pub.kind !== 'rsa') {
    throw keytypeUnsupportedError();
  }
  return { pub, padding, oaepHash, oaepLabel, encoding };
}

function oaepEncode(
  msg: Uint8Array,
  k: number,
  hashName: ShaDigestName,
  label: Uint8Array,
): Uint8Array {
  const hLen = DIGEST_BYTE_SIZES[hashName];
  if (msg.byteLength > k - 2 * hLen - 2) {
    throw new Error(ERR_DATA_TOO_LARGE);
  }
  const lHash = shaHash(hashName)
    .update(Buffer.from(label.buffer, label.byteOffset, label.byteLength))
    .digest();
  const dbLen = k - hLen - 1;
  const db = new Uint8Array(dbLen);
  db.set(lHash, 0);
  db[dbLen - msg.byteLength - 1] = 0x01;
  db.set(msg, dbLen - msg.byteLength);

  const seed = new Uint8Array(hLen);
  globalThis.crypto.getRandomValues(seed);
  const dbMask = mgf1Sha(hashName, seed, dbLen);
  const maskedDb = new Uint8Array(dbLen);
  for (let i = 0; i < dbLen; i++) maskedDb[i] = db[i] ^ dbMask[i];
  const seedMask = mgf1Sha(hashName, maskedDb, hLen);
  const maskedSeed = new Uint8Array(hLen);
  for (let i = 0; i < hLen; i++) maskedSeed[i] = seed[i] ^ seedMask[i];

  const em = new Uint8Array(k);
  em[0] = 0x00;
  em.set(maskedSeed, 1);
  em.set(maskedDb, 1 + hLen);
  return em;
}

function oaepDecode(em: Uint8Array, k: number, hashName: ShaDigestName, label: Uint8Array): Buffer {
  const hLen = DIGEST_BYTE_SIZES[hashName];
  if (k < 2 * hLen + 2 || em.byteLength !== k) {
    throw new Error(ERR_OAEP_DECODING);
  }
  const lHash = shaHash(hashName)
    .update(Buffer.from(label.buffer, label.byteOffset, label.byteLength))
    .digest();
  const y = em[0];
  const maskedSeed = em.subarray(1, 1 + hLen);
  const maskedDb = em.subarray(1 + hLen);
  const dbLen = k - hLen - 1;
  const seedMask = mgf1Sha(hashName, maskedDb, hLen);
  const seed = new Uint8Array(hLen);
  for (let i = 0; i < hLen; i++) seed[i] = maskedSeed[i] ^ seedMask[i];
  const dbMask = mgf1Sha(hashName, seed, dbLen);
  const db = new Uint8Array(dbLen);
  for (let i = 0; i < dbLen; i++) db[i] = maskedDb[i] ^ dbMask[i];

  let bad = y !== 0 ? 1 : 0;
  for (let i = 0; i < hLen; i++) {
    bad |= db[i] ^ lHash[i];
  }
  let idx = hLen;
  while (idx < dbLen && db[idx] === 0x00) idx++;
  if (idx >= dbLen || db[idx] !== 0x01) bad = 1;
  if (bad !== 0) {
    throw new Error(ERR_OAEP_DECODING);
  }
  return Buffer.from(db.subarray(idx + 1));
}

function pkcs1Type2Pad(msg: Uint8Array, k: number): Uint8Array {
  if (msg.byteLength > k - 11) {
    throw new Error(ERR_DATA_TOO_LARGE);
  }
  const psLen = k - msg.byteLength - 3;
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x02;
  const rnd = new Uint8Array(psLen);
  for (let i = 0; i < psLen; i++) {
    let b = 0;
    while (b === 0) {
      globalThis.crypto.getRandomValues(rnd.subarray(i, i + 1));
      b = rnd[i];
    }
    em[2 + i] = b;
  }
  em[2 + psLen] = 0x00;
  em.set(msg, 3 + psLen);
  return em;
}

function pkcs1Type1Pad(msg: Uint8Array, k: number): Uint8Array {
  if (msg.byteLength > k - 11) {
    throw new Error(ERR_DATA_TOO_LARGE);
  }
  const psLen = k - msg.byteLength - 3;
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x01;
  em.fill(0xff, 2, 2 + psLen);
  em[2 + psLen] = 0x00;
  em.set(msg, 3 + psLen);
  return em;
}

function pkcs1Type1Unpad(em: Uint8Array, k: number): Buffer {
  if (em.byteLength !== k || em[0] !== 0x00 || em[1] !== 0x01) {
    throw new Error(ERR_PKCS1_DECODING);
  }
  let idx = 2;
  while (idx < k && em[idx] === 0xff) idx++;
  if (idx < 10 || idx >= k || em[idx] !== 0x00) {
    throw new Error(ERR_PKCS1_DECODING);
  }
  return Buffer.from(em.subarray(idx + 1));
}

export function createRsaCipher() {
  function publicEncrypt(key: unknown, buffer: unknown): Buffer {
    const { pub, padding, oaepHash, oaepLabel, encoding } = parseRsaCipherOptions(
      key,
      RSA_PKCS1_OAEP_PADDING,
      false,
    );
    const msg = getArrayBufferOrViewBytes(buffer, 'buffer', encoding);
    const k = Math.ceil(bitLengthBigInt(pub.n) / 8);
    let em: Uint8Array;
    if (padding === RSA_PKCS1_OAEP_PADDING) {
      em = oaepEncode(msg, k, oaepHash, oaepLabel);
    } else if (padding === RSA_PKCS1_PADDING) {
      em = pkcs1Type2Pad(msg, k);
    } else if (padding === RSA_NO_PADDING) {
      if (msg.byteLength !== k) throw new Error(ERR_DATA_NOT_MODULUS_LEN);
      em = msg;
    } else {
      throw new Error(ERR_ILLEGAL_PADDING);
    }
    const m = bytesToBigInt(em);
    if (m >= pub.n) throw new Error(ERR_DATA_TOO_LARGE_MODULUS);
    const c = modPow(m, pub.e, pub.n);
    return Buffer.from(bigIntToUnsignedBytes(c, k));
  }

  function privateDecrypt(privateKey: unknown, buffer: unknown): Buffer {
    const { priv, padding, oaepHash, oaepLabel, encoding } = parseRsaCipherOptions(
      privateKey,
      RSA_PKCS1_OAEP_PADDING,
      true,
    );
    if (padding === RSA_PKCS1_PADDING) {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_VALUE',
        'RSA_PKCS1_PADDING is no longer supported for private decryption',
      );
    }
    const ct = getArrayBufferOrViewBytes(buffer, 'buffer', encoding);
    const rPriv = priv!;
    const k = Math.ceil(bitLengthBigInt(rPriv.n) / 8);
    if (ct.byteLength !== k) throw new Error(ERR_DATA_NOT_MODULUS_LEN);
    const c = bytesToBigInt(ct);
    if (c >= rPriv.n) throw new Error(ERR_DATA_TOO_LARGE_MODULUS);
    const m = rsaPrivateExp(rPriv, c);
    const em = bigIntToUnsignedBytes(m, k);
    if (padding === RSA_PKCS1_OAEP_PADDING) {
      return oaepDecode(em, k, oaepHash, oaepLabel);
    }
    if (padding === RSA_NO_PADDING) {
      return Buffer.from(em);
    }
    throw new Error(ERR_ILLEGAL_PADDING);
  }

  function privateEncrypt(privateKey: unknown, buffer: unknown): Buffer {
    const { priv, padding, encoding } = parseRsaCipherOptions(privateKey, RSA_PKCS1_PADDING, true);
    const msg = getArrayBufferOrViewBytes(buffer, 'buffer', encoding);
    const rPriv = priv!;
    const k = Math.ceil(bitLengthBigInt(rPriv.n) / 8);
    let em: Uint8Array;
    if (padding === RSA_PKCS1_PADDING) {
      em = pkcs1Type1Pad(msg, k);
    } else if (padding === RSA_NO_PADDING) {
      if (msg.byteLength !== k) throw new Error(ERR_DATA_NOT_MODULUS_LEN);
      em = msg;
    } else {
      throw new Error(ERR_ILLEGAL_PADDING);
    }
    const m = bytesToBigInt(em);
    if (m >= rPriv.n) throw new Error(ERR_DATA_TOO_LARGE_MODULUS);
    const c = rsaPrivateExp(rPriv, m);
    return Buffer.from(bigIntToUnsignedBytes(c, k));
  }

  function publicDecrypt(key: unknown, buffer: unknown): Buffer {
    const { pub, padding, encoding } = parseRsaCipherOptions(key, RSA_PKCS1_PADDING, false);
    const ct = getArrayBufferOrViewBytes(buffer, 'buffer', encoding);
    const k = Math.ceil(bitLengthBigInt(pub.n) / 8);
    if (ct.byteLength !== k) throw new Error(ERR_DATA_NOT_MODULUS_LEN);
    const c = bytesToBigInt(ct);
    if (c >= pub.n) throw new Error(ERR_DATA_TOO_LARGE_MODULUS);
    const m = modPow(c, pub.e, pub.n);
    const em = bigIntToUnsignedBytes(m, k);
    if (padding === RSA_PKCS1_PADDING) {
      return pkcs1Type1Unpad(em, k);
    }
    if (padding === RSA_NO_PADDING) {
      return Buffer.from(em);
    }
    throw new Error(ERR_ILLEGAL_PADDING);
  }

  return { publicEncrypt, privateDecrypt, privateEncrypt, publicDecrypt };
}
