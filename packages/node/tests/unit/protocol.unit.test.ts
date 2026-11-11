import { describe, expect, it } from 'vitest';
import { errorTaxonomy } from '../../src/errors';
import {
  CAPACITY,
  HEADER_BYTES,
  Syscalls,
  VERSION,
  createSyscallResponder,
  decode,
  encode,
  errorRecord,
  fault,
  isFileDescriptor,
  isStdioBindings,
  record,
  unwrap,
} from '../../src/protocol';

function expectRecord(value: unknown): Record<string, unknown> {
  expect(record(value)).toBe(true);
  if (!record(value)) throw new Error('Expected object record');
  return value;
}

function expectUint8Array(value: unknown): Uint8Array {
  expect(value).toBeInstanceOf(Uint8Array);
  if (!(value instanceof Uint8Array)) throw new Error('Expected Uint8Array');
  return value;
}

function expectArray(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) throw new Error('Expected Array');
  return value;
}

function expectDate(value: unknown): Date {
  expect(value).toBeInstanceOf(Date);
  if (!(value instanceof Date)) throw new Error('Expected Date');
  return value;
}

function errorCodeOf(error: unknown): unknown {
  return record(error) ? error.code : undefined;
}

function loopbackPort(postMessage: (data: unknown) => void): MessagePort {
  // Invariant: Syscalls only invokes MessagePort.postMessage(data); synchronous
  // in-thread dispatch lets unit tests exercise Atomics control headers deterministically.
  return { postMessage } as unknown as MessagePort;
}

