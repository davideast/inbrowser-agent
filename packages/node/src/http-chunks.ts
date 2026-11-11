import { Buffer } from 'buffer';
import { fault } from './protocol';

/** Incremental chunk framing; copied payload storage grows geometrically within its bound. */
export class HttpChunks {
  #state: 'size' | 'data' | 'separator' | 'trailers' | 'done' = 'size';
  #line = '';
  #metadata = 0;
  #remaining = 0;
  #separator = 0;
  #body = Buffer.alloc(4096);
  #length = 0;
  #trailers: Record<string, string> = Object.create(null);

  constructor(
    private limit: number,
    private metadataLimit = 65536,
  ) {}

  write(bytes: Uint8Array): { body: Buffer; trailers: Record<string, string> } | undefined {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.#state === 'done') throw fault('EPROTO', 'Bytes after final HTTP chunk');
      if (this.#state === 'data') {
        const count = Math.min(this.#remaining, bytes.length - offset);
        const needed = this.#length + count;
        if (needed > this.#body.length) {
          const next = Buffer.alloc(Math.min(this.limit, Math.max(needed, this.#body.length * 2)));
          this.#body.copy(next, 0, 0, this.#length);
          this.#body = next;
        }
        this.#body.set(bytes.subarray(offset, offset + count), this.#length);
        this.#length = needed;
        this.#remaining -= count;
        offset += count;
        if (!this.#remaining) this.#state = 'separator';
        continue;
      }
      if (++this.#metadata > this.metadataLimit)
        throw fault('E2BIG', 'HTTP chunk metadata exceeds 64 KiB');
      const byte = bytes[offset++];
      if (this.#state === 'separator') {
        if (byte !== (this.#separator === 0 ? 13 : 10))
          throw fault('EPROTO', 'Invalid HTTP chunk separator');
        if (++this.#separator === 2) {
          this.#separator = 0;
          this.#state = 'size';
        }
        continue;
      }
      this.#line += String.fromCharCode(byte);
      if (byte !== 10) continue;
      if (!this.#line.endsWith('\r\n')) throw fault('EPROTO', 'Invalid HTTP chunk line ending');
      const line = this.#line.slice(0, -2);
      this.#line = '';
      if (this.#state === 'size') {
        const match = /^([\da-f]+)(?:;[^\r\n]*)?$/i.exec(line);
        if (!match) throw fault('EPROTO', 'Invalid HTTP chunk size');
        const length = Number.parseInt(match[1], 16);
        if (!Number.isSafeInteger(length) || length > this.limit - this.#length)
          throw fault('E2BIG', 'HTTP chunked body exceeds limit');
        this.#remaining = length;
        this.#state = length ? 'data' : 'trailers';
      } else if (!line) {
        this.#state = 'done';
      } else {
        const match = /^([!#$%&'*+.^_`|~\w-]+):[\t ]*([^\r\n\0]*)$/.exec(line);
        if (!match) throw fault('EPROTO', 'Invalid HTTP trailer');
        const name = match[1].toLowerCase();
        if (name === 'content-length' || name === 'transfer-encoding')
          throw fault('EPROTO', 'Framing header in HTTP trailers');
        if (name in this.#trailers)
          throw fault('ENOSYS', 'Repeated HTTP trailers are not implemented');
        this.#trailers[name] = match[2].trim();
      }
    }
    return this.#state === 'done'
      ? { body: this.#body.subarray(0, this.#length), trailers: this.#trailers }
      : undefined;
  }
}
