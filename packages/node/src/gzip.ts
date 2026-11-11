import { Buffer } from 'buffer';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);

export function createGzip(retain: () => () => void) {
  const LIMIT = resourceLimits().install.gzipBytes;
  const deadline = resourceLimits().timers.gzipMs;
  return (input: unknown, options: unknown, callback?: unknown) => {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== 'function')
      throw Object.assign(new TypeError('callback must be a function'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    if (options != null && (!record(options) || Object.keys(options).length !== 0))
      throw fault('ENOSYS', 'Gzip compression options are not implemented');
    if (!(typeof input === 'string' || input instanceof ArrayBuffer || ArrayBuffer.isView(input)))
      throw Object.assign(new TypeError('input must be a string or buffer'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    const bytes =
      typeof input === 'string'
        ? Buffer.from(input)
        : input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (bytes.byteLength > LIMIT) throw fault('E2BIG', 'Gzip input exceeds 32 MiB');
    // Blob snapshots caller-owned bytes before asynchronous compression starts.
    const blob = new Blob([Uint8Array.from(bytes)]);
    const release = retain();
    const done = callback;
    async function compress() {
      const reader = blob.stream().pipeThrough(new CompressionStream('gzip')).getReader();
      let timer: ReturnType<typeof hostSetTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = hostSetTimeout(() => {
          const error = fault('ETIMEDOUT', 'Gzip compression timed out');
          void reader.cancel(error).catch(() => {});
          reject(error);
        }, deadline);
      });
      const read = async () => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return Buffer.concat(chunks, total);
          total += chunk.value.byteLength;
          if (total > LIMIT) throw fault('E2BIG', 'Gzip output exceeds 32 MiB');
          chunks.push(chunk.value);
        }
      };
      try {
        return await Promise.race([read(), timeout]);
      } finally {
        hostClearTimeout(timer);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    void compress().then(
      (data) => {
        try {
          done(null, data);
        } finally {
          release();
        }
      },
      (error: unknown) => {
        try {
          done(error);
        } finally {
          release();
        }
      },
    );
  };
}
