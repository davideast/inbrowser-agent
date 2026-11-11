import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import { Duplex } from 'readable-stream/lib/stream.js';
import { createBrowserHttpClient } from './browser-http';
import { HttpChunks } from './http-chunks';
import { formatHttpAgentName, keepAgentSocketAlive, reuseAgentSocket } from './http-common';
import type { HttpHeaderPolicy } from './http-header-policy';
import { IncomingMessage } from './http-incoming';
import {
  BaseClientRequest,
  assignOutgoingSocket,
  bindClientRequestConstructor,
  markOutgoingHeadersSent,
  setOutgoingHeaderUnchecked,
} from './http-outgoing';
import { DEFAULT_HTTP_RESPONSE_LIMIT } from './http-response-limit';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

const schedule = globalThis.setTimeout.bind(globalThis);
const cancel = globalThis.clearTimeout.bind(globalThis);
type Options = {
  host: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, unknown>;
  agent: Agent;
};
type Connected = (error: Error | null, socket?: Duplex) => void;

export class Agent extends EventEmitter {
  defaultPort = 80;
  protocol = 'http:';
  keepAlive = false;
  keepAliveMsecs = 1000;
  maxSockets = Number.POSITIVE_INFINITY;
  maxFreeSockets = 256;
  maxTotalSockets = Number.POSITIVE_INFINITY;
  freeSockets: Record<string, unknown[]> = Object.create(null);
  sockets: Record<string, unknown[]> = Object.create(null);
  requests: Record<string, unknown[]> = Object.create(null);
  #sockets = new Set<Duplex>();

  constructor(options: unknown = {}) {
    super();
    if (
      !record(options) ||
      Object.keys(options).some((name) => name !== 'keepAlive') ||
      (options.keepAlive !== undefined && options.keepAlive !== false)
    )
      throw fault('ENOSYS', 'Agent supports only nonpersistent custom sockets');
  }

  createConnection(_options: unknown, _done?: Connected): Duplex | undefined {
    throw fault('ENOSYS', 'Default outbound connections are not implemented');
  }

  getName(options: unknown = {}): string {
    return formatHttpAgentName(options);
  }

  keepSocketAlive(socket: unknown): boolean {
    return keepAgentSocketAlive(socket, this.keepAlive, this.keepAliveMsecs);
  }

  reuseSocket(socket: unknown, request: unknown): void {
    reuseAgentSocket(socket, request);
  }

  createSocket(request: BaseClientRequest, options: Options, done: Connected) {
    let settled = false;
    const connected: Connected = (error, socket) => {
      if (settled) return;
      settled = true;
      if (error) return done(error);
      if (!(socket instanceof Duplex))
        return done(fault('EINVAL', 'Agent must supply a Duplex socket'));
      if (request.destroyed) {
        socket.destroy();
        return;
      }
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
      done(null, socket);
    };
    try {
      const socket = this.createConnection(options, connected);
      if (socket) connected(null, socket);
    } catch (error) {
      connected(error instanceof Error ? error : new Error(String(error)));
    }
  }

  addRequest(request: BaseClientRequest, options: Options) {
    this.createSocket(request, options, (error, socket) => {
      if (error) request.destroy(error);
      else if (socket) request.onSocket(socket);
    });
  }

  destroy() {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }
}

class Response extends IncomingMessage {
  constructor(
    statusCode: number,
    statusMessage: string,
    headers: Record<string, string>,
    rawHeaders: string[] = [],
  ) {
    super(null);
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.headers = headers;
    this.rawHeaders = rawHeaders;
    this.trailers = {};
  }
  override _read() {}
}

class SocketClientRequest extends BaseClientRequest {
  #socket?: Duplex;
  #body: Buffer[] = [];
  #size = 0;
  #ready = false;
  #sent = false;
  #responseBytes: Buffer[] = [];
  #responseSize = 0;
  #expectedSize?: number;
  #chunked?: { decoder: HttpChunks; response: Response };
  #ended = false;
  #response?: Response;
  #timer: ReturnType<typeof setTimeout>;
  #release: () => void;

