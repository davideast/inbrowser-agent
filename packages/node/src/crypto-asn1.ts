import { Buffer } from 'buffer';
import createShaHash from 'sha.js';
import { fault } from './protocol';

// ASN.1 DER, PEM, JWK, curve scalar multiplication (Ed25519, X25519, P-256,
// P-384, P-521), and ECDSA DER <-> IEEE P1363 signature conversion shared by
// KeyObject (crypto-keys.ts) and sign/verify (crypto-sign.ts).

export type AsymmetricKeyTypeName = 'rsa' | 'rsa-pss' | 'ec' | 'ed25519' | 'x25519' | 'dh';
export type EcCurveName = 'prime256v1' | 'secp384r1' | 'secp521r1';
export type WebCryptoCurveName = 'P-256' | 'P-384' | 'P-521';

export interface RsaPssParams {
  hashAlgorithm: string;
  mgf1HashAlgorithm: string;
  saltLength: number;
}

export interface RsaPublicData {
  kind: 'rsa' | 'rsa-pss';
  n: bigint;
  e: bigint;
  pss?: RsaPssParams;
}

export interface RsaPrivateData extends RsaPublicData {
  d: bigint;
  p: bigint;
  q: bigint;
  dp: bigint;
  dq: bigint;
  qi: bigint;
}

export interface EcPublicData {
  kind: 'ec';
  namedCurve: EcCurveName;
  x: Uint8Array;
  y: Uint8Array;
}

export interface EcPrivateData extends EcPublicData {
  d: Uint8Array;
}

export interface OkpPublicData {
  kind: 'ed25519' | 'x25519';
  x: Uint8Array;
}

export interface OkpPrivateData extends OkpPublicData {
  d: Uint8Array;
}

export interface DhPublicData {
  kind: 'dh';
  p: bigint;
  g: bigint;
  y: bigint;
}

export interface DhPrivateData extends DhPublicData {
  x: bigint;
}

export type ParsedPublicKey = RsaPublicData | EcPublicData | OkpPublicData | DhPublicData;
export type ParsedPrivateKey = RsaPrivateData | EcPrivateData | OkpPrivateData | DhPrivateData;

const OID_RSA_ENCRYPTION = '2a864886f70d010101';
const OID_RSASSA_PSS = '2a864886f70d01010a';
const OID_MGF1 = '2a864886f70d010108';
const OID_EC_PUBLIC_KEY = '2a8648ce3d0201';
const OID_P256 = '2a8648ce3d030107';
const OID_P384 = '2b81040022';
const OID_P521 = '2b81040023';
const OID_SECP256K1 = '2b8104000a';
const OID_ED25519 = '2b6570';
const OID_X25519 = '2b656e';
const OID_ED448 = '2b6571';
const OID_X448 = '2b656f';
const OID_DSA = '2a8648ce380401';
const OID_DH = '2a864886f70d010301';

const HASH_OIDS: Record<string, { oid: string; size: number }> = {
  sha1: { oid: '2b0e03021a', size: 20 },
  sha224: { oid: '608648016503040204', size: 28 },
  sha256: { oid: '608648016503040201', size: 32 },
  sha384: { oid: '608648016503040202', size: 48 },
  sha512: { oid: '608648016503040203', size: 64 },
};

const OID_TO_HASH: Record<string, string> = Object.fromEntries(
  Object.entries(HASH_OIDS).map(([name, info]) => [info.oid, name]),
);

export const EC_CURVE_INFO: Record<
  EcCurveName,
  {
    oid: string;
    jwkCrv: WebCryptoCurveName;
    coordBytes: number;
    p: bigint;
    b: bigint;
    gx: bigint;
    gy: bigint;
  }
> = {
  prime256v1: {
    oid: OID_P256,
    jwkCrv: 'P-256',
    coordBytes: 32,
    p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
    b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
    gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  },
  secp384r1: {
    oid: OID_P384,
    jwkCrv: 'P-384',
    coordBytes: 48,
    p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffffn,
    b: 0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn,
    gx: 0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7n,
    gy: 0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5fn,
  },
  secp521r1: {
    oid: OID_P521,
    jwkCrv: 'P-521',
    coordBytes: 66,
    p: (1n << 521n) - 1n,
    b: 0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00n,
    gx: 0x00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66n,
    gy: 0x011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650n,
  },
};

export function normalizeEcCurveName(name: string): EcCurveName | 'secp256k1' | undefined {
  switch (name) {
    case 'prime256v1':
    case 'P-256':
      return 'prime256v1';
    case 'secp384r1':
    case 'P-384':
      return 'secp384r1';
    case 'secp521r1':
    case 'P-521':
      return 'secp521r1';
    case 'secp256k1':
      return 'secp256k1';
    default:
      return undefined;
  }
}

