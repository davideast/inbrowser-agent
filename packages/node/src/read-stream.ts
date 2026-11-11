import { Buffer } from 'buffer';
import { Readable } from 'readable-stream/lib/stream.js';
import { invalidArgType } from './arg-errors';
import type { createFs } from './fs';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

interface CustomFsReadStream {
  open: (
    path: unknown,
    flags: string,
    mode: number,
    cb: (err: Error | null, fd?: number) => void,
  ) => void;
  read: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
    cb: (err: Error | null, bytesRead?: number, buffer?: Buffer) => void,
  ) => void;
  close: (fd: number, cb: (err?: Error | null) => void) => void;
}

function validateCustomFs(custom: unknown): CustomFsReadStream {
  if (!record(custom)) throw invalidArgType('options.fs', 'Object', custom);
  if (typeof custom.open !== 'function') {
    throw invalidArgType('options.fs.open', 'function', custom.open);
  }
  if (typeof custom.read !== 'function') {
    throw invalidArgType('options.fs.read', 'function', custom.read);
  }
  if (typeof custom.close !== 'function') {
    throw invalidArgType('options.fs.close', 'function', custom.close);
  }
  // Validated typeof open/read/close === 'function' just above.
  return {
    open: custom.open as CustomFsReadStream['open'],
    read: custom.read as CustomFsReadStream['read'],
    close: custom.close as CustomFsReadStream['close'],
  };
}

export function createReadStreamClass(
  fs: ReturnType<typeof createFs>,
  retain: () => void,
  release: () => void,
) {
  return class ReadStream extends Readable {
    fd: number | null = null;
    bytesRead = 0;
    #opening = true;
    #customFs: CustomFsReadStream | undefined;
    private position: number;
    private end: number;
    private wanted = false;
    private scheduled = false;

    constructor(
      readonly path: unknown,
      options: unknown = {},
    ) {
      if (typeof options === 'string') options = { encoding: options };
      if (!record(options)) throw fault('EINVAL', 'Invalid read stream options');
      // Node reads only the options it documents and ignores any other key (static
      // file servers pass their own settings alongside start and end). Documented
      // options this stream does not implement fail explicitly.
      if (
        options.fd !== undefined ||
        options.mode !== undefined ||
        options.signal !== undefined ||
        (options.flags !== undefined && options.flags !== 'r') ||
        options.autoClose === false ||
        options.emitClose === false
      )
        throw fault('ENOSYS', 'Unsupported read stream option');
      const customFs = options.fs !== undefined ? validateCustomFs(options.fs) : undefined;
      const start = options.start ?? 0;
      const end = options.end ?? Number.POSITIVE_INFINITY;
      const highWaterMark = options.highWaterMark ?? 64 * 1024;
      const encoding = options.encoding;
      if (
        typeof start !== 'number' ||
        !Number.isSafeInteger(start) ||
        start < 0 ||
        typeof end !== 'number' ||
        (end !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(end)) ||
        end < start ||
        typeof highWaterMark !== 'number' ||
        !Number.isSafeInteger(highWaterMark) ||
        highWaterMark < 1 ||
        highWaterMark > resourceLimits().filesystem.readStreamHighWaterMarkBytes ||
        (encoding != null && (typeof encoding !== 'string' || !Buffer.isEncoding(encoding))) ||
        (options.autoClose !== undefined && typeof options.autoClose !== 'boolean') ||
        (options.emitClose !== undefined && typeof options.emitClose !== 'boolean')
      )
        throw fault('EINVAL', 'Invalid read stream option');
      super({ highWaterMark, autoDestroy: true });
      this.#customFs = customFs;
      this.position = start;
      this.end = end;
      if (typeof encoding === 'string' && Buffer.isEncoding(encoding)) this.setEncoding(encoding);
      if (customFs) {
        customFs.open(path, 'r', 0o666, (err, fd) => {
          this.#opening = false;
          if (this.destroyed) {
            if (!err && typeof fd === 'number') customFs.close(fd, () => {});
            return;
          }
          if (err || typeof fd !== 'number') {
            this.destroy(err ?? fault('EPROTO', 'Invalid stream descriptor'));
            return;
          }
          this.fd = fd;
          this.emit('open', fd);
          this.emit('ready');
          if (this.wanted) this._read(highWaterMark);
        });
      } else {
        retain();
        this.once('close', release);
        queueMicrotask(() => {
          this.#opening = false;
          if (this.destroyed) return;
          try {
            const fd = fs.openSync(path, 'r');
            if (typeof fd !== 'number') throw fault('EPROTO', 'Invalid stream descriptor');
            this.fd = fd;
            this.emit('open', fd);
            this.emit('ready');
            if (this.wanted) this._read(highWaterMark);
          } catch (error) {
            this.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    }

    get pending(): boolean {
      return this.fd === null;
    }

    _read(size: number) {
      this.wanted = true;
      if (this.#opening || this.scheduled || this.destroyed) return;
      this.scheduled = true;
      if (this.#customFs) {
        const customFs = this.#customFs;
        const length = Math.min(size, 64 * 1024, this.end - this.position + 1);
        if (length <= 0) {
          this.scheduled = false;
          this.push(null);
          return;
        }
        const bytes = Buffer.alloc(length);
        if (this.fd === null) {
          this.scheduled = false;
          return;
        }
        customFs.read(this.fd, bytes, 0, length, this.position, (err, count = 0) => {
          this.scheduled = false;
          if (this.destroyed) return;
          if (err) {
            this.destroy(err);
            return;
          }
          this.position += count;
          this.bytesRead += count;
          this.push(count ? bytes.subarray(0, count) : null);
        });
        return;
      }
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.destroyed) return;
        try {
          const length = Math.min(size, 64 * 1024, this.end - this.position + 1);
          if (length <= 0) {
            this.push(null);
            return;
          }
          const bytes = Buffer.alloc(length);
          const count = fs.readSync(this.fd, bytes, 0, length, this.position);
          if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > length)
            throw fault('EPROTO', 'Invalid stream read');
          this.position += count;
          this.bytesRead += count;
          this.push(count ? bytes.subarray(0, count) : null);
        } catch (error) {
          this.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }

    _destroy(error: Error | null, done: (error?: Error | null) => void) {
      if (this.#customFs) {
        const fd = this.fd;
        this.fd = null;
        if (fd === null) {
          done(error);
          return;
        }
        this.#customFs.close(fd, (closeError) => {
          done(error ?? closeError ?? null);
        });
        return;
      }
      try {
        if (this.fd !== null) fs.closeSync(this.fd);
      } catch (closeError) {
        error ??= closeError instanceof Error ? closeError : new Error(String(closeError));
      } finally {
        this.fd = null;
        done(error);
      }
    }
  };
}
