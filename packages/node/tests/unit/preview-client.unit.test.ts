import { describe, expect, it } from 'vitest';
import { LimitError } from '../../src/errors';
import {
  MAX_PREVIEW_CLIENT_SCRIPT_BYTES,
  PREVIEW_CLIENT_PATH,
  buildPreviewClientBundle,
  validatePreviewClientScript,
} from '../../src/preview-client';
import { VERSION } from '../../src/protocol';

describe('preview-client', () => {
  it('exposes the canonical preview-client path and 256 KiB byte limit', () => {
    expect(PREVIEW_CLIENT_PATH).toBe('/__inbrowser__/preview-client.js');
    expect(MAX_PREVIEW_CLIENT_SCRIPT_BYTES).toBe(256 * 1024);
  });

  it('validates undefined, empty, and bounded UTF-8 client scripts and rejects invalid types or oversized scripts', () => {
    expect(validatePreviewClientScript(undefined)).toBeUndefined();
    expect(validatePreviewClientScript('')).toBe('');
    const exact = 'a'.repeat(MAX_PREVIEW_CLIENT_SCRIPT_BYTES);
    expect(validatePreviewClientScript(exact)).toBe(exact);

    for (const invalid of [null, 123, true, {}, []]) {
      expect(() => validatePreviewClientScript(invalid)).toThrowError(
        expect.objectContaining({ code: 'EINVAL' }),
      );
    }

    const oversizedAscii = 'a'.repeat(MAX_PREVIEW_CLIENT_SCRIPT_BYTES + 1);
    expect(() => validatePreviewClientScript(oversizedAscii)).toThrow(LimitError);
    expect(() => validatePreviewClientScript(oversizedAscii)).toThrowError(
      expect.objectContaining({
        code: 'E2BIG',
        limit: MAX_PREVIEW_CLIENT_SCRIPT_BYTES,
        actual: MAX_PREVIEW_CLIENT_SCRIPT_BYTES + 1,
      }),
    );

    // Multi-byte UTF-8 characters count by encoded UTF-8 byte length, not UTF-16 code units.
    const multiByte = '€'.repeat(Math.floor(MAX_PREVIEW_CLIENT_SCRIPT_BYTES / 3) + 1);
    expect(multiByte.length).toBeLessThan(MAX_PREVIEW_CLIENT_SCRIPT_BYTES);
    expect(() => validatePreviewClientScript(multiByte)).toThrow(LimitError);
  });

  it('builds a self-contained bundle with versioned route metadata and user script', () => {
    const originBundle = buildPreviewClientBundle('window.__booted = 1;');
    expect(originBundle).toContain(`"type":"preview-client"`);
    expect(originBundle).toContain(`"version":${VERSION}`);
    expect(originBundle).toContain('__inbrowserPreviewPort');
    expect(originBundle).toContain('window.__booted = 1;');
    expect(originBundle).not.toContain('containerId');

    const prefixBundle = buildPreviewClientBundle('window.__booted = 2;', {
      containerId: 'cid-123',
      port: 3000,
    });
    expect(prefixBundle).toContain(`"containerId":"cid-123"`);
    expect(prefixBundle).toContain(`"port":3000`);
    expect(prefixBundle).toContain('window.__booted = 2;');
  });
});
