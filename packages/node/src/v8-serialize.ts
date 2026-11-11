import { Buffer } from 'buffer';
import { nodeError } from './node-errors';

const WIRE_VERSION = 15;

// V8 ValueSerializer wire format v15 tags (deps/v8/src/objects/value-serializer.cc).
const TAG_VERSION = 0xff;
const TAG_PADDING = 0x00;
const TAG_UNDEFINED = 0x5f; // '_'
const TAG_NULL = 0x30; // '0'
const TAG_TRUE = 0x54; // 'T'
const TAG_FALSE = 0x46; // 'F'
const TAG_INT32 = 0x49; // 'I'
const TAG_UINT32 = 0x55; // 'U'
const TAG_DOUBLE = 0x4e; // 'N'
const TAG_BIGINT = 0x5a; // 'Z'
const TAG_UTF8_STRING = 0x53; // 'S'
const TAG_ONE_BYTE_STRING = 0x22; // '"'
const TAG_TWO_BYTE_STRING = 0x63; // 'c'
const TAG_OBJECT_REF = 0x5e; // '^'
const TAG_BEGIN_JS_OBJECT = 0x6f; // 'o'
const TAG_END_JS_OBJECT = 0x7b; // '{'
const TAG_BEGIN_SPARSE_ARRAY = 0x61; // 'a'
const TAG_END_SPARSE_ARRAY = 0x40; // '@'
const TAG_BEGIN_DENSE_ARRAY = 0x41; // 'A'
const TAG_END_DENSE_ARRAY = 0x24; // '$'
const TAG_THE_HOLE = 0x2d; // '-'
const TAG_DATE = 0x44; // 'D'
const TAG_TRUE_OBJECT = 0x79; // 'y'
const TAG_FALSE_OBJECT = 0x78; // 'x'
const TAG_NUMBER_OBJECT = 0x6e; // 'n'
const TAG_BIGINT_OBJECT = 0x7a; // 'z'
const TAG_STRING_OBJECT = 0x73; // 's'
const TAG_REGEXP = 0x52; // 'R'
const TAG_BEGIN_MAP = 0x3b; // ';'
const TAG_END_MAP = 0x3a; // ':'
const TAG_BEGIN_SET = 0x27; // "'"
const TAG_END_SET = 0x2c; // ','
const TAG_ARRAY_BUFFER = 0x42; // 'B'
const TAG_RESIZABLE_ARRAY_BUFFER = 0x7e; // '~'
const TAG_ARRAY_BUFFER_TRANSFER = 0x74; // 't'
const TAG_ARRAY_BUFFER_VIEW = 0x56; // 'V'
const TAG_SHARED_ARRAY_BUFFER = 0x75; // 'u'
const TAG_ERROR = 0x72; // 'r'
const TAG_HOST_OBJECT = 0x5c; // '\\'

// Error sub-tags inside TAG_ERROR records.
const ERR_EVAL = 0x45; // 'E'
const ERR_RANGE = 0x52; // 'R'
const ERR_REFERENCE = 0x46; // 'F'
const ERR_SYNTAX = 0x53; // 'S'
const ERR_TYPE = 0x54; // 'T'
const ERR_URI = 0x55; // 'U'
const ERR_MESSAGE = 0x6d; // 'm'
const ERR_STACK = 0x73; // 's'
const ERR_CAUSE = 0x63; // 'c'
const ERR_END = 0x2e; // '.'

// V8 ArrayBufferView sub-tags inside TAG_ARRAY_BUFFER_VIEW records.
const ABV_INT8 = 0x62; // 'b'
const ABV_UINT8 = 0x42; // 'B'
const ABV_UINT8_CLAMPED = 0x43; // 'C'
const ABV_INT16 = 0x77; // 'w'
const ABV_UINT16 = 0x57; // 'W'
const ABV_INT32 = 0x64; // 'd'
const ABV_UINT32 = 0x44; // 'D'
const ABV_FLOAT32 = 0x66; // 'f'
const ABV_FLOAT64 = 0x46; // 'F'
const ABV_BIGINT64 = 0x71; // 'q'
const ABV_BIGUINT64 = 0x51; // 'Q'
const ABV_DATAVIEW = 0x3f; // '?'

const UTF8_DECODER = new TextDecoder('utf-8');
const OBJECT_TO_STRING = Object.prototype.toString;

function varintByteLength(n: number): number {
  let v = n >>> 0;
  let len = 1;
  while (v >= 0x80) {
    v >>>= 7;
    len++;
  }
  return len;
}

function isArrayIndexKey(key: string): number {
  if (key.length === 0 || key.length > 10) return -1;
  const n = Number(key);
  if (!Number.isInteger(n) || n < 0 || n >= 0xffffffff || String(n) !== key) return -1;
  return n;
}

function encodeRegExpFlags(flags: string): number {
  let mask = 0;
  if (flags.includes('g')) mask |= 1;
  if (flags.includes('i')) mask |= 2;
  if (flags.includes('m')) mask |= 4;
  if (flags.includes('y')) mask |= 8;
  if (flags.includes('u')) mask |= 16;
  if (flags.includes('s')) mask |= 32;
  // Bit 6 (64) is V8's internal kLinear flag; hasIndices ('d') is bit 7 (128), unicodeSets ('v') is bit 8 (256).
  if (flags.includes('d')) mask |= 128;
  if (flags.includes('v')) mask |= 256;
  return mask;
}

