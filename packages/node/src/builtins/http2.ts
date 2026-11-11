import { Buffer } from 'buffer';
import { Readable, Stream } from 'readable-stream/lib/stream.js';
import { invalidArgType, nodeError, validateObject } from '../node-errors';
import { fault, record } from '../value-guards';

const HTTP2_CONSTANTS = {
  NGHTTP2_ERR_FRAME_SIZE_ERROR: -522,
  NGHTTP2_SESSION_SERVER: 0,
  NGHTTP2_SESSION_CLIENT: 1,
  NGHTTP2_STREAM_STATE_IDLE: 1,
  NGHTTP2_STREAM_STATE_OPEN: 2,
  NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3,
  NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
  NGHTTP2_STREAM_STATE_CLOSED: 7,
  NGHTTP2_FLAG_NONE: 0,
  NGHTTP2_FLAG_END_STREAM: 1,
  NGHTTP2_FLAG_END_HEADERS: 4,
  NGHTTP2_FLAG_ACK: 1,
  NGHTTP2_FLAG_PADDED: 8,
  NGHTTP2_FLAG_PRIORITY: 32,
  DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
  DEFAULT_SETTINGS_ENABLE_PUSH: 1,
  DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295,
  DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535,
  DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384,
  DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,
  DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0,
  MAX_MAX_FRAME_SIZE: 16777215,
  MIN_MAX_FRAME_SIZE: 16384,
  MAX_INITIAL_WINDOW_SIZE: 2147483647,
  NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
  NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
  NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
  NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
  NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
  NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,
  NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
  PADDING_STRATEGY_NONE: 0,
  PADDING_STRATEGY_ALIGNED: 1,
  PADDING_STRATEGY_MAX: 2,
  PADDING_STRATEGY_CALLBACK: 1,
  NGHTTP2_NO_ERROR: 0,
  NGHTTP2_PROTOCOL_ERROR: 1,
  NGHTTP2_INTERNAL_ERROR: 2,
  NGHTTP2_FLOW_CONTROL_ERROR: 3,
  NGHTTP2_SETTINGS_TIMEOUT: 4,
  NGHTTP2_STREAM_CLOSED: 5,
  NGHTTP2_FRAME_SIZE_ERROR: 6,
  NGHTTP2_REFUSED_STREAM: 7,
  NGHTTP2_CANCEL: 8,
  NGHTTP2_COMPRESSION_ERROR: 9,
  NGHTTP2_CONNECT_ERROR: 10,
  NGHTTP2_ENHANCE_YOUR_CALM: 11,
  NGHTTP2_INADEQUATE_SECURITY: 12,
  NGHTTP2_HTTP_1_1_REQUIRED: 13,
  NGHTTP2_DEFAULT_WEIGHT: 16,
  HTTP2_HEADER_STATUS: ':status',
  HTTP2_HEADER_METHOD: ':method',
  HTTP2_HEADER_AUTHORITY: ':authority',
  HTTP2_HEADER_SCHEME: ':scheme',
  HTTP2_HEADER_PATH: ':path',
  HTTP2_HEADER_PROTOCOL: ':protocol',
  HTTP2_HEADER_ACCEPT_ENCODING: 'accept-encoding',
  HTTP2_HEADER_ACCEPT_LANGUAGE: 'accept-language',
  HTTP2_HEADER_ACCEPT_RANGES: 'accept-ranges',
  HTTP2_HEADER_ACCEPT: 'accept',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS: 'access-control-allow-credentials',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: 'access-control-allow-headers',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: 'access-control-allow-methods',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: 'access-control-allow-origin',
  HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: 'access-control-expose-headers',
  HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: 'access-control-request-headers',
  HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: 'access-control-request-method',
  HTTP2_HEADER_AGE: 'age',
  HTTP2_HEADER_AUTHORIZATION: 'authorization',
  HTTP2_HEADER_CACHE_CONTROL: 'cache-control',
  HTTP2_HEADER_CONNECTION: 'connection',
  HTTP2_HEADER_CONTENT_DISPOSITION: 'content-disposition',
  HTTP2_HEADER_CONTENT_ENCODING: 'content-encoding',
  HTTP2_HEADER_CONTENT_LENGTH: 'content-length',
  HTTP2_HEADER_CONTENT_TYPE: 'content-type',
  HTTP2_HEADER_COOKIE: 'cookie',
  HTTP2_HEADER_DATE: 'date',
  HTTP2_HEADER_ETAG: 'etag',
  HTTP2_HEADER_FORWARDED: 'forwarded',
  HTTP2_HEADER_HOST: 'host',
  HTTP2_HEADER_IF_MODIFIED_SINCE: 'if-modified-since',
  HTTP2_HEADER_IF_NONE_MATCH: 'if-none-match',
  HTTP2_HEADER_IF_RANGE: 'if-range',
  HTTP2_HEADER_LAST_MODIFIED: 'last-modified',
  HTTP2_HEADER_LINK: 'link',
  HTTP2_HEADER_LOCATION: 'location',
  HTTP2_HEADER_RANGE: 'range',
  HTTP2_HEADER_REFERER: 'referer',
  HTTP2_HEADER_SERVER: 'server',
  HTTP2_HEADER_SET_COOKIE: 'set-cookie',
  HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: 'strict-transport-security',
  HTTP2_HEADER_TRANSFER_ENCODING: 'transfer-encoding',
  HTTP2_HEADER_TE: 'te',
  HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS: 'upgrade-insecure-requests',
  HTTP2_HEADER_UPGRADE: 'upgrade',
  HTTP2_HEADER_USER_AGENT: 'user-agent',
  HTTP2_HEADER_VARY: 'vary',
  HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: 'x-content-type-options',
  HTTP2_HEADER_X_FRAME_OPTIONS: 'x-frame-options',
  HTTP2_HEADER_KEEP_ALIVE: 'keep-alive',
  HTTP2_HEADER_PROXY_CONNECTION: 'proxy-connection',
  HTTP2_HEADER_X_XSS_PROTECTION: 'x-xss-protection',
  HTTP2_HEADER_ALT_SVC: 'alt-svc',
  HTTP2_HEADER_CONTENT_SECURITY_POLICY: 'content-security-policy',
  HTTP2_HEADER_EARLY_DATA: 'early-data',
  HTTP2_HEADER_EXPECT_CT: 'expect-ct',
  HTTP2_HEADER_ORIGIN: 'origin',
  HTTP2_HEADER_PURPOSE: 'purpose',
  HTTP2_HEADER_TIMING_ALLOW_ORIGIN: 'timing-allow-origin',
  HTTP2_HEADER_X_FORWARDED_FOR: 'x-forwarded-for',
  HTTP2_HEADER_PRIORITY: 'priority',
  HTTP2_HEADER_ACCEPT_CHARSET: 'accept-charset',
  HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: 'access-control-max-age',
  HTTP2_HEADER_ALLOW: 'allow',
  HTTP2_HEADER_CONTENT_LANGUAGE: 'content-language',
  HTTP2_HEADER_CONTENT_LOCATION: 'content-location',
  HTTP2_HEADER_CONTENT_MD5: 'content-md5',
  HTTP2_HEADER_CONTENT_RANGE: 'content-range',
  HTTP2_HEADER_DNT: 'dnt',
  HTTP2_HEADER_EXPECT: 'expect',
  HTTP2_HEADER_EXPIRES: 'expires',
  HTTP2_HEADER_FROM: 'from',
  HTTP2_HEADER_IF_MATCH: 'if-match',
  HTTP2_HEADER_IF_UNMODIFIED_SINCE: 'if-unmodified-since',
  HTTP2_HEADER_MAX_FORWARDS: 'max-forwards',
  HTTP2_HEADER_PREFER: 'prefer',
  HTTP2_HEADER_PROXY_AUTHENTICATE: 'proxy-authenticate',
  HTTP2_HEADER_PROXY_AUTHORIZATION: 'proxy-authorization',
  HTTP2_HEADER_REFRESH: 'refresh',
  HTTP2_HEADER_RETRY_AFTER: 'retry-after',
  HTTP2_HEADER_TRAILER: 'trailer',
  HTTP2_HEADER_TK: 'tk',
  HTTP2_HEADER_VIA: 'via',
  HTTP2_HEADER_WARNING: 'warning',
  HTTP2_HEADER_WWW_AUTHENTICATE: 'www-authenticate',
  HTTP2_HEADER_HTTP2_SETTINGS: 'http2-settings',
  HTTP2_METHOD_ACL: 'ACL',
  HTTP2_METHOD_BASELINE_CONTROL: 'BASELINE-CONTROL',
  HTTP2_METHOD_BIND: 'BIND',
  HTTP2_METHOD_CHECKIN: 'CHECKIN',
  HTTP2_METHOD_CHECKOUT: 'CHECKOUT',
  HTTP2_METHOD_CONNECT: 'CONNECT',
  HTTP2_METHOD_COPY: 'COPY',
  HTTP2_METHOD_DELETE: 'DELETE',
  HTTP2_METHOD_GET: 'GET',
  HTTP2_METHOD_HEAD: 'HEAD',
  HTTP2_METHOD_LABEL: 'LABEL',
  HTTP2_METHOD_LINK: 'LINK',
  HTTP2_METHOD_LOCK: 'LOCK',
  HTTP2_METHOD_MERGE: 'MERGE',
  HTTP2_METHOD_MKACTIVITY: 'MKACTIVITY',
  HTTP2_METHOD_MKCALENDAR: 'MKCALENDAR',
  HTTP2_METHOD_MKCOL: 'MKCOL',
  HTTP2_METHOD_MKREDIRECTREF: 'MKREDIRECTREF',
  HTTP2_METHOD_MKWORKSPACE: 'MKWORKSPACE',
  HTTP2_METHOD_MOVE: 'MOVE',
  HTTP2_METHOD_OPTIONS: 'OPTIONS',
  HTTP2_METHOD_ORDERPATCH: 'ORDERPATCH',
  HTTP2_METHOD_PATCH: 'PATCH',
  HTTP2_METHOD_POST: 'POST',
  HTTP2_METHOD_PRI: 'PRI',
  HTTP2_METHOD_PROPFIND: 'PROPFIND',
  HTTP2_METHOD_PROPPATCH: 'PROPPATCH',
  HTTP2_METHOD_PUT: 'PUT',
  HTTP2_METHOD_REBIND: 'REBIND',
  HTTP2_METHOD_REPORT: 'REPORT',
  HTTP2_METHOD_SEARCH: 'SEARCH',
  HTTP2_METHOD_TRACE: 'TRACE',
  HTTP2_METHOD_UNBIND: 'UNBIND',
  HTTP2_METHOD_UNCHECKOUT: 'UNCHECKOUT',
  HTTP2_METHOD_UNLINK: 'UNLINK',
  HTTP2_METHOD_UNLOCK: 'UNLOCK',
  HTTP2_METHOD_UPDATE: 'UPDATE',
  HTTP2_METHOD_UPDATEREDIRECTREF: 'UPDATEREDIRECTREF',
  HTTP2_METHOD_VERSION_CONTROL: 'VERSION-CONTROL',
  HTTP_STATUS_CONTINUE: 100,
  HTTP_STATUS_SWITCHING_PROTOCOLS: 101,
  HTTP_STATUS_PROCESSING: 102,
  HTTP_STATUS_EARLY_HINTS: 103,
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_CREATED: 201,
  HTTP_STATUS_ACCEPTED: 202,
  HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION: 203,
  HTTP_STATUS_NO_CONTENT: 204,
  HTTP_STATUS_RESET_CONTENT: 205,
  HTTP_STATUS_PARTIAL_CONTENT: 206,
  HTTP_STATUS_MULTI_STATUS: 207,
  HTTP_STATUS_ALREADY_REPORTED: 208,
  HTTP_STATUS_IM_USED: 226,
  HTTP_STATUS_MULTIPLE_CHOICES: 300,
  HTTP_STATUS_MOVED_PERMANENTLY: 301,
  HTTP_STATUS_FOUND: 302,
  HTTP_STATUS_SEE_OTHER: 303,
  HTTP_STATUS_NOT_MODIFIED: 304,
  HTTP_STATUS_USE_PROXY: 305,
  HTTP_STATUS_TEMPORARY_REDIRECT: 307,
  HTTP_STATUS_PERMANENT_REDIRECT: 308,
  HTTP_STATUS_BAD_REQUEST: 400,
  HTTP_STATUS_UNAUTHORIZED: 401,
  HTTP_STATUS_PAYMENT_REQUIRED: 402,
  HTTP_STATUS_FORBIDDEN: 403,
  HTTP_STATUS_NOT_FOUND: 404,
  HTTP_STATUS_METHOD_NOT_ALLOWED: 405,
  HTTP_STATUS_NOT_ACCEPTABLE: 406,
  HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED: 407,
  HTTP_STATUS_REQUEST_TIMEOUT: 408,
  HTTP_STATUS_CONFLICT: 409,
  HTTP_STATUS_GONE: 410,
  HTTP_STATUS_LENGTH_REQUIRED: 411,
  HTTP_STATUS_PRECONDITION_FAILED: 412,
  HTTP_STATUS_PAYLOAD_TOO_LARGE: 413,
  HTTP_STATUS_URI_TOO_LONG: 414,
  HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE: 415,
  HTTP_STATUS_RANGE_NOT_SATISFIABLE: 416,
  HTTP_STATUS_EXPECTATION_FAILED: 417,
  HTTP_STATUS_TEAPOT: 418,
  HTTP_STATUS_MISDIRECTED_REQUEST: 421,
  HTTP_STATUS_UNPROCESSABLE_ENTITY: 422,
  HTTP_STATUS_LOCKED: 423,
  HTTP_STATUS_FAILED_DEPENDENCY: 424,
  HTTP_STATUS_TOO_EARLY: 425,
  HTTP_STATUS_UPGRADE_REQUIRED: 426,
  HTTP_STATUS_PRECONDITION_REQUIRED: 428,
  HTTP_STATUS_TOO_MANY_REQUESTS: 429,
  HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
  HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS: 451,
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
  HTTP_STATUS_NOT_IMPLEMENTED: 501,
  HTTP_STATUS_BAD_GATEWAY: 502,
  HTTP_STATUS_SERVICE_UNAVAILABLE: 503,
  HTTP_STATUS_GATEWAY_TIMEOUT: 504,
  HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED: 505,
  HTTP_STATUS_VARIANT_ALSO_NEGOTIATES: 506,
  HTTP_STATUS_INSUFFICIENT_STORAGE: 507,
  HTTP_STATUS_LOOP_DETECTED: 508,
  HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED: 509,
  HTTP_STATUS_NOT_EXTENDED: 510,
  HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED: 511,
} as const;

