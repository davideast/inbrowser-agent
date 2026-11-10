import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';
import { decodeAdvanced, encodeAdvanced } from '../../src/ipc-codec';

function roundTrip(value: unknown): unknown {
  return decodeAdvanced(encodeAdvanced(value));
}

describe('encodeAdvanced/decodeAdvanced primitives', () => {
  it('round-trips strings, booleans, and null unchanged', () => {
    expect(roundTrip('hello')).toBe('hello');
    expect(roundTrip(true)).toBe(true);
    expect(roundTrip(false)).toBe(false);
    expect(roundTrip(null)).toBe(null);
  });

  it('round-trips undefined', () => {
    expect(roundTrip(undefined)).toBe(undefined);
  });

  it('round-trips bigint values, including negative ones', () => {
    expect(roundTrip(123n)).toBe(123n);
    expect(roundTrip(-99999999999999999999n)).toBe(-99999999999999999999n);
  });

  it('round-trips finite numbers and special non-finite forms', () => {
    expect(roundTrip(42)).toBe(42);
    expect(roundTrip(-42.5)).toBe(-42.5);
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
    expect(roundTrip(Number.NaN)).toBeNaN();
    expect(roundTrip(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundTrip(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('rejects unsupported top-level types', () => {
    expect(() => encodeAdvanced(() => {})).toThrow(/Unsupported advanced IPC value/);
    expect(() => encodeAdvanced(Symbol('x'))).toThrow(/Unsupported advanced IPC value/);
  });
});

describe('encodeAdvanced/decodeAdvanced binary types', () => {
  it('round-trips a Buffer', () => {
    const buffer = Buffer.from([1, 2, 3, 255]);
    const restored = roundTrip(buffer) as Buffer;
    expect(Buffer.isBuffer(restored)).toBe(true);
    expect(Array.from(restored)).toEqual([1, 2, 3, 255]);
  });

  it('round-trips an ArrayBuffer', () => {
    const buffer = Uint8Array.from([9, 8, 7]).buffer;
    const restored = roundTrip(buffer) as ArrayBuffer;
    expect(restored).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(restored))).toEqual([9, 8, 7]);
  });

  it('round-trips typed array views, including a byte-offset subview', () => {
    const int32 = Int32Array.from([1, -2, 3]);
    const restoredInt32 = roundTrip(int32) as Int32Array;
    expect(restoredInt32).toBeInstanceOf(Int32Array);
    expect(Array.from(restoredInt32)).toEqual([1, -2, 3]);

    const backing = new ArrayBuffer(16);
    const view = new Float64Array(backing, 8, 1);
    view[0] = 3.5;
    const restoredView = roundTrip(view) as Float64Array;
    expect(restoredView).toBeInstanceOf(Float64Array);
    expect(Array.from(restoredView)).toEqual([3.5]);

    const dataView = new DataView(new ArrayBuffer(4));
    dataView.setInt32(0, -100);
    const restoredDataView = roundTrip(dataView) as DataView;
    expect(restoredDataView).toBeInstanceOf(DataView);
    expect(restoredDataView.getInt32(0)).toBe(-100);
  });
});

describe('encodeAdvanced/decodeAdvanced collections', () => {
  it('round-trips a Map with structured keys and values', () => {
    const map = new Map<unknown, unknown>([
      ['a', 1],
      [2, { nested: true }],
    ]);
    const restored = roundTrip(map) as Map<unknown, unknown>;
    expect(restored).toBeInstanceOf(Map);
    expect(restored.get('a')).toBe(1);
    expect(restored.get(2)).toEqual({ nested: true });
  });

  it('round-trips a Set', () => {
    const set = new Set([1, 'two', { three: 3 }]);
    const restored = roundTrip(set) as Set<unknown>;
    expect(restored).toBeInstanceOf(Set);
    expect(restored.size).toBe(3);
    expect(Array.from(restored)).toEqual([1, 'two', { three: 3 }]);
  });

  it('round-trips a Date, including an invalid Date', () => {
    const date = new Date(1700000000000);
    const restored = roundTrip(date) as Date;
    expect(restored).toBeInstanceOf(Date);
    expect(restored.getTime()).toBe(1700000000000);

    const invalid = new Date(Number.NaN);
    const restoredInvalid = roundTrip(invalid) as Date;
    expect(restoredInvalid).toBeInstanceOf(Date);
    expect(Number.isNaN(restoredInvalid.getTime())).toBe(true);
  });

  it('round-trips a RegExp with flags', () => {
    const regexp = /a[bc]+/gi;
    const restored = roundTrip(regexp) as RegExp;
    expect(restored).toBeInstanceOf(RegExp);
    expect(restored.source).toBe('a[bc]+');
    expect(restored.flags).toBe('gi');
  });

  it('round-trips plain objects, including null-prototype objects', () => {
    expect(roundTrip({ a: 1, b: { c: 2 } })).toEqual({ a: 1, b: { c: 2 } });
    const nullProto = Object.assign(Object.create(null), { x: 1 });
    const restored = roundTrip(nullProto) as Record<string, unknown>;
    expect(restored).toEqual({ x: 1 });
  });

  it('rejects a class instance that is not a supported structured type', () => {
    class Custom {
      value = 1;
    }
    expect(() => encodeAdvanced(new Custom())).toThrow(/Unsupported advanced IPC object/);
  });
});

describe('encodeAdvanced/decodeAdvanced object graph identity', () => {
  it('preserves shared object identity for repeated references', () => {
    const shared = { id: 'shared' };
    const value = { first: shared, second: shared };
    const restored = roundTrip(value) as { first: unknown; second: unknown };
    expect(restored.first).toBe(restored.second);
  });

  it('preserves cycles instead of infinitely recursing', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    const restored = roundTrip(value) as { self: unknown };
    expect(restored.self).toBe(restored);
  });

  it('preserves sparse array length without materializing missing slots', () => {
    const sparse: number[] = [];
    sparse[5] = 42;
    const restored = roundTrip(sparse) as number[];
    expect(restored.length).toBe(6);
    expect(restored[5]).toBe(42);
    expect(0 in restored).toBe(false);
  });
});

describe('encodeAdvanced limits', () => {
  it('rejects graphs with too many distinct object nodes', () => {
    const many = Array.from({ length: 4100 }, () => ({}));
    expect(() => encodeAdvanced(many)).toThrow(/IPC graph exceeds node limit/);
  });

  it('rejects graphs with too many edges', () => {
    const many = Array.from({ length: 70_000 }, (_, index) => index);
    expect(() => encodeAdvanced(many)).toThrow(/IPC graph exceeds limits/);
  });

  it('rejects a single array whose declared length exceeds the aggregate limit', () => {
    const sparse: unknown[] = [];
    sparse.length = 2_000_000;
    expect(() => encodeAdvanced(sparse)).toThrow(/IPC arrays exceed aggregate length limit/);
  });

  it('rejects graphs deeper than 128 levels', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < 130; i++) value = [value];
    expect(() => encodeAdvanced(value)).toThrow(/IPC graph exceeds limits/);
  });
});

