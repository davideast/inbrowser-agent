import { Buffer, kMaxLength } from 'buffer';
import { invalidArgType, outOfRange, typeList } from './crypto-args';

export type TranscodeEncoding =
  | 'ascii'
  | 'utf8'
  | 'utf-8'
  | 'utf16le'
  | 'utf-16le'
  | 'ucs2'
  | 'ucs-2'
  | 'latin1'
  | 'binary';

type CanonicalTranscodeEncoding = 'ascii' | 'utf8' | 'utf16le' | 'latin1';

const objectUrlRegistry = new Map<string, Blob>();
const wrappedUrlConstructors = new WeakSet<object>();

export function installObjectUrlTracking(): void {
  const urlCtor = globalThis.URL;
  if (typeof urlCtor !== 'function' || wrappedUrlConstructors.has(urlCtor)) {
    return;
  }
  const origCreate = urlCtor.createObjectURL;
  const origRevoke = urlCtor.revokeObjectURL;
  if (typeof origCreate === 'function' && typeof origRevoke === 'function') {
    wrappedUrlConstructors.add(urlCtor);
    urlCtor.createObjectURL = function createObjectURL(obj: Blob | MediaSource): string {
      const id = Reflect.apply(origCreate, this, [obj]);
      if (typeof id === 'string' && obj instanceof globalThis.Blob) {
        objectUrlRegistry.set(id, new globalThis.Blob([obj], { type: obj.type }));
      }
      return id;
    };
    urlCtor.revokeObjectURL = function revokeObjectURL(url: string): void {
      objectUrlRegistry.delete(`${url}`);
      Reflect.apply(origRevoke, this, [url]);
    };
  }
}

export function resolveObjectURL(id: string): Blob | undefined {
  if (typeof id !== 'string') {
    return undefined;
  }
  const stored = objectUrlRegistry.get(id);
  if (!stored) {
    return undefined;
  }
  return new globalThis.Blob([stored], { type: stored.type });
}

interface TypedArrayLike extends ArrayBufferView {
  readonly length: number;
  readonly BYTES_PER_ELEMENT: number;
}

function isTypedArrayView(value: unknown): value is TypedArrayLike {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function validateCopyIndex(value: number, name: string): number {
  if (typeof value !== 'number') {
    throw invalidArgType(name, 'of type number', value);
  }
  if (!Number.isInteger(value)) {
    throw outOfRange(name, 'an integer', value);
  }
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw outOfRange(name, `>= 0 && <= ${Number.MAX_SAFE_INTEGER}`, value);
  }
  return value;
}

export function copyBytesFrom(view: ArrayBufferView, offset?: number, length?: number): Buffer {
  if (!isTypedArrayView(view)) {
    throw invalidArgType(
      'view',
      typeList(
        [],
        [
          'Int8Array',
          'Uint8Array',
          'Uint8ClampedArray',
          'Int16Array',
          'Uint16Array',
          'Int32Array',
          'Uint32Array',
          'Float32Array',
          'Float64Array',
          'BigInt64Array',
          'BigUint64Array',
        ],
      ),
      view,
    );
  }

  const viewLength = view.length;
  if (viewLength === 0) {
    return Buffer.alloc(0);
  }

  let start = 0;
  let end = viewLength;
  if (offset !== undefined || length !== undefined) {
    if (offset !== undefined) {
      start = validateCopyIndex(offset, 'offset');
      if (start >= viewLength) {
        return Buffer.alloc(0);
      }
    }
    if (length !== undefined) {
      end = start + validateCopyIndex(length, 'length');
    } else {
      end = viewLength;
    }
    if (end > viewLength) {
      end = viewLength;
    }
  }

  const elementSize = view.BYTES_PER_ELEMENT;
  const byteOffset = view.byteOffset + start * elementSize;
  const byteLength = (end - start) * elementSize;
  if (byteLength <= 0) {
    return Buffer.alloc(0);
  }
  const copy = new Uint8Array(byteLength);
  copy.set(new Uint8Array(view.buffer, byteOffset, byteLength));
  return Buffer.from(copy.buffer, 0, copy.byteLength);
}

export interface SlowBufferConstructor {
  new (size: number): Buffer;
  (size: number): Buffer;
  prototype: Uint8Array;
}

function slowBufferImpl(size: number): Buffer {
  if (typeof size !== 'number') {
    throw invalidArgType('size', 'of type number', size);
  }
  if (Number.isNaN(size) || size < 0 || size > kMaxLength) {
    throw outOfRange('size', `>= 0 && <= ${kMaxLength}`, size);
  }
  return Buffer.allocUnsafeSlow(Math.trunc(size));
}

Object.setPrototypeOf(slowBufferImpl.prototype, Uint8Array.prototype);
Object.setPrototypeOf(slowBufferImpl, Uint8Array);

// Invariant: slowBufferImpl is a plain function whose prototype chain matches Node's SlowBuffer
// and returns a Buffer regardless of whether it is invoked with `new` or as a function.
export const SlowBuffer: SlowBufferConstructor = slowBufferImpl as unknown as SlowBufferConstructor;

function missingInputError(): TypeError {
  return Object.assign(new TypeError('The "input" argument must be specified'), {
    code: 'ERR_MISSING_ARGS',
  });
}

