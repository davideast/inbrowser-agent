import { describe, expect, it } from 'vitest';
import { GLOBSTAR, Matcher, braceExpand, compileSegment } from '../../src/glob-match';

describe('braceExpand', () => {
  it('expands lists, nesting, numeric and alphabetic sequences like bash', () => {
    expect(braceExpand('a{b,c}d')).toEqual(['abd', 'acd']);
    expect(braceExpand('{a,{b,c}}.js')).toEqual(['a.js', 'b.js', 'c.js']);
    expect(braceExpand('{a,b}{1,2}')).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(braceExpand('a{1..3}')).toEqual(['a1', 'a2', 'a3']);
    expect(braceExpand('a{3..1}')).toEqual(['a3', 'a2', 'a1']);
    expect(braceExpand('a{01..03}')).toEqual(['a01', 'a02', 'a03']);
    expect(braceExpand('{a..c}')).toEqual(['a', 'b', 'c']);
    expect(braceExpand('a{1..10..3}')).toEqual(['a1', 'a4', 'a7', 'a10']);
    expect(braceExpand('{,a}.js')).toEqual(['.js', 'a.js']);
  });

  it('leaves a single item, an unclosed brace and a leading {} alone', () => {
    expect(braceExpand('x{y}.js')).toEqual(['x{y}.js']);
    expect(braceExpand('{a,b')).toEqual(['{a,b']);
    expect(braceExpand('a}')).toEqual(['a}']);
    expect(braceExpand('plain')).toEqual(['plain']);
  });
});

describe('compileSegment', () => {
  it('returns globstar, an exact string, or a pattern', () => {
    expect(compileSegment('**')).toBe(GLOBSTAR);
    expect(compileSegment('a.js')).toBe('a.js');
    expect(compileSegment('*.js')).toBeInstanceOf(RegExp);
  });

  it('never lets a wildcard match a leading dot, but an explicit dot does', () => {
    const star = compileSegment('*') as RegExp;
    expect(star.test('a')).toBe(true);
    expect(star.test('.hidden')).toBe(false);
    expect(star.test('')).toBe(false);
    expect((compileSegment('.*') as RegExp).test('.hidden')).toBe(true);
    expect((compileSegment('?x') as RegExp).test('.x')).toBe(false);
    expect((compileSegment('[a-c]*') as RegExp).test('.a')).toBe(false);
  });

  it('handles classes, ranges, negation and POSIX names', () => {
    const range = compileSegment('a[0-9].js') as RegExp;
    expect(range.test('a5.js')).toBe(true);
    expect(range.test('ax.js')).toBe(false);
    expect((compileSegment('[!a].js') as RegExp).test('a.js')).toBe(false);
    expect((compileSegment('[^a].js') as RegExp).test('b.js')).toBe(true);
    expect((compileSegment('a[[:digit:]]') as RegExp).test('a7')).toBe(true);
    expect((compileSegment('[]a]') as RegExp).test(']')).toBe(true);
    // An unclosed bracket is an ordinary character.
    expect(compileSegment('a[.js')).toBe('a[.js');
  });

  it('handles extended globs, including a negation followed by more pattern', () => {
    const negated = compileSegment('!(a).js') as RegExp;
    expect(negated.test('a.js')).toBe(false);
    expect(negated.test('b.js')).toBe(true);
    expect(negated.test('a1.js')).toBe(true);
    expect((compileSegment('+(a|b)') as RegExp).test('abba')).toBe(true);
    expect((compileSegment('@(src|lib)') as RegExp).test('lib')).toBe(true);
    expect((compileSegment('?(a)b') as RegExp).test('b')).toBe(true);
    expect((compileSegment('*(a)') as RegExp).test('aaa')).toBe(true);
  });
});

describe('Matcher', () => {
  it('splits a pattern into segments per brace expansion, with level two optimization', () => {
    expect(new Matcher('src//x.js').globParts).toEqual([['src', 'x.js']]);
    expect(new Matcher('src/./x.js').globParts).toEqual([['src', 'x.js']]);
    expect(new Matcher('src/deep/../x.js').globParts).toEqual([['src', 'x.js']]);
    expect(new Matcher('**/**/a').globParts).toEqual([['**', 'a']]);
    expect(new Matcher('{a,b}/c').globParts).toEqual([
      ['a', 'c'],
      ['b', 'c'],
    ]);
    expect(new Matcher('').set).toEqual([]);
  });

  it('treats a backslash as a separator and a leading ! or # as ordinary', () => {
    expect(new Matcher('a\\b').globParts).toEqual([['a', 'b']]);
    expect(new Matcher('!x').globParts).toEqual([['!x']]);
    expect(new Matcher('#x').globParts).toEqual([['#x']]);
  });

  it('matches whole paths, with ** swallowing directories but not dot directories', () => {
    const matcher = new Matcher('/root/**/*.js');
    expect(matcher.match('/root/a.js')).toBe(true);
    expect(matcher.match('/root/x/y/a.js')).toBe(true);
    expect(matcher.match('/root/.git/a.js')).toBe(false);
    expect(matcher.match('/root/a.ts')).toBe(false);
    expect(new Matcher('/root/src').match('/root/src/')).toBe(true);
    expect(new Matcher('/root/src').match('/root/src/deep')).toBe(false);
    expect(new Matcher('/root/src/**').match('/root/src/deep/z')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(new Matcher('/a/*.js').match('/a/B.JS')).toBe(false);
  });
});