function curveFromOid(oidHex: string): EcCurveName {
  if (oidHex === OID_P256) return 'prime256v1';
  if (oidHex === OID_P384) return 'secp384r1';
  if (oidHex === OID_P521) return 'secp521r1';
  if (oidHex === OID_SECP256K1) {
    throw fault('ENOSYS', 'EC curve secp256k1 is not supported by WebCrypto');
  }
  throw decodeError();
}

export function decodeError(): Error {
  return Object.assign(new Error('error:1E08010C:DECODER routines::unsupported'), {
    code: 'ERR_OSSL_UNSUPPORTED',
  });
}

export function invalidJwkError(): TypeError {
  return Object.assign(new TypeError('Invalid JWK data'), { code: 'ERR_CRYPTO_INVALID_JWK' });
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) throw invalidJwkError();
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

export function bigIntToUnsignedBytes(value: bigint, fixedLength?: number): Uint8Array {
  if (value < 0n) throw decodeError();
  if (fixedLength !== undefined) {
    const out = new Uint8Array(fixedLength);
    let rem = value;
    for (let i = fixedLength - 1; i >= 0; i--) {
      out[i] = Number(rem & 0xffn);
      rem >>= 8n;
    }
    if (rem > 0n) throw invalidJwkError();
    return out;
  }
  if (value === 0n) return Uint8Array.of(0);
  const bytes: number[] = [];
  let rem = value;
  while (rem > 0n) {
    bytes.push(Number(rem & 0xffn));
    rem >>= 8n;
  }
  bytes.reverse();
  return Uint8Array.from(bytes);
}

export function bitLengthBigInt(value: bigint): number {
  let rem = value;
  let bits = 0;
  while (rem > 0n) {
    rem >>= 1n;
    bits++;
  }
  return bits;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// --- Modular & elliptic-curve math for synchronous public-key derivation ---

function mod(a: bigint, p: bigint): bigint {
  const r = a % p;
  return r >= 0n ? r : r + p;
}

export function modPow(base: bigint, exp: bigint, p: bigint): bigint {
  let result = 1n;
  let b = mod(base, p);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % p;
    b = (b * b) % p;
    e >>= 1n;
  }
  return result;
}

function modInv(a: bigint, p: bigint): bigint {
  return modPow(a, p - 2n, p);
}

const P25519 = (1n << 255n) - 19n;
const ED_D = mod(-121665n * modInv(121666n, P25519), P25519);
const ED_BY = mod(4n * modInv(5n, P25519), P25519);
const ED_BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;

type EdPoint = [bigint, bigint, bigint, bigint];

function edAdd(first: EdPoint, second: EdPoint): EdPoint {
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

export function deriveEd25519PublicKey(seed: Uint8Array): Uint8Array {
  const digest = createShaHash('sha512')
    .update(Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength))
    .digest();
  digest[0] &= 248;
  digest[31] &= 127;
  digest[31] |= 64;
  let scalar = 0n;
  for (let i = 0; i < 32; i++) scalar |= BigInt(digest[i]) << BigInt(8 * i);
  let acc: EdPoint = [0n, 1n, 1n, 0n];
  let cur: EdPoint = [ED_BX, ED_BY, 1n, mod(ED_BX * ED_BY, P25519)];
  while (scalar > 0n) {
    if (scalar & 1n) acc = edAdd(acc, cur);
    cur = edAdd(cur, cur);
    scalar >>= 1n;
  }
  const zInv = modInv(acc[2], P25519);
  const x = mod(acc[0] * zInv, P25519);
  const y = mod(acc[1] * zInv, P25519);
  const out = new Uint8Array(32);
  let rem = y;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  out[31] |= Number(x & 1n) << 7;
  return out;
}

export function deriveX25519PublicKey(seed: Uint8Array): Uint8Array {
  const clamped = Uint8Array.from(seed);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  let scalar = 0n;
  for (let i = 0; i < 32; i++) scalar |= BigInt(clamped[i]) << BigInt(8 * i);
  const x1 = 9n;
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
  const u = mod(x2 * modInv(z2, P25519), P25519);
  const out = new Uint8Array(32);
  let rem = u;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  return out;
}

type WeierstrassPoint = [bigint, bigint] | null;

function weierstrassAdd(
  first: WeierstrassPoint,
  second: WeierstrassPoint,
  p: bigint,
): WeierstrassPoint {
  if (!first) return second;
  if (!second) return first;
  const [x1, y1] = first;
  const [x2, y2] = second;
  if (x1 === x2) {
    if (mod(y1 + y2, p) === 0n) return null;
    const slope = mod((3n * x1 * x1 - 3n) * modInv(2n * y1, p), p);
    const x3 = mod(slope * slope - 2n * x1, p);
    return [x3, mod(slope * (x1 - x3) - y1, p)];
  }
  const slope = mod((y2 - y1) * modInv(x2 - x1, p), p);
  const x3 = mod(slope * slope - x1 - x2, p);
  return [x3, mod(slope * (x1 - x3) - y1, p)];
}