const K_MAX_INT = 2 ** 32 - 1;
const K_MAX_STREAMS = 2 ** 32 - 1;
const K_MAX_FRAME_SIZE = HTTP2_CONSTANTS.MAX_MAX_FRAME_SIZE;
const K_MIN_FRAME_SIZE = HTTP2_CONSTANTS.MIN_MAX_FRAME_SIZE;
const MAX_ADDITIONAL_SETTINGS = 10;

function createHttp2Constants(): typeof HTTP2_CONSTANTS {
  const target: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(HTTP2_CONSTANTS)) {
    Object.defineProperty(target, key, {
      value,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  // Invariant: every property key and literal value from HTTP2_CONSTANTS has been defined on `target`.
  return target as typeof HTTP2_CONSTANTS;
}

function invalidSettingRangeError(name: string, value: unknown): RangeError & { code: string } {
  return nodeError(
    RangeError,
    'ERR_HTTP2_INVALID_SETTING_VALUE',
    `Invalid value for setting "${name}": ${String(value)}`,
  );
}

function invalidSettingTypeError(name: string, value: unknown): TypeError & { code: string } {
  return nodeError(
    TypeError,
    'ERR_HTTP2_INVALID_SETTING_VALUE',
    `Invalid value for setting "${name}": ${String(value)}`,
  );
}

function assertWithinRange(name: string, value: unknown, min: number, max: number): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max)
  ) {
    throw invalidSettingRangeError(name, value);
  }
}

