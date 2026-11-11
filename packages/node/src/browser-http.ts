import { Buffer } from 'buffer';
import { message as statusMessages } from 'statuses';
import { BrowserAgent, HttpsAgent, TLS_CONTROLS } from './browser-agent';
import { HTTP_TOKEN_REGEXP, INVALID_HEADER_CHAR_REGEXP } from './http-common';
import type { HttpHeaderPolicy } from './http-header-policy';
import { IncomingMessage } from './http-incoming';
import {
  BaseClientRequest,
  bindClientRequestConstructor,
  markOutgoingHeadersSent,
} from './http-outgoing';
import { DEFAULT_HTTP_RESPONSE_LIMIT } from './http-response-limit';
import { abortError, invalidArgType, nodeError } from './node-errors';
import { fault, record } from './protocol';
import { httpEgressPolicy, matchesHttpEgressTarget, resourceLimits } from './resource-policy';
import { urlToHttpOptions } from './url-http-options';

// Capture browser facilities before guest globals are installed in this Worker.
const browserFetch = globalThis.fetch.bind(globalThis);
const schedule = globalThis.setTimeout.bind(globalThis);
const cancel = globalThis.clearTimeout.bind(globalThis);

const HTTP_TOKEN = HTTP_TOKEN_REGEXP;
const INVALID_HEADER_CHAR = INVALID_HEADER_CHAR_REGEXP;
const INVALID_PATH_CHAR = /[^\u0021-\u00ff]/;
const FETCH_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const ALLOWED_FETCH_OPTIONS = new Set([
  'protocol',
  'hostname',
  'host',
  'port',
  'defaultPort',
  'path',
  'pathname',
  'search',
  'hash',
  'href',
  'agent',
  'method',
  'headers',
  'auth',
  'rejectUnauthorized',
  'timeout',
  'signal',
  'setHost',
]);
const FORBIDDEN_HEADERS = new Set([
  'accept-charset',
  'access-control-request-headers',
  'access-control-request-method',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'keep-alive',
  'origin',
  'permissions-policy',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
]);

function safeParseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch (error) {
    if (error instanceof TypeError && !('code' in error))
      Object.assign(error, { code: 'ERR_INVALID_URL' });
    throw error;
  }
}

function matchesTargetHost(protocol: string, wireValue: string, expectedHost: string): boolean {
  if (!/^[\w.:[\]-]+$/.test(wireValue)) return false;
  try {
    return new URL(`${protocol}//${wireValue}`).host === expectedHost;
  } catch {
    return false;
  }
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function assertHttpEgressAllowed(url: URL): void {
  const egress = httpEgressPolicy();
  if (!egress) return;
  if (!matchesHttpEgressTarget(egress, url))
    throw fault('EACCES', `Outbound HTTP egress to ${url.origin} is blocked by container policy`, {
      kind: 'unsupported',
    });
}

function validateHeaderNameAndValue(
  name: unknown,
  value: unknown,
): { validName: string; storedValue: unknown; wireValue: string } {
  if (typeof name !== 'string') throw invalidArgType('name', 'string', name);
  if (!HTTP_TOKEN.test(name))
    throw nodeError(
      TypeError,
      'ERR_INVALID_HTTP_TOKEN',
      `Header name must be a valid HTTP token ["${name}"]`,
    );
  if (value === undefined)
    throw nodeError(
      TypeError,
      'ERR_HTTP_INVALID_HEADER_VALUE',
      `Invalid value "undefined" for header "${name}"`,
    );
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const str = String(item);
      if (INVALID_HEADER_CHAR.test(str))
        throw nodeError(
          TypeError,
          'ERR_INVALID_CHAR',
          `Invalid character in header content ["${name}"]`,
        );
      parts.push(str);
    }
    return { validName: name, storedValue: value, wireValue: parts.join(', ') };
  }
  const wireValue = String(value);
  if (INVALID_HEADER_CHAR.test(wireValue))
    throw nodeError(
      TypeError,
      'ERR_INVALID_CHAR',
      `Invalid character in header content ["${name}"]`,
    );
  return { validName: name, storedValue: value, wireValue };
}