function decodeRegExpFlags(mask: number): string {
  let flags = '';
  if (mask & 128) flags += 'd';
  if (mask & 1) flags += 'g';
  if (mask & 2) flags += 'i';
  if (mask & 4) flags += 'm';
  if (mask & 32) flags += 's';
  if (mask & 16) flags += 'u';
  if (mask & 256) flags += 'v';
  if (mask & 8) flags += 'y';
  return flags;
}

function viewTagOf(view: ArrayBufferView): number {
  const tag = OBJECT_TO_STRING.call(view);
  switch (tag) {
    case '[object Int8Array]':
      return ABV_INT8;
    case '[object Uint8Array]':
      return ABV_UINT8;
    case '[object Uint8ClampedArray]':
      return ABV_UINT8_CLAMPED;
    case '[object Int16Array]':
      return ABV_INT16;
    case '[object Uint16Array]':
      return ABV_UINT16;
    case '[object Int32Array]':
      return ABV_INT32;
    case '[object Uint32Array]':
      return ABV_UINT32;
    case '[object Float32Array]':
      return ABV_FLOAT32;
    case '[object Float64Array]':
      return ABV_FLOAT64;
    case '[object BigInt64Array]':
      return ABV_BIGINT64;
    case '[object BigUint64Array]':
      return ABV_BIGUINT64;
    case '[object DataView]':
      return ABV_DATAVIEW;
    default:
      return -1;
  }
}

function constructBareView(
  subtag: number,
  ab: ArrayBufferLike,
  byteOffset: number,
  byteLength: number,
): ArrayBufferView {
  switch (subtag) {
    case ABV_INT8:
      return new Int8Array(ab, byteOffset, byteLength);
    case ABV_UINT8:
      return new Uint8Array(ab, byteOffset, byteLength);
    case ABV_UINT8_CLAMPED:
      return new Uint8ClampedArray(ab, byteOffset, byteLength);
    case ABV_INT16:
      return new Int16Array(ab, byteOffset, byteLength / 2);
    case ABV_UINT16:
      return new Uint16Array(ab, byteOffset, byteLength / 2);
    case ABV_INT32:
      return new Int32Array(ab, byteOffset, byteLength / 4);
    case ABV_UINT32:
      return new Uint32Array(ab, byteOffset, byteLength / 4);
    case ABV_FLOAT32:
      return new Float32Array(ab, byteOffset, byteLength / 4);
    case ABV_FLOAT64:
      return new Float64Array(ab, byteOffset, byteLength / 8);
    case ABV_BIGINT64:
      return new BigInt64Array(ab, byteOffset, byteLength / 8);
    case ABV_BIGUINT64:
      return new BigUint64Array(ab, byteOffset, byteLength / 8);
    case ABV_DATAVIEW:
      return new DataView(ab, byteOffset, byteLength);
    default:
      throw new Error('Unable to deserialize cloned data.');
  }
}

function defaultHostTypeIndex(view: ArrayBufferView): number {
  if (Buffer.isBuffer(view)) return 10;
  const tag = OBJECT_TO_STRING.call(view);
  switch (tag) {
    case '[object Int8Array]':
      return 0;
    case '[object Uint8Array]':
      return 1;
    case '[object Uint8ClampedArray]':
      return 2;
    case '[object Int16Array]':
      return 3;
    case '[object Uint16Array]':
      return 4;
    case '[object Int32Array]':
      return 5;
    case '[object Uint32Array]':
      return 6;
    case '[object Float32Array]':
      return 7;
    case '[object Float64Array]':
      return 8;
    case '[object DataView]':
      return 9;
    case '[object BigInt64Array]':
      return 11;
    case '[object BigUint64Array]':
      return 12;
    default:
      return -1;
  }
}

function constructHostView(
  typeIndex: number,
  backing: ArrayBufferLike,
  byteOffset: number,
  byteLength: number,
): ArrayBufferView {
  if (typeIndex === 10) {
    // Buffer.from(ArrayBuffer, offset, length) creates a zero-copy Buffer slice; narrowed to ArrayBuffer via copy fallback if SAB.
    if (backing instanceof ArrayBuffer) return Buffer.from(backing, byteOffset, byteLength);
    const copy = Buffer.allocUnsafe(byteLength);
    copy.set(new Uint8Array(backing, byteOffset, byteLength));
    return copy;
  }
  const elemBytes =
    typeIndex === 0 || typeIndex === 1 || typeIndex === 2 || typeIndex === 9
      ? 1
      : typeIndex === 3 || typeIndex === 4
        ? 2
        : typeIndex === 5 || typeIndex === 6 || typeIndex === 7
          ? 4
          : typeIndex === 8 || typeIndex === 11 || typeIndex === 12
            ? 8
            : 0;
  if (elemBytes === 0 || byteLength % elemBytes !== 0) {
    throw new Error('Unable to deserialize cloned data.');
  }
  let targetBuf: ArrayBufferLike = backing;
  let targetOffset = byteOffset;
  if (targetOffset % elemBytes !== 0) {
    const aligned = new ArrayBuffer(byteLength);
    new Uint8Array(aligned).set(new Uint8Array(backing, byteOffset, byteLength));
    targetBuf = aligned;
    targetOffset = 0;
  }
  switch (typeIndex) {
    case 0:
      return new Int8Array(targetBuf, targetOffset, byteLength);
    case 1:
      return new Uint8Array(targetBuf, targetOffset, byteLength);
    case 2:
      return new Uint8ClampedArray(targetBuf, targetOffset, byteLength);
    case 3:
      return new Int16Array(targetBuf, targetOffset, byteLength / 2);
    case 4:
      return new Uint16Array(targetBuf, targetOffset, byteLength / 2);
    case 5:
      return new Int32Array(targetBuf, targetOffset, byteLength / 4);
    case 6:
      return new Uint32Array(targetBuf, targetOffset, byteLength / 4);
    case 7:
      return new Float32Array(targetBuf, targetOffset, byteLength / 4);
    case 8:
      return new Float64Array(targetBuf, targetOffset, byteLength / 8);
    case 9:
      return new DataView(targetBuf, targetOffset, byteLength);
    case 11:
      return new BigInt64Array(targetBuf, targetOffset, byteLength / 8);
    case 12:
      return new BigUint64Array(targetBuf, targetOffset, byteLength / 8);
    default:
      throw new Error('Unable to deserialize cloned data.');
  }
}

