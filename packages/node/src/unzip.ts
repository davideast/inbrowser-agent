import { Buffer } from 'buffer';
import {
  ZStream,
  Z_BUF_ERROR,
  Z_FINISH,
  Z_NO_FLUSH,
  Z_OK,
  Z_STREAM_END,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateInit2,
} from 'pako';
import browserProcess from 'process/browser';
import { Transform } from 'readable-stream/lib/stream.js';
import { fault, record } from './protocol';
import { DEFAULT_UNZIP_LIMIT } from './unzip-limit';

/** Synchronous zlib/gzip decoding, including the handle seam used by minizlib. */
export function createUnzipClass(retain: () => () => void, limit = DEFAULT_UNZIP_LIMIT) {
  return class Unzip extends Transform {
    #stream = new ZStream();
    #closed = false;
    #closeEmitted = false;
    #ended = false;
    #input = 0;
    #output = 0;
    // minizlib temporarily replaces close and restores this handle after each call.
    // This handle owns the actual decoder state, not an unrelated dummy resource.
    _handle = { close: () => this.#closeDecoder() };

    constructor(options: unknown = {}) {
      super({ autoDestroy: true });
      this.once('close', () => {
        this.#closeEmitted = true;
      });
      if (!record(options)) throw fault('EINVAL', 'Unzip options must be a record');
      for (const [key, value] of Object.entries(options)) {
        if (
          !(
            (key === 'flush' && value === 0) ||
            (key === 'finishFlush' && value === 4) ||
            (key === 'fullFlushFlag' && value === 3)
          )
        )
          throw fault('ENOSYS', `Unzip option ${key} is not supported`);
      }
      if (zlibInflateInit2(this.#stream, 47) !== Z_OK)
        throw fault('EIO', 'Unable to initialize Unzip');
    }

    #closeDecoder() {
      if (this.#closed) return;
      this.#closed = true;
      zlibInflateEnd(this.#stream);
      this.#stream.input = new Uint8Array(0);
      this.#stream.output = new Uint8Array(0);
    }

    close(callback?: () => void) {
      if (callback) {
        if (this.#closeEmitted) queueMicrotask(callback);
        else this.once('close', callback);
      }
      this.destroy();
    }

    _processChunk(input: unknown, flush: unknown): Buffer {
      try {
        return this.#decode(input, flush);
      } catch (error) {
        this.#closeDecoder();
        throw error;
      } finally {
        // Decoder history lives in its sliding window; caller input and emitted
        // chunks must not stay retained by an idle decoder.
        this.#stream.input = new Uint8Array(0);
        this.#stream.output = new Uint8Array(0);
      }
    }

    #decode(input: unknown, flush: unknown): Buffer {
      if (!(input instanceof Uint8Array)) throw fault('EINVAL', 'Unzip input must be bytes');
      if (flush !== Z_NO_FLUSH && flush !== Z_FINISH)
        throw fault('ENOSYS', 'Unzip flush mode is not supported');
      if (this.#closed) throw fault('ERR_STREAM_DESTROYED', 'Unzip is closed');
      this.#input += input.byteLength;
      if (this.#input > limit) throw fault('E2BIG', `Unzip input exceeds ${limit} bytes`);
      if (this.#ended) {
        if (input.length) throw fault('ENOSYS', 'Additional compressed members are not supported');
        return Buffer.alloc(0);
      }
      const stream = this.#stream;
      stream.input = input;
      stream.next_in = 0;
      stream.avail_in = input.length;
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        stream.output = new Uint8Array(16384);
        stream.next_out = 0;
        stream.avail_out = stream.output.length;
        const status = zlibInflate(stream, flush);
        this.#output += stream.next_out;
        if (this.#output > limit) throw fault('E2BIG', `Unzip output exceeds ${limit} bytes`);
        if (status !== Z_OK && status !== Z_BUF_ERROR && status !== Z_STREAM_END)
          throw Object.assign(new Error(stream.msg || 'Invalid compressed data'), {
            code: status === 2 ? 'Z_NEED_DICT' : 'Z_DATA_ERROR',
            errno: status,
          });
        chunks.push(Buffer.from(stream.output.subarray(0, stream.next_out)));
        total += stream.next_out;
        if (status === Z_STREAM_END) {
          this.#ended = true;
          if (stream.avail_in)
            throw fault('ENOSYS', 'Additional compressed members are not supported');
          break;
        }
        if (stream.avail_out === 0) continue;
        if (flush === Z_FINISH)
          throw Object.assign(new Error('unexpected end of file'), {
            code: 'Z_BUF_ERROR',
            errno: -5,
          });
        break;
      }
      // minizlib temporarily replaces Buffer.concat globally; avoid relying on it.
      const result = Buffer.allocUnsafe(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    }

    override _transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      done: (error?: Error | null) => void,
    ) {
      try {
        this.push(this._processChunk(chunk, Z_NO_FLUSH));
        done();
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    }

    override _flush(done: (error?: Error | null) => void) {
      const release = retain();
      try {
        this.push(this._processChunk(Buffer.alloc(0), Z_FINISH));
        this.#closeDecoder();
        done();
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
        done();
      } finally {
        // Drain the stream library's completion queue, including nested ticks,
        // without requiring the caller to consume buffered readable output.
        browserProcess.nextTick(() => queueMicrotask(release));
      }
    }

    override _destroy(error: Error | null, done: (error?: Error | null) => void) {
      const release = retain();
      this.once('close', release);
      this.#closeDecoder();
      done(error);
    }
  };
}