export function btoa(input: string): string {
  if (arguments.length === 0) {
    throw missingInputError();
  }
  return globalThis.btoa(`${input}`);
}

export function atob(input: string): string {
  if (arguments.length === 0) {
    throw missingInputError();
  }
  return globalThis.atob(`${input}`);
}

function normalizeTranscodeEncoding(enc: unknown): CanonicalTranscodeEncoding | undefined {
  const lowered = `${enc || ''}`.toLowerCase();
  switch (lowered) {
    case 'ascii':
      return 'ascii';
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'utf16le':
    case 'utf-16le':
    case 'ucs2':
    case 'ucs-2':
      return 'utf16le';
    case 'latin1':
    case 'binary':
      return 'latin1';
    default:
      return undefined;
  }
}

function icuError(code: 'U_ILLEGAL_ARGUMENT_ERROR' | 'U_INVALID_CHAR_FOUND'): Error {
  return Object.assign(new Error(`Unable to transcode Buffer [${code}]`), { code });
}

const utf8ReplacementDecoder = new TextDecoder('utf-8', { fatal: false });
const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });
const utf16leReplacementDecoder = new TextDecoder('utf-16le', { fatal: false });

function transcodeToUtf16le(bytes: Uint8Array, from: CanonicalTranscodeEncoding): Buffer {
  if (from === 'utf8') {
    let decoded: string;
    try {
      decoded = utf8FatalDecoder.decode(bytes);
    } catch {
      throw icuError('U_INVALID_CHAR_FOUND');
    }
    return Buffer.from(decoded, 'utf16le');
  }
  if (from === 'utf16le') {
    const evenBytes = bytes.subarray(0, bytes.byteLength & ~1);
    return Buffer.from(utf16leReplacementDecoder.decode(evenBytes), 'utf16le');
  }
  // Node's FromASCII and FromLatin1 fast paths to UTF-16LE zero-extend bytes 0x00..0xff.
  const out = Buffer.allocUnsafe(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    out[i * 2] = bytes[i]!;
    out[i * 2 + 1] = 0;
  }
  return out;
}

function decodeTranscodeSource(bytes: Uint8Array, encoding: CanonicalTranscodeEncoding): string {
  if (encoding === 'utf8') {
    return utf8ReplacementDecoder.decode(bytes);
  }
  if (encoding === 'ascii') {
    const chars: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      chars.push(b <= 0x7f ? String.fromCharCode(b) : '\ufffd');
    }
    return chars.join('');
  }
  if (encoding === 'latin1') {
    const chars: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      chars.push(String.fromCharCode(bytes[i]!));
    }
    return chars.join('');
  }
  // utf16le / ucs2: truncate trailing odd byte, reject unpaired surrogates with U_INVALID_CHAR_FOUND
  const units = bytes.byteLength >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, units * 2);
  const chars: string[] = [];
  for (let i = 0; i < units; i++) {
    const u = view.getUint16(i * 2, true);
    if (u >= 0xd800 && u <= 0xdbff) {
      if (i + 1 >= units) {
        throw icuError('U_INVALID_CHAR_FOUND');
      }
      const low = view.getUint16((i + 1) * 2, true);
      if (low < 0xdc00 || low > 0xdfff) {
        throw icuError('U_INVALID_CHAR_FOUND');
      }
      chars.push(String.fromCharCode(u, low));
      i++;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      throw icuError('U_INVALID_CHAR_FOUND');
    } else {
      chars.push(String.fromCharCode(u));
    }
  }
  return chars.join('');
}

function encodeTranscodeTarget(text: string, encoding: CanonicalTranscodeEncoding): Buffer {
  if (encoding === 'utf8') {
    return Buffer.from(text, 'utf8');
  }
  if (encoding === 'utf16le') {
    return Buffer.from(text, 'utf16le');
  }
  const limit = encoding === 'ascii' ? 0x7f : 0xff;
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    out.push(cp <= limit ? cp : 0x3f);
  }
  return Buffer.from(out);
}

export function transcode(
  source: Uint8Array,
  fromEnc: TranscodeEncoding,
  toEnc: TranscodeEncoding,
): Buffer {
  if (!(source instanceof Uint8Array)) {
    throw invalidArgType('source', typeList([], ['Buffer', 'Uint8Array']), source);
  }
  if (source.length === 0) {
    return Buffer.alloc(0);
  }
  const from = normalizeTranscodeEncoding(fromEnc);
  const to = normalizeTranscodeEncoding(toEnc);
  if (!from || !to) {
    throw icuError('U_ILLEGAL_ARGUMENT_ERROR');
  }
  const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (to === 'utf16le') {
    return transcodeToUtf16le(bytes, from);
  }
  const decoded = decodeTranscodeSource(bytes, from);
  return encodeTranscodeTarget(decoded, to);
}

export function validateInspectMaxBytes(val: unknown): number {
  if (typeof val !== 'number') {
    throw invalidArgType('INSPECT_MAX_BYTES', 'of type number', val);
  }
  if (Number.isNaN(val) || val < 0) {
    throw outOfRange('INSPECT_MAX_BYTES', '>= 0', val);
  }
  return val;
}

export function installBufferStatics(): void {
  Object.defineProperty(Buffer, 'copyBytesFrom', {
    value: copyBytesFrom,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  installObjectUrlTracking();
}
