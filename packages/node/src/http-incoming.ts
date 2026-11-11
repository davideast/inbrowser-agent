import { Buffer } from 'buffer';
import { Readable } from 'readable-stream/lib/stream.js';
import { PREVIEW_CHUNK_BYTES, type PreviewHeaders } from './preview-stream';
import { record } from './value-guards';

export interface IncomingSocketLike {
  destroy(error?: Error): unknown;
  setTimeout?(msecs: number, callback?: () => void): unknown;
}

export interface HttpRequest {
  id: number;
  port: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The whole body of an upgrade request. A streamed request carries none here. */
  body: Uint8Array;
  /**
   * Streamed requests only: the total body size when the service worker knew
   * it before dispatch, or null when the body arrives as a stream of unknown
   * length. Zero means no body frames and no end frame follow.
   */
  bodyLength?: number | null;
}

/**
 * The guest end of one streamed preview exchange. Every method is a no-op once
 * the exchange has ended, been aborted by the client, or failed.
 */
export interface Exchange {
  /** Request bytes handed to the guest's reader; returns them to the sender as credit. */
  consumed(bytes: number): void;
  head(status: number, headers: PreviewHeaders): void;
  /** `done` runs once the chunk's last frame has been posted inside the window. */
  data(chunk: Uint8Array, done: () => void): void;
  end(): void;
  /** Before the head: a 500 carrying the error. After it: an aborted stream. */
  fail(error?: unknown): void;
}

export const detachedExchange: Exchange = {
  consumed() {},
  head() {},
  data(_chunk, done) {
    done();
  },
  end() {},
  fail() {},
};

const SINGLE_VALUE_HEADERS = new Set([
  'age',
  'authorization',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'from',
  'host',
  'if-modified-since',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'retry-after',
  'server',
  'user-agent',
]);

function foldHeaderLine(
  field: string,
  value: string,
  dest: Record<string, string | string[] | undefined>,
): void {
  const key = field.toLowerCase();
  if (key === 'set-cookie') {
    const cur = dest[key];
    if (Array.isArray(cur)) cur.push(value);
    else dest[key] = [value];
    return;
  }
  if (SINGLE_VALUE_HEADERS.has(key)) {
    if (dest[key] === undefined) dest[key] = value;
    return;
  }
  const existing = dest[key];
  if (typeof existing === 'string') {
    dest[key] = key === 'cookie' ? `${existing}; ${value}` : `${existing}, ${value}`;
  } else if (existing === undefined) {
    dest[key] = value;
  }
}

function foldHeaderLineDistinct(
  field: string,
  value: string,
  dest: Record<string, string[]>,
): void {
  const key = field.toLowerCase();
  const cur = dest[key];
  if (cur) cur.push(value);
  else dest[key] = [value];
}

function isHttpRequestObject(value: unknown): value is HttpRequest {
  return (
    record(value) &&
    typeof value.id === 'number' &&
    typeof value.port === 'number' &&
    typeof value.method === 'string' &&
    typeof value.url === 'string' &&
    record(value.headers) &&
    value.body instanceof Uint8Array
  );
}

export class IncomingMessage extends Readable {
  socket: IncomingSocketLike | null;
  httpVersion: string | null = null;
  httpVersionMajor: number | null = null;
  httpVersionMinor: number | null = null;
  aborted = false;
  complete = false;
  url = '';
  method: string | null = null;
  statusCode: number | null = null;
  statusMessage: string | null = null;
  rawHeaders: string[] = [];
  rawTrailers: string[] = [];

  #headers?: Record<string, string | string[] | undefined>;
  #headersDistinct?: Record<string, string[]>;
  #trailers?: Record<string, string | string[] | undefined>;
  #trailersDistinct?: Record<string, string[]>;
  // Frames received and not yet handed to the Readable. The sender's window
  // bounds it: a frame is credited only when it leaves this queue.
  #queue: Buffer[] = [];
  #wanting = false;
  #received = false;
  #finished = false;
  #dumped = false;
  #endEmitted = false;
  #exchange: Exchange = detachedExchange;

  constructor(
    socketOrRequest?: IncomingSocketLike | HttpRequest | null,
    maybeSocket?: IncomingSocketLike,
    maybeExchange: Exchange = detachedExchange,
  ) {
    super({ highWaterMark: PREVIEW_CHUNK_BYTES });
    if (isHttpRequestObject(socketOrRequest)) {
      this.socket = maybeSocket ?? null;
      this.#initServerRequest(socketOrRequest, maybeExchange);
      return;
    }
    this.socket = socketOrRequest ?? null;
  }

