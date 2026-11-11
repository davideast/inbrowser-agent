import { Buffer } from 'buffer';
import { canonicalizeIP, isIP } from './net-address';
import { invalidArgType, invalidArgValue, nodeError } from './node-errors';
import { record } from './value-guards';

export const CLIENT_RENEG_LIMIT = 3;
export const CLIENT_RENEG_WINDOW = 600;
export const DEFAULT_ECDH_CURVE = 'auto';
export const DEFAULT_MAX_VERSION = 'TLSv1.3';
export const DEFAULT_MIN_VERSION = 'TLSv1.2';
export const DEFAULT_CIPHERS =
  'TLS_AES_256_GCM_SHA384:' +
  'TLS_CHACHA20_POLY1305_SHA256:' +
  'TLS_AES_128_GCM_SHA256:' +
  'ECDHE-RSA-AES128-GCM-SHA256:' +
  'ECDHE-ECDSA-AES128-GCM-SHA256:' +
  'ECDHE-RSA-AES256-GCM-SHA384:' +
  'ECDHE-ECDSA-AES256-GCM-SHA384:' +
  'DHE-RSA-AES128-GCM-SHA256:' +
  'ECDHE-RSA-AES128-SHA256:' +
  'DHE-RSA-AES128-SHA256:' +
  'ECDHE-RSA-AES256-SHA384:' +
  'DHE-RSA-AES256-SHA384:' +
  'ECDHE-RSA-AES256-SHA256:' +
  'DHE-RSA-AES256-SHA256:' +
  'HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';

export const EMPTY_ROOT_CERTIFICATES: readonly string[] = Object.freeze([]);

const TLS_CIPHERS: readonly string[] = [
  'aes128-gcm-sha256',
  'aes128-sha',
  'aes128-sha256',
  'aes256-gcm-sha384',
  'aes256-sha',
  'aes256-sha256',
  'dhe-psk-aes128-cbc-sha',
  'dhe-psk-aes128-cbc-sha256',
  'dhe-psk-aes128-gcm-sha256',
  'dhe-psk-aes256-cbc-sha',
  'dhe-psk-aes256-cbc-sha384',
  'dhe-psk-aes256-gcm-sha384',
  'dhe-psk-chacha20-poly1305',
  'dhe-rsa-aes128-gcm-sha256',
  'dhe-rsa-aes128-sha',
  'dhe-rsa-aes128-sha256',
  'dhe-rsa-aes256-gcm-sha384',
  'dhe-rsa-aes256-sha',
  'dhe-rsa-aes256-sha256',
  'dhe-rsa-chacha20-poly1305',
  'ecdhe-ecdsa-aes128-gcm-sha256',
  'ecdhe-ecdsa-aes128-sha',
  'ecdhe-ecdsa-aes128-sha256',
  'ecdhe-ecdsa-aes256-gcm-sha384',
  'ecdhe-ecdsa-aes256-sha',
  'ecdhe-ecdsa-aes256-sha384',
  'ecdhe-ecdsa-chacha20-poly1305',
  'ecdhe-psk-aes128-cbc-sha',
  'ecdhe-psk-aes128-cbc-sha256',
  'ecdhe-psk-aes256-cbc-sha',
  'ecdhe-psk-aes256-cbc-sha384',
  'ecdhe-psk-chacha20-poly1305',
  'ecdhe-rsa-aes128-gcm-sha256',
  'ecdhe-rsa-aes128-sha',
  'ecdhe-rsa-aes128-sha256',
  'ecdhe-rsa-aes256-gcm-sha384',
  'ecdhe-rsa-aes256-sha',
  'ecdhe-rsa-aes256-sha384',
  'ecdhe-rsa-chacha20-poly1305',
  'psk-aes128-cbc-sha',
  'psk-aes128-cbc-sha256',
  'psk-aes128-gcm-sha256',
  'psk-aes256-cbc-sha',
  'psk-aes256-cbc-sha384',
  'psk-aes256-gcm-sha384',
  'psk-chacha20-poly1305',
  'rsa-psk-aes128-cbc-sha',
  'rsa-psk-aes128-cbc-sha256',
  'rsa-psk-aes128-gcm-sha256',
  'rsa-psk-aes256-cbc-sha',
  'rsa-psk-aes256-cbc-sha384',
  'rsa-psk-aes256-gcm-sha384',
  'rsa-psk-chacha20-poly1305',
  'srp-aes-128-cbc-sha',
  'srp-aes-256-cbc-sha',
  'srp-rsa-aes-128-cbc-sha',
  'srp-rsa-aes-256-cbc-sha',
  'tls_aes_128_ccm_8_sha256',
  'tls_aes_128_ccm_sha256',
  'tls_aes_128_gcm_sha256',
  'tls_aes_256_gcm_sha384',
  'tls_chacha20_poly1305_sha256',
];