describe('protocol VERSION and binary v5 encode/decode', () => {
  it('exposes VERSION = 5', () => {
    expect(VERSION).toBe(5);
  });

  it('round-trips primitives including special IEEE-754 numbers, undefined, and bigint', () => {
    const value = {
      a: 1,
      b: 'text',
      c: [1, 2, 3],
      d: null,
      e: true,
      f: false,
      intMin: -2147483648,
      intMax: 2147483647,
      largeSafe: Number.MAX_SAFE_INTEGER,
      negSafe: Number.MIN_SAFE_INTEGER,
      frac: 3.141592653589793,
      big: 900719925474099312345n,
      negBig: -42n,
    };
    expect(decode(encode(value))).toEqual(value);
    expect(decode(encode(undefined))).toBeUndefined();
    expect(Object.is(decode(encode(-0)), -0)).toBe(true);
    expect(Number.isNaN(decode(encode(Number.NaN)))).toBe(true);
    expect(decode(encode(Number.POSITIVE_INFINITY))).toBe(Number.POSITIVE_INFINITY);
    expect(decode(encode(Number.NEGATIVE_INFINITY))).toBe(Number.NEGATIVE_INFINITY);
  });

  it('round-trips strings with multi-byte UTF-8 and unpaired UTF-16 surrogates', () => {
    const value = {
      unicode: 'é😀漢字',
      loneHigh: 'prefix-\ud800-suffix',
      loneLow: '\udcff',
      reversedPair: '\udc00\ud800',
    };
    expect(decode(encode(value))).toEqual(value);
  });

  it('round-trips Date instances with exact millisecond precision and invalid Dates', () => {
    const valid = new Date('2026-11-07T23:44:21.956Z');
    const restored = expectRecord(decode(encode({ valid, invalid: new Date(Number.NaN) })));
    const restoredValid = expectDate(restored.valid);
    const restoredInvalid = expectDate(restored.invalid);
    expect(restoredValid.getTime()).toBe(valid.getTime());
    expect(Number.isNaN(restoredInvalid.getTime())).toBe(true);
  });

  it('encodes Uint8Array directly as compact raw binary without JSON expansion', () => {
    const raw = new Uint8Array(65536);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31) & 0xff;
    const wire = encode({ op: 'fs.writeSync', data: raw });
    expect(wire).toBeInstanceOf(Uint8Array);
    // Compact binary framing adds only small structural headers, not 3-4x ASCII byte arrays.
    expect(wire.byteLength).toBeGreaterThan(raw.byteLength);
    expect(wire.byteLength).toBeLessThan(raw.byteLength + 128);
    const restored = expectRecord(decode(wire));
    expect(restored.op).toBe('fs.writeSync');
    const restoredData = expectUint8Array(restored.data);
    expect(Buffer.compare(restoredData, raw)).toBe(0);
  });

  it('round-trips a top-level Uint8Array and subarray views as standalone buffers', () => {
    const outer = Uint8Array.from([99, 99, 0, 1, 2, 253, 254, 255, 88]);
    const view = outer.subarray(2, 8);
    const wire = encode(view);
    expect(wire.byteLength).toBeLessThan(24);
    const restored = expectUint8Array(decode(wire));
    expect(Array.from(restored)).toEqual([0, 1, 2, 253, 254, 255]);
    wire.fill(0);
    expect(Array.from(restored)).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it('round-trips nested Uint8Array values inside objects and arrays', () => {
    const value = {
      header: Uint8Array.from([1, 2, 3]),
      list: [Uint8Array.from([4, 5]), { deeper: Uint8Array.from([6, 7, 8]) }],
      empty: Uint8Array.from([]),
    };
    const restored = expectRecord(decode(encode(value)));
    const header = expectUint8Array(restored.header);
    expect(Array.from(header)).toEqual([1, 2, 3]);
    const list = expectArray(restored.list);
    const first = expectUint8Array(list[0]);
    expect(Array.from(first)).toEqual([4, 5]);
    const second = expectRecord(list[1]);
    const deeper = expectUint8Array(second.deeper);
    expect(Array.from(deeper)).toEqual([6, 7, 8]);
    const empty = expectUint8Array(restored.empty);
    expect(Array.from(empty)).toEqual([]);
  });

  it('preserves plain objects with { type: "Buffer", data: [...] } even when bytes are 0..255', () => {
    for (const value of [
      { type: 'Buffer', data: [1, 2, 3] },
      { type: 'Buffer', data: [1, 2, 300] },
    ]) {
      const restored: unknown = decode(encode(value));
      expect(restored).not.toBeInstanceOf(Uint8Array);
      expect(restored).toEqual(value);
    }
  });

  it('omits undefined-valued object keys (as ErrorRecord expects) while preserving array undefined and sparse holes', () => {
    const errReply = {
      ok: false,
      error: errorRecord(Object.assign(new Error('nope'), { code: 'ENOENT' })),
    };
    const decodedReply = expectRecord(decode(encode(errReply)));
    const decodedError = expectRecord(decodedReply.error);
    expect(Object.keys(decodedError)).toEqual(['name', 'message', 'code']);

    const sparse = [1, , undefined, 4];
    const restoredSparse = expectArray(decode(encode(sparse)));
    expect(restoredSparse.length).toBe(4);
    expect(0 in restoredSparse).toBe(true);
    expect(1 in restoredSparse).toBe(false);
    expect(2 in restoredSparse).toBe(true);
    expect(restoredSparse[2]).toBeUndefined();
    expect(restoredSparse[3]).toBe(4);
  });

  it('preserves __proto__ as a safe own data property without mutating Object.prototype', () => {
    const payload: unknown = JSON.parse('{"__proto__":{"polluted":true},"normal":1}');
    const restored = expectRecord(decode(encode(payload)));
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(restored, '__proto__')).toBe(true);
    expect(restored['__proto__']).toEqual({ polluted: true });
    expect(restored.normal).toBe(1);
  });

  it('rejects malformed, truncated, trailing-byte, or over-deep frames with EPROTO', () => {
    const valid = encode({ hello: 'world' });
    for (const bad of [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3, 4, 5]),
      valid.subarray(0, valid.length - 1),
      Uint8Array.of(...valid, 0),
    ]) {
      try {
        decode(bad);
        expect.unreachable();
      } catch (error) {
        expect(errorCodeOf(error)).toBe('EPROTO');
      }
    }

    // Build a raw binary v5 frame with 300 nested 1-element arrays (exceeding MAX_DECODE_DEPTH = 256).
    const depth = 300;
    const deepArrayBytes = new Uint8Array(4 + depth * 5 + 1);
    deepArrayBytes.set([0x53, 0x42, 0x76, 0x05], 0);
    for (let i = 0; i < depth; i++) {
      const off = 4 + i * 5;
      deepArrayBytes[off] = 0x0c; // TAG_ARRAY
      deepArrayBytes[off + 1] = 1; // length = 1 (u32 LE)
    }
    deepArrayBytes[4 + depth * 5] = 0x01; // TAG_NULL leaf
    try {
      decode(deepArrayBytes);
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('EPROTO');
    }
  });
});

