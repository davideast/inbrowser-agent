import { describe, expect, it } from 'vitest';
import { HttpChunks } from '../../src/http-chunks';

const encode = (text: string) => new TextEncoder().encode(text);

describe('HttpChunks', () => {
  it('parses a single chunk followed by the terminator', () => {
    const chunks = new HttpChunks(1024);
    const result = chunks.write(encode('5\r\nhello\r\n0\r\n\r\n'));
    expect(result).toBeDefined();
    expect(result!.body.toString('utf8')).toBe('hello');
    expect(result!.trailers).toEqual({});
  });

  it('parses multiple chunks arriving as one write', () => {
    const chunks = new HttpChunks(1024);
    const result = chunks.write(encode('3\r\nfoo\r\n3\r\nbar\r\n0\r\n\r\n'));
    expect(result!.body.toString('utf8')).toBe('foobar');
  });

  it('parses chunks split across many small writes', () => {
    const chunks = new HttpChunks(1024);
    const message = '4\r\nabcd\r\n0\r\n\r\n';
    let result: ReturnType<HttpChunks['write']>;
    for (const byte of encode(message)) {
      result = chunks.write(Uint8Array.of(byte));
    }
    expect(result!.body.toString('utf8')).toBe('abcd');
  });

  it('ignores chunk-extensions after a semicolon in the size line', () => {
    const chunks = new HttpChunks(1024);
    const result = chunks.write(encode('5;foo=bar\r\nhello\r\n0\r\n\r\n'));
    expect(result!.body.toString('utf8')).toBe('hello');
  });

  it('parses trailers after the final chunk', () => {
    const chunks = new HttpChunks(1024);
    const result = chunks.write(encode('2\r\nhi\r\n0\r\nX-Trace: abc\r\n\r\n'));
    expect(result!.trailers).toEqual({ 'x-trace': 'abc' });
  });

  it('rejects a framing header name inside trailers', () => {
    const chunks = new HttpChunks(1024);
    expect(() => chunks.write(encode('0\r\nContent-Length: 1\r\n\r\n'))).toThrow(/Framing header/);
  });

  it('rejects a repeated trailer name', () => {
    const chunks = new HttpChunks(1024);
    expect(() => chunks.write(encode('0\r\nX-A: 1\r\nX-A: 2\r\n\r\n'))).toThrow(
      /Repeated HTTP trailers/,
    );
  });

  it('rejects an invalid chunk size line', () => {
    const chunks = new HttpChunks(1024);
    expect(() => chunks.write(encode('zzz\r\n'))).toThrow(/Invalid HTTP chunk size/);
  });

  it('rejects a chunk size line without a CRLF ending', () => {
    const chunks = new HttpChunks(1024);
    expect(() => chunks.write(encode('5\nhello\r\n0\r\n\r\n'))).toThrow(
      /Invalid HTTP chunk line ending/,
    );
  });

  it('rejects a malformed chunk-data separator', () => {
    const chunks = new HttpChunks(1024);
    expect(() => chunks.write(encode('5\r\nhelloXX0\r\n\r\n'))).toThrow(
      /Invalid HTTP chunk separator/,
    );
  });

  it('rejects a chunk whose declared size exceeds the configured limit', () => {
    const chunks = new HttpChunks(4);
    expect(() => chunks.write(encode('5\r\nhello\r\n'))).toThrow(/HTTP chunked body exceeds limit/);
  });

  it('rejects bytes written after the terminating chunk', () => {
    const chunks = new HttpChunks(1024);
    chunks.write(encode('0\r\n\r\n'));
    expect(() => chunks.write(encode('x'))).toThrow(/Bytes after final HTTP chunk/);
  });

  it('grows its internal buffer across chunks that exceed the initial capacity', () => {
    const chunks = new HttpChunks(1024 * 1024);
    const big = 'a'.repeat(5000);
    const result = chunks.write(encode(`1388\r\n${big}\r\n0\r\n\r\n`));
    expect(result!.body.length).toBe(5000);
    expect(result!.body.toString('utf8')).toBe(big);
  });

  it('returns undefined until the terminating chunk has been seen', () => {
    const chunks = new HttpChunks(1024);
    expect(chunks.write(encode('3\r\nfoo\r\n'))).toBeUndefined();
  });
});