function parseContentLength(wireValue: string, bodyLimit: number): number {
  const text = wireValue.trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw fault('EINVAL', 'Invalid Content-Length header');
  const declared = Number(text);
  if (declared > bodyLimit)
    throw fault('E2BIG', `Browser HTTP request body exceeds ${bodyLimit} bytes`, {
      limit: bodyLimit,
      actual: declared,
    });
  return declared;
}

function validateInitialHeaders(
  headers: Record<string, unknown>,
  allowBody: boolean,
  bodyLimit: number,
): void {
  for (const key of Object.keys(headers)) {
    const { wireValue } = validateHeaderNameAndValue(key, headers[key]);
    if (allowBody && key.toLowerCase() === 'content-length')
      parseContentLength(wireValue, bodyLimit);
  }
}

class BrowserResponse extends IncomingMessage {
  constructor(
    statusCode: number,
    statusMessage: string,
    headers: Record<string, string>,
    rawHeaders: string[],
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
    this.rawTrailers = [];
  }

  override _read() {}

  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    if (!this.complete) this.aborted = true;
    done(error);
  }
}

export class BrowserRequest extends BaseClientRequest {
  #ready = false;
  #allowed = false;
  #sent = false;
  readonly #allowBody: boolean;
  readonly #bodyLimit: number;
  readonly #body: Buffer[] = [];
  #size = 0;
  #expectedLength?: number;
  readonly #headers = new Headers();
  readonly #storedHeaders = new Map<string, { name: string; value: unknown }>();
  readonly #controller = new AbortController();
  #timeout: number;
  #timer?: ReturnType<typeof setTimeout>;
  #reader?: ReadableStreamDefaultReader<Uint8Array>;
  #response?: BrowserResponse;

  constructor(
    private readonly url: URL,
    release: () => void,
    callback?: (response: BrowserResponse) => void,
    timeout = resourceLimits().timers.httpRequestMs,
    private readonly omitHeaders: readonly string[] = [],
    private readonly responseLimit = DEFAULT_HTTP_RESPONSE_LIMIT,
    method = 'GET',
    allowBody = false,
    hostProperty = stripIpv6Brackets(url.hostname),
  ) {
    super({ autoDestroy: false });
    this.method = method;
    this.path = url.pathname + url.search;
    this.host = hostProperty;
    this.protocol = url.protocol;
    this.#allowBody = allowBody;
    this.#timeout = timeout;
    this.#bodyLimit = resourceLimits().http.clientBodyBytes;
    if (callback) this.once('response', callback);
    // The stream's error/close delivery is asynchronous and still owns the process.
    this.once('close', release);
  }

  get origin() {
    return this.url.origin;
  }

  override get headersSent() {
    return this.#sent;
  }