export class Serializer {
  #buf = new Uint8Array(256);
  #len = 0;
  #released = false;
  #treatViewsAsHost = false;
  #objectIds = new Map<object, number>();
  #transferredBuffers = new Map<ArrayBuffer, number>();
  #f64Scratch = new ArrayBuffer(8);
  #f64View = new DataView(this.#f64Scratch);
  #f64Bytes = new Uint8Array(this.#f64Scratch);

  declare _getDataCloneError: ErrorConstructor;
  _writeHostObject?(object: object): void;
  _getSharedArrayBufferId?(sharedArrayBuffer: SharedArrayBuffer): number;

  #ensureOpen(): void {
    if (this.#released) {
      throw new Error('Serializer buffer has already been released');
    }
  }

  #reserve(extra: number): void {
    this.#ensureOpen();
    const needed = this.#len + extra;
    if (needed <= this.#buf.length) return;
    let nextCap = this.#buf.length * 2;
    while (nextCap < needed) nextCap *= 2;
    const grown = new Uint8Array(nextCap);
    grown.set(this.#buf.subarray(0, this.#len));
    this.#buf = grown;
  }

  #writeByte(b: number): void {
    this.#reserve(1);
    this.#buf[this.#len++] = b & 0xff;
  }

  #writeVarintBig(value: bigint): void {
    let v = value;
    while (v >= 0x80n) {
      this.#writeByte(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.#writeByte(Number(v));
  }

  #throwCloneError(message: string): never {
    const Ctor = typeof this._getDataCloneError === 'function' ? this._getDataCloneError : Error;
    throw new Ctor(message);
  }

  writeHeader(): void {
    this.#writeByte(TAG_VERSION);
    this.writeUint32(WIRE_VERSION);
  }

  writeUint32(value: number): void {
    if (typeof value !== 'number') {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "value" argument must be of type number.',
      );
    }
    let v = value >>> 0;
    this.#reserve(5);
    while (v >= 0x80) {
      this.#buf[this.#len++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.#buf[this.#len++] = v;
  }

  writeUint64(hi: number, lo: number): void {
    if (typeof hi !== 'number' || typeof lo !== 'number') {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "hi" and "lo" arguments must be of type number.',
      );
    }
    const combined = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    this.#writeVarintBig(combined);
  }

  writeDouble(value: number): void {
    if (typeof value !== 'number') {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "value" argument must be of type number.',
      );
    }
    this.#f64View.setFloat64(0, value, true);
    this.#reserve(8);
    this.#buf.set(this.#f64Bytes, this.#len);
    this.#len += 8;
  }

  writeRawBytes(buffer: ArrayBufferView): void {
    if (!ArrayBuffer.isView(buffer)) {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "buffer" argument must be an instance of Buffer, TypedArray, or DataView.',
      );
    }
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.#reserve(bytes.byteLength);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.byteLength;
  }

  releaseBuffer(): Buffer {
    this.#ensureOpen();
    this.#released = true;
    const out = Buffer.allocUnsafe(this.#len);
    out.set(this.#buf.subarray(0, this.#len));
    return out;
  }

  transferArrayBuffer(id: number, arrayBuffer: ArrayBuffer): void {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "arrayBuffer" argument must be an instance of ArrayBuffer.',
      );
    }
    this.#transferredBuffers.set(arrayBuffer, id >>> 0);
  }

  _setTreatArrayBufferViewsAsHostObjects(flag: boolean): void {
    this.#treatViewsAsHost = Boolean(flag);
  }

  writeValue(value: unknown): boolean {
    this.#ensureOpen();
    this.#writeAny(value);
    return true;
  }

  #registerObject(obj: object): number {
    const id = this.#objectIds.size;
    this.#objectIds.set(obj, id);
    return id;
  }

  #writeString(str: string): void {
    let oneByte = true;
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 0xff) {
        oneByte = false;
        break;
      }
    }
    if (oneByte) {
      this.#writeByte(TAG_ONE_BYTE_STRING);
      this.writeUint32(str.length);
      this.#reserve(str.length);
      for (let i = 0; i < str.length; i++) {
        this.#buf[this.#len++] = str.charCodeAt(i);
      }
      return;
    }
    const byteLen = str.length * 2;
    const headerBytes = 1 + varintByteLength(byteLen);
    if (((this.#len + headerBytes) & 1) !== 0) {
      this.#writeByte(TAG_PADDING);
    }
    this.#writeByte(TAG_TWO_BYTE_STRING);
    this.writeUint32(byteLen);
    this.#reserve(byteLen);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      this.#buf[this.#len++] = code & 0xff;
      this.#buf[this.#len++] = (code >>> 8) & 0xff;
    }
  }

  #writeBigIntPayload(bi: bigint): void {
    if (bi === 0n) {
      this.writeUint32(0);
      return;
    }
    const neg = bi < 0n ? 1 : 0;
    let mag = bi < 0n ? -bi : bi;
    const words: bigint[] = [];
    const mask64 = 0xffffffffffffffffn;
    while (mag > 0n) {
      words.push(mag & mask64);
      mag >>= 64n;
    }
    const byteLength = words.length * 8;
    const bitfield = (BigInt(byteLength) << 1n) | BigInt(neg);
    this.#writeVarintBig(bitfield);
    this.#reserve(byteLength);
    for (const word of words) {
      let w = word;
      for (let b = 0; b < 8; b++) {
        this.#buf[this.#len++] = Number(w & 0xffn);
        w >>= 8n;
      }
    }
  }

  #writePropertyKey(key: string): void {
    const idx = isArrayIndexKey(key);
    if (idx >= 0 && idx <= 0x7fffffff) {
      this.#writeInt32(idx);
    } else if (idx > 0x7fffffff) {
      this.#writeByte(TAG_UINT32);
      this.writeUint32(idx);
    } else {
      this.#writeString(key);
    }
  }

  #writeInt32(n: number): void {
    this.#writeByte(TAG_INT32);
    const zigzag = ((n << 1) ^ (n >> 31)) >>> 0;
    this.writeUint32(zigzag);
  }

  #writeArrayBufferOrRef(ab: ArrayBufferLike): void {
    const existing = this.#objectIds.get(ab);
    if (existing !== undefined) {
      this.#writeByte(TAG_OBJECT_REF);
      this.writeUint32(existing);
      return;
    }
    if (typeof SharedArrayBuffer === 'function' && ab instanceof SharedArrayBuffer) {
      if (typeof this._getSharedArrayBufferId !== 'function') {
        this.#throwCloneError('#<SharedArrayBuffer> could not be cloned.');
      }
      const sabId = this._getSharedArrayBufferId(ab);
      this.#registerObject(ab);
      this.#writeByte(TAG_SHARED_ARRAY_BUFFER);
      this.writeUint32(sabId >>> 0);
      return;
    }
    // Narrowed: ab is ArrayBufferLike and not SharedArrayBuffer, so it is an ArrayBuffer.
    const arrayBuf = ab as ArrayBuffer;
    this.#registerObject(arrayBuf);
    const xferId = this.#transferredBuffers.get(arrayBuf);
    if (xferId !== undefined) {
      this.#writeByte(TAG_ARRAY_BUFFER_TRANSFER);
      this.writeUint32(xferId);
      return;
    }
    const resizable = Reflect.get(arrayBuf, 'resizable') === true;
    const maxLen = Reflect.get(arrayBuf, 'maxByteLength');
    if (resizable && typeof maxLen === 'number') {
      this.#writeByte(TAG_RESIZABLE_ARRAY_BUFFER);
      this.writeUint32(arrayBuf.byteLength);
      this.writeUint32(maxLen);
    } else {
      this.#writeByte(TAG_ARRAY_BUFFER);
      this.writeUint32(arrayBuf.byteLength);
    }
    const bytes = new Uint8Array(arrayBuf);
    this.#reserve(bytes.byteLength);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.byteLength;
  }

  #writeAny(value: unknown): void {
    if (value === undefined) {
      this.#writeByte(TAG_UNDEFINED);
      return;
    }
    if (value === null) {
      this.#writeByte(TAG_NULL);
      return;
    }
    if (typeof value === 'boolean') {
      this.#writeByte(value ? TAG_TRUE : TAG_FALSE);
      return;
    }
    if (typeof value === 'number') {
      if (
        Number.isInteger(value) &&
        !Object.is(value, -0) &&
        value >= -2147483648 &&
        value <= 2147483647
      ) {
        this.#writeInt32(value);
      } else {
        this.#writeByte(TAG_DOUBLE);
        this.writeDouble(value);
      }
      return;
    }
    if (typeof value === 'bigint') {
      this.#writeByte(TAG_BIGINT);
      this.#writeBigIntPayload(value);
      return;
    }
    if (typeof value === 'string') {
      this.#writeString(value);
      return;
    }
    if (typeof value === 'symbol') {
      this.#throwCloneError(`${String(value)} could not be cloned.`);
    }
    if (typeof value === 'function') {
      this.#throwCloneError(`${value.name || 'function'} could not be cloned.`);
    }

    // Narrowed: all JS primitives, symbols, and functions returned or threw above; value is a non-null object.
    const obj = value as object;
    const prevId = this.#objectIds.get(obj);
    if (prevId !== undefined) {
      this.#writeByte(TAG_OBJECT_REF);
      this.writeUint32(prevId);
      return;
    }

    if (
      obj instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer === 'function' && obj instanceof SharedArrayBuffer)
    ) {
      this.#writeArrayBufferOrRef(obj);
      return;
    }

    if (ArrayBuffer.isView(obj)) {
      if (this.#treatViewsAsHost) {
        if (typeof this._writeHostObject !== 'function') {
          this.#throwCloneError('Unserializable host object');
        }
        this.#registerObject(obj);
        this.#writeByte(TAG_HOST_OBJECT);
        this._writeHostObject(obj);
        return;
      }
      const subtag = viewTagOf(obj);
      if (subtag === -1) {
        this.#throwCloneError('Unserializable ArrayBufferView');
      }
      this.#writeArrayBufferOrRef(obj.buffer);
      this.#registerObject(obj);
      this.#writeByte(TAG_ARRAY_BUFFER_VIEW);
      this.#writeByte(subtag);
      this.writeUint32(obj.byteOffset);
      this.writeUint32(obj.byteLength);
      this.writeUint32(0); // V8 wire v15 ArrayBufferView flags
      return;
    }

    if (obj instanceof Date) {
      this.#registerObject(obj);
      this.#writeByte(TAG_DATE);
      this.writeDouble(obj.getTime());
      return;
    }

    if (obj instanceof RegExp) {
      this.#registerObject(obj);
      this.#writeByte(TAG_REGEXP);
      this.#writeString(obj.source);
      this.writeUint32(encodeRegExpFlags(obj.flags));
      return;
    }

    const strTag = OBJECT_TO_STRING.call(obj);
    if (strTag === '[object Boolean]') {
      this.#registerObject(obj);
      this.#writeByte(Boolean.prototype.valueOf.call(obj) ? TAG_TRUE_OBJECT : TAG_FALSE_OBJECT);
      return;
    }
    if (strTag === '[object Number]') {
      this.#registerObject(obj);
      this.#writeByte(TAG_NUMBER_OBJECT);
      this.writeDouble(Number.prototype.valueOf.call(obj));
      return;
    }
    if (strTag === '[object String]') {
      this.#registerObject(obj);
      this.#writeByte(TAG_STRING_OBJECT);
      this.#writeString(String.prototype.valueOf.call(obj));
      return;
    }
    if (strTag === '[object BigInt]') {
      this.#registerObject(obj);
      this.#writeByte(TAG_BIGINT_OBJECT);
      this.#writeBigIntPayload(BigInt.prototype.valueOf.call(obj));
      return;
    }

    if (obj instanceof Map) {
      this.#registerObject(obj);
      this.#writeByte(TAG_BEGIN_MAP);
      let count = 0;
      for (const [k, v] of obj.entries()) {
        this.#writeAny(k);
        this.#writeAny(v);
        count += 2;
      }
      this.#writeByte(TAG_END_MAP);
      this.writeUint32(count);
      return;
    }

    if (obj instanceof Set) {
      this.#registerObject(obj);
      this.#writeByte(TAG_BEGIN_SET);
      let count = 0;
      for (const item of obj.values()) {
        this.#writeAny(item);
        count++;
      }
      this.#writeByte(TAG_END_SET);
      this.writeUint32(count);
      return;
    }

    if (obj instanceof WeakMap || obj instanceof WeakSet || obj instanceof Promise) {
      this.#throwCloneError(`${strTag} could not be cloned.`);
    }

    if (obj instanceof Error) {
      this.#registerObject(obj);
      this.#writeByte(TAG_ERROR);
      if (obj instanceof EvalError) this.#writeByte(ERR_EVAL);
      else if (obj instanceof RangeError) this.#writeByte(ERR_RANGE);
      else if (obj instanceof ReferenceError) this.#writeByte(ERR_REFERENCE);
      else if (obj instanceof SyntaxError) this.#writeByte(ERR_SYNTAX);
      else if (obj instanceof TypeError) this.#writeByte(ERR_TYPE);
      else if (obj instanceof URIError) this.#writeByte(ERR_URI);

      if (obj.message !== '') {
        this.#writeByte(ERR_MESSAGE);
        this.#writeString(String(obj.message));
      } else if (Object.prototype.hasOwnProperty.call(obj, 'message')) {
        this.#writeByte(ERR_MESSAGE);
        this.#writeString('');
      }
      if (typeof obj.stack === 'string') {
        this.#writeByte(ERR_STACK);
        this.#writeString(obj.stack);
      }
      if ('cause' in obj) {
        this.#writeByte(ERR_CAUSE);
        this.#writeAny(Reflect.get(obj, 'cause'));
      }
      this.#writeByte(ERR_END);
      return;
    }

    if (Array.isArray(obj)) {
      this.#registerObject(obj);
      const len = obj.length;
      let dense = true;
      for (let i = 0; i < len; i++) {
        if (!(i in obj)) {
          dense = false;
          break;
        }
      }
      const keys = Object.keys(obj);
      if (dense) {
        this.#writeByte(TAG_BEGIN_DENSE_ARRAY);
        this.writeUint32(len);
        for (let i = 0; i < len; i++) {
          this.#writeAny(obj[i]);
        }
        let extra = 0;
        for (const k of keys) {
          const idx = isArrayIndexKey(k);
          if (idx >= 0 && idx < len) continue;
          this.#writePropertyKey(k);
          this.#writeAny(Reflect.get(obj, k));
          extra++;
        }
        this.#writeByte(TAG_END_DENSE_ARRAY);
        this.writeUint32(extra);
        this.writeUint32(len);
      } else {
        this.#writeByte(TAG_BEGIN_SPARSE_ARRAY);
        this.writeUint32(len);
        let written = 0;
        for (const k of keys) {
          this.#writePropertyKey(k);
          this.#writeAny(Reflect.get(obj, k));
          written++;
        }
        this.#writeByte(TAG_END_SPARSE_ARRAY);
        this.writeUint32(written);
        this.writeUint32(len);
      }
      return;
    }

    this.#registerObject(obj);
    this.#writeByte(TAG_BEGIN_JS_OBJECT);
    const keys = Object.keys(obj);
    for (const k of keys) {
      this.#writePropertyKey(k);
      // Narrowed: k is an own enumerable key on obj.
      this.#writeAny((obj as Record<string, unknown>)[k]);
    }
    this.#writeByte(TAG_END_JS_OBJECT);
    this.writeUint32(keys.length);
  }
}

