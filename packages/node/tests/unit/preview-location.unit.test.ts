import { describe, expect, it } from 'vitest';
import {
  previewPrefix,
  rewriteLocationValue,
  rewritePreviewLocation,
} from '../../src/preview-location';

const P = '/__preview__/c-1/3000';
const rewrite = (location: unknown) => {
  const result = rewritePreviewLocation({ location } as Record<string, unknown>, 'c-1', 3000);
  return result.location;
};

describe('previewPrefix', () => {
  it('forms the prefix as container.preview() does, without the trailing slash', () => {
    expect(previewPrefix('c-1', 3000)).toBe(P);
  });
});

describe('rewritePreviewLocation', () => {
  it('prefixes a root-relative path, keeping query and fragment', () => {
    expect(rewrite('/login')).toBe(P + '/login');
    expect(rewrite('/a/b?x=1#h')).toBe(P + '/a/b?x=1#h');
    expect(rewrite('/')).toBe(P + '/');
    expect(rewrite('/?x=1')).toBe(P + '/?x=1');
    expect(rewrite('/#top')).toBe(P + '/#top');
  });

  it('keeps encoded characters byte for byte', () => {
    expect(rewrite('/a%20b/%2Fc?q=%2F&r=a+b#%E2%9C%93')).toBe(
      P + '/a%20b/%2Fc?q=%2F&r=a+b#%E2%9C%93',
    );
    expect(rewrite('/café')).toBe(P + '/café');
  });

  it('leaves protocol-relative values unchanged, including backslash forms', () => {
    for (const value of ['//host/x', '//', '/\\host/x', '/\\']) expect(rewrite(value)).toBe(value);
  });

  it('leaves absolute URLs unchanged, even for the guest virtual origin', () => {
    for (const value of [
      'http://example.com/x',
      'https://example.com/',
      'http://127.0.0.1:3000/x',
      'http://localhost:3000/x',
      'mailto:a@b.c',
    ])
      expect(rewrite(value)).toBe(value);
  });

  it('leaves relative, empty, query-only and fragment-only values unchanged', () => {
    for (const value of ['login', '../x', './y', '', '?x=1', '#h', ' /login'])
      expect(rewrite(value)).toBe(value);
  });

  it('leaves values holding characters that URL parsers strip unchanged', () => {
    for (const value of ['/\t/host', '/\n/host', '/a\rb']) expect(rewrite(value)).toBe(value);
  });

  it('is idempotent: a value already inside the prefix is not rewritten again', () => {
    for (const value of [P, P + '/', P + '/login', P + '?x=1', P + '#h', P + '/a?b#c'])
      expect(rewrite(value)).toBe(value);
    expect(rewrite(rewrite('/login'))).toBe(P + '/login');
  });

  it('does not treat a longer container id or port as the same prefix', () => {
    expect(rewrite('/__preview__/c-1/30001/x')).toBe(P + '/__preview__/c-1/30001/x');
    expect(rewrite('/__preview__/c-10/3000/x')).toBe(P + '/__preview__/c-10/3000/x');
    expect(rewrite(P + 'x')).toBe(P + P + 'x');
  });

  it('matches the Location name in any case and keeps that spelling', () => {
    const result = rewritePreviewLocation({ Location: '/x', 'set-cookie': ['a=b'] }, 'c-1', 3000);
    expect(result).toEqual({ Location: P + '/x', 'set-cookie': ['a=b'] });
  });

  it('rewrites a one-element array', () => {
    expect(rewrite(['/x'])).toEqual([P + '/x']);
  });

  it('passes through a missing, repeated or non-string Location without throwing', () => {
    const none = { 'content-type': 'text/plain' };
    expect(rewritePreviewLocation(none, 'c-1', 3000)).toBe(none);
    const many = { location: ['/a', '/b'] };
    expect(rewritePreviewLocation(many, 'c-1', 3000)).toBe(many);
    const empty = { location: [] as string[] };
    expect(rewritePreviewLocation(empty, 'c-1', 3000)).toBe(empty);
    const cased = { Location: '/a', location: '/b' };
    expect(rewritePreviewLocation(cased, 'c-1', 3000)).toBe(cased);
    for (const value of [7, null, undefined, {}, true, [1], [null]]) {
      const headers = { location: value };
      expect(rewritePreviewLocation(headers, 'c-1', 3000)).toBe(headers);
    }
  });

  it('never touches other headers and does not mutate its input', () => {
    const input = { location: '/x', 'set-cookie': ['sid=1; Path=/'], 'content-type': 'text/html' };
    const snapshot = JSON.stringify(input);
    const output = rewritePreviewLocation(input, 'c-1', 3000);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(output).toEqual({ ...input, location: P + '/x' });
    expect(output['set-cookie']).toBe(input['set-cookie']);
  });
});

describe('rewriteLocationValue', () => {
  it('returns non-strings as given', () => {
    const value = {};
    expect(rewriteLocationValue(value, P)).toBe(value);
  });
});