function validateSettings(settings: Record<string, unknown>): void {
  if (settings.customSettings !== undefined) {
    if (
      settings.customSettings === null ||
      typeof settings.customSettings !== 'object' ||
      Array.isArray(settings.customSettings)
    ) {
      throw invalidArgType('customSettings', 'Number', settings.customSettings);
    }
    const entries = Object.entries(settings.customSettings);
    if (entries.length > MAX_ADDITIONAL_SETTINGS) {
      throw nodeError(
        Error,
        'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS',
        'Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS',
      );
    }
    for (const [key, value] of entries) {
      assertWithinRange('customSettings:id', Number(key), 0, 0xffff);
      assertWithinRange('customSettings:value', Number(value), 0, K_MAX_INT);
    }
  }
  assertWithinRange('headerTableSize', settings.headerTableSize, 0, K_MAX_INT);
  assertWithinRange(
    'initialWindowSize',
    settings.initialWindowSize,
    0,
    HTTP2_CONSTANTS.MAX_INITIAL_WINDOW_SIZE,
  );
  assertWithinRange('maxFrameSize', settings.maxFrameSize, K_MIN_FRAME_SIZE, K_MAX_FRAME_SIZE);
  assertWithinRange('maxConcurrentStreams', settings.maxConcurrentStreams, 0, K_MAX_STREAMS);
  assertWithinRange('maxHeaderListSize', settings.maxHeaderListSize, 0, K_MAX_INT);
  assertWithinRange('maxHeaderSize', settings.maxHeaderSize, 0, K_MAX_INT);
  if (settings.enablePush !== undefined && typeof settings.enablePush !== 'boolean') {
    throw invalidSettingTypeError('enablePush', settings.enablePush);
  }
  if (
    settings.enableConnectProtocol !== undefined &&
    typeof settings.enableConnectProtocol !== 'boolean'
  ) {
    throw invalidSettingTypeError('enableConnectProtocol', settings.enableConnectProtocol);
  }
}