Serializer.prototype._getDataCloneError = Error;

export class Deserializer {
  buffer: ArrayBufferView;
  #bytes: Uint8Array;
  #view: DataView;
  #pos = 0;
  #version: number | undefined = undefined;
  #objects: unknown[] = [];
  #transferredBuffers = new Map<number, ArrayBufferLike>();

  _readHostObject?(): unknown;

  constructor(buffer: ArrayBufferView) {
    if (!ArrayBuffer.isView(buffer)) {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "buffer" argument must be an instance of Buffer, TypedArray, or DataView.',
      );
    }
    this.buffer = buffer;
    this.#bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.#view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  #ensureAvailable(count: number): void {
    if (count < 0 || this.#pos + count > this.#bytes.byteLength) {
      throw new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
    }
  }

  #readByte(): number {
    this.#ensureAvailable(1);
    return this.#bytes[this.#pos++];
  }

  #peekByte(): number {
    this.#ensureAvailable(1);
    return this.#bytes[this.#pos];
  }

  #readVarintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.#readByte();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) {
        throw new Error('Unable to deserialize cloned data.');
      }
    }
  }

  readHeader(): boolean {
    while (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === TAG_PADDING) {
      this.#pos++;
    }
    const tag = this.#readByte();
    if (tag !== TAG_VERSION) {
      throw new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
    }
    const version = this.readUint32();
    if (version < 13 || version > WIRE_VERSION) {
      throw new Error('Unable to deserialize cloned data due to invalid or unsupported version.');
    }
    this.#version = version;
    return true;
  }

  getWireFormatVersion(): number {
    return this.#version ?? 0;
  }

  readUint32(): number {
    const v = this.#readVarintBig();
    if (v > 0xffffffffn) {
      throw new Error('Unable to deserialize cloned data.');
    }
    return Number(v);
  }

  readUint64(): [number, number] {
    const v = this.#readVarintBig();
    const lo = Number(v & 0xffffffffn) >>> 0;
    const hi = Number((v >> 32n) & 0xffffffffn) >>> 0;
    return [hi, lo];
  }

  readDouble(): number {
    this.#ensureAvailable(8);
    const val = this.#view.getFloat64(this.#pos, true);
    this.#pos += 8;
    return val;
  }

  _readRawBytes(length: number): number {
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
      throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'Invalid raw byte length');
    }
    this.#ensureAvailable(length);
    const start = this.#pos;
    this.#pos += length;
    return start;
  }

  readRawBytes(length: number): Buffer {
    const relOffset = this._readRawBytes(length);
    if (this.buffer.buffer instanceof ArrayBuffer) {
      return Buffer.from(this.buffer.buffer, this.buffer.byteOffset + relOffset, length);
    }
    const copy = Buffer.allocUnsafe(length);
    copy.set(new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + relOffset, length));
    return copy;
  }

  transferArrayBuffer(id: number, arrayBuffer: ArrayBufferLike): void {
    const isAb =
      arrayBuffer instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer === 'function' && arrayBuffer instanceof SharedArrayBuffer);
    if (!isAb) {
      throw nodeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "arrayBuffer" argument must be an instance of ArrayBuffer or SharedArrayBuffer.',
      );
    }
    this.#transferredBuffers.set(id >>> 0, arrayBuffer);
  }

  readValue(): unknown {
    return this.#readAny(false);
  }

  #register<T>(obj: T): T {
    this.#objects.push(obj);
    return obj;
  }

  #readNextTag(): number {
    let tag = this.#readByte();
    while (tag === TAG_PADDING) {
      tag = this.#readByte();
    }
    return tag;
  }

  #readOneByteString(): string {
    const len = this.readUint32();
    const start = this._readRawBytes(len);
    let out = '';
    const end = start + len;
    for (let i = start; i < end; i++) {
      out += String.fromCharCode(this.#bytes[i]);
    }
    return out;
  }

  #readUtf8String(): string {
    const byteLen = this.readUint32();
    const start = this._readRawBytes(byteLen);
    return UTF8_DECODER.decode(this.#bytes.subarray(start, start + byteLen));
  }

  #readTwoByteString(): string {
    const byteLen = this.readUint32();
    if ((byteLen & 1) !== 0) {
      throw new Error('Unable to deserialize cloned data.');
    }
    const start = this._readRawBytes(byteLen);
    let out = '';
    for (let i = 0; i < byteLen; i += 2) {
      const code = this.#bytes[start + i] | (this.#bytes[start + i + 1] << 8);
      out += String.fromCharCode(code);
    }
    return out;
  }

  #readStringValue(): string {
    const tag = this.#readNextTag();
    if (tag === TAG_ONE_BYTE_STRING) return this.#readOneByteString();
    if (tag === TAG_UTF8_STRING) return this.#readUtf8String();
    if (tag === TAG_TWO_BYTE_STRING) return this.#readTwoByteString();
    throw new Error('Unable to deserialize cloned data.');
  }

  #readBigIntPayload(): bigint {
    const bitfield = this.#readVarintBig();
    const neg = (bitfield & 1n) !== 0n;
    const byteLen = Number(bitfield >> 1n);
    if (byteLen === 0) return 0n;
    const start = this._readRawBytes(byteLen);
    let mag = 0n;
    for (let i = byteLen - 1; i >= 0; i--) {
      mag = (mag << 8n) | BigInt(this.#bytes[start + i]);
    }
    return neg ? -mag : mag;
  }

  #maybeWrapView(ab: ArrayBufferLike): ArrayBufferLike | ArrayBufferView {
    while (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === TAG_PADDING) {
      this.#pos++;
    }
    if (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === TAG_ARRAY_BUFFER_VIEW) {
      this.#pos++; // consume TAG_ARRAY_BUFFER_VIEW
      const subtag = this.#readByte();
      const byteOffset = this.readUint32();
      const byteLength = this.readUint32();
      if ((this.#version ?? WIRE_VERSION) >= 14) {
        this.readUint32(); // consume flags
      }
      const view = constructBareView(subtag, ab, byteOffset, byteLength);
      return this.#register(view);
    }
    return ab;
  }

  #readError(): Error {
    let Ctor: ErrorConstructor = Error;
    const first = this.#peekByte();
    if (first === ERR_EVAL) {
      this.#readByte();
      Ctor = EvalError;
    } else if (first === ERR_RANGE) {
      this.#readByte();
      Ctor = RangeError;
    } else if (first === ERR_REFERENCE) {
      this.#readByte();
      Ctor = ReferenceError;
    } else if (first === ERR_SYNTAX) {
      this.#readByte();
      Ctor = SyntaxError;
    } else if (first === ERR_TYPE) {
      this.#readByte();
      Ctor = TypeError;
    } else if (first === ERR_URI) {
      this.#readByte();
      Ctor = URIError;
    }

    const err = new Ctor();
    Reflect.deleteProperty(err, 'stack');
    this.#register(err);

    for (;;) {
      const sub = this.#readByte();
      if (sub === ERR_END) break;
      if (sub === ERR_MESSAGE) {
        Object.defineProperty(err, 'message', {
          value: this.#readStringValue(),
          writable: true,
          enumerable: false,
          configurable: true,
        });
      } else if (sub === ERR_STACK) {
        Object.defineProperty(err, 'stack', {
          value: this.#readStringValue(),
          writable: true,
          enumerable: false,
          configurable: true,
        });
      } else if (sub === ERR_CAUSE) {
        const cause = this.#readAny(false);
        Object.defineProperty(err, 'cause', {
          value: cause,
          writable: true,
          enumerable: false,
          configurable: true,
        });
      } else {
        throw new Error('Unable to deserialize cloned data.');
      }
    }
    return err;
  }

  #readAny(allowHole: boolean): unknown {
    const tag = this.#readNextTag();
    switch (tag) {
      case TAG_UNDEFINED:
        return undefined;
      case TAG_NULL:
        return null;
      case TAG_TRUE:
        return true;
      case TAG_FALSE:
        return false;
      case TAG_THE_HOLE:
        if (allowHole) return HOLE_SENTINEL;
        throw new Error('Unable to deserialize cloned data.');
      case TAG_INT32: {
        const zigzag = this.readUint32();
        return (zigzag >>> 1) ^ -(zigzag & 1);
      }
      case TAG_UINT32:
        return this.readUint32();
      case TAG_DOUBLE:
        return this.readDouble();
      case TAG_BIGINT:
        return this.#readBigIntPayload();
      case TAG_ONE_BYTE_STRING:
        return this.#readOneByteString();
      case TAG_UTF8_STRING:
        return this.#readUtf8String();
      case TAG_TWO_BYTE_STRING:
        return this.#readTwoByteString();
      case TAG_OBJECT_REF: {
        const id = this.readUint32();
        if (id >= this.#objects.length) {
          throw new Error('Unable to deserialize cloned data.');
        }
        const target = this.#objects[id];
        if (
          target instanceof ArrayBuffer ||
          (typeof SharedArrayBuffer === 'function' && target instanceof SharedArrayBuffer)
        ) {
          return this.#maybeWrapView(target);
        }
        return target;
      }
      case TAG_ARRAY_BUFFER: {
        const byteLen = this.readUint32();
        const start = this._readRawBytes(byteLen);
        const ab = new ArrayBuffer(byteLen);
        new Uint8Array(ab).set(this.#bytes.subarray(start, start + byteLen));
        this.#register(ab);
        return this.#maybeWrapView(ab);
      }
      case TAG_RESIZABLE_ARRAY_BUFFER: {
        const byteLen = this.readUint32();
        const maxByteLen = this.readUint32();
        const start = this._readRawBytes(byteLen);
        // ES2024 ArrayBuffer(length, { maxByteLength }) is constructed via Reflect.construct for ES2022 lib target compatibility; returns ArrayBuffer.
        const ab = Reflect.construct(ArrayBuffer, [
          byteLen,
          { maxByteLength: maxByteLen },
        ]) as ArrayBuffer;
        new Uint8Array(ab).set(this.#bytes.subarray(start, start + byteLen));
        this.#register(ab);
        return this.#maybeWrapView(ab);
      }
      case TAG_ARRAY_BUFFER_TRANSFER:
      case TAG_SHARED_ARRAY_BUFFER: {
        const xferId = this.readUint32();
        const ab = this.#transferredBuffers.get(xferId);
        if (!ab) {
          throw new Error('Unable to deserialize cloned data.');
        }
        this.#register(ab);
        return this.#maybeWrapView(ab);
      }
      case TAG_HOST_OBJECT: {
        if (typeof this._readHostObject !== 'function') {
          throw new Error('Unable to deserialize host object.');
        }
        const hostVal = this._readHostObject();
        return this.#register(hostVal);
      }
      case TAG_DATE:
        return this.#register(new Date(this.readDouble()));
      case TAG_TRUE_OBJECT:
        return this.#register(new Boolean(true));
      case TAG_FALSE_OBJECT:
        return this.#register(new Boolean(false));
      case TAG_NUMBER_OBJECT:
        return this.#register(new Number(this.readDouble()));
      case TAG_STRING_OBJECT:
        return this.#register(new String(this.#readStringValue()));
      case TAG_BIGINT_OBJECT:
        return this.#register(Object(this.#readBigIntPayload()));
      case TAG_REGEXP: {
        const source = this.#readStringValue();
        const flagsMask = this.readUint32();
        return this.#register(new RegExp(source, decodeRegExpFlags(flagsMask)));
      }
      case TAG_BEGIN_JS_OBJECT: {
        const obj: Record<string, unknown> = {};
        this.#register(obj);
        let count = 0;
        while (this.#peekByteAfterPadding() !== TAG_END_JS_OBJECT) {
          const key = String(this.#readAny(false));
          const val = this.#readAny(false);
          Object.defineProperty(obj, key, {
            value: val,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          count++;
        }
        this.#readNextTag(); // TAG_END_JS_OBJECT
        const expected = this.readUint32();
        if (expected !== count) {
          throw new Error('Unable to deserialize cloned data.');
        }
        return obj;
      }
      case TAG_BEGIN_DENSE_ARRAY: {
        const len = this.readUint32();
        const arr = new Array<unknown>(len);
        this.#register(arr);
        for (let i = 0; i < len; i++) {
          const elem = this.#readAny(true);
          if (elem !== HOLE_SENTINEL) {
            arr[i] = elem;
          }
        }
        let extra = 0;
        while (this.#peekByteAfterPadding() !== TAG_END_DENSE_ARRAY) {
          const key = String(this.#readAny(false));
          const val = this.#readAny(false);
          Object.defineProperty(arr, key, {
            value: val,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          extra++;
        }
        this.#readNextTag(); // TAG_END_DENSE_ARRAY
        const expectedExtra = this.readUint32();
        const expectedLen = this.readUint32();
        if (expectedExtra !== extra || expectedLen !== len) {
          throw new Error('Unable to deserialize cloned data.');
        }
        return arr;
      }
      case TAG_BEGIN_SPARSE_ARRAY: {
        const len = this.readUint32();
        const arr = new Array<unknown>(len);
        this.#register(arr);
        let props = 0;
        while (this.#peekByteAfterPadding() !== TAG_END_SPARSE_ARRAY) {
          const key = String(this.#readAny(false));
          const val = this.#readAny(false);
          Object.defineProperty(arr, key, {
            value: val,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          props++;
        }
        this.#readNextTag(); // TAG_END_SPARSE_ARRAY
        const expectedProps = this.readUint32();
        const expectedLen = this.readUint32();
        if (expectedProps !== props || expectedLen !== len) {
          throw new Error('Unable to deserialize cloned data.');
        }
        return arr;
      }
      case TAG_BEGIN_MAP: {
        const map = new Map<unknown, unknown>();
        this.#register(map);
        let entries = 0;
        while (this.#peekByteAfterPadding() !== TAG_END_MAP) {
          const k = this.#readAny(false);
          const v = this.#readAny(false);
          map.set(k, v);
          entries += 2;
        }
        this.#readNextTag(); // TAG_END_MAP
        const expected = this.readUint32();
        if (expected !== entries) {
          throw new Error('Unable to deserialize cloned data.');
        }
        return map;
      }
      case TAG_BEGIN_SET: {
        const set = new Set<unknown>();
        this.#register(set);
        let items = 0;
        while (this.#peekByteAfterPadding() !== TAG_END_SET) {
          set.add(this.#readAny(false));
          items++;
        }
        this.#readNextTag(); // TAG_END_SET
        const expected = this.readUint32();
        if (expected !== items) {
          throw new Error('Unable to deserialize cloned data.');
        }
        return set;
      }
      case TAG_ERROR:
        return this.#readError();
      default:
        throw new Error('Unable to deserialize cloned data.');
    }
  }

  #peekByteAfterPadding(): number {
    while (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === TAG_PADDING) {
      this.#pos++;
    }
    return this.#peekByte();
  }
}

const HOLE_SENTINEL = Symbol('v8.hole');

export class DefaultSerializer extends Serializer {
  constructor() {
    super();
    this._setTreatArrayBufferViewsAsHostObjects(true);
  }

  override _writeHostObject(abView: object): void {
    if (!ArrayBuffer.isView(abView)) {
      const Ctor = typeof this._getDataCloneError === 'function' ? this._getDataCloneError : Error;
      throw new Ctor('Unserializable host object');
    }
    const idx = defaultHostTypeIndex(abView);
    if (idx === -1) {
      const Ctor = typeof this._getDataCloneError === 'function' ? this._getDataCloneError : Error;
      throw new Ctor('Unserializable host object');
    }
    this.writeUint32(idx);
    this.writeUint32(abView.byteLength);
    this.writeRawBytes(new Uint8Array(abView.buffer, abView.byteOffset, abView.byteLength));
  }
}

export class DefaultDeserializer extends Deserializer {
  override _readHostObject(): unknown {
    const typeIndex = this.readUint32();
    const byteLength = this.readUint32();
    const relOffset = this._readRawBytes(byteLength);
    return constructHostView(
      typeIndex,
      this.buffer.buffer,
      this.buffer.byteOffset + relOffset,
      byteLength,
    );
  }
}

export function serialize(value: unknown): Buffer {
  const ser = new DefaultSerializer();
  ser.writeHeader();
  ser.writeValue(value);
  return ser.releaseBuffer();
}

export function deserialize(buffer: ArrayBufferView): unknown {
  const des = new DefaultDeserializer(buffer);
  des.readHeader();
  return des.readValue();
}