export function deriveEcPublicCoords(
  curve: EcCurveName,
  dBytes: Uint8Array,
): { x: Uint8Array; y: Uint8Array } {
  const info = EC_CURVE_INFO[curve];
  let scalar = bytesToBigInt(dBytes);
  if (scalar <= 0n || scalar >= info.p) throw decodeError();
  let acc: WeierstrassPoint = null;
  let cur: WeierstrassPoint = [info.gx, info.gy];
  while (scalar > 0n) {
    if (scalar & 1n) acc = weierstrassAdd(acc, cur, info.p);
    cur = weierstrassAdd(cur, cur, info.p);
    scalar >>= 1n;
  }
  if (!acc) throw decodeError();
  return {
    x: bigIntToUnsignedBytes(acc[0], info.coordBytes),
    y: bigIntToUnsignedBytes(acc[1], info.coordBytes),
  };
}

export function isValidEcPoint(
  curve: EcCurveName,
  xBytes: Uint8Array,
  yBytes: Uint8Array,
): boolean {
  const info = EC_CURVE_INFO[curve];
  if (xBytes.byteLength !== info.coordBytes || yBytes.byteLength !== info.coordBytes) return false;
  const x = bytesToBigInt(xBytes);
  const y = bytesToBigInt(yBytes);
  if (x >= info.p || y >= info.p) return false;
  const lhs = mod(y * y, info.p);
  const rhs = mod(mod(x * x, info.p) * x - 3n * x + info.b, info.p);
  return lhs === rhs;
}

/**
 * Decodes an X9.62 uncompressed (`0x04 || x || y`), compressed (`0x02`/`0x03 || x`),
 * or (when `allowHybrid` is true, as in ASN.1 SPKI/SEC1 DER) hybrid (`0x06`/`0x07 || x || y`)
 * EC point on P-256, P-384, or P-521 (all satisfying `p === 3 mod 4`) and validates
 * curve membership and parity.
 */
export function decodeEcPoint(
  curve: EcCurveName,
  pointBytes: Uint8Array,
  allowHybrid = true,
): { x: Uint8Array; y: Uint8Array } {
  const info = EC_CURVE_INFO[curve];
  const len = info.coordBytes;
  if (pointBytes.byteLength === 1 + 2 * len) {
    const prefix = pointBytes[0];
    if (prefix === 0x04 || (allowHybrid && (prefix === 0x06 || prefix === 0x07))) {
      const x = Uint8Array.from(pointBytes.subarray(1, 1 + len));
      const y = Uint8Array.from(pointBytes.subarray(1 + len));
      if (!isValidEcPoint(curve, x, y)) throw decodeError();
      if (prefix === 0x06 || prefix === 0x07) {
        const expectedParity = prefix === 0x07 ? 1 : 0;
        if ((y[y.byteLength - 1] & 1) !== expectedParity) throw decodeError();
      }
      return { x, y };
    }
  }
  if (pointBytes.byteLength === 1 + len && (pointBytes[0] === 0x02 || pointBytes[0] === 0x03)) {
    const xBytes = Uint8Array.from(pointBytes.subarray(1));
    const x = bytesToBigInt(xBytes);
    if (x >= info.p) throw decodeError();
    const rhs = mod(mod(x * x, info.p) * x - 3n * x + info.b, info.p);
    let y = modPow(rhs, (info.p + 1n) >> 2n, info.p);
    if (mod(y * y, info.p) !== rhs) throw decodeError();
    const yParity = BigInt(pointBytes[0] & 1);
    if ((y & 1n) !== yParity) y = y === 0n ? 0n : info.p - y;
    if ((y & 1n) !== yParity) throw decodeError();
    let yBytes: Uint8Array;
    try {
      yBytes = bigIntToUnsignedBytes(y, len);
    } catch {
      throw decodeError();
    }
    if (!isValidEcPoint(curve, xBytes, yBytes)) throw decodeError();
    return { x: xBytes, y: yBytes };
  }
  throw decodeError();
}

// --- ASN.1 DER encoder & decoder ---

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  if (length <= 0xff) return Uint8Array.of(0x81, length);
  if (length <= 0xffff) return Uint8Array.of(0x82, (length >> 8) & 0xff, length & 0xff);
  if (length <= 0xffffff) {
    return Uint8Array.of(0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
  }
  return Uint8Array.of(
    0x84,
    (length >>> 24) & 0xff,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  );
}

function derTlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), derLength(content.byteLength), content);
}

