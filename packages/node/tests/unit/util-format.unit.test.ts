import { describe, expect, it } from 'vitest';
import { formatWithOptions, stripVTControlCharacters } from '../../src/util-format';

describe('formatWithOptions', () => {
  it('returns the sole string argument unchanged when there is nothing to substitute', () => {
    expect(formatWithOptions({}, 'just a string')).toBe('just a string');
  });

  it('joins non-string arguments with util.inspect when there is no format string', () => {
    expect(formatWithOptions({}, 1, true, null)).toBe('1 true null');
  });

  it('substitutes %s for strings, numbers, and bigints', () => {
    expect(formatWithOptions({}, '%s and %s', 'a', 5)).toBe('a and 5');
    expect(formatWithOptions({}, '%s', 5n)).toBe('5n');
  });

  it('formats %d via Number() and %i via parseInt(), and %f as a float', () => {
    expect(formatWithOptions({}, '%d', '3.9')).toBe('3.9');
    expect(formatWithOptions({}, '%i', '3.9')).toBe('3');
    expect(formatWithOptions({}, '%f', '3.9abc')).toBe('3.9');
    expect(formatWithOptions({}, '%d', Symbol('x'))).toBe('NaN');
  });

  it('renders bigint arguments to %d/%i with a trailing n instead of converting them', () => {
    expect(formatWithOptions({}, '%d', 5n)).toBe('5n');
    expect(formatWithOptions({}, '%i', 5n)).toBe('5n');
  });

  it('formats %j as JSON and reports circular references as [Circular]', () => {
    expect(formatWithOptions({}, '%j', { a: 1 })).toBe('{"a":1}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatWithOptions({}, '%j', circular)).toBe('[Circular]');
  });

  it('formats %o with hidden properties and depth 4, %O without those overrides', () => {
    expect(formatWithOptions({}, '%o', { a: 1 })).toBe('{ a: 1 }');
    expect(formatWithOptions({}, '%O', { a: 1 })).toBe('{ a: 1 }');
  });

  it('discards the value consumed by %c', () => {
    expect(formatWithOptions({}, 'color:%c text', 'red')).toBe('color: text');
  });

  it('treats %% as a literal percent without consuming an argument', () => {
    expect(formatWithOptions({}, '100%% done: %s', 'yes')).toBe('100% done: yes');
  });

  it('leaves an unmatched trailing specifier as-is when arguments run out', () => {
    expect(formatWithOptions({}, 'value: %s')).toBe('value: %s');
  });

  it('appends extra arguments beyond the format specifiers, space-joined', () => {
    expect(formatWithOptions({}, '%s', 'a', 'b', 'c')).toBe('a b c');
  });

  it('rejects a non-object options argument', () => {
    expect(() => formatWithOptions(null, 'x')).toThrow(TypeError);
    try {
      formatWithOptions(undefined, 'x');
      expect.unreachable();
    } catch (error) {
      expect((error as Error & { code: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    }
  });
});

describe('stripVTControlCharacters', () => {
  it('removes ANSI escape sequences from a string', () => {
    expect(stripVTControlCharacters('[31mred[39m')).toBe('red');
  });

  it('leaves plain text untouched', () => {
    expect(stripVTControlCharacters('plain')).toBe('plain');
  });

  it('rejects non-string input', () => {
    try {
      stripVTControlCharacters(42);
      expect.unreachable();
    } catch (error) {
      expect((error as Error & { code: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    }
  });
});
