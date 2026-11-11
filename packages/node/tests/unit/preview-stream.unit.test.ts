import { describe, expect, it } from 'vitest';
import {
  FrameSender,
  PREVIEW_CHUNK_BYTES,
  WindowMeter,
  frameBytes,
  readFrame,
} from '../../src/preview-stream';
import { VERSION } from '../../src/protocol';
import { FIXED_LIMITS } from '../../src/resource-policy';

describe('readFrame', () => {
  const frame = (fields: Record<string, unknown>) => readFrame({ version: VERSION, ...fields });

  it('uses the fixed transport chunk', () => {
    expect(PREVIEW_CHUNK_BYTES).toBe(FIXED_LIMITS.transportChunkBytes);
  });

  it('rejects another protocol version and non-records', () => {
    expect(readFrame({ version: VERSION - 1, type: 'end' })).toBeUndefined();
    expect(readFrame({ type: 'end' })).toBeUndefined();
    expect(readFrame(null)).toBeUndefined();
    expect(readFrame('end')).toBeUndefined();
    expect(frame({ type: 'unknown' })).toBeUndefined();
  });

  it('accepts a head with string and string-array headers only', () => {
    expect(
      frame({ type: 'head', status: 200, headers: { a: '1', 'set-cookie': ['x', 'y'] } }),
    ).toEqual({ type: 'head', status: 200, headers: { a: '1', 'set-cookie': ['x', 'y'] } });
    expect(frame({ type: 'head', status: 200, headers: {}, previewSocket: true })).toEqual({
      type: 'head',
      status: 200,
      headers: {},
      previewSocket: true,
    });
    expect(
      frame({
        type: 'head',
        status: 200,
        headers: {},
        previewSocket: true,
        previewClient: true,
      }),
    ).toEqual({
      type: 'head',
      status: 200,
      headers: {},
      previewSocket: true,
      previewClient: true,
    });
    expect(frame({ type: 'head', status: 200, headers: {}, previewClient: false })).toEqual({
      type: 'head',
      status: 200,
      headers: {},
    });
    expect(frame({ type: 'head', status: 200, headers: { a: 1 } })).toBeUndefined();
    expect(frame({ type: 'head', status: 200, headers: { a: ['x', 2] } })).toBeUndefined();
    expect(frame({ type: 'head', status: 200.5, headers: {} })).toBeUndefined();
    expect(frame({ type: 'head', status: '200', headers: {} })).toBeUndefined();
    expect(frame({ type: 'head', status: 200, headers: [] })).toBeUndefined();
  });

  it('carries origin-mode cookie mirror operations on a head, validated', () => {
    const cookies = [
      { op: 'set', name: 'a', value: '1', path: '/', expires: null, sameSite: 'lax' },
      { op: 'set', name: 'b', value: '', path: '/x', expires: 1700000000000, sameSite: 'strict' },
      { op: 'delete', name: 'c', path: '/' },
    ];
    expect(frame({ type: 'head', status: 200, headers: {}, cookies })).toEqual({
      type: 'head',
      status: 200,
      headers: {},
      cookies,
    });
    for (const bad of [
      'a=1',
      [{ op: 'set', name: 'a', value: 1, path: '/', expires: null, sameSite: 'lax' }],
      [{ op: 'set', name: 'a', value: '1', path: '/', expires: 'soon', sameSite: 'lax' }],
      [{ op: 'set', name: 'a', value: '1', path: '/', expires: null, sameSite: 'default' }],
      [{ op: 'set', name: 'a', value: '1', path: 'x', expires: null, sameSite: 'lax' }],
      [{ op: 'clear', name: 'a', path: '/' }],
      [{ op: 'delete', name: '', path: '/' }],
    ])
      expect(frame({ type: 'head', status: 200, headers: {}, cookies: bad })).toBeUndefined();
  });

  it('bounds a data frame to one non-empty transport chunk', () => {
    const full = new Uint8Array(PREVIEW_CHUNK_BYTES);
    expect(frame({ type: 'data', bytes: full })).toEqual({ type: 'data', bytes: full });
    expect(frame({ type: 'data', bytes: new Uint8Array(PREVIEW_CHUNK_BYTES + 1) })).toBeUndefined();
    expect(frame({ type: 'data', bytes: new Uint8Array(0) })).toBeUndefined();
    expect(frame({ type: 'data', bytes: [1, 2, 3] })).toBeUndefined();
  });

  it('requires a positive safe integer credit', () => {
    expect(frame({ type: 'credit', bytes: 10 })).toEqual({ type: 'credit', bytes: 10 });
    for (const bytes of [0, -1, 1.5, Number.POSITIVE_INFINITY, '10'])
      expect(frame({ type: 'credit', bytes })).toBeUndefined();
  });

  it('accepts end, ping and abort with an optional error record', () => {
    expect(frame({ type: 'end' })).toEqual({ type: 'end' });
    expect(frame({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(frame({ type: 'abort' })).toEqual({ type: 'abort' });
    const error = { name: 'Error', message: 'too big', code: 'E2BIG', kind: 'limit', limit: 1 };
    expect(frame({ type: 'abort', error })).toEqual({ type: 'abort', error });
    expect(frame({ type: 'abort', error: 'too big' })).toBeUndefined();
    expect(frame({ type: 'abort', error: { message: 'no code' } })).toBeUndefined();
  });
});

describe('WindowMeter', () => {
  it('tracks outstanding bytes, the peak and the remaining room', () => {
    const meter = new WindowMeter(100);
    expect(meter.add(60)).toBe(true);
    expect(meter.add(40)).toBe(true);
    expect([meter.inFlight, meter.available, meter.peak]).toEqual([100, 0, 100]);
    expect(meter.remove(70)).toBe(true);
    expect([meter.inFlight, meter.available, meter.peak]).toEqual([30, 70, 100]);
  });

  it('rejects a frame beyond the window and a credit for bytes never sent', () => {
    const meter = new WindowMeter(100);
    expect(meter.add(101)).toBe(false);
    expect(meter.add(100)).toBe(true);
    expect(meter.add(1)).toBe(false);
    expect(meter.remove(101)).toBe(false);
    expect(meter.inFlight).toBe(100);
    for (const bytes of [0, -1, 1.5, Number.NaN]) {
      expect(meter.add(bytes)).toBe(false);
      expect(meter.remove(bytes)).toBe(false);
    }
  });
});

describe('FrameSender', () => {
  const collect = (windowBytes: number) => {
    const frames: Uint8Array[] = [];
    const sender = new FrameSender(windowBytes, (bytes) => frames.push(bytes));
    return { frames, sender };
  };
  const pattern = (size: number) => Uint8Array.from({ length: size }, (_, index) => index % 251);

  it('caps a frame at the transport chunk, or at a smaller window', () => {
    expect(frameBytes(1024 * 1024)).toBe(PREVIEW_CHUNK_BYTES);
    expect(frameBytes(4096)).toBe(4096);
  });

  it('splits a chunk into transport-sized frames in order and then completes it', () => {
    const { frames, sender } = collect(1024 * 1024);
    const source = pattern(PREVIEW_CHUNK_BYTES * 2 + 10);
    let done = 0;
    sender.send(source, () => done++);
    expect(frames.map((frame) => frame.length)).toEqual([
      PREVIEW_CHUNK_BYTES,
      PREVIEW_CHUNK_BYTES,
      10,
    ]);
    expect(done).toBe(1);
    expect(sender.blocked).toBe(false);
    const joined = new Uint8Array(source.length);
    let offset = 0;
    for (const frame of frames) {
      joined.set(frame, offset);
      offset += frame.length;
    }
    expect(joined).toEqual(source);
  });

  it('posts exact-size copies so a frame can be transferred without its source', () => {
    const { frames, sender } = collect(1024);
    const backing = pattern(4096);
    sender.send(backing.subarray(100, 200), () => {});
    expect(frames[0].byteLength).toBe(100);
    expect(frames[0].buffer.byteLength).toBe(100);
    expect(frames[0].buffer).not.toBe(backing.buffer);
    expect(Array.from(frames[0])).toEqual(Array.from(backing.subarray(100, 200)));
  });

  it('never has more than one window in flight and resumes on credit', () => {
    const { frames, sender } = collect(100);
    let done = 0;
    sender.send(pattern(250), () => done++);
    expect(frames.map((frame) => frame.length)).toEqual([100]);
    expect([sender.meter.inFlight, sender.blocked, done]).toEqual([100, true, 0]);
    expect(sender.credit(30)).toBe(true);
    expect(frames.map((frame) => frame.length)).toEqual([100, 30]);
    expect(sender.meter.inFlight).toBe(100);
    expect(sender.credit(100)).toBe(true);
    expect(frames.map((frame) => frame.length)).toEqual([100, 30, 100]);
    expect(done).toBe(0);
    expect(sender.credit(100)).toBe(true);
    expect(frames.map((frame) => frame.length)).toEqual([100, 30, 100, 20]);
    expect([sender.meter.inFlight, sender.meter.peak, sender.blocked, done]).toEqual([
      20,
      100,
      false,
      1,
    ]);
  });

  it('completes chunks in order, including an empty one and one sent re-entrantly', () => {
    const { frames, sender } = collect(100);
    const order: string[] = [];
    sender.send(pattern(150), () => {
      order.push('a');
      sender.send(pattern(10), () => order.push('c'));
    });
    sender.send(new Uint8Array(0), () => order.push('b'));
    expect(order).toEqual([]);
    sender.credit(100);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(frames.map((frame) => frame.length)).toEqual([100, 50, 10]);
  });

  it('rejects a credit for bytes it never sent', () => {
    const { sender } = collect(100);
    sender.send(pattern(40), () => {});
    expect(sender.credit(41)).toBe(false);
    expect(sender.credit(0)).toBe(false);
    expect(sender.meter.inFlight).toBe(40);
  });

  it('drops queued chunks on close and completes later sends without posting', () => {
    const { frames, sender } = collect(100);
    let done = 0;
    sender.send(pattern(300), () => done++);
    sender.close();
    expect(sender.blocked).toBe(false);
    expect(sender.credit(100)).toBe(true);
    expect(frames).toHaveLength(1);
    expect(done).toBe(0);
    sender.send(pattern(10), () => done++);
    expect(frames).toHaveLength(1);
    expect(done).toBe(1);
  });
});