function derSequence(...items: Uint8Array[]): Uint8Array {
  return derTlv(0x30, concatBytes(...items));
}

function derIntegerBigInt(value: bigint): Uint8Array {
  const raw = bigIntToUnsignedBytes(value);
  const body = raw[0] & 0x80 ? concatBytes(Uint8Array.of(0x00), raw) : raw;
  return derTlv(0x02, body);
}

function derOctetString(bytes: Uint8Array): Uint8Array {
  return derTlv(0x04, bytes);
}

function derBitString(bytes: Uint8Array): Uint8Array {
  return derTlv(0x03, concatBytes(Uint8Array.of(0x00), bytes));
}

function derNull(): Uint8Array {
  return Uint8Array.of(0x05, 0x00);
}

function derOid(hexBody: string): Uint8Array {
  return derTlv(0x06, Uint8Array.from(Buffer.from(hexBody, 'hex')));
}

function derExplicit(tagNumber: number, inner: Uint8Array): Uint8Array {
  return derTlv(0xa0 | tagNumber, inner);
}

export interface TlvNode {
  tag: number;
  content: Uint8Array;
  next: number;
}

export function readTlv(buf: Uint8Array, offset: number): TlvNode {
  if (offset >= buf.byteLength || offset + 2 > buf.byteLength) throw decodeError();
  const tag = buf[offset];
  const firstLen = buf[offset + 1];
  let headerEnd = offset + 2;
  let length = 0;
  if ((firstLen & 0x80) === 0) {
    length = firstLen;
  } else {
    const count = firstLen & 0x7f;
    // Canonical DER (ITU-T X.690 §10.1) forbids indefinite lengths and leading zero length octets.
    if (count === 0 || count > 4 || headerEnd + count > buf.byteLength || buf[headerEnd] === 0) {
      throw decodeError();
    }
    for (let i = 0; i < count; i++) {
      length = (length << 8) | buf[headerEnd + i];
    }
    if (length < 0x80) throw decodeError();
    headerEnd += count;
  }
  const end = headerEnd + length;
  if (end > buf.byteLength) throw decodeError();
  return { tag, content: buf.subarray(headerEnd, end), next: end };
}

export function readExactTlv(buf: Uint8Array, expectedTag?: number): TlvNode {
  const node = readTlv(buf, 0);
  if (node.next !== buf.byteLength) throw decodeError();
  if (expectedTag !== undefined && node.tag !== expectedTag) throw decodeError();
  return node;
}

export function readChildren(content: Uint8Array): TlvNode[] {
  const out: TlvNode[] = [];
  let cursor = 0;
  while (cursor < content.byteLength) {
    const child = readTlv(content, cursor);
    out.push(child);
    cursor = child.next;
  }
  return out;
}

export function readUnsignedInteger(node: TlvNode): bigint {
  if (node.tag !== 0x02 || node.content.byteLength === 0) throw decodeError();
  if (node.content[0] & 0x80) throw decodeError();
  if (node.content.byteLength > 1 && node.content[0] === 0 && (node.content[1] & 0x80) === 0) {
    throw decodeError();
  }
  return bytesToBigInt(node.content);
}

export function readBitStringBytes(node: TlvNode): Uint8Array {
  if (node.tag !== 0x03 || node.content.byteLength < 1 || node.content[0] !== 0x00) {
    throw decodeError();
  }
  return node.content.subarray(1);
}

export function oidHex(node: TlvNode): string {
  if (node.tag !== 0x06) throw decodeError();
  return Buffer.from(
    node.content.buffer,
    node.content.byteOffset,
    node.content.byteLength,
  ).toString('hex');
}

// --- PEM framing ---

export function wrapPem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der.buffer, der.byteOffset, der.byteLength).toString('base64');
  const lines: string[] = [`-----BEGIN ${label}-----`];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  lines.push(`-----END ${label}-----`, '');
  return lines.join('\n');
}

export function unwrapPem(pemText: string): { label: string; der: Uint8Array } {
  if (
    pemText.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----') ||
    /Proc-Type:\s*4,\s*ENCRYPTED/i.test(pemText)
  ) {
    throw fault('ENOSYS', 'Encrypted PEM keys and passphrases are not supported in WebCrypto');
  }
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]+?)-----END \1-----/.exec(pemText);
  if (!match) throw decodeError();
  const label = match[1];
  const body = match[2].replace(/[\r\n\s]+/g, '');
  if (body.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw decodeError();
  return { label, der: Uint8Array.from(Buffer.from(body, 'base64')) };
}

// --- RSA-PSS AlgorithmIdentifier codec ---