export function getCiphers(): string[] {
  return [...TLS_CIPHERS];
}

export function getCACertificates(type: unknown = 'default'): readonly string[] {
  if (typeof type !== 'string') {
    throw invalidArgType('type', 'string', type);
  }
  switch (type) {
    case 'default':
    case 'system':
    case 'bundled':
    case 'extra':
      return EMPTY_ROOT_CERTIFICATES;
    default:
      throw invalidArgValue('type', type);
  }
}

function convertProtocols(protocols: unknown[]): Buffer {
  const lens = new Array<number>(protocols.length);
  let totalBytes = 0;
  for (let i = 0; i < protocols.length; i++) {
    const item = protocols[i];
    let len: number;
    if (typeof item === 'string') {
      len = Buffer.byteLength(item, 'utf8');
    } else if (item instanceof Uint8Array) {
      len = item.byteLength;
    } else if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
      len = item.byteLength;
    } else {
      throw invalidArgType('string', ['string', 'Buffer', 'ArrayBuffer'], item);
    }
    if (len > 255) {
      throw nodeError(
        RangeError,
        'ERR_OUT_OF_RANGE',
        `The byte length of the protocol at index ${i} exceeds the maximum length. It must be <= 255. Received ${len}`,
      );
    }
    lens[i] = len;
    totalBytes += 1 + len;
  }

  const buff = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (let i = 0; i < protocols.length; i++) {
    const len = lens[i]!;
    const item = protocols[i];
    buff[offset++] = len;
    if (typeof item === 'string') {
      buff.write(item, offset, 'utf8');
    } else if (item instanceof Uint8Array) {
      buff.set(item, offset);
    } else if (ArrayBuffer.isView(item)) {
      buff.set(new Uint8Array(item.buffer, item.byteOffset, item.byteLength), offset);
    } else if (item instanceof ArrayBuffer) {
      buff.set(new Uint8Array(item), offset);
    }
    offset += len;
  }
  return buff;
}

function setAlpnOutput(out: unknown, value: Buffer): void {
  if (!record(out)) {
    throw new TypeError(`Cannot set properties of ${String(out)} (setting 'ALPNProtocols')`);
  }
  out.ALPNProtocols = value;
}

export function convertALPNProtocols(protocols: unknown, out?: unknown): void {
  if (Array.isArray(protocols)) {
    setAlpnOutput(out, convertProtocols(protocols));
  } else if (protocols instanceof Uint8Array) {
    setAlpnOutput(out, Buffer.from(protocols));
  } else if (ArrayBuffer.isView(protocols)) {
    setAlpnOutput(
      out,
      Buffer.from(
        protocols.buffer.slice(protocols.byteOffset, protocols.byteOffset + protocols.byteLength),
      ),
    );
  }
}

function unfqdn(host: string): string {
  return host.replace(/[.]$/, '');
}

function asciiLowerChar(ch: string): string {
  return String.fromCharCode(32 + ch.charCodeAt(0));
}

function splitHost(host: string): string[] {
  return unfqdn(host).replace(/[A-Z]/g, asciiLowerChar).split('.');
}

function hasNonPrintableOrNonAscii(part: string): boolean {
  return /[^\u0021-\u007F]/u.test(part);
}

function checkHostPattern(hostParts: string[], pattern: string, wildcards: boolean): boolean {
  if (!pattern) return false;

  const patternParts = splitHost(pattern);
  if (hostParts.length !== patternParts.length) return false;
  if (patternParts.includes('')) return false;
  if (patternParts.some(hasNonPrintableOrNonAscii)) return false;

  for (let i = hostParts.length - 1; i > 0; i -= 1) {
    if (hostParts[i] !== patternParts[i]) return false;
  }

  const hostSubdomain = hostParts[0]!;
  const patternSubdomain = patternParts[0]!;
  const patternSubdomainParts = patternSubdomain.split('*', 3);

  if (patternSubdomainParts.length === 1 || patternSubdomain.includes('xn--')) {
    return hostSubdomain === patternSubdomain;
  }

  if (!wildcards) return false;
  if (patternSubdomainParts.length > 2) return false;
  if (patternParts.length <= 2) return false;

  const prefix = patternSubdomainParts[0]!;
  const suffix = patternSubdomainParts[1]!;

  if (prefix.length + suffix.length > hostSubdomain.length) return false;
  if (!hostSubdomain.startsWith(prefix)) return false;
  if (!hostSubdomain.endsWith(suffix)) return false;

  return true;
}