describe('isFileDescriptor', () => {
  it('accepts non-negative safe integers', () => {
    expect(isFileDescriptor(0)).toBe(true);
    expect(isFileDescriptor(3)).toBe(true);
  });

  it('rejects negative numbers, floats, and non-numbers', () => {
    expect(isFileDescriptor(-1)).toBe(false);
    expect(isFileDescriptor(1.5)).toBe(false);
    expect(isFileDescriptor('3')).toBe(false);
    expect(isFileDescriptor(Number.MAX_SAFE_INTEGER + 10)).toBe(false);
  });
});

describe('isStdioBindings', () => {
  it('accepts a triple of fds, "inherit", and null', () => {
    expect(isStdioBindings([0, 'inherit', null])).toBe(true);
    expect(isStdioBindings(['inherit', 'inherit', 'inherit'])).toBe(true);
    expect(isStdioBindings([null, null, null])).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isStdioBindings([0, 1])).toBe(false);
    expect(isStdioBindings([0, 1, 2, 3])).toBe(false);
    expect(isStdioBindings([])).toBe(false);
  });

  it('rejects invalid entries and non-arrays', () => {
    expect(isStdioBindings([0, 'pipe', null])).toBe(false);
    expect(isStdioBindings([-1, null, null])).toBe(false);
    expect(isStdioBindings([1.5, null, null])).toBe(false);
    expect(isStdioBindings('not-an-array')).toBe(false);
    expect(isStdioBindings(undefined)).toBe(false);
  });
});

describe('record', () => {
  it('accepts non-null objects and arrays, rejects everything else', () => {
    expect(record({})).toBe(true);
    expect(record([])).toBe(true);
    expect(record(null)).toBe(false);
    expect(record(undefined)).toBe(false);
    expect(record('x')).toBe(false);
    expect(record(1)).toBe(false);
  });
});

describe('fault', () => {
  it('produces an Error carrying the given code', () => {
    const error = fault('ETIMEDOUT', 'Kernel did not complete syscall');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('ETIMEDOUT');
    expect(error.message).toBe('Kernel did not complete syscall');
  });
});

describe('errorRecord', () => {
  it('extracts known fields from an Error-like object', () => {
    const source = Object.assign(new Error('boom'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      path: '/app/x',
      dest: undefined,
    });
    expect(errorRecord(source)).toEqual({
      name: 'Error',
      message: 'boom',
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      path: '/app/x',
      dest: undefined,
    });
  });

  it('falls back to defaults when fields are missing or the wrong type', () => {
    expect(errorRecord({})).toEqual({
      name: 'Error',
      message: '[object Object]',
      code: 'EIO',
      errno: undefined,
      syscall: undefined,
      path: undefined,
      dest: undefined,
    });
    // A message field of the wrong type is ignored, not coerced.
    expect(errorRecord({ message: 42 }).message).toBe('[object Object]');
  });

  it('handles thrown non-object values by stringifying them', () => {
    expect(errorRecord('plain string').message).toBe('plain string');
    expect(errorRecord(42).message).toBe('42');
    expect(errorRecord(null).code).toBe('EIO');
  });
});

