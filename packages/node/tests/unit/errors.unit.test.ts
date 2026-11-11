import { describe, expect, it } from 'vitest';
import {
  ChannelError,
  LifecycleError,
  LimitError,
  RuntimeError,
  type RuntimeErrorKind,
  UnsupportedError,
  errorKind,
} from '../../src/errors';
import { decode, encode, errorRecord, fault, unwrap } from '../../src/protocol';

describe('RuntimeError construction', () => {
  it('carries code and kind on each subclass', () => {
    const rows: Array<[RuntimeError, RuntimeErrorKind, string]> = [
      [new UnsupportedError('ENOSYS', 'not implemented'), 'unsupported', 'ENOSYS'],
      [new LimitError('E2BIG', 'too big'), 'limit', 'E2BIG'],
      [new ChannelError('ETIMEDOUT', 'too slow'), 'channel', 'ETIMEDOUT'],
      [new LifecycleError('EPIPE', 'closed'), 'lifecycle', 'EPIPE'],
    ];
    for (const [error, kind, code] of rows) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error.kind).toBe(kind);
      expect(error.code).toBe(code);
      // Guest programs print these errors, so the Node error name is unchanged.
      expect(error.name).toBe('Error');
      expect(String(error)).toBe(`Error: ${error.message}`);
    }
  });

  it('separates the subclasses from each other', () => {
    expect(new UnsupportedError('ENOSYS', 'x')).not.toBeInstanceOf(LimitError);
    expect(new LimitError('E2BIG', 'x')).not.toBeInstanceOf(ChannelError);
    expect(new ChannelError('EPROTO', 'x')).not.toBeInstanceOf(LifecycleError);
    expect(new LifecycleError('EPIPE', 'x')).not.toBeInstanceOf(UnsupportedError);
  });

  it('records optional numeric bounds on a LimitError only when given', () => {
    const bounded = new LimitError('E2BIG', 'too big', { limit: 1024, actual: 2048 });
    expect(bounded.limit).toBe(1024);
    expect(bounded.actual).toBe(2048);
    const plain = new LimitError('E2BIG', 'too big');
    expect(plain.limit).toBeUndefined();
    expect(plain.actual).toBeUndefined();
    expect('limit' in plain).toBe(false);
    expect('actual' in plain).toBe(false);
  });
});

describe('code to kind mapping', () => {
  it('maps the taxonomy codes', () => {
    expect(errorKind('ENOSYS')).toBe('unsupported');
    expect(errorKind('ENOTSUP')).toBe('unsupported');
    expect(errorKind('E2BIG')).toBe('limit');
    expect(errorKind('ENOMEM')).toBe('limit');
    expect(errorKind('EOVERFLOW')).toBe('limit');
    expect(errorKind('ETIMEDOUT')).toBe('channel');
    expect(errorKind('EPROTO')).toBe('channel');
    expect(errorKind('EPIPE')).toBe('lifecycle');
    expect(errorKind('ESRCH')).toBe('lifecycle');
    expect(errorKind('EASSET')).toBe('lifecycle');
  });

  it('leaves unmapped and guest-visible Node codes untyped', () => {
    for (const code of ['EINVAL', 'ENOENT', 'EBUSY', 'ERR_INVALID_ARG_TYPE', 'Z_DATA_ERROR'])
      expect(errorKind(code)).toBeUndefined();
  });
});

describe('fault', () => {
  it('still produces an Error carrying the given code and message', () => {
    const error = fault('ETIMEDOUT', 'Kernel did not complete syscall');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('ETIMEDOUT');
    expect(error.message).toBe('Kernel did not complete syscall');
  });

  it('selects the subclass from the code map', () => {
    expect(fault('ENOSYS', 'x')).toBeInstanceOf(UnsupportedError);
    expect(fault('E2BIG', 'x')).toBeInstanceOf(LimitError);
    expect(fault('EPROTO', 'x')).toBeInstanceOf(ChannelError);
    expect(fault('EPIPE', 'x')).toBeInstanceOf(LifecycleError);
  });

  it('leaves an unmapped code a plain Error', () => {
    const error = fault('ENOENT', 'missing');
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RuntimeError);
    expect(error.code).toBe('ENOENT');
  });

  it('accepts an explicit kind and numeric bounds', () => {
    const poisoned = fault('EPIPE', 'Syscall channel failed', { kind: 'channel' });
    expect(poisoned).toBeInstanceOf(ChannelError);
    expect(poisoned.code).toBe('EPIPE');
    const bounded = fault('E2BIG', 'Syscall request exceeds 1 MiB', {
      limit: 1048576,
      actual: 2000000,
    });
    expect(bounded).toBeInstanceOf(LimitError);
    expect((bounded as LimitError).limit).toBe(1048576);
    expect((bounded as LimitError).actual).toBe(2000000);
  });
});