  #scheduleTimeout(msecs: number) {
    const cap = resourceLimits().timers.httpRequestMs;
    const bounded = msecs > 0 ? Math.min(cap, msecs) : cap;
    return schedule(() => {
      this.emit('timeout');
      if (!this.destroyed)
        this.destroy(fault('ETIMEDOUT', `Browser HTTP request exceeded ${bounded} milliseconds`));
    }, bounded);
  }

  setTimeout(msecs: number, callback?: () => void) {
    if (typeof msecs !== 'number' || !Number.isFinite(msecs) || msecs < 0)
      throw fault('EINVAL', 'Invalid HTTP timeout');
    if (callback !== undefined) {
      if (typeof callback !== 'function') throw invalidArgType('callback', 'Function', callback);
      this.once('timeout', callback);
    }
    const cap = resourceLimits().timers.httpRequestMs;
    this.#timeout = msecs > 0 ? Math.min(cap, msecs) : cap;
    if (!this.destroyed && this.#allowed) {
      if (this.#timer !== undefined) cancel(this.#timer);
      this.#timer = this.#scheduleTimeout(this.#timeout);
    }
    return this;
  }

  setHeader(name: string, value: unknown) {
    if (this.#sent) throw fault('ERR_HTTP_HEADERS_SENT', 'Request headers already sent');
    const { validName, storedValue, wireValue } = validateHeaderNameAndValue(name, value);
    const lower = validName.toLowerCase();
    if (lower === 'host') {
      if (!matchesTargetHost(this.url.protocol, wireValue, this.url.host))
        throw fault('ENOSYS', 'Host header override is unsupported');
      this.#storedHeaders.set('host', { name: validName, value: storedValue });
      return this;
    }
    if (lower === 'content-length') {
      if (!this.#allowBody) {
        if (wireValue !== '0')
          throw fault('ENOSYS', 'Bodyless GET/HEAD cannot declare content bytes');
        this.#storedHeaders.set('content-length', { name: validName, value: storedValue });
        return this;
      }
      this.#expectedLength = parseContentLength(wireValue, this.#bodyLimit);
      this.#storedHeaders.set('content-length', { name: validName, value: storedValue });
      return this;
    }
    // Browser-owned framing, compression negotiation and physical pooling.
    if (lower === 'accept-encoding') {
      this.#storedHeaders.set('accept-encoding', { name: validName, value: storedValue });
      return this;
    }
    if (lower === 'connection') {
      if (!['close', 'keep-alive'].includes(wireValue.toLowerCase()))
        throw fault('ENOSYS', 'HTTP connection upgrade is unsupported');
      this.#storedHeaders.set('connection', { name: validName, value: storedValue });
      return this;
    }
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-'))
      throw fault('ENOSYS', `Browser-owned header ${validName} cannot be overridden`);
    this.#storedHeaders.set(lower, { name: validName, value: storedValue });
    if (!this.omitHeaders.includes(lower)) this.#headers.set(validName, wireValue);
    return this;
  }

  getHeader(name: string): unknown {
    if (typeof name !== 'string') throw invalidArgType('name', 'string', name);
    return this.#storedHeaders.get(name.toLowerCase())?.value;
  }

  getHeaders(): Record<string, unknown> {
    // Object.create(null) matches Node's null-prototype header snapshot.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of this.#storedHeaders) out[key] = entry.value;
    return out;
  }

  getHeaderNames(): string[] {
    return [...this.#storedHeaders.keys()];
  }

  getRawHeaderNames(): string[] {
    return [...this.#storedHeaders.values()].map((entry) => entry.name);
  }

  hasHeader(name: string): boolean {
    if (typeof name !== 'string') throw invalidArgType('name', 'string', name);
    return this.#storedHeaders.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    if (typeof name !== 'string') throw invalidArgType('name', 'string', name);
    if (this.#sent)
      throw fault('ERR_HTTP_HEADERS_SENT', 'Cannot remove headers after they are sent');
    const lower = name.toLowerCase();
    if (lower === 'host') throw fault('ENOSYS', 'Browser-owned Host header cannot be omitted');
    if (lower === 'content-length') this.#expectedLength = undefined;
    this.#storedHeaders.delete(lower);
    if (HTTP_TOKEN.test(name)) this.#headers.delete(name);
  }

  flushHeaders(): void {
    // Browser Fetch dispatches headers and buffered body atomically when the request ends.
  }

  dispatch() {
    if (this.#allowed || this.destroyed) return;
    this.#allowed = true;
    // Start the per-request deadline on dispatch so requests waiting in a
    // concurrency-bounded BrowserAgent queue do not expire before dispatch.
    this.#timer = this.#scheduleTimeout(this.#timeout);
    this.#start();
  }

  #start() {
    if (!this.#ready || !this.#allowed || this.#sent || this.destroyed) return;
    this.#sent = true;
    markOutgoingHeadersSent(this, true);
    void this.#send().catch((error: unknown) => {
      if (!this.destroyed) this.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  }

  override _write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void) {
    if (!this.#allowBody) {
      if (chunk.length === 0) {
        done();
        return;
      }
      const error = fault(
        'ENOSYS',
        'Browser HTTP adapter supports request bodies only on body-capable fetch-mode methods',
      );
      // autoDestroy is off, so a failed write alone would leave the request (and its
      // process ownership) open; destroying with the error emits it once and closes.
      this.destroy(error);
      done(error);
      return;
    }
    const nextSize = this.#size + chunk.length;
    if (nextSize > this.#bodyLimit) {
      const error = fault('E2BIG', `Browser HTTP request body exceeds ${this.#bodyLimit} bytes`, {
        limit: this.#bodyLimit,
        actual: nextSize,
      });
      this.destroy(error);
      done(error);
      return;
    }
    if (chunk.length > 0) {
      this.#size = nextSize;
      this.#body.push(Buffer.from(chunk));
    }
    done();
  }

  override _final(done: (error?: Error | null) => void) {
    if (this.#expectedLength !== undefined && this.#expectedLength !== this.#size) {
      const error = fault('EINVAL', 'Request Content-Length does not match body byte length');
      this.destroy(error);
      done(error);
      return;
    }
    this.#ready = true;
    this.finished = true;
    this.#start();
    done();
  }

  async #send() {
    assertHttpEgressAllowed(this.url);
    if (Buffer.byteLength(JSON.stringify([...this.#headers])) > resourceLimits().http.headerBytes)
      throw fault('E2BIG', 'Browser HTTP request headers exceed 64 KiB');
    // Match Node 22: empty POST/PUT/PATCH carries a 0-byte body, while empty DELETE/OPTIONS
    // omits a body unless bytes were written or Content-Length was explicitly set.
    const body =
      this.#allowBody &&
      (this.#size > 0 ||
        this.#expectedLength !== undefined ||
        this.method === 'POST' ||
        this.method === 'PUT' ||
        this.method === 'PATCH')
        ? Buffer.concat(this.#body, this.#size)
        : undefined;
    this.#body.length = 0;
    const result = await browserFetch(this.url, {
      method: this.method,
      headers: this.#headers,
      body,
      signal: this.#controller.signal,
      credentials: 'omit',
      redirect: 'error',
    });
    if (this.destroyed) {
      await result.body?.cancel();
      return;
    }
    if (result.url) {
      const finalUrl = safeParseUrl(result.url);
      try {
        assertHttpEgressAllowed(finalUrl);
      } catch (error) {
        await result.body?.cancel();
        throw error;
      }
    }
    const chunks: Buffer[] = [];
    let size = 0;
    this.#reader = result.body?.getReader();
    if (this.#reader) {
      try {
        for (;;) {
          const next = await this.#reader.read();
          if (this.destroyed) return;
          if (next.done) break;
          size += next.value.byteLength;
          if (size > this.responseLimit)
            throw fault('E2BIG', `Browser HTTP response exceeds ${this.responseLimit} bytes`, {
              limit: this.responseLimit,
              actual: size,
            });
          chunks.push(Buffer.from(next.value));
        }
      } finally {
        // On failure, destruction aborts Fetch and cancels the pending body stream.
        if (!this.destroyed) this.#reader.releaseLock();
        this.#reader = undefined;
      }
    }
    if (this.destroyed) return;
    const headers: Record<string, string> = Object.fromEntries(result.headers);
    if (Buffer.byteLength(JSON.stringify(headers)) > resourceLimits().http.headerBytes)
      throw fault('E2BIG', 'Browser HTTP response headers exceed 64 KiB');
    // Fetch exposes decoded bytes. Never forward wire framing that contradicts them.
    const encoding = headers['content-encoding'];
    if (encoding && !['gzip', 'deflate', 'br', 'zstd', 'identity'].includes(encoding.toLowerCase()))
      throw fault('ENOSYS', 'Unsupported browser HTTP content encoding');
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    if (this.method === 'HEAD') {
      if (encoding) delete headers['content-length'];
    } else {
      headers['content-length'] = String(size);
    }
    const rawHeaders: string[] = [];
    for (const [key, val] of Object.entries(headers)) rawHeaders.push(key, val);
    const statusText = result.statusText || statusMessages[result.status] || '';
    const response = new BrowserResponse(result.status, statusText, headers, rawHeaders);
    this.#response = response;
    response.once('end', () => this.destroy());
    response.once('close', () => this.destroy());
    response.once('error', (error) => this.destroy(error));
    // Guest callback failures must escape as process errors, outside the Fetch
    // rejection handler. They are not recoverable transport failures.
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.emit('response', response);
      // Preserve bounded delivery chunks for consumers such as npm's cache
      // writer. A complete archive must not become one oversized fs.write.
      for (const chunk of chunks) {
        for (let offset = 0; offset < chunk.length; offset += 65536) {
          if (this.destroyed || response.destroyed) return;
          response.push(chunk.subarray(offset, offset + 65536));
        }
      }
      if (this.destroyed || response.destroyed) return;
      response.complete = true;
      response.push(null);
    });
  }

  abort() {
    if (!this.aborted && !this.#response?.complete) {
      this.aborted = true;
      if (this.#response && !this.#response.complete) this.#response.aborted = true;
      this.emit('abort');
    }
    this.destroy();
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    if (this.#timer !== undefined) cancel(this.#timer);
    this.#body.length = 0;
    this.#controller.abort();
    void this.#reader?.cancel().catch(() => {});
    this.#response?.destroy();
    done(error);
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof Reflect.get(value, 'addEventListener') === 'function'
  );
}

/** Narrowed after a `typeof value === 'function'` guard; Node ignores extra listener args. */
function asResponseCallback(value: unknown): ((response: BrowserResponse) => void) | undefined {
  return typeof value === 'function' ? (value as (response: BrowserResponse) => void) : undefined;
}

function validateOptionalHost(value: unknown, field: 'hostname' | 'host'): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw invalidArgType(`options.${field}`, ['string', 'undefined', 'null'], value);
  return value;
}

function splitHostAndPort(
  hostnameOpt: string | undefined,
  hostOpt: string | undefined,
): { bareHost: string; portFromHost?: string } {
  if (hostnameOpt) return { bareHost: stripIpv6Brackets(hostnameOpt) };
  if (!hostOpt) return { bareHost: 'localhost' };
  if (hostOpt.startsWith('[')) {
    const closeBracket = hostOpt.indexOf(']');
    if (closeBracket !== -1) {
      const rest = hostOpt.slice(closeBracket + 1);
      if (rest.length === 0) return { bareHost: hostOpt.slice(1, closeBracket) };
      if (rest.startsWith(':'))
        return { bareHost: hostOpt.slice(1, closeBracket), portFromHost: rest.slice(1) };
    }
    return { bareHost: stripIpv6Brackets(hostOpt) };
  }
  const firstColon = hostOpt.indexOf(':');
  if (firstColon !== -1 && firstColon === hostOpt.lastIndexOf(':')) {
    return {
      bareHost: hostOpt.slice(0, firstColon),
      portFromHost: hostOpt.slice(firstColon + 1),
    };
  }
  return { bareHost: hostOpt };
}

function resolvePortNumber(rawPort: unknown): number | undefined {
  if (rawPort === undefined || rawPort === null || rawPort === '') return undefined;
  if (typeof rawPort !== 'number' && typeof rawPort !== 'string')
    throw invalidArgType('options.port', ['number', 'string'], rawPort);
  const num = Number(rawPort);
  if (
    !Number.isInteger(num) ||
    num < 0 ||
    num > 65535 ||
    (typeof rawPort === 'string' && rawPort.trim() !== rawPort)
  ) {
    throw nodeError(
      RangeError,
      'ERR_SOCKET_BAD_PORT',
      `Port should be >= 0 and < 65536. Received ${String(rawPort)}.`,
    );
  }
  return num > 0 ? num : undefined;
}

interface ParsedTarget {
  url: URL;
  hostProperty: string;
  method: string;
  timeout: number;
  headers: Record<string, unknown>;
  signal?: AbortSignal;
  agent?: BrowserAgent;
  agentOptions: Record<string, unknown>;
  responseCallback?: (response: BrowserResponse) => void;
}

function normalizeFetchArguments(
  input: unknown,
  options?: unknown,
  callback?: unknown,
): { merged: Record<string, unknown>; responseCallback?: (response: BrowserResponse) => void } {
  if (typeof input === 'string' || input instanceof URL) {
    const parsed = input instanceof URL ? input : safeParseUrl(input);
    if (parsed.username || parsed.password)
      throw fault(
        'ENOSYS',
        'Browser HTTP adapter requires matching protocol and no URL credentials',
      );
    // urlToHttpOptions reads standard WHATWG URL getters; URL lacks a TS index signature.
    const urlOptions = urlToHttpOptions(parsed as unknown as Record<string, unknown>);
    if (typeof options === 'function')
      return { merged: urlOptions, responseCallback: asResponseCallback(options) };
    if (options === undefined || options === null) {
      if (callback !== undefined && typeof callback !== 'function')
        throw invalidArgType('cb', 'Function', callback);
      return { merged: urlOptions, responseCallback: asResponseCallback(callback) };
    }
    if (record(options) && !(options instanceof URL)) {
      if (callback !== undefined && typeof callback !== 'function')
        throw invalidArgType('cb', 'Function', callback);
      return {
        merged: { ...urlOptions, ...options },
        responseCallback: asResponseCallback(callback),
      };
    }
    throw invalidArgType('options', ['Object', 'Function'], options);
  }
  if (record(input)) {
    if (options !== undefined && typeof options !== 'function')
      throw invalidArgType('cb', 'Function', options);
    return { merged: input, responseCallback: asResponseCallback(options) };
  }
  throw invalidArgType('url', ['string', 'Object', 'URL'], input);
}

function parseFetchTarget(
  protocol: 'http:' | 'https:',
  input: unknown,
  options?: unknown,
  callback?: unknown,
): ParsedTarget {
  const { merged, responseCallback } = normalizeFetchArguments(input, options, callback);
  for (const [key, value] of Object.entries(merged)) {
    if (
      value !== undefined &&
      !(value === null && TLS_CONTROLS.includes(key)) &&
      !ALLOWED_FETCH_OPTIONS.has(key)
    ) {
      throw fault('ENOSYS', `Browser HTTP option ${key} is unsupported`);
    }
  }
  if (merged.auth !== undefined && merged.auth !== '')
    throw fault('ENOSYS', 'HTTP auth options are unsupported; use explicit authorization headers');
  if (merged.rejectUnauthorized !== undefined && merged.rejectUnauthorized !== true)
    throw fault('ENOSYS', 'Browser certificate verification cannot be disabled');
  if (merged.setHost !== undefined) {
    if (typeof merged.setHost !== 'boolean')
      throw invalidArgType('options.setHost', 'boolean', merged.setHost);
    if (!merged.setHost) throw fault('ENOSYS', 'Browser-owned Host header cannot be omitted');
  }

  let signal: AbortSignal | undefined;
  if (merged.signal !== undefined && merged.signal !== null) {
    if (!isAbortSignal(merged.signal))
      throw invalidArgType('options.signal', 'AbortSignal', merged.signal);
    signal = merged.signal;
  }

  let timeout = resourceLimits().timers.httpRequestMs;
  if (merged.timeout !== undefined) {
    if (
      typeof merged.timeout !== 'number' ||
      !Number.isFinite(merged.timeout) ||
      merged.timeout < 0
    )
      throw fault('EINVAL', 'Invalid HTTP timeout');
    if (merged.timeout > 0) timeout = Math.min(timeout, merged.timeout);
  }

  const resolvedProtocol = merged.protocol || protocol;
  if (resolvedProtocol !== protocol)
    throw nodeError(
      TypeError,
      'ERR_INVALID_PROTOCOL',
      `Protocol "${String(resolvedProtocol)}" not supported. Expected "${protocol}"`,
    );

  if (merged.path !== undefined && merged.path !== null && typeof merged.path !== 'string')
    throw invalidArgType('options.path', 'string', merged.path);
  let resolvedPath = '/';
  if (typeof merged.path === 'string' && merged.path.length > 0) {
    if (INVALID_PATH_CHAR.test(merged.path))
      throw nodeError(
        TypeError,
        'ERR_UNESCAPED_CHARACTERS',
        'Request path contains unescaped characters',
      );
    resolvedPath = merged.path;
  }
  if (!resolvedPath.startsWith('/'))
    throw nodeError(TypeError, 'ERR_INVALID_URL', `Invalid URL path: ${resolvedPath}`);

  if (merged.method !== undefined && merged.method !== null && typeof merged.method !== 'string')
    throw invalidArgType('options.method', 'string', merged.method);
  let method = 'GET';
  if (typeof merged.method === 'string' && merged.method.length > 0) {
    if (!HTTP_TOKEN.test(merged.method))
      throw nodeError(
        TypeError,
        'ERR_INVALID_HTTP_TOKEN',
        `Method must be a valid HTTP token ["${merged.method}"]`,
      );
    method = merged.method.toUpperCase();
  }
  if (!FETCH_METHODS.has(method))
    throw fault('ENOSYS', `Browser HTTP method ${method} is unsupported`);

  const hostnameOpt = validateOptionalHost(merged.hostname, 'hostname');
  const hostOpt = validateOptionalHost(merged.host, 'host');
  const { bareHost, portFromHost } = splitHostAndPort(hostnameOpt, hostOpt);
  if (bareHost.length === 0) throw nodeError(TypeError, 'ERR_INVALID_URL', 'Invalid HTTP hostname');
  const portNumber = resolvePortNumber(merged.port || merged.defaultPort || portFromHost);
  const authorityHost = bareHost.includes(':') ? `[${bareHost}]` : bareHost;
  const url = safeParseUrl(
    `${protocol}//${authorityHost}${portNumber ? ':' + portNumber : ''}${resolvedPath}`,
  );
  if (stripIpv6Brackets(url.hostname) !== bareHost.toLowerCase())
    throw nodeError(TypeError, 'ERR_INVALID_URL', `Invalid URL hostname: ${bareHost}`);

  if (
    merged.agent !== undefined &&
    merged.agent !== false &&
    merged.agent !== null &&
    !(merged.agent instanceof BrowserAgent)
  )
    throw fault('ENOSYS', 'Browser HTTP mode requires its Agent');
  const agent = merged.agent instanceof BrowserAgent ? merged.agent : undefined;

  let headers: Record<string, unknown> = {};
  if (merged.headers !== undefined && merged.headers !== null) {
    if (!record(merged.headers)) throw invalidArgType('options.headers', 'Object', merged.headers);
    headers = merged.headers;
  }

  const { signal: _omitSignal, ...agentOptions } = merged;
  void _omitSignal;
  return {
    url,
    hostProperty: bareHost,
    method,
    timeout,
    headers,
    signal,
    agent,
    agentOptions,
    responseCallback,
  };
}

function parseSocketModeTarget(
  input: unknown,
  options?: unknown,
  callback?: unknown,
): ParsedTarget {
  if (typeof input !== 'string' && !(input instanceof URL))
    throw fault('ENOSYS', 'Browser HTTP adapter requires an absolute URL');
  const url = input instanceof URL ? input : safeParseUrl(input);
  if ((options !== undefined && typeof options !== 'function') || callback !== undefined)
    throw fault('ENOSYS', 'Browser HTTP request options are unsupported');
  return {
    url,
    hostProperty: stripIpv6Brackets(url.hostname),
    method: 'GET',
    timeout: resourceLimits().timers.httpRequestMs,
    headers: {},
    agentOptions: {},
    responseCallback: asResponseCallback(options),
  };
}

function applyInitialHeaders(
  child: BrowserRequest,
  headers: Record<string, unknown>,
  defaultHostHeader: string,
): void {
  let deferredFailure: Error | undefined;
  for (const key of Object.keys(headers)) {
    try {
      child.setHeader(key, headers[key]);
    } catch (error) {
      deferredFailure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!child.hasHeader('host')) child.setHeader('Host', defaultHostHeader);
  if (deferredFailure) throw deferredFailure;
}

export function createBrowserHttpClient(
  protocol: 'http:' | 'https:',
  retain: () => void,
  release: () => void,
  fetchAgents = false,
  headerPolicy: HttpHeaderPolicy = {},
  responseLimit = DEFAULT_HTTP_RESPONSE_LIMIT,
) {
  const request = (input: unknown, options?: unknown, callback?: unknown) => {
    const target = fetchAgents
      ? parseFetchTarget(protocol, input, options, callback)
      : parseSocketModeTarget(input, options, callback);

    if (target.url.protocol !== protocol || target.url.username || target.url.password)
      throw fault(
        'ENOSYS',
        'Browser HTTP adapter requires matching protocol and no URL credentials',
      );

    const allowBody = fetchAgents && target.method !== 'GET' && target.method !== 'HEAD';
    validateInitialHeaders(target.headers, allowBody, resourceLimits().http.clientBodyBytes);

    const child = new BrowserRequest(
      target.url,
      release,
      target.responseCallback,
      target.timeout,
      headerPolicy[target.url.origin],
      responseLimit,
      target.method,
      allowBody,
      target.hostProperty,
    );
    retain();
    try {
      applyInitialHeaders(child, target.headers, target.url.host);
      assertHttpEgressAllowed(target.url);
      if (target.signal) {
        const signal = target.signal;
        const toAbortError = () =>
          abortError('The operation was aborted', { cause: signal.reason });
        if (signal.aborted) {
          queueMicrotask(() => child.destroy(toAbortError()));
          return child;
        }
        const onAbort = () => child.destroy(toAbortError());
        signal.addEventListener('abort', onAbort, { once: true });
        child.once('close', () => signal.removeEventListener('abort', onAbort));
      }
      if (target.agent) {
        const proxy: unknown = Reflect.get(target.agent, 'proxy');
        if (record(proxy) && Object.keys(proxy).length)
          throw fault('ENOSYS', 'Browser HTTP proxy agents are unsupported');
        target.agent.addRequest(child, {
          ...target.agentOptions,
          protocol,
          host: target.hostProperty,
          port: Number(target.url.port || (protocol === 'https:' ? 443 : 80)),
        });
      } else {
        child.dispatch();
      }
    } catch (error) {
      queueMicrotask(() =>
        child.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    }
    return child;
  };
  const ClientRequest = bindClientRequestConstructor(request);
  return {
    Agent: protocol === 'https:' ? HttpsAgent : BrowserAgent,
    ClientRequest,
    request,
    get: (input: unknown, options?: unknown, callback?: unknown) => {
      const child = request(input, options, callback);
      child.end();
      return child;
    },
  };
}