function encodeRsaPssAlgorithmIdentifier(pss: RsaPssParams | undefined): Uint8Array {
  if (pss === undefined) {
    return derSequence(derOid(OID_RSASSA_PSS));
  }
  const hashInfo = HASH_OIDS[pss.hashAlgorithm];
  const mgf1Info = HASH_OIDS[pss.mgf1HashAlgorithm];
  if (!hashInfo || !mgf1Info) {
    throw fault(
      'ENOSYS',
      `RSA-PSS digest ${pss.hashAlgorithm}/${pss.mgf1HashAlgorithm} is unsupported`,
    );
  }
  const parts: Uint8Array[] = [];
  if (pss.hashAlgorithm !== 'sha1') {
    parts.push(derExplicit(0, derSequence(derOid(hashInfo.oid), derNull())));
  }
  if (pss.mgf1HashAlgorithm !== 'sha1') {
    parts.push(
      derExplicit(1, derSequence(derOid(OID_MGF1), derSequence(derOid(mgf1Info.oid), derNull()))),
    );
  }
  if (pss.saltLength !== 20) {
    parts.push(derExplicit(2, derIntegerBigInt(BigInt(pss.saltLength))));
  }
  return derSequence(derOid(OID_RSASSA_PSS), derSequence(...parts));
}

function decodeRsaPssParams(algChildren: TlvNode[]): RsaPssParams | undefined {
  if (algChildren.length < 2) return undefined;
  const paramNode = algChildren[1];
  if (paramNode.tag !== 0x30) throw decodeError();
  let hashAlgorithm = 'sha1';
  let mgf1HashAlgorithm = 'sha1';
  let saltLength = 20;
  for (const field of readChildren(paramNode.content)) {
    if (field.tag === 0xa0) {
      const hashSeq = readExactTlv(field.content, 0x30);
      const items = readChildren(hashSeq.content);
      if (items.length < 1) throw decodeError();
      const name = OID_TO_HASH[oidHex(items[0])];
      if (!name) throw fault('ENOSYS', 'Unsupported RSA-PSS hash OID');
      hashAlgorithm = name;
    } else if (field.tag === 0xa1) {
      const mgfSeq = readExactTlv(field.content, 0x30);
      const items = readChildren(mgfSeq.content);
      if (items.length !== 2 || oidHex(items[0]) !== OID_MGF1 || items[1].tag !== 0x30) {
        throw decodeError();
      }
      const inner = readChildren(items[1].content);
      if (inner.length < 1) throw decodeError();
      const name = OID_TO_HASH[oidHex(inner[0])];
      if (!name) throw fault('ENOSYS', 'Unsupported RSA-PSS MGF1 hash OID');
      mgf1HashAlgorithm = name;
    } else if (field.tag === 0xa2) {
      const saltInt = readExactTlv(field.content, 0x02);
      saltLength = Number(readUnsignedInteger(saltInt));
    }
  }
  return { hashAlgorithm, mgf1HashAlgorithm, saltLength };
}

export function resolveRsaPssKeygenParams(options: {
  hashAlgorithm?: string;
  mgf1HashAlgorithm?: string;
  saltLength?: number;
}): RsaPssParams | undefined {
  const { hashAlgorithm, mgf1HashAlgorithm, saltLength } = options;
  if (hashAlgorithm === undefined && mgf1HashAlgorithm === undefined && saltLength === undefined) {
    return undefined;
  }
  const hashName = (hashAlgorithm ?? 'sha1').toLowerCase();
  const hashInfo = HASH_OIDS[hashName];
  if (!hashInfo) {
    throw Object.assign(new TypeError(`Invalid digest: ${hashAlgorithm}`), {
      code: 'ERR_CRYPTO_INVALID_DIGEST',
    });
  }
  const mgf1Name = (mgf1HashAlgorithm ?? hashName).toLowerCase();
  if (!HASH_OIDS[mgf1Name]) {
    throw Object.assign(new TypeError(`Invalid MGF1 digest: ${mgf1HashAlgorithm}`), {
      code: 'ERR_CRYPTO_INVALID_DIGEST',
    });
  }
  return {
    hashAlgorithm: hashName,
    mgf1HashAlgorithm: mgf1Name,
    saltLength: saltLength ?? hashInfo.size,
  };
}

// --- Key encoding (Public & Private -> DER) ---

