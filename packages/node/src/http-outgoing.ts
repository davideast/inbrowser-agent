import { Writable } from 'readable-stream/lib/stream.js';
import { INVALID_HEADER_CHAR_REGEXP, validateHeaderName, validateHeaderValue } from './http-common';
import { invalidArgType, nodeError, validateObject } from './node-errors';
import { record } from './value-guards';

export interface OutgoingSocketLike {
  destroy?(error?: Error): unknown;
  setTimeout?(msecs: number, callback?: () => void): unknown;
  setNoDelay?(noDelay?: boolean): unknown;
  setKeepAlive?(enable?: boolean, initialDelay?: number): unknown;
  ref?(): unknown;
  unref?(): unknown;
}

interface StoredHeader {
  name: string;
  value: unknown;
}

export let markOutgoingHeadersSent: (target: OutgoingMessage, sent?: boolean) => void;
export let assignOutgoingSocket: (
  target: OutgoingMessage,
  socket: OutgoingSocketLike | null,
) => void;
export let setOutgoingHeaderUnchecked: (
  target: OutgoingMessage,
  name: string,
  value: unknown,
) => void;

function isHeadersOrMap(headers: unknown): headers is Iterable<readonly [unknown, unknown]> & {
  keys: CallableFunction;
  get: CallableFunction;
} {
  return (
    record(headers) &&
    !Array.isArray(headers) &&
    typeof headers.keys === 'function' &&
    typeof headers.get === 'function' &&
    typeof Reflect.get(headers, Symbol.iterator) === 'function'
  );
}

export class OutgoingMessage extends Writable {
  readonly #headers = new Map<string, StoredHeader>();
  #headersSent = false;
  #socket: OutgoingSocketLike | null = null;

  static {
    markOutgoingHeadersSent = (target: OutgoingMessage, sent = true) => {
      target.#headersSent = sent;
    };
    assignOutgoingSocket = (target: OutgoingMessage, socket: OutgoingSocketLike | null) => {
      target.#socket = socket;
    };
    setOutgoingHeaderUnchecked = (target: OutgoingMessage, name: string, value: unknown) => {
      target.#headers.set(name.toLowerCase(), { name, value });
    };
  }

  constructor(options?: Record<string, unknown>) {
    super(options);
  }

  get headersSent(): boolean {
    return this.#headersSent;
  }

  get socket(): OutgoingSocketLike | null {
    return this.#socket;
  }

  set socket(value: OutgoingSocketLike | null) {
    this.#socket = value ?? null;
  }

  get connection(): OutgoingSocketLike | null {
    return this.#socket;
  }

  set connection(value: OutgoingSocketLike | null) {
    this.#socket = value ?? null;
  }

  setHeader(name: string, value: unknown): this {
    if (this.#headersSent) {
      throw nodeError(
        Error,
        'ERR_HTTP_HEADERS_SENT',
        'Cannot set headers after they are sent to the client',
      );
    }
    validateHeaderName(name);
    validateHeaderValue(name, value);
    this.#headers.set(name.toLowerCase(), { name, value });
    return this;
  }

  setHeaders(headers: unknown): this {
    if (this.#headersSent) {
      throw nodeError(
        Error,
        'ERR_HTTP_HEADERS_SENT',
        'Cannot set headers after they are sent to the client',
      );
    }
    if (!isHeadersOrMap(headers)) {
      throw invalidArgType('headers', ['Headers', 'Map'], headers);
    }
    const cookies: unknown[] = [];
    for (const entry of headers) {
      const key = String(entry[0]);
      const val = entry[1];
      if (key === 'set-cookie') {
        if (Array.isArray(val)) {
          cookies.push(...val);
        } else {
          cookies.push(val);
        }
        continue;
      }
      this.setHeader(key, val);
    }
    if (cookies.length > 0) {
      this.setHeader('set-cookie', cookies);
    }
    return this;
  }

  appendHeader(name: string, value: unknown): this {
    if (this.headersSent) {
      throw nodeError(
        Error,
        'ERR_HTTP_HEADERS_SENT',
        'Cannot append headers after they are sent to the client',
      );
    }
    validateHeaderName(name);
    validateHeaderValue(name, value);
    const existing = this.getHeader(name);
    if (existing === undefined) {
      return this.setHeader(name, value);
    }
    const lower = name.toLowerCase();
    const names = this.getHeaderNames();
    const rawNames = this.getRawHeaderNames();
    const index = names.indexOf(lower);
    const canonicalName = index >= 0 ? rawNames[index] : name;
    const prior = Array.isArray(existing) ? existing.map(String) : [String(existing)];
    const incoming = Array.isArray(value) ? value.map(String) : [String(value)];
    return this.setHeader(canonicalName, [...prior, ...incoming]);
  }

  getHeader(name: string): unknown {
    if (typeof name !== 'string') throw invalidArgType('name', 'string', name);
    return this.#headers.get(name.toLowerCase())?.value;
  }

