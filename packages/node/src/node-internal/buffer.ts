// Browser-safe `buffer` bridge for upstream Node `lib/` modules.
// `buffer@6.0.3` omits `Buffer.prototype.hexSlice`, lacks receiver/encoding validation
// matching Node.js v22.18.0 on `Buffer.prototype.toString`, and decodes invalid UTF-8
// byte-by-byte instead of WHATWG/V8 maximal-subpart replacement.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { Buffer } from 'buffer';
import { codes } from './errors';
import { kIsEncodingSymbol } from './util';

Reflect.set(Buffer, kIsEncodingSymbol, Buffer.isEncoding);

if (typeof Reflect.get(Buffer.prototype, 'hexSlice') !== 'function') {
  Object.defineProperty(Buffer.prototype, 'hexSlice', {
    value: function hexSlice(this: Uint8Array, start = 0, end = this.byteLength): string {
      const from = Math.max(0, Math.min(this.byteLength, start >>> 0));
      const to = Math.max(from, Math.min(this.byteLength, end >>> 0));
      let out = '';
      for (let i = from; i < to; i++) {
        out += this[i].toString(16).padStart(2, '0');
      }
      return out;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

const utf8TextDecoder = new TextDecoder('utf-8', { fatal: false });
const baseBufferToString = Buffer.prototype.toString;

type NormalizedBufferEncoding =
  | 'utf8'
  | 'utf16le'
  | 'latin1'
  | 'base64'
  | 'base64url'
  | 'hex'
  | 'ascii';

function resolveBufferEncoding(encoding: unknown): NormalizedBufferEncoding | undefined {
  if (typeof encoding === 'symbol') {
    throw new TypeError('Cannot convert a Symbol value to a string');
  }
  const str = String(encoding);
  switch (str.length) {
    case 4: {
      if (str === 'utf8') return 'utf8';
      if (str === 'ucs2') return 'utf16le';
      const low = str.toLowerCase();
      if (low === 'utf8') return 'utf8';
      if (low === 'ucs2') return 'utf16le';
      return undefined;
    }
    case 5: {
      if (str === 'utf-8') return 'utf8';
      if (str === 'ascii') return 'ascii';
      if (str === 'ucs-2') return 'utf16le';
      const low = str.toLowerCase();
      if (low === 'utf-8') return 'utf8';
      if (low === 'ascii') return 'ascii';
      if (low === 'ucs-2') return 'utf16le';
      return undefined;
    }
    case 7:
      if (str === 'utf16le' || str.toLowerCase() === 'utf16le') return 'utf16le';
      return undefined;
    case 8:
      if (str === 'utf-16le' || str.toLowerCase() === 'utf-16le') return 'utf16le';
      return undefined;
    case 6: {
      if (str === 'latin1' || str === 'binary') return 'latin1';
      if (str === 'base64') return 'base64';
      const low = str.toLowerCase();
      if (low === 'latin1' || low === 'binary') return 'latin1';
      if (low === 'base64') return 'base64';
      return undefined;
    }
    case 3:
      if (str === 'hex' || str.toLowerCase() === 'hex') return 'hex';
      return undefined;
    case 9:
      if (str === 'base64url' || str.toLowerCase() === 'base64url') return 'base64url';
      return undefined;
    default:
      return undefined;
  }
}

function decodeUtf8Slice(buf: Buffer, from: number, to: number): string {
  if (to <= from) return '';
  const view = new Uint8Array(buf.buffer, buf.byteOffset + from, to - from);
  const safeView =
    typeof SharedArrayBuffer !== 'undefined' && buf.buffer instanceof SharedArrayBuffer
      ? view.slice()
      : view;
  return utf8TextDecoder.decode(safeView);
}

Object.defineProperty(Buffer.prototype, 'toString', {
  value: {
    toString(this: unknown, encoding?: unknown, start?: unknown, end?: unknown): string {
      if (this === null || this === undefined) {
        throw new TypeError(`Cannot read properties of ${String(this)} (reading 'length')`);
      }
      if (!Buffer.isBuffer(this)) {
        throw new TypeError('buf.utf8Slice is not a function');
      }

      const len = this.length;

      let from: number;
      if (typeof start === 'bigint') {
        if (start <= 0n) {
          from = 0;
        } else if (start >= BigInt(len)) {
          return '';
        } else {
          throw new TypeError('Cannot convert a BigInt value to a number');
        }
      } else {
        const startNum = Number(start);
        if (startNum <= 0) {
          from = 0;
        } else if (startNum >= len) {
          return '';
        } else {
          from = Math.trunc(startNum) || 0;
        }
      }

      let to: number;
      if (end === undefined) {
        to = len;
      } else if (typeof end === 'bigint') {
        if (end > BigInt(len)) {
          to = len;
        } else {
          throw new TypeError('Cannot convert a BigInt value to a number');
        }
      } else {
        const endNum = Number(end);
        to = endNum > len ? len : Math.trunc(endNum) || 0;
      }

      if (to <= from) {
        return '';
      }

      if (encoding === undefined) {
        return decodeUtf8Slice(this, from, to);
      }

      const normalized = resolveBufferEncoding(encoding);
      if (normalized === undefined) {
        throw new codes.ERR_UNKNOWN_ENCODING(encoding);
      }

      if (normalized === 'utf8') {
        return decodeUtf8Slice(this, from, to);
      }

      if (normalized === 'base64url') {
        // Invariant: `baseBufferToString` returns a base64 `string` for a verified `Buffer` receiver.
        const b64 = Reflect.apply(baseBufferToString, this, ['base64', from, to]) as string;
        return b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      }

      // Invariant: `baseBufferToString` returns `string` for a verified `Buffer` receiver and valid encoding.
      return Reflect.apply(baseBufferToString, this, [normalized, from, to]) as string;
    },
  }.toString,
  writable: true,
  enumerable: false,
  configurable: true,
});

const isBuffer = Buffer.isBuffer;

export { Buffer, isBuffer };