export interface Http2Settings {
  headerTableSize?: number;
  enablePush?: boolean;
  initialWindowSize?: number;
  maxFrameSize?: number;
  maxConcurrentStreams?: number;
  maxHeaderListSize?: number;
  maxHeaderSize?: number;
  enableConnectProtocol?: boolean;
  customSettings?: Record<string, number>;
}

function getDefaultSettings(): Required<Omit<Http2Settings, 'customSettings'>> {
  return Object.setPrototypeOf(
    {
      headerTableSize: HTTP2_CONSTANTS.DEFAULT_SETTINGS_HEADER_TABLE_SIZE,
      enablePush: Boolean(HTTP2_CONSTANTS.DEFAULT_SETTINGS_ENABLE_PUSH),
      initialWindowSize: HTTP2_CONSTANTS.DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE,
      maxFrameSize: HTTP2_CONSTANTS.DEFAULT_SETTINGS_MAX_FRAME_SIZE,
      maxConcurrentStreams: HTTP2_CONSTANTS.DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS,
      maxHeaderSize: HTTP2_CONSTANTS.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE,
      maxHeaderListSize: HTTP2_CONSTANTS.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE,
      enableConnectProtocol: Boolean(HTTP2_CONSTANTS.DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL),
    },
    null,
  );
}