describe('decodeAdvanced malformed wire input', () => {
  it('rejects wire text that is not a valid graph envelope', () => {
    expect(() => decodeAdvanced(JSON.stringify({ root: 1 }))).toThrow(/Invalid advanced IPC graph/);
    expect(() => decodeAdvanced(JSON.stringify({ root: 1, nodes: 'nope' }))).toThrow(
      /Invalid advanced IPC graph/,
    );
  });

  it('rejects a node list longer than the node limit', () => {
    const nodes = Array.from({ length: 4200 }, () => ['object', []]);
    expect(() => decodeAdvanced(JSON.stringify({ root: ['ref', 0], nodes }))).toThrow(
      /Invalid advanced IPC graph/,
    );
  });

  it('rejects an array node whose declared length exceeds the aggregate limit', () => {
    const nodes = [['array', 2_000_000, []]];
    expect(() => decodeAdvanced(JSON.stringify({ root: ['ref', 0], nodes }))).toThrow(
      /Invalid advanced IPC graph/,
    );
  });

  it('rejects an out-of-range backreference', () => {
    const nodes = [['object', []]];
    expect(() => decodeAdvanced(JSON.stringify({ root: ['ref', 5], nodes }))).toThrow(
      /Invalid advanced IPC graph/,
    );
  });

  it('rejects an unrecognized node kind', () => {
    const nodes = [['mystery', []]];
    expect(() => decodeAdvanced(JSON.stringify({ root: ['ref', 0], nodes }))).toThrow(
      /Invalid advanced IPC graph/,
    );
  });

  it('rejects a bytes node naming an unsupported typed array view', () => {
    const nodes = [['bytes', 'NotAView', '']];
    expect(() => decodeAdvanced(JSON.stringify({ root: ['ref', 0], nodes }))).toThrow(
      /Invalid advanced IPC graph/,
    );
  });

  it('rejects a bytes node whose payload is not valid base64', () => {
    const nodes = [['bytes', 'Buffer', 'not base64!!']];
    expect(() => decodeAdvanced(JSON.stringify({ root: ['ref', 0], nodes }))).toThrow(
      /Invalid advanced IPC graph/,
    );
  });

  it('rejects attempts to set "length" as an own array property', () => {
    const nodes = [['array', 1, [['length', 99]]]];
    expect(() => decodeAdvanced(JSON.stringify({ root: ['ref', 0], nodes }))).toThrow(
      /Invalid advanced IPC graph/,
    );
  });
});
