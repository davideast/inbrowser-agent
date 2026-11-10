import { decoder, encoder, errorRecord, fault, record, unwrap } from './value-guards';

export {
  decoder,
  encoder,
  errorRecord,
  fault,
  isFileDescriptor,
  isStdioBindings,
  record,
  reviveError,
  unwrap,
  type ErrorRecord,
  type StdioBindings,
} from './value-guards';

export const VERSION = 5;
export const CAPACITY = 1024 * 1024;
export const HEADER_BYTES = 16;
export const CALL_TIMEOUT = 5000;
export const SYSCALL_FRAMING_SLACK = 64 * 1024;
export const DEFAULT_MAX_SYSCALL_BYTES = 32 * 1024 * 1024 + SYSCALL_FRAMING_SLACK;
export const SEEK_SET = 0;
export const SEEK_CUR = 1;
export const SEEK_END = 2;
export const MAX_DECODE_DEPTH = 256;
export const SOCKET_LIMIT = 1024 * 1024;

const FRAME_MAGIC_0 = 0x53; // 'S'
const FRAME_MAGIC_1 = 0x42; // 'B'
const FRAME_MAGIC_2 = 0x76; // 'v'
const FRAME_VERSION = 0x05;

const TAG_UNDEFINED = 0x00;
const TAG_NULL = 0x01;
const TAG_FALSE = 0x02;
const TAG_TRUE = 0x03;
const TAG_INT32 = 0x04;
const TAG_FLOAT64 = 0x05;
const TAG_STRING = 0x06;
const TAG_UTF16_STRING = 0x07;
const TAG_UINT8ARRAY = 0x08;
const TAG_DATE = 0x09;
const TAG_BIGINT = 0x0a;
const TAG_HOLE = 0x0b;
const TAG_ARRAY = 0x0c;
const TAG_OBJECT = 0x0d;

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

class FrameWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private pos = 0;
  private readonly active = new Set<object>();

  constructor() {
    this.ensure(4);
    this.buf[0] = FRAME_MAGIC_0;
    this.buf[1] = FRAME_MAGIC_1;
    this.buf[2] = FRAME_MAGIC_2;
    this.buf[3] = FRAME_VERSION;
    this.pos = 4;
  }

  private ensure(extra: number): void {
    const needed = this.pos + extra;
    if (needed <= this.buf.byteLength) return;
    let nextCap = this.buf.byteLength * 2;
    if (nextCap < needed) nextCap = needed + 64;
    const grown = new Uint8Array(nextCap);
    grown.set(this.buf.subarray(0, this.pos), 0);
    this.buf = grown;
    this.view = new DataView(this.buf.buffer);
  }

  private writeU8(byte: number): void {
    this.ensure(1);
    this.buf[this.pos++] = byte;
  }

  private writeU32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, value, true);
    this.pos += 4;
  }

  private writeI32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, value, true);
    this.pos += 4;
  }

  private writeF64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, value, true);
    this.pos += 8;
  }

  private writeBytes(bytes: Uint8Array): void {
    const len = bytes.byteLength;
    this.writeU32(len);
    this.ensure(len);
    this.buf.set(new Uint8Array(bytes.buffer, bytes.byteOffset, len), this.pos);
    this.pos += len;
  }

  writeStringValue(text: string): void {
    if (hasLoneSurrogate(text)) {
      this.writeU8(TAG_UTF16_STRING);
      this.writeU32(text.length);
      this.ensure(text.length * 2);
      for (let i = 0; i < text.length; i++) {
        this.view.setUint16(this.pos, text.charCodeAt(i), true);
        this.pos += 2;
      }
      return;
    }
    this.writeU8(TAG_STRING);
    this.writeBytes(encoder.encode(text));
  }

  writeValue(value: unknown): void {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      this.writeU8(TAG_UNDEFINED);
      return;
    }
    if (value === null) {
      this.writeU8(TAG_NULL);
      return;
    }
    if (typeof value === 'boolean') {
      this.writeU8(value ? TAG_TRUE : TAG_FALSE);
      return;
    }
    if (typeof value === 'number') {
      if (
        Number.isInteger(value) &&
        !Object.is(value, -0) &&
        value >= -2147483648 &&
        value <= 2147483647
      ) {
        this.writeU8(TAG_INT32);
        this.writeI32(value);
      } else {
        this.writeU8(TAG_FLOAT64);
        this.writeF64(value);
      }
      return;
    }
    if (typeof value === 'string') {
      this.writeStringValue(value);
      return;
    }
    if (typeof value === 'bigint') {
      this.writeU8(TAG_BIGINT);
      this.writeBytes(encoder.encode(value.toString()));
      return;
    }
    if (value instanceof Uint8Array) {
      this.writeU8(TAG_UINT8ARRAY);
      this.writeBytes(value);
      return;
    }
    if (Object.prototype.toString.call(value) === '[object Date]') {
      this.writeU8(TAG_DATE);
      this.writeF64(Date.prototype.getTime.call(value));
      return;
    }
    if (Array.isArray(value)) {
      if (this.active.has(value)) throw new TypeError('Converting circular structure to binary');
      this.active.add(value);
      try {
        this.writeU8(TAG_ARRAY);
        this.writeU32(value.length);
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) this.writeU8(TAG_HOLE);
          else this.writeValue(value[i]);
        }
      } finally {
        this.active.delete(value);
      }
      return;
    }
    if (record(value)) {
      if (this.active.has(value)) throw new TypeError('Converting circular structure to binary');
      this.active.add(value);
      try {
        const keys = Object.keys(value);
        const kept: Array<[string, unknown]> = [];
        for (const key of keys) {
          const item = value[key];
          if (item !== undefined && typeof item !== 'function' && typeof item !== 'symbol')
            kept.push([key, item]);
        }
        this.writeU8(TAG_OBJECT);
        this.writeU32(kept.length);
        for (const [key, item] of kept) {
          this.writeStringValue(key);
          this.writeValue(item);
        }
      } finally {
        this.active.delete(value);
      }
      return;
    }
    this.writeU8(TAG_UNDEFINED);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export function encode(value: unknown): Uint8Array {
  const writer = new FrameWriter();
  writer.writeValue(value);
  return writer.finish();
}

