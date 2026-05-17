import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { createEmitter, errorEvent, pickMode } from '../../src/cli/output.js';

function collect(stream: PassThrough): string {
  return stream.read()?.toString() ?? '';
}

describe('pickMode', () => {
  it('defaults to text on a TTY', () => {
    expect(pickMode(undefined, { isTTY: true } as unknown as NodeJS.WriteStream)).toBe('text');
  });
  it('defaults to ndjson when not a TTY', () => {
    expect(pickMode(undefined, { isTTY: false } as unknown as NodeJS.WriteStream)).toBe('ndjson');
  });
  it('honors explicit preference', () => {
    expect(pickMode('json', { isTTY: true } as unknown as NodeJS.WriteStream)).toBe('json');
  });
});

describe('createEmitter — ndjson', () => {
  it('emits one JSON line per event', () => {
    const stream = new PassThrough();
    const e = createEmitter({ mode: 'ndjson' }, stream as unknown as NodeJS.WriteStream);
    e.event({ type: 'a', n: 1 });
    e.event({ type: 'b', n: 2 });
    e.finish();
    const out = collect(stream).trim().split('\n');
    expect(out).toEqual(['{"type":"a","n":1}', '{"type":"b","n":2}']);
  });

  it('applies --fields allowlist', () => {
    const stream = new PassThrough();
    const e = createEmitter(
      { mode: 'ndjson', fields: ['type', 'n'] },
      stream as unknown as NodeJS.WriteStream,
    );
    e.event({ type: 'a', n: 1, drop: 'me' });
    e.finish();
    expect(collect(stream).trim()).toBe('{"type":"a","n":1}');
  });
});

describe('createEmitter — json', () => {
  it('emits a single object for one event', () => {
    const stream = new PassThrough();
    const e = createEmitter({ mode: 'json' }, stream as unknown as NodeJS.WriteStream);
    e.event({ type: 'a' });
    e.finish();
    const parsed = JSON.parse(collect(stream));
    expect(parsed).toEqual({ type: 'a' });
  });

  it('emits an array for multiple events', () => {
    const stream = new PassThrough();
    const e = createEmitter({ mode: 'json' }, stream as unknown as NodeJS.WriteStream);
    e.event({ n: 1 });
    e.event({ n: 2 });
    e.finish();
    const parsed = JSON.parse(collect(stream));
    expect(parsed).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe('errorEvent', () => {
  it('extracts custom fields from Error subclasses', () => {
    class FieldError extends Error {
      override name = 'FieldError';
      readonly field = 'x';
      readonly reason = 'bad';
    }
    const ev = errorEvent(new FieldError('boom'));
    expect(ev['name']).toBe('FieldError');
    expect(ev['message']).toBe('boom');
    expect(ev['field']).toBe('x');
    expect(ev['reason']).toBe('bad');
  });

  it('handles non-Error throws', () => {
    const ev = errorEvent('plain string');
    expect(ev['message']).toBe('plain string');
  });
});