// Matches ECMA-404 / RFC 8259 JSON string literals inside escaped subjectaltname fields.
const JSON_STRING_PATTERN = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/;

function altNameFormatError(): SyntaxError & { code: string } {
  return Object.assign(new SyntaxError('Invalid subject alternative name string'), {
    code: 'ERR_TLS_CERT_ALTNAME_FORMAT',
  });
}

function splitEscapedAltNames(altNames: string): string[] {
  const result: string[] = [];
  let currentToken = '';
  let offset = 0;
  while (offset !== altNames.length) {
    const nextSep = altNames.indexOf(',', offset);
    const nextQuote = altNames.indexOf('"', offset);
    if (nextQuote !== -1 && (nextSep === -1 || nextQuote < nextSep)) {
      currentToken += altNames.substring(offset, nextQuote);
      const match = JSON_STRING_PATTERN.exec(altNames.substring(nextQuote));
      if (!match) {
        throw altNameFormatError();
      }
      const parsed: unknown = JSON.parse(match[0]);
      currentToken += typeof parsed === 'string' ? parsed : String(parsed);
      offset = nextQuote + match[0].length;
    } else if (nextSep !== -1) {
      currentToken += altNames.substring(offset, nextSep);
      result.push(currentToken);
      currentToken = '';
      offset = nextSep + 2;
    } else {
      currentToken += altNames.substring(offset);
      offset = altNames.length;
    }
  }
  result.push(currentToken);
  return result;
}

export function checkServerIdentity(hostname: unknown, cert: unknown): Error | undefined {
  if (!record(cert)) {
    throw new TypeError(`Cannot read properties of ${String(cert)} (reading 'subject')`);
  }
  const subject = record(cert.subject) ? cert.subject : undefined;
  const altNames = cert.subjectaltname;
  const dnsNames: string[] = [];
  const ips: string[] = [];

  let host = `${String(hostname)}`;

  if (typeof altNames === 'string' && altNames.length > 0) {
    const splitAltNames = altNames.includes('"')
      ? splitEscapedAltNames(altNames)
      : altNames.split(', ');
    for (const name of splitAltNames) {
      if (name.startsWith('DNS:')) {
        dnsNames.push(name.slice(4));
      } else if (name.startsWith('IP Address:')) {
        ips.push(canonicalizeIP(name.slice(11)));
      }
    }
  }

  let valid = false;
  let reason = 'Unknown reason';

  host = unfqdn(host);

  const subjectCn = subject?.CN;
  const hasSubjectCn =
    (typeof subjectCn === 'string' && subjectCn.length > 0) ||
    (Array.isArray(subjectCn) && subjectCn.length > 0);

  if (isIP(host)) {
    valid = ips.includes(canonicalizeIP(host));
    if (!valid) {
      reason = `IP: ${host} is not in the cert's list: ${ips.join(', ')}`;
    }
  } else if (dnsNames.length > 0 || hasSubjectCn) {
    const hostParts = splitHost(host);
    const wildcard = (pattern: string) => checkHostPattern(hostParts, pattern, true);

    if (dnsNames.length > 0) {
      valid = dnsNames.some(wildcard);
      if (!valid) {
        reason = `Host: ${host}. is not in the cert's altnames: ${String(altNames)}`;
      }
    } else {
      if (Array.isArray(subjectCn)) {
        valid = subjectCn.some((entry) => typeof entry === 'string' && wildcard(entry));
      } else if (typeof subjectCn === 'string' && subjectCn.length > 0) {
        valid = wildcard(subjectCn);
      }
      if (!valid) {
        reason = `Host: ${host}. is not cert's CN: ${String(subjectCn)}`;
      }
    }
  } else {
    reason = 'Cert does not contain a DNS name';
  }

  if (!valid) {
    return Object.assign(
      new Error(`Hostname/IP does not match certificate's altnames: ${reason}`),
      {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        reason,
        host,
        cert,
      },
    );
  }
  return undefined;
}
