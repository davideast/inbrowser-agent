import { describe, expect, it } from 'vitest';
import { parseMountEntries, parseMountMode } from '../../src/mount-entries';

function failure(run: () => unknown): { code?: string; type: string } {
  try {
    run();
  } catch (error) {
    return { code: (error as { code?: string }).code, type: (error as Error).constructor.name };
  }
  throw new Error('expected failure');
}

describe('parseMountMode', () => {
  it('accepts permission bit patterns from 0 through 0o7777', () => {
    for (const mode of [0, 0o400, 0o644, 0o755, 0o4755, 0o7777])
      expect(parseMountMode(mode)).toBe(mode);
  });
  it('rejects out-of-range and non-integer numbers like Node chmod', () => {
    for (const bad of [-1, 0.5, 0o10000, 0o100644, Number.NaN, Number.POSITIVE_INFINITY])
      expect(failure(() => parseMountMode(bad)).code).toBe('ERR_OUT_OF_RANGE');
  });
  it('rejects non-numbers with ERR_INVALID_ARG_TYPE', () => {
    for (const bad of ['755', null, undefined, {}, 1n])
      expect(failure(() => parseMountMode(bad)).code).toBe('ERR_INVALID_ARG_TYPE');
  });
});

describe('parseMountEntries', () => {
  it('normalizes bare and object entries, leaving mode absent when not given', () => {
    const bytes = new Uint8Array([1]);
    expect(
      parseMountEntries({
        '/a': 'x',
        '/b': bytes,
        '/c': { data: 'y' },
        '/d': { data: bytes, mode: 0o755 },
      }),
    ).toEqual([
      { path: '/a', data: 'x' },
      { path: '/b', data: bytes },
      { path: '/c', data: 'y' },
      { path: '/d', data: bytes, mode: 0o755 },
    ]);
  });
  it('accepts mode 0 and rejects a null mode', () => {
    expect(parseMountEntries({ '/z': { data: '', mode: 0 } })[0]?.mode).toBe(0);
    expect(failure(() => parseMountEntries({ '/z': { data: '', mode: null } })).code).toBe(
      'ERR_INVALID_ARG_TYPE',
    );
  });
  it('rejects bad paths, contents and shapes with EINVAL', () => {
    for (const files of [
      { relative: 'x' },
      { '/a': 5 },
      { '/a': null },
      { '/a': [] },
      { '/a': { mode: 0o644 } },
      { '/a': { data: 5 } },
      { '/a': { data: 'x', extra: 1 } },
      null,
      'text',
    ])
      expect(failure(() => parseMountEntries(files)).code).toBe('EINVAL');
  });
});
