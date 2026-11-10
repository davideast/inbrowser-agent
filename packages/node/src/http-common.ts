import { nodeError, validateInteger } from './node-errors';
import { record } from './value-guards';

export const HTTP_TOKEN_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const INVALID_HEADER_CHAR_REGEXP = /[^\t\x20-\x7e\x80-\xff]/;
export const MAX_HEADER_SIZE = 16384;

export const HTTP_METHODS: readonly string[] = Object.freeze([
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'QUERY',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE',
]);

function formatHeaderSubject(value: unknown): string {
  return typeof value === 'symbol' ? value.toString() : String(value);
}

export function setMaxIdleHTTPParsers(max: unknown): void {
  validateInteger(max, 'max', 1);
}

export function validateHeaderName(name: unknown, label?: string): void {
  if (typeof name !== 'string' || !name || !HTTP_TOKEN_REGEXP.test(name)) {
    throw nodeError(
      TypeError,
      'ERR_INVALID_HTTP_TOKEN',
      `${label || 'Header name'} must be a valid HTTP token ["${formatHeaderSubject(name)}"]`,
    );
  }
}

export function validateHeaderValue(name: unknown, value: unknown): void {
  if (value === undefined) {
    throw nodeError(
      TypeError,
      'ERR_HTTP_INVALID_HEADER_VALUE',
      `Invalid value "undefined" for header "${formatHeaderSubject(name)}"`,
    );
  }
  const hasInvalidChar = Array.isArray(value)
    ? value.some((item) => INVALID_HEADER_CHAR_REGEXP.test(formatHeaderSubject(item)))
    : INVALID_HEADER_CHAR_REGEXP.test(formatHeaderSubject(value));
  if (hasInvalidChar) {
    throw nodeError(
      TypeError,
      'ERR_INVALID_CHAR',
      `Invalid character in header content ["${formatHeaderSubject(name)}"]`,
    );
  }
}

export function formatHttpAgentName(options: unknown = {}): string {
  const opts = record(options) ? options : {};
  let name = typeof opts.host === 'string' && opts.host.length > 0 ? opts.host : 'localhost';
  name += ':';
  if (opts.port !== undefined && opts.port !== null && opts.port !== '') {
    name += String(opts.port);
  }
  name += ':';
  if (opts.localAddress !== undefined && opts.localAddress !== null && opts.localAddress !== '') {
    name += String(opts.localAddress);
  }
  if (opts.family === 4 || opts.family === 6) {
    name += `:${opts.family}`;
  }
  if (opts.socketPath !== undefined && opts.socketPath !== null && opts.socketPath !== '') {
    name += `:${String(opts.socketPath)}`;
  }
  return name;
}

const HTTPS_NAME_SIMPLE_KEYS = ['ca', 'cert', 'clientCertEngine', 'ciphers', 'key', 'pfx'] as const;

const HTTPS_NAME_MID_KEYS = ['minVersion', 'maxVersion', 'secureProtocol', 'crl'] as const;

const HTTPS_NAME_TAIL_KEYS = ['ecdhCurve', 'dhparam', 'secureOptions', 'sessionIdContext'] as const;

export function formatHttpsAgentName(options: unknown = {}): string {
  const opts = record(options) ? options : {};
  let name = formatHttpAgentName(opts);

  for (const key of HTTPS_NAME_SIMPLE_KEYS) {
    name += ':';
    if (opts[key] !== undefined && opts[key] !== null) name += String(opts[key]);
  }

  name += ':';
  if (opts.rejectUnauthorized !== undefined) name += String(opts.rejectUnauthorized);

  name += ':';
  const host = typeof opts.host === 'string' && opts.host.length > 0 ? opts.host : 'localhost';
  if (opts.servername && opts.servername !== host) name += String(opts.servername);

  for (const key of HTTPS_NAME_MID_KEYS) {
    name += ':';
    if (opts[key] !== undefined && opts[key] !== null) name += String(opts[key]);
  }

  name += ':';
  if (opts.honorCipherOrder !== undefined) name += String(opts.honorCipherOrder);

  for (const key of HTTPS_NAME_TAIL_KEYS) {
    name += ':';
    if (opts[key] !== undefined && opts[key] !== null) name += String(opts[key]);
  }

  name += ':';
  if (opts.sigalgs) name += JSON.stringify(opts.sigalgs);

  name += ':';
  if (opts.privateKeyIdentifier) name += String(opts.privateKeyIdentifier);

  name += ':';
  if (opts.privateKeyEngine) name += String(opts.privateKeyEngine);

  return name;
}

export function keepAgentSocketAlive(
  socket: unknown,
  keepAlive: boolean,
  keepAliveMsecs: number,
): boolean {
  if (record(socket)) {
    if (typeof socket.setKeepAlive === 'function') {
      Reflect.apply(socket.setKeepAlive, socket, [keepAlive, keepAliveMsecs]);
    }
    if (typeof socket.unref === 'function') {
      Reflect.apply(socket.unref, socket, []);
    }
  }
  return true;
}

export function reuseAgentSocket(socket: unknown, request: unknown): void {
  if (record(request)) {
    Reflect.set(request, 'reusedSocket', true);
  }
  if (record(socket) && typeof socket.ref === 'function') {
    Reflect.apply(socket.ref, socket, []);
  }
}