  constructor(
    private options: Options,
    release: () => void,
    callback?: (response: Response) => void,
  ) {
    super({ autoDestroy: false });
    this.#release = release;
    this.method = options.method;
    this.path = options.path;
    this.host = options.host;
    this.protocol = 'http:';
    if (callback) this.once('response', callback);
    for (const [name, value] of Object.entries(options.headers)) this.setHeader(name, value);
    this.#timer = schedule(
      () => this.destroy(fault('ETIMEDOUT', 'HTTP request exceeded 20 seconds')),
      resourceLimits().timers.httpRequestMs,
    );
  }

  override setHeader(name: string, value: unknown) {
    if (this.#sent || this.headersSent)
      throw fault('ERR_HTTP_HEADERS_SENT', 'Request headers already sent');
    if (
      !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) ||
      (typeof value !== 'string' && typeof value !== 'number') ||
      /[\r\n]/.test(String(value))
    )
      throw fault('EINVAL', 'Invalid HTTP header');
    if (name.toLowerCase() === 'connection' && String(value).toLowerCase() !== 'close')
      throw fault('ENOSYS', 'Persistent HTTP connections are not implemented');
    setOutgoingHeaderUnchecked(this, name, String(value));
    return this;
  }

  override _write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void) {
    if (this.#size + chunk.length > resourceLimits().http.clientBodyBytes) {
      // autoDestroy is off: destroying with the error emits it once and closes.
      const error = fault('E2BIG', 'HTTP request body exceeds 8 MiB');
      this.destroy(error);
      return done(error);
    }
    this.#size += chunk.length;
    this.#body.push(Buffer.from(chunk));
    done();
  }

  override _final(done: (error?: Error | null) => void) {
    this.#ready = true;
    this.finished = true;
    try {
      this.#send();
      done();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.destroy(failure);
      done(failure);
    }
  }

  override onSocket(socket: Duplex) {
    this.#socket = socket;
    assignOutgoingSocket(this, socket);
    socket.on('error', (error) => {
      if (!this.destroyed) this.destroy(error);
    });
    socket.on('data', (chunk: unknown) => {
      if (this.destroyed || this.#ended) return;
      if (!(chunk instanceof Uint8Array)) {
        this.destroy(fault('EPROTO', 'Socket returned nonbinary HTTP data'));
        return;
      }
      this.#responseSize += chunk.byteLength;
      if (
        this.#responseSize >
        resourceLimits().http.clientBodyBytes + resourceLimits().http.headerBytes
      ) {
        this.destroy(fault('E2BIG', 'HTTP response exceeds limit'));
        return;
      }
      try {
        if (this.#chunked) {
          const result = this.#chunked.decoder.write(chunk);
          if (result) this.#complete(this.#chunked.response, result.body, result.trailers);
        } else {
          this.#responseBytes.push(Buffer.from(chunk));
          this.#receive(false);
        }
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('end', () => {
      if (this.destroyed || this.#ended) return;
      try {
        this.#receive(true);
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('close', () => {
      if (!this.#ended && !this.destroyed)
        this.destroy(fault('ECONNRESET', 'HTTP socket closed before response completion'));
    });
    this.emit('socket', socket);
    try {
      this.#send();
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #send() {
    if (!this.#ready || !this.#socket || this.#sent || this.destroyed) return;
    const { host, port, method, path } = this.options;
    const currentHeaders = this.getHeaders();
    if (Object.hasOwn(currentHeaders, 'transfer-encoding'))
      throw fault('ENOSYS', 'Chunked request encoding is not implemented');
    const declared =
      currentHeaders['content-length'] !== undefined
        ? String(currentHeaders['content-length'])
        : undefined;
    if (declared !== undefined && Number(declared) !== this.#size)
      throw fault('EINVAL', 'Request content length does not match body');
    const hostVal =
      currentHeaders.host !== undefined
        ? String(currentHeaders.host)
        : `${host}${port === 80 ? '' : ':' + port}`;
    setOutgoingHeaderUnchecked(this, 'host', hostVal);
    setOutgoingHeaderUnchecked(this, 'connection', 'close');
    if (this.#size || declared !== undefined)
      setOutgoingHeaderUnchecked(this, 'content-length', String(this.#size));
    const wireHeaders = this.getHeaders();
    const head =
      `${method} ${path} HTTP/1.1\r\n` +
      Object.entries(wireHeaders)
        .map(([name, value]) => {
          const rendered = Array.isArray(value) ? value.join(', ') : String(value);
          return `${name}: ${rendered}\r\n`;
        })
        .join('') +
      '\r\n';
    if (Buffer.byteLength(head) > resourceLimits().http.headerBytes)
      throw fault('E2BIG', 'HTTP headers exceed 64 KiB');
    this.#sent = true;
    markOutgoingHeadersSent(this, true);
    this.#socket.write(Buffer.concat([Buffer.from(head), ...this.#body]));
    this.#body = [];
  }

  #receive(eof: boolean) {
    if (this.#chunked) throw fault('EPROTO', 'Incomplete chunked HTTP response');
    // Once headers specify the length, avoid repeatedly assembling a growing body.
    if (!eof && this.#expectedSize !== undefined && this.#responseSize < this.#expectedSize) return;
    const bytes = Buffer.concat(this.#responseBytes);
    const boundary = bytes.indexOf('\r\n\r\n');
    const headerBytes = resourceLimits().http.headerBytes;
    if (boundary < 0 && !eof && bytes.length <= headerBytes) return;
    if (boundary < 0 || boundary > headerBytes)
      throw fault('EPROTO', 'Invalid HTTP response headers');
    const lines = bytes.subarray(0, boundary).toString('latin1').split('\r\n');
    const status = /^HTTP\/1\.[01] (\d{3}) (.*)$/.exec(lines.shift() ?? '');
    if (!status) throw fault('EPROTO', 'Invalid HTTP response status');
    const headers: Record<string, string> = Object.create(null);
    const rawHeaders: string[] = [];
    for (const line of lines) {
      const at = line.indexOf(':');
      if (at < 1) throw fault('EPROTO', 'Invalid HTTP response header');
      const rawName = line.slice(0, at);
      const name = rawName.toLowerCase();
      if (name in headers) throw fault('ENOSYS', 'Repeated response headers are not implemented');
      const val = line.slice(at + 1).trim();
      headers[name] = val;
      rawHeaders.push(rawName, val);
    }
    const body = bytes.subarray(boundary + 4);
    if (this.options.method === 'HEAD' || Number(status[1]) === 204 || Number(status[1]) === 304) {
      this.#complete(
        new Response(Number(status[1]), status[2], headers, rawHeaders),
        Buffer.alloc(0),
      );
      return;
    }
    if (headers['transfer-encoding']) {
      if (headers['content-length'] !== undefined)
        throw fault('EPROTO', 'Conflicting HTTP response framing');
      if (headers['transfer-encoding'].toLowerCase() !== 'chunked')
        throw fault('ENOSYS', 'Unsupported HTTP transfer encoding');
      const decoder = new HttpChunks(
        resourceLimits().http.clientBodyBytes,
        resourceLimits().http.headerBytes,
      );
      const response = new Response(Number(status[1]), status[2], headers, rawHeaders);
      this.#chunked = { decoder, response };
      this.#responseBytes = [];
      const result = decoder.write(body);
      if (result) this.#complete(response, result.body, result.trailers);
      else if (eof) throw fault('EPROTO', 'Incomplete chunked HTTP response');
      return;
    }
    const length = headers['content-length'];
    if (length !== undefined && !/^\d+$/.test(length))
      throw fault('EPROTO', 'Invalid response content length');
    const expected = length === undefined ? undefined : Number(length);
    if (
      expected !== undefined &&
      (!Number.isSafeInteger(expected) || expected > resourceLimits().http.clientBodyBytes)
    )
      throw fault('E2BIG', 'HTTP response body exceeds 8 MiB');
    this.#expectedSize =
      expected === undefined ? Number.POSITIVE_INFINITY : boundary + 4 + expected;
    if (!eof && this.#responseSize < this.#expectedSize) return;
    if (body.length > resourceLimits().http.clientBodyBytes)
      throw fault('E2BIG', 'HTTP response body exceeds 8 MiB');
    if (expected !== undefined && expected !== body.length)
      throw fault('EPROTO', 'Incomplete HTTP response body');
    this.#complete(new Response(Number(status[1]), status[2], headers, rawHeaders), body);
  }

  #complete(response: Response, body: Buffer, trailers: Record<string, string> = {}) {
    this.#ended = true;
    this.#responseBytes = [];
    this.#chunked = undefined;
    response.trailers = trailers;
    response.rawTrailers = Object.entries(trailers).flat();
    response.socket = this.#socket ?? null;
    this.#response = response;
    response.once('end', () => this.destroy());
    response.once('close', () => this.destroy());
    response.once('error', (error) => this.destroy(error));
    this.emit('response', response);
    response.push(body);
    response.complete = true;
    response.push(null);
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    cancel(this.#timer);
    this.#socket?.destroy();
    this.#response?.destroy();
    this.#body = [];
    this.#responseBytes = [];
    this.#chunked = undefined;
    this.#release();
    done(error);
  }
}

export function createHttpClient(
  retain: () => void,
  release: () => void,
  fetchAgents = false,
  headerPolicy: HttpHeaderPolicy = {},
  responseLimit = DEFAULT_HTTP_RESPONSE_LIMIT,
) {
  if (fetchAgents)
    return createBrowserHttpClient('http:', retain, release, true, headerPolicy, responseLimit);
  const browser = createBrowserHttpClient(
    'http:',
    retain,
    release,
    false,
    headerPolicy,
    responseLimit,
  );
  const request = (
    input: unknown,
    optionsOrCallback?: unknown,
    maybeCallback?: (response: Response) => void,
  ) => {
    if (typeof input === 'string' || input instanceof URL)
      return browser.request(input, optionsOrCallback, maybeCallback);
    if (optionsOrCallback !== undefined && typeof optionsOrCallback !== 'function')
      throw fault('ENOSYS', 'HTTP request option is not implemented');
    const callback =
      typeof optionsOrCallback === 'function'
        ? (optionsOrCallback as (response: Response) => void)
        : maybeCallback;
    if (!record(input) || !(input.agent instanceof Agent))
      throw fault('ENOSYS', 'HTTP requires a custom socket agent');
    if (
      Object.keys(input).some(
        (name) =>
          !['agent', 'hostname', 'host', 'port', 'path', 'method', 'headers'].includes(name),
      )
    )
      throw fault('ENOSYS', 'HTTP request option is not implemented');
    const host = input.hostname ?? input.host;
    const port = input.port ?? 80;
    const path = input.path ?? '/';
    const method = input.method ?? 'GET';
    if (
      typeof host !== 'string' ||
      !/^[\w.-]+$/.test(host) ||
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      /[\s\0]/.test(path) ||
      typeof method !== 'string' ||
      !/^[A-Z]+$/.test(method) ||
      (input.headers !== undefined && !record(input.headers))
    )
      throw fault('EINVAL', 'Invalid HTTP request options');
    const options: Options = {
      host,
      port,
      path,
      method,
      headers: input.headers ?? {},
      agent: input.agent,
    };
    retain();
    let child: SocketClientRequest;
    try {
      child = new SocketClientRequest(options, release, callback);
    } catch (error) {
      release();
      throw error;
    }
    try {
      options.agent.addRequest(child, options);
    } catch (error) {
      child.destroy(error instanceof Error ? error : new Error(String(error)));
    }
    return child;
  };
  const ClientRequest = bindClientRequestConstructor((input, options, cb) =>
    request(
      input,
      options,
      typeof cb === 'function' ? (cb as (response: Response) => void) : undefined,
    ),
  );
  return {
    Agent,
    ClientRequest,
    request,
    get: (
      input: unknown,
      optionsOrCallback?: unknown,
      maybeCallback?: (response: Response) => void,
    ) => {
      const child = request(input, optionsOrCallback, maybeCallback);
      child.end();
      return child;
    },
  };
}
