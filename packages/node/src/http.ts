import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import { message as statusMessages } from 'statuses';
import { Server as NetServer } from './builtins/net';
import { captured } from './context-hook';
import { createHttpClient } from './http-client';
import {
  HTTP_METHODS,
  HTTP_TOKEN_REGEXP,
  MAX_HEADER_SIZE,
  setMaxIdleHTTPParsers,
  validateHeaderName,
  validateHeaderValue,
} from './http-common';
import type { HttpHeaderPolicy } from './http-header-policy';
import {
  type Exchange,
  type HttpRequest,
  IncomingMessage,
  detachedExchange,
} from './http-incoming';
import {
  OutgoingMessage,
  type OutgoingSocketLike,
  assignOutgoingSocket,
  markOutgoingHeadersSent,
  setOutgoingHeaderUnchecked,
} from './http-outgoing';
import { DEFAULT_HTTP_RESPONSE_LIMIT } from './http-response-limit';
import { invalidArgType, validateObject } from './node-errors';
import { PortSocket } from './port-socket';
import {
  FrameSender,
  PREVIEW_CHUNK_BYTES,
  type PreviewHeaders,
  WindowMeter,
  readFrame,
} from './preview-stream';
import type { Syscalls } from './protocol';
import { VERSION, errorRecord, fault } from './protocol';
import { offerUncaught } from './uncaught-hook';

export { HTTP_LIMIT, HTTP_RESPONSE_LIMIT } from './http-limits';
export { IncomingMessage, type HttpRequest };
import { resourceLimits } from './resource-policy';