export function encodePublicKeyDer(data: ParsedPublicKey, encodingType: 'spki' | 'pkcs1'): Buffer {
  if (encodingType === 'pkcs1') {
    if (data.kind !== 'rsa') throw decodeError();
    return Buffer.from(derSequence(derIntegerBigInt(data.n), derIntegerBigInt(data.e)));
  }
  switch (data.kind) {
    case 'ec': {
      const curveOid = EC_CURVE_INFO[data.namedCurve].oid;
      const uncompressed = concatBytes(Uint8Array.of(0x04), data.x, data.y);
      return Buffer.from(
        derSequence(
          derSequence(derOid(OID_EC_PUBLIC_KEY), derOid(curveOid)),
          derBitString(uncompressed),
        ),
      );
    }
    case 'ed25519':
    case 'x25519': {
      const oid = data.kind === 'ed25519' ? OID_ED25519 : OID_X25519;
      return Buffer.from(derSequence(derSequence(derOid(oid)), derBitString(data.x)));
    }
    case 'dh': {
      const params = derSequence(derIntegerBigInt(data.p), derIntegerBigInt(data.g));
      return Buffer.from(
        derSequence(derSequence(derOid(OID_DH), params), derBitString(derIntegerBigInt(data.y))),
      );
    }
    case 'rsa':
    case 'rsa-pss': {
      const pkcs1 = derSequence(derIntegerBigInt(data.n), derIntegerBigInt(data.e));
      const algId =
        data.kind === 'rsa'
          ? derSequence(derOid(OID_RSA_ENCRYPTION), derNull())
          : encodeRsaPssAlgorithmIdentifier(data.pss);
      return Buffer.from(derSequence(algId, derBitString(pkcs1)));
    }
  }
}

export function encodePrivateKeyDer(
  data: ParsedPrivateKey,
  encodingType: 'pkcs8' | 'pkcs1' | 'sec1',
): Buffer {
  if (encodingType === 'pkcs1') {
    if (data.kind !== 'rsa') throw decodeError();
    return Buffer.from(
      derSequence(
        derIntegerBigInt(0n),
        derIntegerBigInt(data.n),
        derIntegerBigInt(data.e),
        derIntegerBigInt(data.d),
        derIntegerBigInt(data.p),
        derIntegerBigInt(data.q),
        derIntegerBigInt(data.dp),
        derIntegerBigInt(data.dq),
        derIntegerBigInt(data.qi),
      ),
    );
  }
  if (encodingType === 'sec1') {
    if (data.kind !== 'ec') throw decodeError();
    const curveOid = EC_CURVE_INFO[data.namedCurve].oid;
    const uncompressed = concatBytes(Uint8Array.of(0x04), data.x, data.y);
    return Buffer.from(
      derSequence(
        derIntegerBigInt(1n),
        derOctetString(data.d),
        derExplicit(0, derOid(curveOid)),
        derExplicit(1, derBitString(uncompressed)),
      ),
    );
  }
  switch (data.kind) {
    case 'ec': {
      const curveOid = EC_CURVE_INFO[data.namedCurve].oid;
      const uncompressed = concatBytes(Uint8Array.of(0x04), data.x, data.y);
      const innerSec1 = derSequence(
        derIntegerBigInt(1n),
        derOctetString(data.d),
        derExplicit(1, derBitString(uncompressed)),
      );
      return Buffer.from(
        derSequence(
          derIntegerBigInt(0n),
          derSequence(derOid(OID_EC_PUBLIC_KEY), derOid(curveOid)),
          derOctetString(innerSec1),
        ),
      );
    }
    case 'ed25519':
    case 'x25519': {
      const oid = data.kind === 'ed25519' ? OID_ED25519 : OID_X25519;
      return Buffer.from(
        derSequence(
          derIntegerBigInt(0n),
          derSequence(derOid(oid)),
          derOctetString(derOctetString(data.d)),
        ),
      );
    }
    case 'dh': {
      const params = derSequence(derIntegerBigInt(data.p), derIntegerBigInt(data.g));
      return Buffer.from(
        derSequence(
          derIntegerBigInt(0n),
          derSequence(derOid(OID_DH), params),
          derOctetString(derIntegerBigInt(data.x)),
        ),
      );
    }
    case 'rsa':
    case 'rsa-pss': {
      const pkcs1Priv = derSequence(
        derIntegerBigInt(0n),
        derIntegerBigInt(data.n),
        derIntegerBigInt(data.e),
        derIntegerBigInt(data.d),
        derIntegerBigInt(data.p),
        derIntegerBigInt(data.q),
        derIntegerBigInt(data.dp),
        derIntegerBigInt(data.dq),
        derIntegerBigInt(data.qi),
      );
      const algId =
        data.kind === 'rsa'
          ? derSequence(derOid(OID_RSA_ENCRYPTION), derNull())
          : encodeRsaPssAlgorithmIdentifier(data.pss);
      return Buffer.from(derSequence(derIntegerBigInt(0n), algId, derOctetString(pkcs1Priv)));
    }
  }
}

// --- Key decoding (DER -> ParsedPublicKey / ParsedPrivateKey) ---

function parseRsaPkcs1Public(
  der: Uint8Array,
  kind: 'rsa' | 'rsa-pss',
  pss?: RsaPssParams,
): RsaPublicData {
  const seq = readExactTlv(der, 0x30);
  const items = readChildren(seq.content);
  if (items.length !== 2) throw decodeError();
  return { kind, n: readUnsignedInteger(items[0]), e: readUnsignedInteger(items[1]), pss };
}

