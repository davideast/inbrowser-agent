import { describe, expect, it } from 'vitest';
import { copyFileMode } from '../../src/copy-file-mode';

describe('copyFileMode', () => {
  it('defaults to 0 when given undefined or null', () => {
    expect(copyFileMode(undefined)).toBe(0);
    expect(copyFileMode(null)).toBe(0);
  });

  it('accepts values across the full supported flag range', () => {
    for (let flags = 0; flags <= 7; flags++) expect(copyFileMode(flags)).toBe(flags);
  });

  it('truncates a finite fractional value before range-checking', () => {
    expect(copyFileMode(3.9)).toBe(3);
  });

  it('rejects a non-number mode with a typed error', () => {
    try {
      copyFileMode('3');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error & { code: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    }
  });

  it('rejects modes outside the supported flag bits', () => {
    for (const bad of [-1, 8, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      try {
        copyFileMode(bad);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        expect((error as Error & { code: string }).code).toBe('ERR_OUT_OF_RANGE');
      }
    }
  });
});
