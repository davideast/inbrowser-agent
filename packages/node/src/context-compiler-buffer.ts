// The channel between a process and its compiler Worker: one growable
// SharedArrayBuffer holding an 8-byte header (status word, reply length) and the
// reply bytes. Requests travel by postMessage; only replies use the buffer.
// Both sides know the policy bounds, so the buffer is sized by what replies
// need and never by what the policy allows.

import { fault } from './protocol';

export const HEADER_BYTES = 8;
/** Reply capacity a buffer starts with; it grows in whole MiB when a reply needs more. */
export const INITIAL_REPLY_BYTES = 1024 * 1024;
const GROWTH_STEP = 1024 * 1024;

/** Header status values; 0 means the compiler has not answered. */
export const REPLY_OK = 1;
export const REPLY_FAILED = -1;
export const REPLY_TOO_LARGE = -2;

/** The growable form of SharedArrayBuffer, which the pinned TypeScript lib does not declare. */
export interface GrowableSharedBuffer extends SharedArrayBuffer {
  readonly growable: boolean;
  readonly maxByteLength: number;
  grow(newByteLength: number): void;
}

export function createReplyBuffer(outputLimit: number): GrowableSharedBuffer {
  // The runtime constructor accepts the options bag; only the lib typing lacks it.
  const Growable = SharedArrayBuffer as unknown as new (
    byteLength: number,
    options: { maxByteLength: number },
  ) => GrowableSharedBuffer;
  return new Growable(HEADER_BYTES + Math.min(INITIAL_REPLY_BYTES, outputLimit), {
    maxByteLength: HEADER_BYTES + outputLimit,
  });
}

export function isReplyBuffer(value: unknown, outputLimit: number): value is GrowableSharedBuffer {
  // instanceof SharedArrayBuffer is checked first, so the cast reads real properties.
  return (
    value instanceof SharedArrayBuffer &&
    (value as GrowableSharedBuffer).growable === true &&
    (value as GrowableSharedBuffer).maxByteLength === HEADER_BYTES + outputLimit
  );
}

/**
 * Makes room for `length` reply bytes. Growth is visible to the other side of
 * the channel through the same buffer object; it reads with views created after
 * the reply arrives, never with a view cached from before.
 */
export function reserveReply(shared: GrowableSharedBuffer, length: number): void {
  const needed = HEADER_BYTES + length;
  if (shared.byteLength >= needed) return;
  shared.grow(Math.min(shared.maxByteLength, Math.ceil(needed / GROWTH_STEP) * GROWTH_STEP));
}

export function describeBytes(bytes: number): string {
  const MiB = 1024 * 1024;
  if (bytes % MiB === 0) return `${bytes / MiB} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

/** The E2BIG a process raises for a source over `contextSourceBytes`. */
export function sourceTooLarge(limit: number, actual: number): Error {
  return fault('E2BIG', `Context compiler source exceeds ${describeBytes(limit)}`, {
    limit,
    actual,
  });
}

/** The E2BIG a process raises when the compiler's reply passes `contextOutputBytes`. */
export function replyTooLarge(limit: number, actual: number): Error {
  return fault('E2BIG', `Compiled context source exceeds ${describeBytes(limit)}`, {
    limit,
    actual,
  });
}