export function decode(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5)
    throw fault('EPROTO', 'Malformed binary v5 frame');
  if (
    bytes[0] !== FRAME_MAGIC_0 ||
    bytes[1] !== FRAME_MAGIC_1 ||
    bytes[2] !== FRAME_MAGIC_2 ||
    bytes[3] !== FRAME_VERSION
  )
    throw fault('EPROTO', 'Unsupported wire frame version');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 4;

  const requireBytes = (count: number): void => {
    if (count < 0 || pos + count > bytes.byteLength)
      throw fault('EPROTO', 'Truncated binary v5 frame');
  };
  const readU8 = (): number => {
    requireBytes(1);
    return bytes[pos++]!;
  };
  const readU32 = (): number => {
    requireBytes(4);
    const val = view.getUint32(pos, true);
    pos += 4;
    return val;
  };
  const readI32 = (): number => {
    requireBytes(4);
    const val = view.getInt32(pos, true);
    pos += 4;
    return val;
  };
  const readF64 = (): number => {
    requireBytes(8);
    const val = view.getFloat64(pos, true);
    pos += 8;
    return val;
  };
  const readStringByTag = (tag: number): string => {
    if (tag === TAG_STRING) {
      const len = readU32();
      requireBytes(len);
      const text = decoder.decode(bytes.subarray(pos, pos + len));
      pos += len;
      return text;
    }
    if (tag === TAG_UTF16_STRING) {
      const units = readU32();
      if (units > 0x3fffffff) throw fault('EPROTO', 'Invalid UTF-16 string length');
      requireBytes(units * 2);
      const chunks: string[] = [];
      for (let offset = 0; offset < units; offset += 4096) {
        const end = Math.min(units, offset + 4096);
        const codes: number[] = [];
        for (let i = offset; i < end; i++) {
          codes.push(view.getUint16(pos, true));
          pos += 2;
        }
        chunks.push(String.fromCharCode(...codes));
      }
      return chunks.join('');
    }
    throw fault('EPROTO', 'Expected string tag in binary v5 frame');
  };

  const readValue = (depth = 0): unknown => {
    const tag = readU8();
    switch (tag) {
      case TAG_UNDEFINED:
        return undefined;
      case TAG_NULL:
        return null;
      case TAG_FALSE:
        return false;
      case TAG_TRUE:
        return true;
      case TAG_INT32:
        return readI32();
      case TAG_FLOAT64:
        return readF64();
      case TAG_STRING:
      case TAG_UTF16_STRING:
        return readStringByTag(tag);
      case TAG_UINT8ARRAY: {
        const len = readU32();
        requireBytes(len);
        const slice = bytes.slice(pos, pos + len);
        pos += len;
        return slice;
      }
      case TAG_DATE:
        return new Date(readF64());
      case TAG_BIGINT: {
        const len = readU32();
        requireBytes(len);
        const digits = decoder.decode(bytes.subarray(pos, pos + len));
        pos += len;
        try {
          return BigInt(digits);
        } catch {
          throw fault('EPROTO', 'Invalid bigint in binary v5 frame');
        }
      }
      case TAG_ARRAY: {
        if (depth >= MAX_DECODE_DEPTH)
          throw fault('EPROTO', 'Binary v5 frame exceeds maximum nesting depth');
        const len = readU32();
        if (len > bytes.byteLength - pos) throw fault('EPROTO', 'Invalid array length');
        const list = new Array<unknown>(len);
        for (let i = 0; i < len; i++) {
          requireBytes(1);
          if (bytes[pos] === TAG_HOLE) {
            pos++;
          } else {
            list[i] = readValue(depth + 1);
          }
        }
        return list;
      }
      case TAG_OBJECT: {
        if (depth >= MAX_DECODE_DEPTH)
          throw fault('EPROTO', 'Binary v5 frame exceeds maximum nesting depth');
        const count = readU32();
        if (count > bytes.byteLength - pos) throw fault('EPROTO', 'Invalid object entry count');
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const key = readStringByTag(readU8());
          const item = readValue(depth + 1);
          if (key === '__proto__') {
            Object.defineProperty(obj, key, {
              value: item,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          } else {
            obj[key] = item;
          }
        }
        return obj;
      }
      default:
        throw fault('EPROTO', 'Unknown binary v5 tag');
    }
  };

  const result = readValue();
  if (pos !== bytes.byteLength) throw fault('EPROTO', 'Trailing bytes in binary v5 frame');
  return result;
}