  #initServerRequest(request: HttpRequest, exchange: Exchange): void {
    this.#exchange = exchange;
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.method = request.method;
    this.url = request.url;
    const reqHeaders: Record<string, string> = { ...request.headers };
    const framed = reqHeaders['content-length'] || reqHeaders['transfer-encoding'];
    if (request.bodyLength === undefined) {
      // An upgrade request: whatever body it has is complete on arrival.
      if (request.body.length > 0 && !framed) {
        reqHeaders['content-length'] = String(request.body.length);
      }
      if (request.body.length > 0) this.#queue.push(Buffer.from(request.body));
      this.#received = true;
    } else if (request.bodyLength === null) {
      // A body of unknown length is what HTTP/1.1 carries as chunked.
      if (!framed) reqHeaders['transfer-encoding'] = 'chunked';
    } else {
      if (request.bodyLength > 0 && !framed) {
        reqHeaders['content-length'] = String(request.bodyLength);
      }
      if (request.bodyLength === 0) {
        this.#received = true;
        this.complete = true;
      }
    }
    this.#headers = reqHeaders;
    this.rawHeaders = Object.entries(reqHeaders).flat();
    this.once('end', () => {
      this.#endEmitted = true;
    });
  }

  get connection(): IncomingSocketLike | null {
    return this.socket;
  }

  set connection(value: IncomingSocketLike | null) {
    this.socket = value ?? null;
  }

  get headers(): Record<string, string | string[] | undefined> {
    if (!this.#headers) {
      const built: Record<string, string | string[] | undefined> = {};
      for (let i = 0; i + 1 < this.rawHeaders.length; i += 2) {
        foldHeaderLine(this.rawHeaders[i], this.rawHeaders[i + 1], built);
      }
      this.#headers = built;
    }
    return this.#headers;
  }

  set headers(value: Record<string, string | string[] | undefined>) {
    this.#headers = value;
  }

  get headersDistinct(): Record<string, string[]> {
    if (!this.#headersDistinct) {
      const built: Record<string, string[]> = {};
      for (let i = 0; i + 1 < this.rawHeaders.length; i += 2) {
        foldHeaderLineDistinct(this.rawHeaders[i], this.rawHeaders[i + 1], built);
      }
      this.#headersDistinct = built;
    }
    return this.#headersDistinct;
  }

  set headersDistinct(value: Record<string, string[]>) {
    this.#headersDistinct = value;
  }

  get trailers(): Record<string, string | string[] | undefined> {
    if (!this.#trailers) {
      const built: Record<string, string | string[] | undefined> = {};
      for (let i = 0; i + 1 < this.rawTrailers.length; i += 2) {
        foldHeaderLine(this.rawTrailers[i], this.rawTrailers[i + 1], built);
      }
      this.#trailers = built;
    }
    return this.#trailers;
  }

  set trailers(value: Record<string, string | string[] | undefined>) {
    this.#trailers = value;
  }

  get trailersDistinct(): Record<string, string[]> {
    if (!this.#trailersDistinct) {
      const built: Record<string, string[]> = {};
      for (let i = 0; i + 1 < this.rawTrailers.length; i += 2) {
        foldHeaderLineDistinct(this.rawTrailers[i], this.rawTrailers[i + 1], built);
      }
      this.#trailersDistinct = built;
    }
    return this.#trailersDistinct;
  }

  set trailersDistinct(value: Record<string, string[]>) {
    this.#trailersDistinct = value;
  }

  setTimeout(msecs: number, callback?: () => void): this {
    if (callback) this.on('timeout', callback);
    if (this.socket && typeof this.socket.setTimeout === 'function') {
      this.socket.setTimeout(msecs);
    }
    return this;
  }

  _addHeaderLines(headers: string[], n: number): void {
    if (!headers || headers.length === 0) return;
    const limit = Math.min(headers.length, n);
    for (let i = 0; i < limit; i++) {
      this.rawHeaders.push(headers[i]);
    }
    this.#headers = undefined;
    this.#headersDistinct = undefined;
  }

  _addHeaderLine(
    field: string,
    value: string,
    dest: Record<string, string | string[] | undefined> = this.headers,
  ): void {
    foldHeaderLine(field, value, dest);
  }

  _addHeaderLineDistinct(
    field: string,
    value: string,
    dest: Record<string, string[]> = this.headersDistinct,
  ): void {
    foldHeaderLineDistinct(field, value, dest);
  }

  _dump(): void {
    if (!this.#dumped) {
      this.#dumped = true;
      this.resume();
    }
  }

  override _read(): void {
    this.#wanting = true;
    this.#flow();
  }

  #flow(): void {
    while (this.#wanting && this.#queue.length > 0) {
      const chunk = this.#queue.shift()!;
      this.#exchange.consumed(chunk.length);
      this.#wanting = this.push(chunk);
    }
    if (this.#received && !this.#queue.length && !this.#finished) {
      this.#finished = true;
      this.complete = true;
      this.push(null);
    }
  }

  /** One request body frame from the transport. */
  _receive(bytes: Uint8Array): void {
    if (this.destroyed) {
      // Nobody will read it; return the credit so the sender is not left waiting.
      this.#exchange.consumed(bytes.length);
      return;
    }
    this.#queue.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    this.#flow();
  }

  /** The transport delivered the last request body frame. */
  _receiveEnd(): void {
    this.#received = true;
    this.complete = true;
    if (!this.destroyed) this.#flow();
  }

  /** The client went away before the response finished. */
  _abort(): void {
    this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
  }

  /** The response finished; Node then discards whatever of the request is unread. */
  _finish(): void {
    this.#dumped = true;
    this.destroy();
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.#queue.length = 0;
    // An upgrade request or standalone instance keeps stream defaults.
    if (this.#exchange === detachedExchange) {
      done(error);
      return;
    }
    if (!this.#dumped && (!this.#endEmitted || !this.complete)) {
      this.aborted = true;
      this.emit('aborted');
      // Node destroys the connection under an aborted request, which ends its
      // response too.
      this.socket?.destroy();
    }
    // Node reports the reset only to a request that listens for errors.
    process.nextTick(() => done(error && this.listenerCount('error') > 0 ? error : null));
  }
}
