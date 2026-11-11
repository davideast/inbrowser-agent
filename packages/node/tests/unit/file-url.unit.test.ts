import { describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from '../../src/file-url';

describe('pathToFileURL', () => {
  it('converts an absolute posix path to a file: URL', () => {
    const url = pathToFileURL('/a/b/c');
    expect(url.protocol).toBe('file:');
    expect(url.pathname).toBe('/a/b/c');
    expect(url.href).toBe('file:///a/b/c');
  });

  it('resolves a relative path against the given cwd', () => {
    const url = pathToFileURL('sub/file.txt', '/home/user');
    expect(url.pathname).toBe('/home/user/sub/file.txt');
  });

  it('preserves a trailing slash lost by path resolution', () => {
    const url = pathToFileURL('dir/', '/home/user');
    expect(url.pathname.endsWith('/')).toBe(true);
    expect(url.pathname).toBe('/home/user/dir/');
  });

  it('percent-encodes characters that would otherwise be reinterpreted', () => {
    const url = pathToFileURL('/a%b\\c\nd\re\tf');
    expect(url.pathname).toBe('/a%25b%5Cc%0Ad%0De%09f');
  });

  it('throws a typed error for non-string input', () => {
    expect(() => pathToFileURL(42 as unknown as string)).toThrow(TypeError);
    try {
      pathToFileURL(42 as unknown as string);
      expect.unreachable();
    } catch (error) {
      expect((error as Error & { code: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    }
  });
});

describe('fileURLToPath', () => {
  it('round-trips a path produced by pathToFileURL', () => {
    expect(fileURLToPath(pathToFileURL('/a/b/c'))).toBe('/a/b/c');
    expect(fileURLToPath(pathToFileURL('/a b/c'))).toBe('/a b/c');
    expect(fileURLToPath(pathToFileURL('/a%b'))).toBe('/a%b');
  });

  it('accepts both a URL instance and a string', () => {
    expect(fileURLToPath('file:///a/b')).toBe('/a/b');
    expect(fileURLToPath(new URL('file:///a/b'))).toBe('/a/b');
  });

  it('treats an empty or "localhost" host as equivalent to no host', () => {
    expect(fileURLToPath('file://localhost/a/b')).toBe('/a/b');
  });

  it('rejects non-string, non-URL input', () => {
    try {
      fileURLToPath(42 as unknown as string);
      expect.unreachable();
    } catch (error) {
      expect((error as Error & { code: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    }
  });

  it('rejects a non-file: protocol', () => {
    try {
      fileURLToPath('https://example.com/a');
      expect.unreachable();
    } catch (error) {
      expect((error as Error & { code: string }).code).toBe('ERR_INVALID_URL_SCHEME');
    }
  });

  it('rejects a file: URL carrying a non-empty host', () => {
    try {
      fileURLToPath('file://example.com/a');
      expect.unreachable();
    } catch (error) {
      expect((error as Error & { code: string }).code).toBe('ERR_INVALID_FILE_URL_HOST');
    }
  });

  it('rejects a file: URL with an encoded slash in the path', () => {
    try {
      fileURLToPath('file:///a%2Fb');
      expect.unreachable();
    } catch (error) {
      expect((error as Error & { code: string }).code).toBe('ERR_INVALID_FILE_URL_PATH');
    }
  });
});