describe('unwrap', () => {
  it('returns the value field on an ok reply', () => {
    expect(unwrap({ ok: true, value: 42 })).toBe(42);
    expect(unwrap({ ok: true, value: { nested: true } })).toEqual({ nested: true });
  });

  it('throws the carried error on a failure reply', () => {
    expect(() => unwrap({ ok: false, error: { message: 'nope', code: 'EACCES' } })).toThrow('nope');
    try {
      unwrap({ ok: false, error: { message: 'nope', code: 'EACCES' } });
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('EACCES');
    }
  });

  it('throws EPROTO for a malformed reply shape', () => {
    expect(() => unwrap(null)).toThrow(/Invalid reply/);
    expect(() => unwrap({})).toThrow(/Invalid reply/);
    expect(() => unwrap({ ok: 'yes' })).toThrow(/Invalid reply/);
    try {
      unwrap(undefined);
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('EPROTO');
    }
  });

  it('throws EPROTO when the error payload on a failure reply is not a record', () => {
    try {
      unwrap({ ok: false, error: 'boom' });
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('EPROTO');
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) expect(error.message).toMatch(/Invalid error reply/);
    }
  });
});

describe('Syscalls multi-chunk >1 MiB SAB v5 transport', () => {
  function createLoopback(options?: {
    callTimeoutMs?: number;
    maxPayloadBytes?: number;
    handler?: (op: string, args: unknown[]) => unknown;
  }) {
    const shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
    const postedSizes: number[] = [];
    const responder = createSyscallResponder(
      shared,
      options?.handler ?? ((_op, args) => args[0]),
      () => options?.maxPayloadBytes ?? 8 * 1024 * 1024,
    );
    const port = loopbackPort((data: unknown) => {
      if (data instanceof Uint8Array) postedSizes.push(data.byteLength);
      else if (record(data) && data.data instanceof Uint8Array)
        postedSizes.push(data.data.byteLength);
      responder.handleMessage(data);
    });
    const sys = new Syscalls(
      port,
      shared,
      options?.callTimeoutMs ?? 200,
      options?.maxPayloadBytes ?? 8 * 1024 * 1024,
    );
    return { shared, sys, responder, postedSizes };
  }

  it('transports multi-megabyte (>1 MiB) requests and replies in <= CAPACITY chunks', () => {
    const size = 3 * 1024 * 1024 + 12345;
    const input = new Uint8Array(size);
    for (let i = 0; i < size; i++) input[i] = (i * 19 + 7) & 0xff;

    const { sys, postedSizes } = createLoopback({
      handler(op, args) {
        expect(op).toBe('echoXor');
        const received = expectUint8Array(args[0]);
        const out = new Uint8Array(received.byteLength);
        for (let i = 0; i < received.byteLength; i++) out[i] = received[i]! ^ 0x5a;
        return out;
      },
    });

    const reply = expectUint8Array(sys.call('echoXor', [input]));
    expect(reply.byteLength).toBe(size);
    for (const chunkLen of postedSizes) expect(chunkLen).toBeLessThanOrEqual(CAPACITY);
    expect(postedSizes.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < size; i += 4093) expect(reply[i]).toBe(input[i]! ^ 0x5a);
    expect(reply[size - 1]).toBe(input[size - 1]! ^ 0x5a);
  });

  it('enforces LimitError (E2BIG) when request or reply exceeds configured policy bound without poisoning the channel', () => {
    const maxBytes = 2 * 1024 * 1024;
    const { sys } = createLoopback({
      maxPayloadBytes: maxBytes,
      handler(op, args) {
        if (op === 'oversizedReply') return new Uint8Array(2 * 1024 * 1024 + 4096);
        return args[0];
      },
    });

    try {
      sys.call('oversizedReq', [new Uint8Array(2 * 1024 * 1024 + 4096)]);
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('E2BIG');
      const tax = errorTaxonomy(error);
      expect(tax.kind).toBe('limit');
      expect(tax.limit).toBe(maxBytes);
      expect(tax.actual).toBeGreaterThan(maxBytes);
    }

    try {
      sys.call('oversizedReply', []);
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('E2BIG');
      const tax = errorTaxonomy(error);
      expect(tax.kind).toBe('limit');
      expect(tax.limit).toBe(maxBytes);
      expect(tax.actual).toBeGreaterThan(maxBytes);
    }

    // Channel stays usable after E2BIG policy rejections.
    expect(sys.call('ok', ['still-alive'])).toBe('still-alive');
  });

  it('poisons the channel with ETIMEDOUT then EPIPE (kind: "channel") when kernel does not answer', () => {
    const shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
    const silentPort = loopbackPort(() => {});
    const sys = new Syscalls(silentPort, shared, 15, 4 * 1024 * 1024);

    try {
      sys.call('hang', []);
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('ETIMEDOUT');
      expect(errorTaxonomy(error).kind).toBe('channel');
    }

    try {
      sys.call('afterHang', []);
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('EPIPE');
      expect(errorTaxonomy(error).kind).toBe('channel');
    }
  });

  it('poisons the channel with EPROTO then EPIPE (kind: "channel") on mismatched completion sequence', () => {
    const shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
    const control = new Int32Array(shared, 0, 4);
    const badPort = loopbackPort(() => {
      Atomics.store(control, 1, 10);
      Atomics.store(control, 2, 999);
      Atomics.store(control, 3, 10);
      Atomics.store(control, 0, 1);
    });
    const sys = new Syscalls(badPort, shared, 50, 4 * 1024 * 1024);

    try {
      sys.call('badSeq', []);
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('EPROTO');
      expect(errorTaxonomy(error).kind).toBe('channel');
    }

    try {
      sys.call('afterBadSeq', []);
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('EPIPE');
      expect(errorTaxonomy(error).kind).toBe('channel');
    }
  });

  it('poisons the channel with EPROTO then EPIPE when reply bytes or envelope are corrupted', () => {
    for (const corruptPayload of [new Uint8Array([0, 1, 2, 3, 4, 5]), encode({ bogus: true })]) {
      const shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
      const control = new Int32Array(shared, 0, 4);
      const payload = new Uint8Array(shared, HEADER_BYTES);
      const port = loopbackPort(() => {
        payload.set(corruptPayload, 0);
        Atomics.store(control, 1, corruptPayload.byteLength);
        Atomics.store(control, 2, 1);
        Atomics.store(control, 3, corruptPayload.byteLength);
        Atomics.store(control, 0, 1);
      });
      const sys = new Syscalls(port, shared, 50, 4 * 1024 * 1024);

      try {
        sys.call('corrupt', []);
        expect.unreachable();
      } catch (error) {
        expect(errorCodeOf(error)).toBe('EPROTO');
        expect(errorTaxonomy(error).kind).toBe('channel');
      }

      try {
        sys.call('afterCorrupt', []);
        expect.unreachable();
      } catch (error) {
        expect(errorCodeOf(error)).toBe('EPIPE');
        expect(errorTaxonomy(error).kind).toBe('channel');
      }
    }
  });

  it('converts unencodable circular handler results into an error reply without hanging the channel', () => {
    const { sys } = createLoopback({
      handler(op) {
        if (op === 'circular') {
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          return cyclic;
        }
        return 'recovered';
      },
    });

    try {
      sys.call('circular', []);
      expect.unreachable();
    } catch (error) {
      expect(errorCodeOf(error)).toBe('EIO');
    }

    expect(sys.call('healthy', [])).toBe('recovered');
  });
});
