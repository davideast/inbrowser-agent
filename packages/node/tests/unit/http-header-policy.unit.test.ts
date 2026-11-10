import { describe, expect, it } from 'vitest';
import { validateHttpHeaderPolicy } from '../../src/http-header-policy';

describe('validateHttpHeaderPolicy', () => {
  it('returns an empty policy when given undefined', () => {
    expect(validateHttpHeaderPolicy(undefined)).toEqual({});
  });

  it('normalizes origins and lower-cases header names', () => {
    const policy = validateHttpHeaderPolicy({
      'https://Example.com/': ['X-Trace', 'Authorization'],
      'http://api.example.com:8080': ['Cookie'],
    });
    expect(policy).toEqual({
      'https://example.com': ['x-trace', 'authorization'],
      'http://api.example.com:8080': ['cookie'],
    });
  });

  it('freezes the result and each header-name list', () => {
    const policy = validateHttpHeaderPolicy({ 'https://example.com': ['x-trace'] });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy['https://example.com'])).toBe(true);
  });

  it('accepts an empty header-name list for an origin', () => {
    expect(validateHttpHeaderPolicy({ 'https://example.com': [] })).toEqual({
      'https://example.com': [],
    });
  });

  it('rejects a non-record value', () => {
    expect(() => validateHttpHeaderPolicy(null)).toThrow(/Invalid HTTP header policy/);
    expect(() => validateHttpHeaderPolicy('nope')).toThrow(/Invalid HTTP header policy/);
    expect(() => validateHttpHeaderPolicy(42)).toThrow(/Invalid HTTP header policy/);
  });

  it('rejects more than 64 origins', () => {
    const many: Record<string, string[]> = {};
    for (let i = 0; i < 65; i++) many[`https://example${i}.com`] = [];
    expect(() => validateHttpHeaderPolicy(many)).toThrow(/Invalid HTTP header policy/);
  });

  it('rejects a malformed origin URL', () => {
    expect(() => validateHttpHeaderPolicy({ 'not a url': [] })).toThrow(
      /Invalid HTTP policy origin/,
    );
  });

  it('rejects a non-HTTP(S) origin', () => {
    expect(() => validateHttpHeaderPolicy({ 'ftp://example.com': [] })).toThrow(
      /HTTP policy requires distinct HTTP origins/,
    );
  });

  it('rejects an origin carrying credentials, a path, a query, or a hash', () => {
    expect(() => validateHttpHeaderPolicy({ 'https://user:pass@example.com': [] })).toThrow(
      /HTTP policy requires distinct HTTP origins/,
    );
    expect(() => validateHttpHeaderPolicy({ 'https://example.com/path': [] })).toThrow(
      /HTTP policy requires distinct HTTP origins/,
    );
    expect(() => validateHttpHeaderPolicy({ 'https://example.com/?x=1': [] })).toThrow(
      /HTTP policy requires distinct HTTP origins/,
    );
    expect(() => validateHttpHeaderPolicy({ 'https://example.com/#frag': [] })).toThrow(
      /HTTP policy requires distinct HTTP origins/,
    );
  });

  it('rejects two keys that normalize to the same origin', () => {
    expect(() =>
      validateHttpHeaderPolicy({
        'https://example.com': [],
        'https://EXAMPLE.com': [],
      }),
    ).toThrow(/HTTP policy requires distinct HTTP origins/);
  });

  it('rejects a non-array header-name list', () => {
    expect(() =>
      validateHttpHeaderPolicy({ 'https://example.com': 'x-trace' as unknown as string[] }),
    ).toThrow(/Invalid omitted header names/);
  });

  it('rejects more than 64 header names for one origin', () => {
    const names = Array.from({ length: 65 }, (_, i) => `x-h${i}`);
    expect(() => validateHttpHeaderPolicy({ 'https://example.com': names })).toThrow(
      /Invalid omitted header names/,
    );
  });

  it('rejects a header name over 256 characters', () => {
    const long = 'x-'.padEnd(257, 'a');
    expect(() => validateHttpHeaderPolicy({ 'https://example.com': [long] })).toThrow(
      /Invalid omitted header names/,
    );
  });

  it('rejects a header name with characters outside the RFC 7230 token set', () => {
    expect(() => validateHttpHeaderPolicy({ 'https://example.com': ['bad header'] })).toThrow(
      /Invalid omitted header names/,
    );
    expect(() => validateHttpHeaderPolicy({ 'https://example.com': ['bad:header'] })).toThrow(
      /Invalid omitted header names/,
    );
  });
});
