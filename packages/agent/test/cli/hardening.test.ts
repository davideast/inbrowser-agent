import { describe, expect, it } from 'bun:test';
import { InputHardeningError, hardenPath, hardenString } from '../../src/cli/hardening.js';

describe('hardenString', () => {
  it('passes through clean values', () => {
    expect(hardenString('x', 'hello-world.txt', {})).toBe('hello-world.txt');
  });

  it('rejects control chars when asked', () => {
    expect(() => hardenString('x', 'a\x00b', { rejectControlChars: true })).toThrow(
      InputHardeningError,
    );
    // \t and \n are allowed (not in the control range we reject)
    expect(hardenString('x', 'a\tb\nc', { rejectControlChars: true })).toBe('a\tb\nc');
  });

  it('rejects path traversal', () => {
    expect(() => hardenString('x', '../etc', { rejectPathTraversal: true })).toThrow(
      InputHardeningError,
    );
    expect(() => hardenString('x', 'a/../b', { rejectPathTraversal: true })).toThrow(
      InputHardeningError,
    );
    expect(() => hardenString('x', '%2e%2e/etc', { rejectPathTraversal: true })).toThrow(
      InputHardeningError,
    );
  });

  it('rejects query / fragment chars', () => {
    expect(() => hardenString('x', 'a?b', { rejectQueryChars: true })).toThrow(InputHardeningError);
    expect(() => hardenString('x', 'a#b', { rejectQueryChars: true })).toThrow(InputHardeningError);
  });

  it('enforces maxLength', () => {
    expect(() => hardenString('x', 'abcdef', { maxLength: 3 })).toThrow(InputHardeningError);
  });

  it('enforces pattern', () => {
    expect(() => hardenString('x', 'has space', { pattern: '^[a-z]+$' })).toThrow(
      InputHardeningError,
    );
    expect(hardenString('x', 'lowercase', { pattern: '^[a-z]+$' })).toBe('lowercase');
  });

  it('carries field + reason on rejection', () => {
    try {
      hardenString('my-field', 'a\x01b', { rejectControlChars: true });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InputHardeningError);
      expect((err as InputHardeningError).field).toBe('my-field');
      expect((err as InputHardeningError).reason).toContain('control characters');
    }
  });
});

describe('hardenPath', () => {
  it('returns absolute paths unchanged', () => {
    expect(hardenPath('p', '/etc/passwd', {}, '/cwd')).toBe('/etc/passwd');
  });

  it('resolves relative paths against cwd', () => {
    expect(hardenPath('p', 'subdir/file', {}, '/cwd')).toBe('/cwd/subdir/file');
  });

  it('rejects path traversal at the string layer', () => {
    expect(() => hardenPath('p', '../escape', { rejectPathTraversal: true }, '/cwd')).toThrow(
      InputHardeningError,
    );
  });
});
