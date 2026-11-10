import { Buffer } from 'buffer';
import { fault } from './protocol';

// Argument validation and digest lookup shared by the guest crypto functions
// (HMAC, HKDF). Errors are plain Node-shaped errors: the exact class, a `code`
// own property, and Node 22's message text, so guest code and the conformance
// differential see what a native process sees.

type Coded<T extends Error> = T & { code: string };
const coded = <T extends Error>(error: T, code: string): Coded<T> => Object.assign(error, { code });

function quoted(value: string) {
  // util.inspect prefers single quotes and switches only when the text has one.
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `'${value.replace(/'/g, "\\'")}'`;
}

/** The "Received ..." suffix of ERR_INVALID_ARG_TYPE and ERR_OUT_OF_RANGE. */
export function received(value: unknown): string {
  if (value === null || value === undefined) return `Received ${value}`;
  if (typeof value === 'function')
    return `Received function ${(value as { name: string }).name}`.trimEnd();
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === 'string' && name !== ''
      ? `Received an instance of ${name}`
      : 'Received [Object: null prototype] {}';
  }
  let shown: string;
  if (typeof value === 'string') shown = quoted(value);
  else if (typeof value === 'bigint') shown = `${value}n`;
  else if (typeof value === 'number' && Object.is(value, -0)) shown = '-0';
  else shown = String(value as number | boolean | symbol);
  if (shown.length > 28) shown = `${shown.slice(0, 25)}...`;
  return `Received type ${typeof value} (${shown})`;
}

export function invalidArgType(name: string, expected: string, value: unknown) {
  return coded(
    new TypeError(`The "${name}" argument must be ${expected}. ${received(value)}`),
    'ERR_INVALID_ARG_TYPE',
  );
}

/** "string or an instance of A, B, or C" for the class names, as Node words it. */
export function typeList(types: string[], classes: string[]) {
  const parts: string[] = [];
  if (types.length > 0) parts.push(`of type ${types.join(' or ')}`);
  if (classes.length > 0) {
    const listed =
      classes.length > 2
        ? `${classes.slice(0, -1).join(', ')}, or ${classes[classes.length - 1]}`
        : classes.join(' or ');
    parts.push(`an instance of ${listed}`);
  }
  return parts.join(' or ');
}

function separated(value: number) {
  const digits = String(Math.abs(value));
  if (!Number.isInteger(value) || Math.abs(value) <= 2 ** 32) return String(value);
  let out = '';
  for (let index = digits.length; index > 0; index -= 3)
    out = `${digits.slice(Math.max(0, index - 3), index)}${out === '' ? '' : '_'}${out}`;
  return `${value < 0 ? '-' : ''}${out}`;
}

export function outOfRange(name: string, range: string, value: unknown) {
  const shown = typeof value === 'number' ? separated(value) : String(value);
  return coded(
    new RangeError(
      `The value of "${name}" is out of range. It must be ${range}. Received ${shown}`,
    ),
    'ERR_OUT_OF_RANGE',
  );
}

export function validateString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw invalidArgType(name, 'of type string', value);
  return value;
}

export function validateInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number') throw invalidArgType(name, 'of type number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  return value;
}

export function unknownEncoding(encoding: string) {
  return coded(new TypeError(`Unknown encoding: ${encoding}`), 'ERR_UNKNOWN_ENCODING');
}

/**
 * Node's encoding lookup is case-insensitive, and the literal 'buffer' means
 * "no text encoding". Returns undefined for names it does not recognize.
 */
export function textEncoding(encoding: unknown): TextName | undefined {
  if (typeof encoding !== 'string') return undefined;
  const name = encoding.toLowerCase();
  if (name === 'buffer' || name === 'base64url') return name;
  return Buffer.isEncoding(name) ? (name as BufferEncoding) : undefined;
}

type TextName = BufferEncoding | 'buffer' | 'base64url';