function parseRsaPkcs1Private(
  der: Uint8Array,
  kind: 'rsa' | 'rsa-pss',
  pss?: RsaPssParams,
): RsaPrivateData {
  const seq = readExactTlv(der, 0x30);
  const items = readChildren(seq.content);
  if (items.length < 9) throw decodeError();
  const version = readUnsignedInteger(items[0]);
  if (version !== 0n) throw decodeError();
  return {
    kind,
    n: readUnsignedInteger(items[1]),
    e: readUnsignedInteger(items[2]),
    d: readUnsignedInteger(items[3]),
    p: readUnsignedInteger(items[4]),
    q: readUnsignedInteger(items[5]),
    dp: readUnsignedInteger(items[6]),
    dq: readUnsignedInteger(items[7]),
    qi: readUnsignedInteger(items[8]),
    pss,
  };
}

export function decodeSpkiDer(der: Uint8Array): ParsedPublicKey {
  const outer = readExactTlv(der, 0x30);
  const top = readChildren(outer.content);
  if (top.length !== 2 || top[0].tag !== 0x30) throw decodeError();
  const algItems = readChildren(top[0].content);
  if (algItems.length < 1) throw decodeError();
  const algOid = oidHex(algItems[0]);
  const pubBytes = readBitStringBytes(top[1]);

  if (algOid === OID_ED448 || algOid === OID_X448 || algOid === OID_DSA) {
    throw fault('ENOSYS', 'Asymmetric key algorithm is not supported in WebCrypto');
  }
  if (algOid === OID_DH) {
    if (algItems.length < 2 || algItems[1].tag !== 0x30) throw decodeError();
    const dhParams = readChildren(algItems[1].content);
    if (dhParams.length < 2) throw decodeError();
    const p = readUnsignedInteger(dhParams[0]);
    const g = readUnsignedInteger(dhParams[1]);
    const yNode = readExactTlv(pubBytes, 0x02);
    const y = readUnsignedInteger(yNode);
    return { kind: 'dh', p, g, y };
  }
  if (algOid === OID_RSA_ENCRYPTION) {
    return parseRsaPkcs1Public(pubBytes, 'rsa');
  }
  if (algOid === OID_RSASSA_PSS) {
    return parseRsaPkcs1Public(pubBytes, 'rsa-pss', decodeRsaPssParams(algItems));
  }
  if (algOid === OID_EC_PUBLIC_KEY) {
    if (algItems.length < 2) throw decodeError();
    const namedCurve = curveFromOid(oidHex(algItems[1]));
    const { x, y } = decodeEcPoint(namedCurve, pubBytes);
    return { kind: 'ec', namedCurve, x, y };
  }
  if (algOid === OID_ED25519 || algOid === OID_X25519) {
    if (pubBytes.byteLength !== 32) throw decodeError();
    return { kind: algOid === OID_ED25519 ? 'ed25519' : 'x25519', x: Uint8Array.from(pubBytes) };
  }
  throw decodeError();
}

function decodeSec1Der(der: Uint8Array, explicitCurve?: EcCurveName): EcPrivateData {
  const outer = readExactTlv(der, 0x30);
  const items = readChildren(outer.content);
  if (items.length < 2) throw decodeError();
  if (readUnsignedInteger(items[0]) !== 1n || items[1].tag !== 0x04) throw decodeError();
  const rawD = items[1].content;
  let curve = explicitCurve;
  let pubBits: Uint8Array | undefined;
  for (let i = 2; i < items.length; i++) {
    if (items[i].tag === 0xa0) {
      const oidNode = readExactTlv(items[i].content, 0x06);
      curve = curveFromOid(oidHex(oidNode));
    } else if (items[i].tag === 0xa1) {
      const bsNode = readExactTlv(items[i].content, 0x03);
      pubBits = readBitStringBytes(bsNode);
    }
  }
  if (!curve) throw decodeError();
  const coordLen = EC_CURVE_INFO[curve].coordBytes;
  if (rawD.byteLength > coordLen) throw decodeError();
  const d =
    rawD.byteLength === coordLen
      ? Uint8Array.from(rawD)
      : bigIntToUnsignedBytes(bytesToBigInt(rawD), coordLen);
  const { x, y } =
    pubBits !== undefined ? decodeEcPoint(curve, pubBits) : deriveEcPublicCoords(curve, d);
  return { kind: 'ec', namedCurve: curve, d, x, y };
}