function getPackedSettings(settings?: unknown): Buffer {
  if (settings === undefined) return Buffer.alloc(0);
  validateObject(settings, 'settings');
  validateSettings(settings);

  const pairs: Array<[number, number]> = [];
  if (typeof settings.headerTableSize === 'number') {
    pairs.push([HTTP2_CONSTANTS.NGHTTP2_SETTINGS_HEADER_TABLE_SIZE, settings.headerTableSize]);
  }
  if (typeof settings.enablePush === 'boolean') {
    pairs.push([HTTP2_CONSTANTS.NGHTTP2_SETTINGS_ENABLE_PUSH, settings.enablePush ? 1 : 0]);
  }
  if (typeof settings.maxConcurrentStreams === 'number') {
    pairs.push([
      HTTP2_CONSTANTS.NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS,
      settings.maxConcurrentStreams,
    ]);
  }
  if (typeof settings.initialWindowSize === 'number') {
    pairs.push([HTTP2_CONSTANTS.NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE, settings.initialWindowSize]);
  }
  if (typeof settings.maxFrameSize === 'number') {
    pairs.push([HTTP2_CONSTANTS.NGHTTP2_SETTINGS_MAX_FRAME_SIZE, settings.maxFrameSize]);
  }
  const maxHeaderVal =
    typeof settings.maxHeaderSize === 'number'
      ? settings.maxHeaderSize
      : typeof settings.maxHeaderListSize === 'number'
        ? settings.maxHeaderListSize
        : undefined;
  if (maxHeaderVal !== undefined) {
    pairs.push([HTTP2_CONSTANTS.NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE, maxHeaderVal]);
  }
  if (typeof settings.enableConnectProtocol === 'boolean') {
    pairs.push([
      HTTP2_CONSTANTS.NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL,
      settings.enableConnectProtocol ? 1 : 0,
    ]);
  }
  if (record(settings.customSettings)) {
    for (const [rawId, rawVal] of Object.entries(settings.customSettings)) {
      if (typeof rawVal === 'number') {
        pairs.push([Number(rawId), rawVal]);
      }
    }
  }

  const packed = Buffer.alloc(pairs.length * 6);
  for (let i = 0; i < pairs.length; i++) {
    const [id, val] = pairs[i]!;
    packed.writeUInt16BE(id >>> 0, i * 6);
    packed.writeUInt32BE(val >>> 0, i * 6 + 2);
  }
  return packed;
}

