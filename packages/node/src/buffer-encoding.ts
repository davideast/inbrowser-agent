import { Buffer } from 'buffer';
import { installBufferStatics } from './buffer-extras';

// Called once during process Worker bootstrap. All guest buffers, including
// filesystem results and subarrays, share this realm's pinned Buffer prototype.
export function installBufferOutputEncodings() {
  installBufferStatics();
  const baseToString = Buffer.prototype.toString;
  Buffer.prototype.toString = function (encoding?: string, start?: number, end?: number) {
    if (typeof encoding === 'string' && encoding.toLowerCase() === 'base64url') {
      return baseToString
        .call(this, 'base64', start, end)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    }
    return baseToString.call(this, encoding, start, end);
  };
  // Buffer's locale method is the same encoding-aware alias, unlike Uint8Array.
  Object.defineProperty(Buffer.prototype, 'toLocaleString', { value: Buffer.prototype.toString });
  // Node searches for any Uint8Array needle, not only a Buffer, and rejects every
  // other non-string, non-number value with ERR_INVALID_ARG_TYPE. The bundled
  // Buffer accepts only Buffers; includes() delegates to indexOf().
  for (const name of ['indexOf', 'lastIndexOf'] as const) {
    const search = Buffer.prototype[name];
    Buffer.prototype[name] = function (
      this: Buffer,
      value: unknown,
      byteOffset?: unknown,
      encoding?: unknown,
    ) {
      let needle = value;
      if (typeof value !== 'string' && typeof value !== 'number') {
        if (!(value instanceof Uint8Array))
          throw Object.assign(
            new TypeError(
              'The "value" argument must be one of type number or string or an instance of Buffer or Uint8Array.',
            ),
            { code: 'ERR_INVALID_ARG_TYPE' },
          );
        if (!Buffer.isBuffer(value))
          needle = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      }
      // Invariant: needle is now a string, a number or a Buffer view, the types the
      // bundled search accepts; the remaining arguments pass through unchanged.
      return Reflect.apply(search, this, [needle, byteOffset, encoding]) as number;
    } as typeof search;
  }
}
