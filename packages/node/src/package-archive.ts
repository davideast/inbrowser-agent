import { fault } from './protocol';
import { resourceLimits } from './resource-policy';

const text = new TextDecoder('utf-8', { fatal: true });

export async function boundedBytes(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(fault('ETIMEDOUT', 'Package stream timed out')),
    resourceLimits().timers.downloadMs,
  );
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const cancel = () => {
    void reader.cancel(lifetime.reason).catch(() => {});
  };
  lifetime.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      lifetime.throwIfAborted();
      const next = await reader.read();
      lifetime.throwIfAborted();
      if (next.done) break;
      size += next.value.length;
      if (size > resourceLimits().install.archiveBytes)
        throw fault('E2BIG', 'Package archive exceeds 64 MiB');
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    lifetime.removeEventListener('abort', cancel);
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Strip the registry archive's single leading directory. No archive links are followed. */
export async function packageFiles(
  compressed: Uint8Array,
  signal: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  const bytes = await boundedBytes(
    new Blob([new Uint8Array(compressed)]).stream().pipeThrough(new DecompressionStream('gzip')),
    signal,
  );
  // Archive filenames are data, including __proto__.
  const files: Record<string, Uint8Array> = Object.create(null);
  const string = (offset: number, length: number) => {
    const field = bytes.subarray(offset, offset + length);
    const nul = field.indexOf(0);
    return text.decode(nul < 0 ? field : field.subarray(0, nul));
  };
  const octal = (offset: number, length: number) => {
    const value = string(offset, length).trim();
    if (!/^[0-7]+$/.test(value)) throw fault('EINVAL', 'Invalid tar numeric field');
    const number = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(number)) throw fault('E2BIG', 'Tar numeric field exceeds range');
    return number;
  };
  let offset = 0;
  let root: string | undefined;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > bytes.length || bytes.subarray(offset).some((byte) => byte !== 0))
        throw fault('EINVAL', 'Invalid tar end marker');
      return files;
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== octal(offset + 148, 8)) throw fault('EINVAL', 'Tar checksum mismatch');
    const prefix = string(offset + 345, 155);
    const name = (prefix ? prefix + '/' : '') + string(offset, 100);
    const parts = name.replace(/\/$/, '').split('/');
    const relative = parts.slice(1).join('/');
    root ??= parts[0];
    const type = header[156];
    if (
      parts[0] !== root ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      name.includes('\\') ||
      (!relative && type !== 53)
    )
      throw fault('EINVAL', 'Package archive path escapes its root');
    const size = octal(offset + 124, 12);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > bytes.length) throw fault('EINVAL', 'Truncated package archive');
    if (type === 0 || type === 48) {
      if (Object.hasOwn(files, relative)) throw fault('EINVAL', 'Duplicate package file');
      if (relative.endsWith('.node') || relative === 'binding.gyp')
        throw fault('ENOSYS', 'Native addons are not supported by the browser installer');
      files[relative] = bytes.slice(offset + 512, offset + 512 + size);
      if (Object.keys(files).length > 10000) throw fault('E2BIG', 'Too many package files');
    } else if (type !== 53) throw fault('ENOSYS', 'Unsupported package archive entry type');
    offset = next;
  }
  throw fault('EINVAL', 'Package archive is missing its end marker');
}
