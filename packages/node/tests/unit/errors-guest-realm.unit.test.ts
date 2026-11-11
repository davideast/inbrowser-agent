import { describe, expect, it } from 'vitest';
import {
  LimitError,
  errorTaxonomy,
  isGuestRealm,
  markGuestRealm,
  runtimeError,
} from '../../src/errors';
import { errorRecord, fault, reviveError } from '../../src/protocol';

// Separate file: the guest-realm flag is module state, and vitest isolates
// modules per file, so this suite sees a fresh errors module.
markGuestRealm();

describe('guest realm errors', () => {
  it('marks the realm once', () => {
    expect(isGuestRealm()).toBe(true);
  });

  it('builds exact-prototype Errors whose only own data property is code', () => {
    const error = runtimeError('ENOSYS', 'statfs unsupported');
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error).not.toBeInstanceOf(LimitError);
    expect(Reflect.ownKeys(error).filter((key) => key !== 'stack')).toEqual(['message', 'code']);
    expect(error.code).toBe('ENOSYS');
    expect(String(error)).toBe('Error: statfs unsupported');
  });

  it('keeps the taxonomy in the side table and serializes it for the host', () => {
    const error = fault('E2BIG', 'too many entries', { limit: 10, actual: 11 });
    expect('kind' in error).toBe(false);
    expect(errorTaxonomy(error)).toEqual({ kind: 'limit', limit: 10, actual: 11 });
    expect(errorRecord(error)).toMatchObject({
      code: 'E2BIG',
      kind: 'limit',
      limit: 10,
      actual: 11,
    });
    expect(errorTaxonomy(new Error('plain'))).toEqual({});
  });

  it('revives kernel records as plain Errors without taxonomy own properties', () => {
    const revived = reviveError({
      name: 'Error',
      message: 'kernel bound',
      code: 'E2BIG',
      kind: 'limit',
      limit: 5,
      actual: 6,
      syscall: 'write',
    }) as Error & { code: string; syscall: string };
    expect(Object.getPrototypeOf(revived)).toBe(Error.prototype);
    expect('kind' in revived).toBe(false);
    expect('limit' in revived).toBe(false);
    expect(revived.code).toBe('E2BIG');
    expect(revived.syscall).toBe('write');
    expect(errorTaxonomy(revived)).toEqual({ kind: 'limit', limit: 5, actual: 6 });
  });
});
