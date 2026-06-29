import { gzip, ungzip } from 'pako';

export const constants = {
  Z_BEST_COMPRESSION: 9,
  Z_BEST_SPEED: 1,
  Z_DEFAULT_COMPRESSION: -1,
};

export function gunzipSync(
  input: Uint8Array,
  options: { maxOutputLength?: number } = {},
): Uint8Array {
  const output = ungzip(input);
  if (options.maxOutputLength && output.byteLength > options.maxOutputLength) {
    throw new Error(`decompressed data exceeds limit (${options.maxOutputLength} bytes)`);
  }
  return output;
}

type CompressionLevel = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export function gzipSync(
  input: Uint8Array,
  options: { level?: CompressionLevel } = {},
): Uint8Array {
  return gzip(input, { level: options.level });
}