  getHeaders(): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of this.#headers) {
      out[key] = entry.value;
    }
    return out;
  }

  getHeaderNames(): string[] {
    return [...this.#headers.keys()];
  }

  getRawHeaderNames(): string[] {
    const out: string[] = [];
    for (const entry of this.#headers.values()) {
      out.push(entry.name);
    }
    return out;
  }

  hasHeader(name: string): boolean {
    if (typeof name !== 'string') throw invalidArgType('name', 'string', name);
    return this.#headers.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    if (typeof name !== 'string') throw invalidArgType('name', 'string', name);
    if (this.#headersSent) {
      throw nodeError(
        Error,
        'ERR_HTTP_HEADERS_SENT',
        'Cannot remove headers after they are sent to the client',
      );
    }
    this.#headers.delete(name.toLowerCase());
  }

  flushHeaders(): void {
    this.#headersSent = true;
  }

  addTrailers(headers: unknown): void {
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (!Array.isArray(pair) || pair.length < 2) {
          throw invalidArgType('headers', ['Object', 'Array'], headers);
        }
        const key = String(pair[0]);
        const val = String(pair[1]);
        validateHeaderName(key, 'Trailer name');
        if (INVALID_HEADER_CHAR_REGEXP.test(val)) {
          throw nodeError(
            TypeError,
            'ERR_INVALID_CHAR',
            `Invalid character in trailer content ["${key}"]`,
          );
        }
      }
      return;
    }
    validateObject(headers, 'headers');
    if (record(headers)) {
      for (const key of Object.keys(headers)) {
        validateHeaderName(key, 'Trailer name');
        const val = String(headers[key]);
        if (INVALID_HEADER_CHAR_REGEXP.test(val)) {
          throw nodeError(
            TypeError,
            'ERR_INVALID_CHAR',
            `Invalid character in trailer content ["${key}"]`,
          );
        }
      }
    }
  }

  setTimeout(msecs: number, callback?: () => void): this {
    if (callback) {
      this.once('timeout', callback);
    }
    if (this.#socket && typeof this.#socket.setTimeout === 'function') {
      this.#socket.setTimeout(msecs);
    } else {
      this.once('socket', (sock: unknown) => {
        if (record(sock) && typeof sock.setTimeout === 'function') {
          Reflect.apply(sock.setTimeout, sock, [msecs]);
        }
      });
    }
    return this;
  }

  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#headersSent = true;
    callback();
  }
}

export class BaseClientRequest extends OutgoingMessage {
  aborted = false;
  finished = false;
  maxHeadersCount: number | null = null;
  reusedSocket = false;
  method = 'GET';
  path = '/';
  host = 'localhost';
  protocol = 'http:';

  constructor(options?: Record<string, unknown>) {
    super(options);
  }

  abort(): void {
    if (!this.aborted) {
      this.aborted = true;
      this.emit('abort');
    }
    this.destroy();
  }

  override destroy(error?: Error): this {
    super.destroy(error);
    return this;
  }

  setNoDelay(noDelay = true): void {
    const sock = this.socket;
    if (sock && typeof sock.setNoDelay === 'function') {
      sock.setNoDelay(noDelay);
    } else {
      this.once('socket', (attached: unknown) => {
        if (record(attached) && typeof attached.setNoDelay === 'function') {
          Reflect.apply(attached.setNoDelay, attached, [noDelay]);
        }
      });
    }
  }

  setSocketKeepAlive(enable = false, initialDelay = 0): void {
    const sock = this.socket;
    if (sock && typeof sock.setKeepAlive === 'function') {
      sock.setKeepAlive(enable, initialDelay);
    } else {
      this.once('socket', (attached: unknown) => {
        if (record(attached) && typeof attached.setKeepAlive === 'function') {
          Reflect.apply(attached.setKeepAlive, attached, [enable, initialDelay]);
        }
      });
    }
  }

  override setTimeout(msecs: number, callback?: () => void): this {
    return super.setTimeout(msecs, callback);
  }

  clearTimeout(callback?: () => void): void {
    this.setTimeout(0, callback);
  }

  onSocket(socket: OutgoingSocketLike): void {
    assignOutgoingSocket(this, socket);
    this.emit('socket', socket);
  }
}

export type ClientRequestConstructor = {
  new (input: unknown, options?: unknown, callback?: unknown): BaseClientRequest;
  prototype: BaseClientRequest;
};

export function bindClientRequestConstructor(
  requestFn: (input: unknown, options?: unknown, callback?: unknown) => BaseClientRequest,
): ClientRequestConstructor {
  const ClientRequest = function ClientRequest(
    this: unknown,
    input: unknown,
    options?: unknown,
    callback?: unknown,
  ) {
    return requestFn(input, options, callback);
  };
  ClientRequest.prototype = BaseClientRequest.prototype;
  Object.setPrototypeOf(ClientRequest, OutgoingMessage);
  // Safe narrowing: ClientRequest is a non-arrow function with prototype = BaseClientRequest.prototype.
  return ClientRequest as unknown as ClientRequestConstructor;
}
