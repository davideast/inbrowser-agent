import rawPaths from 'path-browserify-win32';
import { describe, expect, it } from 'vitest';
import { createPath } from '../../src/path';

describe('createPath', () => {
  it('resolves relative paths against the injected cwd', () => {
    const path = createPath(() => '/home/user');
    expect(path.resolve('sub', 'file.txt')).toBe(
      rawPaths.posix.resolve('/home/user', 'sub', 'file.txt'),
    );
    expect(path.resolve('/abs/path')).toBe('/abs/path');
  });

  it('re-reads cwd() on every call rather than caching it', () => {
    let cwd = '/first';
    const path = createPath(() => cwd);
    expect(path.resolve('x')).toBe('/first/x');
    cwd = '/second';
    expect(path.resolve('x')).toBe('/second/x');
  });

  it('resolves both sides before computing a relative path', () => {
    const path = createPath(() => '/home/user');
    const expected = rawPaths.posix.relative(
      rawPaths.posix.resolve('/home/user', 'a'),
      rawPaths.posix.resolve('/home/user', 'b/c'),
    );
    expect(path.relative('a', 'b/c')).toBe(expected);
  });

  it('exposes the underlying path-browserify implementation for non-overridden members', () => {
    const path = createPath(() => '/home/user');
    expect(path.join('a', 'b')).toBe(rawPaths.posix.join('a', 'b'));
    expect(path.sep).toBe(rawPaths.posix.sep);
    expect(path.basename('/a/b/c.txt')).toBe('c.txt');
    expect(path.extname('/a/b/c.txt')).toBe('.txt');
  });

  it('cross-links posix and win32 onto themselves and each other', () => {
    const path = createPath(() => '/home/user');
    expect(path.posix).toBe(path);
    expect(path.win32).not.toBe(path);
    expect(path.win32.posix).toBe(path);
    expect(path.win32.win32).toBe(path.win32);
  });

  it('resolves win32 toNamespacedPath through the injected cwd', () => {
    const path = createPath(() => '/home/user');
    const win32 = path.win32;
    // Empty strings and other falsy-length values pass through unchanged.
    expect(win32.toNamespacedPath('')).toBe('');
    const resolved = win32.resolve('sub/dir');
    expect(win32.toNamespacedPath('sub/dir')).toBe(rawPaths.win32.toNamespacedPath(resolved));
  });
});