function getUnpackedSettings(buf: unknown, options: unknown = {}): Http2Settings {
  if (!ArrayBuffer.isView(buf) || buf instanceof DataView) {
    throw invalidArgType('buf', ['Buffer', 'TypedArray'], buf);
  }
  // Match Node 22.18: checks element `length` when present, byteLength otherwise.
  const elementLength = Reflect.get(buf, 'length');
  const length = typeof elementLength === 'number' ? elementLength : buf.byteLength;
  if (length % 6 !== 0) {
    throw nodeError(
      RangeError,
      'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH',
      'Packed settings length must be a multiple of six',
    );
  }
  const view = Buffer.from(buf.buffer, buf.byteOffset, length);
  const unpacked: Record<string, unknown> = {};
  let customSettings: Record<string, number> | undefined;
  for (let offset = 0; offset < length; offset += 6) {
    const id = view.readUInt16BE(offset);
    const value = view.readUInt32BE(offset + 2);
    switch (id) {
      case HTTP2_CONSTANTS.NGHTTP2_SETTINGS_HEADER_TABLE_SIZE:
        unpacked.headerTableSize = value;
        break;
      case HTTP2_CONSTANTS.NGHTTP2_SETTINGS_ENABLE_PUSH:
        unpacked.enablePush = value !== 0;
        break;
      case HTTP2_CONSTANTS.NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS:
        unpacked.maxConcurrentStreams = value;
        break;
      case HTTP2_CONSTANTS.NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE:
        unpacked.initialWindowSize = value;
        break;
      case HTTP2_CONSTANTS.NGHTTP2_SETTINGS_MAX_FRAME_SIZE:
        unpacked.maxFrameSize = value;
        break;
      case HTTP2_CONSTANTS.NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE:
        unpacked.maxHeaderSize = value;
        unpacked.maxHeaderListSize = value;
        break;
      case HTTP2_CONSTANTS.NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL:
        unpacked.enableConnectProtocol = value !== 0;
        break;
      default:
        customSettings ??= {};
        customSettings[String(id)] = value;
        unpacked.customSettings = customSettings;
        break;
    }
  }

  if (record(options) && options.validate) {
    validateSettings(unpacked);
  }
  return unpacked;
}