/** The bytes of text in a recognized encoding ('buffer' means UTF-8). */
export function decodeText(value: string, name: TextName): Buffer {
  // The bundled Buffer decodes URL-safe base64 under 'base64' but lacks the name.
  return Buffer.from(value, name === 'buffer' ? 'utf8' : name === 'base64url' ? 'base64' : name);
}

/** Bytes as text in a recognized encoding. UTF-8 follows the WHATWG decoder, as V8 does. */
export function encodeText(bytes: Buffer, name: Exclude<TextName, 'buffer'>): string {
  if (name === 'utf8' || name === 'utf-8') return new TextDecoder().decode(bytes);
  return bytes.toString(name);
}

/** A string as bytes; an unknown encoding is an error, 'buffer' means UTF-8. */
export function stringBytes(value: string, encoding: unknown): Buffer {
  if (encoding === undefined || encoding === null) return Buffer.from(value, 'utf8');
  const name = textEncoding(encoding);
  if (name === undefined) throw unknownEncoding(String(encoding));
  return decodeText(value, name);
}

/** The bytes of an ArrayBuffer or view, or undefined for any other value. */
export function viewBytes(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer)
    return new Uint8Array(value);
  return undefined;
}

interface DigestInfo {
  /** The sha.js algorithm name. */
  name: 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512';
  block: number;
  size: number;
}

const supported: Record<string, DigestInfo> = {
  sha1: { name: 'sha1', block: 64, size: 20 },
  sha224: { name: 'sha224', block: 64, size: 28 },
  sha256: { name: 'sha256', block: 64, size: 32 },
  sha384: { name: 'sha384', block: 128, size: 48 },
  sha512: { name: 'sha512', block: 128, size: 64 },
};

// Digest names Node 22.18.0 (OpenSSL 3) accepts that this runtime does not
// implement. They are rejected as unsupported, never as invalid, because the
// native process would accept them.
const nativeOnly = new Set(
  (
    'rsa-md5 rsa-ripemd160 rsa-sha1 rsa-sha1-2 rsa-sha224 rsa-sha256 rsa-sha3-224 rsa-sha3-256 ' +
    'rsa-sha3-384 rsa-sha3-512 rsa-sha384 rsa-sha512 rsa-sha512/224 rsa-sha512/256 rsa-sm3 ' +
    'blake2b512 blake2s256 id-rsassa-pkcs1-v1_5-with-sha3-224 id-rsassa-pkcs1-v1_5-with-sha3-256 ' +
    'id-rsassa-pkcs1-v1_5-with-sha3-384 id-rsassa-pkcs1-v1_5-with-sha3-512 md5 md5-sha1 ' +
    'md5withrsaencryption ripemd ripemd160 ripemd160withrsa rmd160 sha1withrsaencryption ' +
    'sha224withrsaencryption sha256withrsaencryption sha3-224 sha3-256 sha3-384 sha3-512 ' +
    'sha384withrsaencryption sha512-224 sha512-224withrsaencryption sha512-256 ' +
    'sha512-256withrsaencryption sha512withrsaencryption shake128 shake256 sm3 ' +
    'sm3withrsaencryption ssl3-md5 ssl3-sha1 sha-1 sha-224 sha-256 sha-384 sha-512 sha2-224 ' +
    'sha2-256 sha2-384 sha2-512 sha-512/224 sha-512/256 sha2-512/224 sha2-512/256 sha512/224 ' +
    'sha512/256'
  ).split(' '),
);

/** Resolves a digest name for HMAC and HKDF the way OpenSSL names are matched. */
export function resolveDigest(name: string): DigestInfo {
  const key = name.toLowerCase();
  const found = Object.prototype.hasOwnProperty.call(supported, key) ? supported[key] : undefined;
  if (found !== undefined) return found;
  if (nativeOnly.has(key))
    throw fault('ENOSYS', 'Digest algorithm is outside the supported SHA family');
  throw coded(new TypeError(`Invalid digest: ${name}`), 'ERR_CRYPTO_INVALID_DIGEST');
}