const STATUS_WAITING = 0;
const STATUS_COMPLETE = 1;
const STATUS_MORE = 2;

export class Syscalls {
  private readonly control: Int32Array;
  private readonly payload: Uint8Array;
  private sequence = 0;
  private poisoned = false;
  constructor(
    private port: MessagePort,
    shared: SharedArrayBuffer,
    // resource-policy.ts imports this module, so runtime deadlines and payload
    // bounds arrive as parameters rather than through the realm accessor.
    private readonly callTimeoutMs: number = CALL_TIMEOUT,
    private readonly maxPayloadBytes: number = DEFAULT_MAX_SYSCALL_BYTES,
  ) {
    this.control = new Int32Array(shared, 0, 4);
    this.payload = new Uint8Array(shared, HEADER_BYTES);
  }

  private waitForTurn(deadline: number): number {
    for (;;) {
      const status = Atomics.load(this.control, 0);
      if (status !== STATUS_WAITING) return status;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.poisoned = true;
        throw fault('ETIMEDOUT', 'Kernel did not complete syscall');
      }
      Atomics.wait(this.control, 0, STATUS_WAITING, remaining);
    }
  }

  private failProtocol(): never {
    this.poisoned = true;
    throw fault('EPROTO', 'Invalid syscall completion');
  }

  private decodeReply(bytes: Uint8Array): unknown {
    let decoded: unknown;
    try {
      decoded = decode(bytes);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
    if (
      !record(decoded) ||
      typeof decoded.ok !== 'boolean' ||
      (decoded.ok === false && !record(decoded.error))
    ) {
      this.poisoned = true;
    }
    return unwrap(decoded);
  }

  call(op: string, args: unknown[] = []): unknown {
    // A poisoned channel is the one EPIPE that is a channel failure, not a
    // closed container or process, so it names its kind explicitly.
    if (this.poisoned) throw fault('EPIPE', 'Syscall channel failed', { kind: 'channel' });
    const sequence = ++this.sequence;
    const request = encode({ version: VERSION, sequence, op, args });
    if (request.length > this.maxPayloadBytes)
      throw fault('E2BIG', 'Syscall request exceeds policy limit', {
        limit: this.maxPayloadBytes,
        actual: request.length,
      });

    const deadline = Date.now() + this.callTimeoutMs;
    Atomics.store(this.control, 0, STATUS_WAITING);
    if (request.length <= CAPACITY) {
      this.port.postMessage(request);
    } else {
      for (let offset = 0; offset < request.length; offset += CAPACITY) {
        const end = Math.min(request.length, offset + CAPACITY);
        this.port.postMessage({
          v5Chunk: 'req',
          sequence,
          totalBytes: request.length,
          offset,
          data: request.slice(offset, end),
        });
      }
    }

    const firstStatus = this.waitForTurn(deadline);
    const firstSize = Atomics.load(this.control, 1);
    const firstSeq = Atomics.load(this.control, 2);
    const rawTotal = Atomics.load(this.control, 3);
    const totalBytes = rawTotal === 0 ? firstSize : rawTotal;

    if (firstSeq !== sequence || firstSize < 0 || firstSize > CAPACITY) this.failProtocol();

    if (firstStatus === STATUS_COMPLETE) {
      if (totalBytes !== firstSize) this.failProtocol();
      return this.decodeReply(this.payload.slice(0, firstSize));
    }

    if (
      firstStatus !== STATUS_MORE ||
      firstSize === 0 ||
      totalBytes <= firstSize ||
      totalBytes > this.maxPayloadBytes
    )
      this.failProtocol();

    const assembled = new Uint8Array(totalBytes);
    assembled.set(this.payload.subarray(0, firstSize), 0);
    let received = firstSize;

    while (received < totalBytes) {
      Atomics.store(this.control, 0, STATUS_WAITING);
      this.port.postMessage({ v5Chunk: 'pull', sequence, offset: received });
      const nextStatus = this.waitForTurn(deadline);
      const nextSize = Atomics.load(this.control, 1);
      const nextSeq = Atomics.load(this.control, 2);
      const nextTotal = Atomics.load(this.control, 3);
      if (
        nextSeq !== sequence ||
        nextTotal !== totalBytes ||
        nextSize <= 0 ||
        nextSize > CAPACITY ||
        received + nextSize > totalBytes
      )
        this.failProtocol();
      const complete = received + nextSize === totalBytes;
      if (complete ? nextStatus !== STATUS_COMPLETE : nextStatus !== STATUS_MORE)
        this.failProtocol();
      assembled.set(this.payload.subarray(0, nextSize), received);
      received += nextSize;
    }

    return this.decodeReply(assembled);
  }
}

