import { describe, expect, it } from 'vitest';
import { TailCapture } from '../../src/output-capture';

const enc = new TextEncoder();
const total = (capture: TailCapture) => capture.chunks.reduce((sum, c) => sum + c.byteLength, 0);

describe('TailCapture', () => {
  it('keeps complete output under the bound with zero truncation', () => {
    const capture = new TailCapture(64);
    capture.push(enc.encode('hello '));
    capture.push(enc.encode('world'));
    expect(capture.text(false)).toBe('hello world');
    expect(capture.truncatedBytes).toBe(0);
    expect(total(capture)).toBe(11);
  });

  it('retains exactly the last bytes across chunks and counts the dropped bytes', () => {
    const capture = new TailCapture(10);
    capture.push(enc.encode('0123456789'));
    capture.push(enc.encode('abcdefg'));
    capture.push(enc.encode('XYZ'));
    expect(capture.text(true)).toBe('0123456789abcdefgXYZ'.slice(-10));
    expect(total(capture)).toBe(10);
    expect(capture.truncatedBytes).toBe(10);
  });

  it('cuts one oversized chunk down to its tail', () => {
    const capture = new TailCapture(4);
    capture.push(enc.encode('abcdefghij'));
    expect(capture.text(true)).toBe('ghij');
    expect(capture.truncatedBytes).toBe(6);
  });

  it('starts the retained text on a character boundary and counts skipped bytes as dropped', () => {
    // 'é' is 2 bytes, '€' 3 bytes, '😀' 4 bytes.
    const source = 'a😀€é!';
    const bytes = enc.encode(source);
    for (let limit = 1; limit <= bytes.length; limit++) {
      const capture = new TailCapture(limit);
      capture.push(bytes);
      const text = capture.text(true);
      expect(text).not.toContain('�');
      expect(source.endsWith(text)).toBe(true);
      expect(total(capture)).toBeLessThanOrEqual(limit);
      expect(enc.encode(text).byteLength).toBe(total(capture));
      expect(capture.truncatedBytes).toBe(bytes.length - total(capture));
    }
    const cut = new TailCapture(5);
    cut.push(bytes); // 1+4+3+2+1 bytes: the last 5 bytes begin inside the euro sign.
    expect(cut.text(true)).toBe('é!');
    expect(cut.truncatedBytes).toBe(bytes.length - 3);
  });

  it('boundary handling is independent of how the input is chunked', () => {
    const bytes = enc.encode('😀é€x'.repeat(5));
    const whole = new TailCapture(13);
    whole.push(bytes);
    const split = new TailCapture(13);
    for (const byte of bytes) split.push(Uint8Array.of(byte));
    expect(split.text(true)).toBe(whole.text(true));
    expect(split.truncatedBytes).toBe(whole.truncatedBytes);
  });

  it('withholds an incomplete trailing sequence until the stream completes', () => {
    const capture = new TailCapture(64);
    const euro = enc.encode('€');
    capture.push(Uint8Array.of(...enc.encode('a'), euro[0]!, euro[1]!));
    expect(capture.text(false)).toBe('a');
    capture.push(Uint8Array.of(euro[2]!));
    expect(capture.text(false)).toBe('a€');
    const partial = new TailCapture(64);
    partial.push(Uint8Array.of(euro[0]!));
    expect(partial.text(true)).toBe('�');
  });

  it('strips a leading byte-order mark from untruncated output like a TextDecoder', () => {
    const complete = new TailCapture(64);
    complete.push(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61));
    expect(complete.text(true)).toBe('a');
  });

  it('rejects a non-positive or non-integer limit', () => {
    expect(() => new TailCapture(0)).toThrow(RangeError);
    expect(() => new TailCapture(1.5)).toThrow(RangeError);
  });
});
