import createSodium from 'libsodium-sumo';
import { fault } from './protocol';
import { resourceLimits } from './resource-policy';

let sodium: Awaited<ReturnType<typeof createSodium>> | undefined;
const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
export async function initializeCryptoComparison() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    sodium = await Promise.race([
      createSodium({
        // Supplying this hook prevents the package's Node entropy fallback.
        getRandomValue: () => getRandomValues(new Uint32Array(1))[0],
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(fault('ETIMEDOUT', 'Crypto initialization timed out')),
          resourceLimits().timers.cryptoInitMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function bytes(value: unknown) {
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer)
    return new Uint8Array(value);
  throw Object.assign(new TypeError('Expected an ArrayBuffer or binary view'), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
}
export function timingSafeEqual(a: unknown, b: unknown) {
  const left = bytes(a);
  const right = bytes(b);
  if (left.length !== right.length)
    throw Object.assign(new RangeError('Input buffers must have the same byte length'), {
      code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH',
    });
  if (left.length > resourceLimits().child.comparisonBytes)
    throw fault('E2BIG', 'Comparison exceeds 32 MiB');
  if (!sodium) throw fault('EAGAIN', 'Crypto comparison is not initialized');
  const pointer = sodium._malloc(64);
  if (!pointer) throw fault('ENOMEM', 'Crypto scratch allocation failed');
  let difference = 0;
  try {
    // Every block invokes the upstream WASM constant-time primitive. No branch or
    // address depends on matching bytes, and the final short block is zero padded.
    for (let offset = 0; offset < left.length; offset += 32) {
      const heap = sodium.HEAPU8;
      heap.fill(0, pointer, pointer + 64);
      heap.set(left.subarray(offset, offset + 32), pointer);
      heap.set(right.subarray(offset, offset + 32), pointer + 32);
      difference |= sodium._crypto_verify_32(pointer, pointer + 32);
    }
    return difference === 0;
  } finally {
    sodium.HEAPU8.fill(0, pointer, pointer + 64);
    sodium._free(pointer);
  }
}