describe('errorRecord', () => {
  it('adds kind and present bounds without changing the existing fields', () => {
    expect(errorRecord(fault('ENOSYS', 'unsupported operation'))).toEqual({
      name: 'Error',
      message: 'unsupported operation',
      code: 'ENOSYS',
      errno: undefined,
      syscall: undefined,
      path: undefined,
      dest: undefined,
      kind: 'unsupported',
    });
    expect(errorRecord(fault('E2BIG', 'too big', { limit: 4, actual: 9 }))).toEqual({
      name: 'Error',
      message: 'too big',
      code: 'E2BIG',
      errno: undefined,
      syscall: undefined,
      path: undefined,
      dest: undefined,
      kind: 'limit',
      limit: 4,
      actual: 9,
    });
  });

  it('omits kind for errors outside the taxonomy', () => {
    const source = Object.assign(new Error('boom'), { code: 'ENOENT', errno: -2, syscall: 'open' });
    const produced = errorRecord(source);
    expect('kind' in produced).toBe(false);
    expect(produced.code).toBe('ENOENT');
  });

  it('ignores a kind field that is not a taxonomy kind', () => {
    expect('kind' in errorRecord({ message: 'x', code: 'EIO', kind: 'nonsense' })).toBe(false);
    expect('limit' in errorRecord({ message: 'x', code: 'E2BIG', limit: 'lots' })).toBe(false);
  });
});

describe('record round trip through encode, decode and unwrap', () => {
  const roundTrip = (error: unknown): unknown => {
    const bytes = encode({ ok: false, error: errorRecord(error) });
    return decode(bytes);
  };
  it('rehydrates each kind as its host subclass', () => {
    const rows: Array<[unknown, new (...args: never[]) => RuntimeError, string]> = [
      [fault('ENOSYS', 'unsupported operation'), UnsupportedError, 'ENOSYS'],
      [fault('E2BIG', 'Snapshot has too many entries'), LimitError, 'E2BIG'],
      [fault('ETIMEDOUT', 'Kernel did not complete syscall'), ChannelError, 'ETIMEDOUT'],
      [fault('EPIPE', 'Container closed'), LifecycleError, 'EPIPE'],
    ];
    for (const [source, ErrorClass, code] of rows) {
      let thrown: unknown;
      try {
        unwrap(roundTrip(source));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ErrorClass);
      const rehydrated = thrown as RuntimeError;
      expect(rehydrated.code).toBe(code);
      expect(rehydrated.message).toBe((source as Error).message);
      expect(rehydrated.kind).toBe((source as RuntimeError).kind);
      expect(rehydrated.name).toBe('Error');
    }
  });

  it('carries numeric bounds across the boundary', () => {
    let thrown: unknown;
    try {
      unwrap(roundTrip(fault('E2BIG', 'Snapshot exceeds 128 MiB', { limit: 128, actual: 200 })));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LimitError);
    expect((thrown as LimitError).limit).toBe(128);
    expect((thrown as LimitError).actual).toBe(200);
  });

  it('keeps filesystem error fields and stays a plain Error without a kind', () => {
    const source = Object.assign(new Error('ENOENT: no such file'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      path: '/missing',
    });
    let thrown: unknown;
    try {
      unwrap(roundTrip(source));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RuntimeError);
    const rehydrated = thrown as Error & { code: string; errno: number; syscall: string };
    expect(rehydrated.message).toBe('ENOENT: no such file');
    expect(rehydrated.code).toBe('ENOENT');
    expect(rehydrated.errno).toBe(-2);
    expect(rehydrated.syscall).toBe('open');
  });

  it('treats a legacy record without a kind field as a plain Error', () => {
    let thrown: unknown;
    try {
      unwrap({ ok: false, error: { name: 'Error', message: 'legacy', code: 'E2BIG' } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(LimitError);
    expect((thrown as Error & { code: string }).code).toBe('E2BIG');
  });
});
