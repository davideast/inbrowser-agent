// buffer.isUtf8 and buffer.isAscii (Node 22.18, lib/buffer.js): the input must be
// a TypedArray (Buffer included) or an ArrayBuffer; a DataView is rejected.
function bytesOf(input: unknown): Uint8Array {
  if (input instanceof ArrayBuffer || input instanceof SharedArrayBuffer)
    return new Uint8Array(input);
  if (ArrayBuffer.isView(input) && !(input instanceof DataView))
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw Object.assign(
    new TypeError(
      'The "input" argument must be an instance of ArrayBuffer, Buffer, or TypedArray.',
    ),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function isUtf8(input: unknown): boolean {
  const bytes = bytesOf(input);
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function isAscii(input: unknown): boolean {
  const bytes = bytesOf(input);
  for (let index = 0; index < bytes.length; index++) if (bytes[index] > 0x7f) return false;
  return true;
}