class Http2ServerRequest extends Readable {
  constructor() {
    super();
    throw fault('ENOSYS', 'HTTP2 requests are not implemented');
  }
  get aborted(): boolean {
    return false;
  }
  get authority(): string {
    return '';
  }
  get complete(): boolean {
    return false;
  }
  get connection(): unknown {
    return undefined;
  }
  get headers(): Record<string, unknown> {
    return {};
  }
  get httpVersion(): string {
    return '2.0';
  }
  get httpVersionMajor(): number {
    return 2;
  }
  get httpVersionMinor(): number {
    return 0;
  }
  get method(): string {
    return 'GET';
  }
  get rawHeaders(): string[] {
    return [];
  }
  get rawTrailers(): string[] {
    return [];
  }
  get scheme(): string {
    return 'http';
  }
  get socket(): unknown {
    return undefined;
  }
  get stream(): unknown {
    return undefined;
  }
  get trailers(): Record<string, unknown> {
    return {};
  }
  get url(): string {
    return '';
  }
  setTimeout(_msecs?: number, _callback?: () => void): this {
    return this;
  }
}

class Http2ServerResponse extends Stream {
  constructor() {
    super();
    throw fault('ENOSYS', 'HTTP2 responses are not implemented');
  }
  get connection(): unknown {
    return undefined;
  }
  get finished(): boolean {
    return false;
  }
  get headersSent(): boolean {
    return false;
  }
  get sendDate(): boolean {
    return true;
  }
  get socket(): unknown {
    return undefined;
  }
  get statusCode(): number {
    return 200;
  }
  get statusMessage(): string {
    return '';
  }
  get stream(): unknown {
    return undefined;
  }
  get writableCorked(): number {
    return 0;
  }
  get writableEnded(): boolean {
    return false;
  }
  get writableFinished(): boolean {
    return false;
  }
  get writableHighWaterMark(): number {
    return 16384;
  }
  get writableLength(): number {
    return 0;
  }
  addTrailers(_headers: unknown): void {}
  appendHeader(_name: string, _value: unknown): this {
    return this;
  }
  cork(): void {}
  createPushResponse(_headers: unknown, _callback: unknown): void {}
  destroy(_error?: Error): this {
    return this;
  }
  end(_chunk?: unknown, _encoding?: unknown, _callback?: unknown): this {
    return this;
  }
  flushHeaders(): void {}
  getHeader(_name: string): unknown {
    return undefined;
  }
  getHeaderNames(): string[] {
    return [];
  }
  getHeaders(): Record<string, unknown> {
    return Object.setPrototypeOf({}, null);
  }
  hasHeader(_name: string): boolean {
    return false;
  }
  removeHeader(_name: string): void {}
  setHeader(_name: string, _value: unknown): this {
    return this;
  }
  setTimeout(_msecs?: number, _callback?: () => void): this {
    return this;
  }
  setTrailer(_headers: unknown): void {}
  uncork(): void {}
  write(_chunk: unknown, _encoding?: unknown, _callback?: unknown): boolean {
    return false;
  }
  writeContinue(): void {}
  writeEarlyHints(_hints: unknown): void {}
  writeHead(_statusCode: number, _statusMessage?: unknown, _headers?: unknown): this {
    return this;
  }
}

export function createHttp2Builtin() {
  const unimplementedSession = (): never => {
    throw fault('ENOSYS', 'HTTP2 sessions are not implemented');
  };

  return {
    connect: unimplementedSession,
    constants: createHttp2Constants(),
    createServer: unimplementedSession,
    createSecureServer: unimplementedSession,
    getDefaultSettings,
    getPackedSettings,
    getUnpackedSettings,
    performServerHandshake: unimplementedSession,
    sensitiveHeaders: Symbol.for('nodejs.http2.sensitiveHeaders'),
    Http2ServerRequest,
    Http2ServerResponse,
  };
}