export function decodePkcs8Der(der: Uint8Array): ParsedPrivateKey {
  const outer = readExactTlv(der, 0x30);
  const top = readChildren(outer.content);
  if (top.length < 3 || top[1].tag !== 0x30 || top[2].tag !== 0x04) throw decodeError();
  const version = readUnsignedInteger(top[0]);
  if (version !== 0n && version !== 1n) throw decodeError();
  const algItems = readChildren(top[1].content);
  if (algItems.length < 1) throw decodeError();
  const algOid = oidHex(algItems[0]);
  const privOctets = top[2].content;

  if (algOid === OID_ED448 || algOid === OID_X448 || algOid === OID_DSA) {
    throw fault('ENOSYS', 'Asymmetric key algorithm is not supported in WebCrypto');
  }
  if (algOid === OID_DH) {
    if (algItems.length < 2 || algItems[1].tag !== 0x30) throw decodeError();
    const dhParams = readChildren(algItems[1].content);
    if (dhParams.length < 2) throw decodeError();
    const p = readUnsignedInteger(dhParams[0]);
    const g = readUnsignedInteger(dhParams[1]);
    const xNode = readExactTlv(privOctets, 0x02);
    const x = readUnsignedInteger(xNode);
    if (p <= 1n) throw decodeError();
    const y = modPow(g, x, p);
    return { kind: 'dh', p, g, x, y };
  }
  if (algOid === OID_RSA_ENCRYPTION) {
    return parseRsaPkcs1Private(privOctets, 'rsa');
  }
  if (algOid === OID_RSASSA_PSS) {
    return parseRsaPkcs1Private(privOctets, 'rsa-pss', decodeRsaPssParams(algItems));
  }
  if (algOid === OID_EC_PUBLIC_KEY) {
    if (algItems.length < 2) throw decodeError();
    const curve = curveFromOid(oidHex(algItems[1]));
    return decodeSec1Der(privOctets, curve);
  }
  if (algOid === OID_ED25519 || algOid === OID_X25519) {
    const inner = readExactTlv(privOctets, 0x04);
    if (inner.content.byteLength !== 32) throw decodeError();
    const d = Uint8Array.from(inner.content);
    const kind = algOid === OID_ED25519 ? 'ed25519' : 'x25519';
    const x = kind === 'ed25519' ? deriveEd25519PublicKey(d) : deriveX25519PublicKey(d);
    return { kind, d, x };
  }
  throw decodeError();
}

export function decodePrivateKeyDer(
  der: Uint8Array,
  encodingType: 'pkcs8' | 'pkcs1' | 'sec1',
): ParsedPrivateKey {
  if (encodingType === 'pkcs8') return decodePkcs8Der(der);
  if (encodingType === 'pkcs1') return parseRsaPkcs1Private(der, 'rsa');
  return decodeSec1Der(der);
}

export function decodePublicKeyDer(
  der: Uint8Array,
  encodingType: 'spki' | 'pkcs1',
): ParsedPublicKey {
  if (encodingType === 'spki') return decodeSpkiDer(der);
  return parseRsaPkcs1Public(der, 'rsa');
}

export function publicFromPrivateData(priv: ParsedPrivateKey): ParsedPublicKey {
  switch (priv.kind) {
    case 'rsa':
    case 'rsa-pss':
      return { kind: priv.kind, n: priv.n, e: priv.e, pss: priv.pss };
    case 'ec':
      return { kind: 'ec', namedCurve: priv.namedCurve, x: priv.x, y: priv.y };
    case 'ed25519':
    case 'x25519':
      return { kind: priv.kind, x: priv.x };
    case 'dh':
      return { kind: 'dh', p: priv.p, g: priv.g, y: priv.y };
  }
}

// --- ECDSA signature conversion (ASN.1 DER <-> IEEE P1363 raw r||s) ---

export function ecdsaP1363ToDer(rawSig: Uint8Array, coordBytes: number): Buffer {
  if (rawSig.byteLength !== coordBytes * 2) {
    throw new Error('Invalid IEEE P1363 signature length');
  }
  const r = bytesToBigInt(rawSig.subarray(0, coordBytes));
  const s = bytesToBigInt(rawSig.subarray(coordBytes));
  return Buffer.from(derSequence(derIntegerBigInt(r), derIntegerBigInt(s)));
}

export function ecdsaDerToP1363(derSig: Uint8Array, coordBytes: number): Uint8Array | undefined {
  try {
    const seq = readExactTlv(derSig, 0x30);
    const items = readChildren(seq.content);
    if (items.length !== 2) return undefined;
    const r = readUnsignedInteger(items[0]);
    const s = readUnsignedInteger(items[1]);
    const rBytes = bigIntToUnsignedBytes(r, coordBytes);
    const sBytes = bigIntToUnsignedBytes(s, coordBytes);
    return concatBytes(rBytes, sBytes);
  } catch {
    return undefined;
  }
}