export interface SyscallResponder {
  handleMessage(data: unknown): void;
  dispose(): void;
}

export function createSyscallResponder(
  shared: SharedArrayBuffer,
  handler: (op: string, args: unknown[]) => unknown,
  getMaxPayloadBytes: () => number = () => DEFAULT_MAX_SYSCALL_BYTES,
): SyscallResponder {
  const control = new Int32Array(shared, 0, 4);
  const payload = new Uint8Array(shared, HEADER_BYTES);
  let pendingRequest: {
    sequence: number;
    totalBytes: number;
    offset: number;
    buffer: Uint8Array;
  } | null = null;
  let rejectedRequest: { sequence: number; limit: number; actual: number } | null = null;
  let pendingReply: { sequence: number; bytes: Uint8Array; offset: number } | null = null;

  const publishChunk = (
    sequence: number,
    chunk: Uint8Array,
    totalBytes: number,
    status: number,
  ): void => {
    payload.set(chunk, 0);
    Atomics.store(control, 1, chunk.byteLength);
    Atomics.store(control, 2, sequence);
    Atomics.store(control, 3, totalBytes);
    Atomics.store(control, 0, status);
    Atomics.notify(control, 0);
  };

  const sendReplyBytes = (sequence: number, rawBytes: Uint8Array, maxBytes: number): void => {
    let bytes = rawBytes;
    if (bytes.byteLength > maxBytes) {
      bytes = encode({
        ok: false,
        error: errorRecord(
          fault('E2BIG', 'Syscall response exceeds policy limit', {
            limit: maxBytes,
            actual: bytes.byteLength,
          }),
        ),
      });
    }
    if (bytes.byteLength <= CAPACITY) {
      pendingReply = null;
      publishChunk(sequence, bytes, bytes.byteLength, STATUS_COMPLETE);
      return;
    }
    const first = bytes.subarray(0, CAPACITY);
    pendingReply = { sequence, bytes, offset: CAPACITY };
    publishChunk(sequence, first, bytes.byteLength, STATUS_MORE);
  };

  const executeFrame = (frameBytes: Uint8Array, maxBytes: number, fallbackSequence = -1): void => {
    let sequence = fallbackSequence;
    let encodedReply: Uint8Array;
    try {
      const request = decode(frameBytes);
      if (
        !record(request) ||
        request.version !== VERSION ||
        typeof request.sequence !== 'number' ||
        !Number.isInteger(request.sequence) ||
        typeof request.op !== 'string' ||
        !Array.isArray(request.args)
      )
        throw fault('EPROTO', 'Invalid syscall');
      sequence = request.sequence;
      encodedReply = encode({ ok: true, value: handler(request.op, request.args) });
    } catch (error) {
      encodedReply = encode({ ok: false, error: errorRecord(error) });
    }
    sendReplyBytes(sequence, encodedReply, maxBytes);
  };

  return {
    handleMessage(data: unknown): void {
      const maxBytes = getMaxPayloadBytes();

      if (data instanceof Uint8Array) {
        pendingRequest = null;
        rejectedRequest = null;
        pendingReply = null;
        if (data.byteLength > CAPACITY) {
          sendReplyBytes(
            -1,
            encode({
              ok: false,
              error: errorRecord(
                fault('E2BIG', 'Invalid syscall request chunk', {
                  limit: CAPACITY,
                  actual: data.byteLength,
                }),
              ),
            }),
            maxBytes,
          );
          return;
        }
        executeFrame(data, maxBytes);
        return;
      }

      if (record(data) && data.v5Chunk === 'req') {
        pendingReply = null;
        const { sequence, totalBytes, offset, data: chunk } = data;
        if (
          typeof sequence !== 'number' ||
          !Number.isInteger(sequence) ||
          typeof totalBytes !== 'number' ||
          !Number.isSafeInteger(totalBytes) ||
          totalBytes <= CAPACITY ||
          typeof offset !== 'number' ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !(chunk instanceof Uint8Array) ||
          chunk.byteLength === 0 ||
          chunk.byteLength > CAPACITY ||
          offset + chunk.byteLength > totalBytes
        ) {
          pendingRequest = null;
          rejectedRequest = null;
          const seq = typeof sequence === 'number' && Number.isInteger(sequence) ? sequence : -1;
          sendReplyBytes(
            seq,
            encode({ ok: false, error: errorRecord(fault('EPROTO', 'Invalid request chunk')) }),
            maxBytes,
          );
          return;
        }

        const isFinal = offset + chunk.byteLength === totalBytes;
        if (offset === 0 && totalBytes > maxBytes) {
          pendingRequest = null;
          rejectedRequest = { sequence, limit: maxBytes, actual: totalBytes };
        }
        if (rejectedRequest && rejectedRequest.sequence === sequence) {
          if (isFinal) {
            const { limit, actual } = rejectedRequest;
            rejectedRequest = null;
            sendReplyBytes(
              sequence,
              encode({
                ok: false,
                error: errorRecord(
                  fault('E2BIG', 'Syscall request exceeds policy limit', { limit, actual }),
                ),
              }),
              maxBytes,
            );
          }
          return;
        }
        rejectedRequest = null;

        if (offset === 0) {
          const buffer = new Uint8Array(totalBytes);
          buffer.set(chunk, 0);
          pendingRequest = { sequence, totalBytes, offset: chunk.byteLength, buffer };
        } else if (
          pendingRequest &&
          pendingRequest.sequence === sequence &&
          pendingRequest.totalBytes === totalBytes &&
          pendingRequest.offset === offset
        ) {
          pendingRequest.buffer.set(chunk, offset);
          pendingRequest.offset += chunk.byteLength;
        } else {
          pendingRequest = null;
          sendReplyBytes(
            sequence,
            encode({
              ok: false,
              error: errorRecord(fault('EPROTO', 'Out-of-order request chunk')),
            }),
            maxBytes,
          );
          return;
        }

        if (isFinal && pendingRequest) {
          const assembled = pendingRequest.buffer;
          pendingRequest = null;
          executeFrame(assembled, maxBytes, sequence);
        }
        return;
      }

      if (record(data) && data.v5Chunk === 'pull') {
        const { sequence, offset } = data;
        if (
          typeof sequence !== 'number' ||
          !Number.isInteger(sequence) ||
          typeof offset !== 'number' ||
          !Number.isSafeInteger(offset) ||
          !pendingReply ||
          pendingReply.sequence !== sequence ||
          pendingReply.offset !== offset
        ) {
          pendingReply = null;
          const seq = typeof sequence === 'number' && Number.isInteger(sequence) ? sequence : -1;
          publishChunk(
            seq,
            encode({ ok: false, error: errorRecord(fault('EPROTO', 'Invalid reply pull')) }),
            0,
            STATUS_COMPLETE,
          );
          return;
        }
        const total = pendingReply.bytes.byteLength;
        const nextLen = Math.min(CAPACITY, total - offset);
        const slice = pendingReply.bytes.subarray(offset, offset + nextLen);
        pendingReply.offset += nextLen;
        const done = pendingReply.offset >= total;
        if (done) pendingReply = null;
        publishChunk(sequence, slice, total, done ? STATUS_COMPLETE : STATUS_MORE);
        return;
      }

      pendingRequest = null;
      rejectedRequest = null;
      pendingReply = null;
      sendReplyBytes(
        -1,
        encode({ ok: false, error: errorRecord(fault('EPROTO', 'Invalid syscall message')) }),
        maxBytes,
      );
    },
    dispose(): void {
      pendingRequest = null;
      rejectedRequest = null;
      pendingReply = null;
    },
  };
}