class VirtualSocket extends EventEmitter {
  remoteAddress = '127.0.0.1';
  writable = true;
  readable = true;
  destroyed = false;
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.readable = false;
    this.emit('close');
  }
}
export class ServerResponse extends OutgoingMessage {
  declare statusCode: number;
  declare statusMessage: string | undefined;
  finished = false;
  sendDate = true;
  strictContentLength = false;
  // Internal state is private by language, not by convention: middleware adds
  // its own properties to responses (compression assigns `flush`), and Node's
  // ServerResponse leaves these names free for it.
  #size = 0;
  // Head frame posted. `headersSent` turns true earlier, at writeHead, as in Node.
  #flushed = false;
  #wrote = false;
  #ending = false;
  #single?: number;
  #disconnected = false;
  #closeEmitted = false;
  #exchange: Exchange;
  constructor(
    readonly req: IncomingMessage,
    exchange: Exchange = detachedExchange,
  ) {
    // Node 22's default highWaterMark. 'close' is emitted by this class so a
    // client disconnect can report it in the same turn, as Node does.
    super({ highWaterMark: PREVIEW_CHUNK_BYTES, autoDestroy: true, emitClose: false });
    this.#exchange = exchange;
    if (exchange !== detachedExchange && req?.socket) {
      assignOutgoingSocket(this, req.socket);
    }
  }
  static {
    this.prototype.statusCode = 200;
    this.prototype.statusMessage = undefined;
    // `writableEnded` follows this response's own end(), as Node's OutgoingMessage does.
    Object.defineProperty(this.prototype, 'writableEnded', {
      configurable: true,
      get(this: ServerResponse) {
        return this.#ending;
      },
    });
  }
  assignSocket(socket: OutgoingSocketLike): void {
    assignOutgoingSocket(this, socket);
    this.emit('socket', socket);
  }
  detachSocket(_socket: OutgoingSocketLike): void {
    assignOutgoingSocket(this, null);
  }
  override setHeader(name: string, value: unknown): this {
    if (this.headersSent) throw fault('ERR_HTTP_HEADERS_SENT', 'Headers already sent');
    if (!HTTP_TOKEN_REGEXP.test(name) || /[\r\n]/.test(String(value)))
      throw fault('ERR_INVALID_HTTP_TOKEN', 'Invalid header');
    setOutgoingHeaderUnchecked(
      this,
      name,
      Array.isArray(value) ? value.map(String) : String(value),
    );
    return this;
  }
  writeContinue(callback?: () => void): void {
    if (typeof callback === 'function') process.nextTick(callback);
  }
  writeProcessing(callback?: () => void): void {
    if (typeof callback === 'function') process.nextTick(callback);
  }
  writeEarlyHints(hints: unknown, callback?: () => void): void {
    validateObject(hints, 'hints');
    if (callback !== undefined && typeof callback !== 'function') {
      throw invalidArgType('cb', 'Function', callback);
    }
    if (callback) process.nextTick(callback);
  }
  writeHead(
    status: number,
    messageOrHeaders?: string | Record<string, string | string[] | number>,
    headers?: Record<string, string | string[] | number>,
  ) {
    if (!Number.isInteger(status) || status < 200 || status > 599)
      throw fault('ENOSYS', 'Preview supports final HTTP statuses 200–599');
    this.statusCode = status;
    if (typeof messageOrHeaders === 'string') this.statusMessage = messageOrHeaders;
    for (const [key, value] of Object.entries(
      headers ??
        (typeof messageOrHeaders === 'object' && messageOrHeaders !== null ? messageOrHeaders : {}),
    ))
      this.setHeader(key, value);
    markOutgoingHeadersSent(this, true);
    return this;
  }
  writeHeader(
    status: number,
    messageOrHeaders?: string | Record<string, string | string[] | number>,
    headers?: Record<string, string | string[] | number>,
  ) {
    return this.writeHead(status, messageOrHeaders, headers);
  }
  _implicitHeader() {
    this.writeHead(this.statusCode);
  }
  override flushHeaders() {
    if (!this.headersSent) this._implicitHeader();
    this.#flush();
  }
  #bodyless() {
    return this.req?.method === 'HEAD' || this.statusCode === 204 || this.statusCode === 304;
  }
  #previewHeaders(): PreviewHeaders {
    const raw = this.getHeaders();
    const out: PreviewHeaders = {};
    for (const key of Object.keys(raw)) {
      const val = raw[key];
      out[key] = Array.isArray(val) ? val.map(String) : String(val);
    }
    return out;
  }
  /** Posts the head frame once, with the framing header Node would have chosen. */
  #flush() {
    markOutgoingHeadersSent(this, true);
    if (this.#flushed) return;
    this.#flushed = true;
    const headers = this.#previewHeaders();
    if (
      !this.#bodyless() &&
      headers['content-length'] === undefined &&
      headers['transfer-encoding'] === undefined
    ) {
      // A response ended in one call has a known length; anything written
      // before its end is a streamed body, which HTTP/1.1 sends chunked.
      if (this.#single !== undefined) headers['content-length'] = String(this.#single);
      else headers['transfer-encoding'] = 'chunked';
    }
    this.#exchange.head(this.statusCode, headers);
  }
  write(
    chunk: unknown,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const done = typeof encoding === 'function' ? encoding : callback;
    if (this.destroyed) {
      // Node reports a write after disconnect to the callback only.
      const error = fault('ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed');
      process.nextTick(() => done?.(error));
      return false;
    }
    this.#wrote = true;
    const length =
      typeof chunk === 'string'
        ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined)
        : chunk instanceof Uint8Array
          ? chunk.length
          : 0;
    // Counted when accepted, not when sent, so a guest that ignores `false`
    // cannot queue more than the budget in its own Writable.
    const limit = resourceLimits().preview.responseBytes;
    if (this.#size + length > limit) {
      this.destroy(
        fault(
          'E2BIG',
          limit % (1024 * 1024) === 0
            ? `HTTP response exceeds ${limit / (1024 * 1024)} MiB`
            : `HTTP response exceeds ${limit} bytes`,
          { limit, actual: this.#size + length },
        ),
      );
      return false;
    }
    this.#size += length;
    // Writable.write accepts (chunk, cb) and (chunk, encoding, cb).
    return (super.write as (...args: unknown[]) => boolean)(chunk, encoding, callback);
  }
  end(...args: unknown[]): this {
    if (!this.#flushed && !this.#wrote && !this.#ending) {
      const chunk = typeof args[0] === 'function' ? undefined : args[0];
      const encoding = typeof args[1] === 'string' ? (args[1] as BufferEncoding) : undefined;
      this.#single =
        typeof chunk === 'string'
          ? Buffer.byteLength(chunk, encoding)
          : chunk instanceof Uint8Array
            ? chunk.length
            : 0;
    }
    // Writable.end accepts (cb), (chunk, cb) and (chunk, encoding, cb). Its chunk
    // bypasses this.write() (Node's Writable writes it internally), so the chunk goes
    // through write() here, where the response budget is counted.
    const callback = args.find((arg) => typeof arg === 'function');
    const chunk = typeof args[0] === 'function' ? undefined : args[0];
    if (chunk !== undefined && chunk !== null)
      this.write(chunk, typeof args[1] === 'string' ? (args[1] as BufferEncoding) : undefined);
    this.#ending = true;
    return (super.end as (...args: unknown[]) => this)(...(callback ? [callback] : []));
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.#flush();
    if (this.#bodyless()) {
      done();
      return;
    }
    this.#exchange.data(chunk, done);
  }
  _final(done: (error?: Error | null) => void) {
    this.#flush();
    this.finished = true;
    this.#exchange.end();
    done();
  }
  /** The client went away: Node closes the response in the same turn. */
  _disconnect() {
    this.#disconnected = true;
    this.destroy();
  }
  _destroy(error: Error | null, done: (error?: Error | null) => void) {
    this.#exchange.fail(error ?? undefined);
    done(error);
    const close = () => {
      if (this.#closeEmitted) return;
      this.#closeEmitted = true;
      this.emit('close');
    };
    if (this.#disconnected) close();
    else process.nextTick(close);
  }
}
export function createHttp(
  sys: Syscalls,
  retain: () => void,
  release: () => void,
  fetchAgents = false,
  headerPolicy: HttpHeaderPolicy = {},
  responseLimit = DEFAULT_HTTP_RESPONSE_LIMIT,
  BaseServerClass: typeof NetServer = NetServer,
) {
  const servers = new Map<number, Server>();
  type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
  class Server extends EventEmitter {
    timeout = 0;
    headersTimeout = 60000;
    keepAliveTimeout = 5000;
    requestTimeout = 300000;
    maxHeadersCount: number | null = null;
    maxRequestsPerSocket = 0;
    #listening = false;
    private port = 0;
    activeRequests = 0;
    private closing = false;
    private closeCallback?: (err?: Error) => void;
    /**
     * Runs connection work in the async context that called listen(), which is
     * where Node dispatches requests from. Identity outside experimental mode.
     */
    enter: (run: () => void) => void = (run) => run();
    constructor(optionsOrListener?: unknown, maybeListener?: RequestListener) {
      super();
      if (typeof optionsOrListener === 'function') {
        this.on('request', (...args: unknown[]) => {
          Reflect.apply(optionsOrListener, this, args);
        });
      } else {
        if (optionsOrListener !== undefined) {
          validateObject(optionsOrListener, 'options');
        }
        if (typeof maybeListener === 'function') {
          this.on('request', maybeListener);
        }
      }
    }
    get listening(): boolean {
      return this.#listening;
    }
    listen(port: number, ...args: unknown[]) {
      if (this.#listening || this.closing)
        throw fault('ERR_SERVER_ALREADY_LISTEN', 'Server is already listening');
      const result = sys.call('listen', [port]);
      if (typeof result !== 'number') throw fault('EPROTO', 'Invalid port reply');
      this.port = result;
      this.#listening = true;
      servers.set(result, this);
      this.enter = captured((run: () => void) => run());
      retain();
      const callback = args.find((arg) => typeof arg === 'function');
      queueMicrotask(() => {
        this.emit('listening');
        if (typeof callback === 'function') callback();
      });
      return this;
    }
    address() {
      return this.#listening ? { address: '127.0.0.1', family: 'IPv4', port: this.port } : null;
    }
    close(callback?: (err?: Error) => void) {
      if (!this.#listening) throw fault('ERR_SERVER_NOT_RUNNING', 'Server is not running');
      sys.call('closeServer', [this.port]);
      servers.delete(this.port);
      this.#listening = false;
      this.closing = true;
      this.closeCallback = callback;
      this.maybeClose();
      return this;
    }
    setTimeout(msecs = 0, callback?: () => void): this {
      this.timeout = msecs;
      if (typeof callback === 'function') {
        this.on('timeout', callback);
      }
      return this;
    }
    closeAllConnections(): void {}
    closeIdleConnections(): void {}
    async [Symbol.asyncDispose](): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        this.close((err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    maybeClose() {
      if (!this.closing || this.activeRequests !== 0) return;
      this.closing = false;
      const callback = this.closeCallback;
      this.closeCallback = undefined;
      release();
      queueMicrotask(() => {
        this.emit('close');
        callback?.();
      });
    }
  }
  Object.defineProperty(Server, 'name', { configurable: true, value: 'Server' });
  Object.setPrototypeOf(Server.prototype, BaseServerClass.prototype);
  Object.setPrototypeOf(Server, BaseServerClass);
  /**
   * Serves one preview request over its own port. The guest holds at most one
   * request window of unread frames and has at most one response window of
   * posted frames outstanding; see docs/reference/architecture.md, "Preview HTTP".
   */
  function dispatch(request: HttpRequest, port: MessagePort) {
    const limits = resourceLimits().preview;
    const post = (frame: Record<string, unknown>, transfer: Transferable[] = []) =>
      port.postMessage({ version: VERSION, ...frame }, transfer);
    const reply = (status: number, text: string) => {
      post({ type: 'head', status, headers: {} });
      const bytes = new TextEncoder().encode(text).slice(0, PREVIEW_CHUNK_BYTES);
      if (bytes.length) post({ type: 'data', bytes });
      post({ type: 'end' });
    };
    const server = servers.get(request.port);
    if (!server) {
      reply(503, 'Server closed');
      port.close();
      return;
    }
    server.activeRequests++;
    let open = true;
    let flushed = false;
    let requestEnded = request.bodyLength === 0;
    const inbound = new WindowMeter(limits.requestWindowBytes);
    const outbound = new FrameSender(limits.responseWindowBytes, (bytes) =>
      post({ type: 'data', bytes }, [bytes.buffer]),
    );
    const close = () => {
      if (!open) return false;
      open = false;
      outbound.close();
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
      server.activeRequests--;
      server.maybeClose();
      return true;
    };
    const exchange: Exchange = {
      consumed(bytes) {
        if (!open || !inbound.remove(bytes)) return;
        post({ type: 'credit', bytes });
      },
      head(status, headers) {
        if (!open) return;
        flushed = true;
        post({ type: 'head', status, headers });
      },
      data(chunk, done) {
        if (!open) done();
        else outbound.send(chunk, done);
      },
      end() {
        if (!open) return;
        post({ type: 'end' });
        close();
      },
      fail(error) {
        if (!open) return;
        if (!flushed && error !== undefined) reply(500, String(error));
        else post({ type: 'abort', ...(error !== undefined ? { error: errorRecord(error) } : {}) });
        close();
      },
    };
    const socket = new VirtualSocket();
    const req = new IncomingMessage(request, socket, exchange);
    const res = new ServerResponse(req, exchange);
    const disconnect = (notify: boolean) => {
      if (!open) return;
      if (notify) post({ type: 'abort' });
      close();
      req._abort();
      res._disconnect();
      socket.destroy();
    };
    const enter = server.enter;
    const receive = (event: MessageEvent<unknown>) => {
      const frame = readFrame(event.data);
      if (frame?.type === 'data' && !requestEnded && inbound.add(frame.bytes.length)) {
        req._receive(frame.bytes);
        return;
      }
      if (frame?.type === 'end' && !requestEnded) {
        requestEnded = true;
        req._receiveEnd();
        return;
      }
      if (frame?.type === 'credit' && outbound.credit(frame.bytes)) return;
      // The client aborted, or the peer broke the protocol: either way the
      // connection is gone and the guest sees a disconnect.
      disconnect(frame?.type !== 'abort');
    };
    port.onmessage = (event: MessageEvent<unknown>) => enter(() => receive(event));
    port.onmessageerror = () => enter(() => disconnect(true));
    // A guest that destroys the connection ends the exchange, as in Node.
    socket.once('close', () => {
      exchange.fail();
      res._disconnect();
    });
    res.on('error', (error) => exchange.fail(error));
    res.once('close', () => req._finish());
    enter(() => {
      try {
        server.emit('request', req, res);
      } catch (error) {
        // Node raises a handler's throw as an uncaught exception and leaves the
        // exchange open. With no consumer it is fatal, as in Node: the rethrow
        // reaches the Worker's error event and the process ends, which ends the
        // exchange the way any guest exit does.
        if (!offerUncaught(error)) throw error;
      }
    });
  }
  const client = createHttpClient(retain, release, fetchAgents, headerPolicy, responseLimit);
  let currentGlobalAgent: unknown = new client.Agent();
  const httpModule = {
    Server,
    IncomingMessage,
    OutgoingMessage,
    ServerResponse,
    STATUS_CODES: { ...statusMessages },
    METHODS: [...HTTP_METHODS],
    createServer: (optionsOrListener?: unknown, maybeListener?: RequestListener) =>
      new Server(optionsOrListener, maybeListener),
    setMaxIdleHTTPParsers,
    validateHeaderName,
    validateHeaderValue,
    ...client,
    maxHeaderSize: MAX_HEADER_SIZE,
    globalAgent: currentGlobalAgent,
  };
  Reflect.deleteProperty(httpModule, 'maxHeaderSize');
  Object.defineProperty(httpModule, 'maxHeaderSize', {
    get: () => MAX_HEADER_SIZE,
    enumerable: true,
    configurable: true,
  });
  Reflect.deleteProperty(httpModule, 'globalAgent');
  Object.defineProperty(httpModule, 'globalAgent', {
    get: () => currentGlobalAgent,
    set: (value: unknown) => {
      currentGlobalAgent = value;
    },
    enumerable: true,
    configurable: true,
  });
  return {
    dispatch,
    upgrade(request: HttpRequest, port: MessagePort) {
      const socket = new PortSocket(port);
      socket.on('error', () => {});
      const server = servers.get(request.port);
      if (!server || server.listenerCount('upgrade') === 0) {
        socket.destroy(fault('ECONNREFUSED', 'No upgrade listener'));
        return;
      }
      retain();
      socket.once('close', release);
      server.enter(() => {
        try {
          server.emit('upgrade', new IncomingMessage(request, socket), socket, Buffer.alloc(0));
        } catch (error) {
          // As for a request listener: with no consumer the throw is fatal.
          if (!offerUncaught(error)) throw error;
          socket.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    module: httpModule,
  };
}
