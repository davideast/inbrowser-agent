import { describe, expect, test } from 'bun:test';
import {
  ENVELOPE_KEY,
  type EventValueCodec,
  composeCodecs,
  defaultEventValueCodec,
  identityCodec,
} from '../../src/events/codec.js';

describe('defaultEventValueCodec', () => {
  test('round-trips Date', () => {
    const v = new Date('2026-05-11T13:00:00.000Z');
    const encoded = defaultEventValueCodec.encode(v);
    expect(JSON.parse(JSON.stringify(encoded))).toEqual({
      [ENVELOPE_KEY]: 'Date',
      iso: '2026-05-11T13:00:00.000Z',
    });
    const decoded = defaultEventValueCodec.decode(JSON.parse(JSON.stringify(encoded)));
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).toISOString()).toBe(v.toISOString());
  });

  test('round-trips Uint8Array', () => {
    const v = new Uint8Array([1, 2, 3, 254, 255]);
    const encoded = defaultEventValueCodec.encode(v);
    const decoded = defaultEventValueCodec.decode(JSON.parse(JSON.stringify(encoded)));
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded as Uint8Array)).toEqual([1, 2, 3, 254, 255]);
  });

  test('round-trips bigint', () => {
    const v = 123456789012345678901234567890n;
    const encoded = defaultEventValueCodec.encode(v);
    const decoded = defaultEventValueCodec.decode(JSON.parse(JSON.stringify(encoded)));
    expect(typeof decoded).toBe('bigint');
    expect(decoded).toBe(v);
  });

  test('passes objects with undefined-valued properties through unchanged', () => {
    // We don't encode `undefined` — JSON.stringify already drops those
    // properties, and Firestore doesn't accept undefined writes.
    const v = { a: undefined, b: 1 };
    const decoded = defaultEventValueCodec.decode(
      JSON.parse(JSON.stringify(defaultEventValueCodec.encode(v))),
    ) as Record<string, unknown>;
    expect(decoded.a).toBeUndefined();
    expect(decoded.b).toBe(1);
  });

  test('passes through plain JSON values unchanged', () => {
    const v = { path: 'items/foo', data: { name: 'a', count: 1, list: [1, 2, 3] } };
    const encoded = defaultEventValueCodec.encode(v);
    expect(encoded).toEqual(v);
    const decoded = defaultEventValueCodec.decode(encoded);
    expect(decoded).toEqual(v);
  });

  test('recursively transforms nested values', () => {
    const v = {
      ts: new Date('2026-05-11T13:00:00.000Z'),
      nested: { bytes: new Uint8Array([7, 8, 9]) },
      list: [new Date('2026-01-01T00:00:00.000Z'), { x: 1n }],
    };
    const decoded = defaultEventValueCodec.decode(
      JSON.parse(JSON.stringify(defaultEventValueCodec.encode(v))),
    ) as typeof v;
    expect(decoded.ts).toBeInstanceOf(Date);
    expect(decoded.nested.bytes).toBeInstanceOf(Uint8Array);
    expect(decoded.list[0]).toBeInstanceOf(Date);
    expect(typeof (decoded.list[1] as { x: bigint }).x).toBe('bigint');
  });

  test('does NOT misidentify ordinary objects with __pyric-like keys', () => {
    // An ordinary object whose value at __pyric is not a recognized tag
    // should pass through decode unchanged.
    const v = { foo: 'bar', [ENVELOPE_KEY]: 'unknown-tag', meta: 'data' };
    const decoded = defaultEventValueCodec.decode(v);
    expect(decoded).toEqual(v);
  });
});

describe('identityCodec', () => {
  test('passes through everything unchanged', () => {
    expect(identityCodec.encode({ a: 1 })).toEqual({ a: 1 });
    expect(identityCodec.decode({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('composeCodecs', () => {
  test('outer-encode-first / inner-decode-first', () => {
    const outer: EventValueCodec = {
      encode(v) {
        if (typeof v === 'object' && v !== null && 'firestoreTs' in v) {
          return {
            [ENVELOPE_KEY]: 'FirestoreTimestamp',
            seconds: (v as { firestoreTs: { seconds: number } }).firestoreTs.seconds,
          };
        }
        return v;
      },
      decode(v) {
        if (
          typeof v === 'object' &&
          v !== null &&
          (v as Record<string, unknown>)[ENVELOPE_KEY] === 'FirestoreTimestamp'
        ) {
          return { firestoreTs: { seconds: (v as { seconds: number }).seconds } };
        }
        return v;
      },
    };

    const composed = composeCodecs(outer, defaultEventValueCodec);

    // Outer handles firestoreTs.
    const ts = { firestoreTs: { seconds: 1234 } };
    const encodedTs = composed.encode(ts);
    expect(encodedTs).toEqual({ [ENVELOPE_KEY]: 'FirestoreTimestamp', seconds: 1234 });
    expect(composed.decode(encodedTs)).toEqual(ts);

    // Inner (default) still handles Date — outer is identity for it.
    const d = new Date('2026-05-11T13:00:00.000Z');
    const encodedD = composed.encode(d);
    const decodedD = composed.decode(JSON.parse(JSON.stringify(encodedD)));
    expect(decodedD).toBeInstanceOf(Date);
  });
});
