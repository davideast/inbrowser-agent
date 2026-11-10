import type { CookieMirrorOp } from './preview-cookies';
import { type ErrorRecord, VERSION, record } from './protocol';

// Preview HTTP is a streamed exchange over one MessageChannel per request:
// service worker <-> host relay <-> guest process. Both directions carry the
// same frames. Body bytes travel in `data` frames of at most one transport
// chunk, and a sender may have at most one window of bytes outstanding: every
// `data` frame stays "in flight" until the receiver has handed it to its own
// consumer and answered with a `credit` frame for the same byte count.
//
// This module is pure framing and accounting. It owns no port and no timer so
// the Node unit tier can exercise it directly.

/** The fixed transport chunk; see `FIXED_LIMITS.transportChunkBytes`. */
export const PREVIEW_CHUNK_BYTES = 65536;

export type PreviewHeaders = Record<string, string | string[]>;

export type PreviewFrame =
  | {
      type: 'head';
      status: number;
      headers: PreviewHeaders;
      previewSocket?: boolean;
      previewClient?: boolean;
      /** Origin mode only: guest cookies to mirror into the preview's page-visible store. */
      cookies?: CookieMirrorOp[];
    }
  | { type: 'data'; bytes: Uint8Array }
  | { type: 'credit'; bytes: number }
  | { type: 'end' }
  | { type: 'abort'; error?: ErrorRecord }
  | { type: 'ping' };

function headers(value: unknown): value is PreviewHeaders {
  if (!record(value) || Array.isArray(value)) return false;
  for (const item of Object.values(value)) {
    if (typeof item === 'string') continue;
    if (!Array.isArray(item) || !item.every((entry) => typeof entry === 'string')) return false;
  }
  return true;
}

function mirrorOps(value: unknown): value is CookieMirrorOp[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (op: unknown) =>
      record(op) &&
      typeof op.name === 'string' &&
      op.name !== '' &&
      typeof op.path === 'string' &&
      op.path.startsWith('/') &&
      (op.op === 'delete' ||
        (op.op === 'set' &&
          typeof op.value === 'string' &&
          (op.expires === null ||
            (typeof op.expires === 'number' && Number.isFinite(op.expires))) &&
          (op.sameSite === 'strict' || op.sameSite === 'lax' || op.sameSite === 'none'))),
  );
}

/** Validates one untrusted message; anything else is a protocol violation. */
export function readFrame(value: unknown): PreviewFrame | undefined {
  if (!record(value) || value.version !== VERSION) return;
  switch (value.type) {
    case 'head':
      if (
        typeof value.status !== 'number' ||
        !Number.isInteger(value.status) ||
        !headers(value.headers) ||
        (value.cookies !== undefined && !mirrorOps(value.cookies))
      )
        return;
      return {
        type: 'head',
        status: value.status,
        headers: value.headers,
        ...(value.previewSocket === true ? { previewSocket: true } : {}),
        ...(value.previewClient === true ? { previewClient: true } : {}),
        ...(value.cookies !== undefined ? { cookies: value.cookies } : {}),
      };
    case 'data':
      if (
        !(value.bytes instanceof Uint8Array) ||
        value.bytes.length < 1 ||
        value.bytes.length > PREVIEW_CHUNK_BYTES
      )
        return;
      return { type: 'data', bytes: value.bytes };
    case 'credit':
      if (typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1)
        return;
      return { type: 'credit', bytes: value.bytes };
    case 'end':
      return { type: 'end' };
    case 'ping':
      return { type: 'ping' };
    case 'abort': {
      const error = value.error;
      if (error === undefined) return { type: 'abort' };
      if (!record(error) || typeof error.message !== 'string' || typeof error.code !== 'string')
        return;
      // Shape checked above; the remaining ErrorRecord fields are optional.
      return { type: 'abort', error: error as unknown as ErrorRecord };
    }
  }
  return;
}

/** Largest `data` frame a sender may post under a window. */
export function frameBytes(windowBytes: number): number {
  return Math.min(PREVIEW_CHUNK_BYTES, windowBytes);
}

/**
 * Outstanding-byte accounting for one direction of one exchange. The sender
 * uses it to decide what it may post; the relay and the receiver use the same
 * arithmetic to reject a peer that posts beyond the window or credits bytes
 * that were never sent.
 */
export class WindowMeter {
  #inFlight = 0;
  #peak = 0;
  constructor(readonly windowBytes: number) {}
  get inFlight(): number {
    return this.#inFlight;
  }
  get peak(): number {
    return this.#peak;
  }
  get available(): number {
    return this.windowBytes - this.#inFlight;
  }
  /** Accounts for a posted frame. False when it would exceed the window. */
  add(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.available) return false;
    this.#inFlight += bytes;
    if (this.#inFlight > this.#peak) this.#peak = this.#inFlight;
    return true;
  }
  /** Accounts for a credit. False when it acknowledges bytes never sent. */
  remove(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.#inFlight) return false;
    this.#inFlight -= bytes;
    return true;
  }
}

interface Pending {
  bytes: Uint8Array;
  offset: number;
  done: () => void;
}

/**
 * Splits written chunks into frames and posts them only while the window has
 * room. `done` for a chunk runs once its last byte has been posted, which is
 * the sender's backpressure signal: a writer that waits for `done` holds at
 * most one unsent chunk here plus one window in flight.
 */
export class FrameSender {
  readonly meter: WindowMeter;
  #queue: Pending[] = [];
  #closed = false;
  constructor(
    windowBytes: number,
    private readonly post: (bytes: Uint8Array) => void,
  ) {
    this.meter = new WindowMeter(windowBytes);
  }
  /** True while a queued chunk is waiting for credit. */
  get blocked(): boolean {
    return this.#queue.length > 0;
  }
  send(bytes: Uint8Array, done: () => void): void {
    if (this.#closed) {
      done();
      return;
    }
    this.#queue.push({ bytes, offset: 0, done });
    this.#pump();
  }
  /** Applies a peer credit. False is a protocol violation. */
  credit(bytes: number): boolean {
    if (this.#closed) return true;
    if (!this.meter.remove(bytes)) return false;
    this.#pump();
    return true;
  }
  /** Drops queued chunks without running their callbacks; the stream is gone. */
  close(): void {
    this.#closed = true;
    this.#queue.length = 0;
  }
  #pump(): void {
    const frame = frameBytes(this.meter.windowBytes);
    while (!this.#closed && this.#queue.length) {
      const head = this.#queue[0];
      const remaining = head.bytes.length - head.offset;
      if (remaining > 0) {
        const size = Math.min(frame, remaining, this.meter.available);
        if (size < 1) return;
        // Copy into an exact-size buffer: a structured clone of a view would
        // serialize the writer's whole backing buffer for every frame, and the
        // writer's own buffer must never be transferred away from it.
        const bytes = new Uint8Array(head.bytes.subarray(head.offset, head.offset + size));
        head.offset += size;
        this.meter.add(size);
        this.post(bytes);
        continue;
      }
      this.#queue.shift();
      head.done();
    }
  }
}
