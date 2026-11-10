// Pure-JS port of Node.js v22.18.0 `internalBinding('string_decoder')` (`src/string_decoder.cc`).
// Matches C++ state layout (`kSize = 7`) and multi-byte streaming/replacement semantics.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { Buffer } from 'buffer';

const kIncompleteCharactersStart = 0;
const kIncompleteCharactersEnd = 4;
const kMissingBytes = 4;
const kBufferedBytes = 5;
const kEncodingField = 6;
const kNumFields = 7;
const kSize = 7;

const ENC_ASCII = 0;
const ENC_UTF8 = 1;
const ENC_BASE64 = 2;
const ENC_UTF16LE = 3;
const ENC_LATIN1 = 4;
const ENC_HEX = 5;
const ENC_BASE64URL = 7;

const encodings = Object.freeze([
  'ascii',
  'utf8',
  'base64',
  'utf16le',
  'latin1',
  'hex',
  'buffer',
  'base64url',
]);

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

const HEX_TABLE: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return '';
  const safe =
    typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer
      ? bytes.slice()
      : bytes;
  return utf8Decoder.decode(safe);
}

function decodeAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i] & 0x7f);
  }
  return out;
}

function decodeLatin1(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function decodeHex(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    out += HEX_TABLE[bytes[i]];
  }
  return out;
}

function decodeUtf16LE(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i + 1 < end; i += 2) {
    out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return out;
}

function encodeBase64(bytes: Uint8Array, urlSafe: boolean): string {
  if (bytes.byteLength === 0) return '';
  const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  if (!urlSafe) return base64;
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(state: Uint8Array, buf: ArrayBufferView): string {
  const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = raw.byteLength;
  const enc = state[kEncodingField];

  if (enc === ENC_ASCII) return decodeAscii(raw, 0, len);
  if (enc === ENC_LATIN1) return decodeLatin1(raw, 0, len);
  if (enc === ENC_HEX) return decodeHex(raw, 0, len);

  let missingBytes = state[kMissingBytes];
  let bufferedBytes = state[kBufferedBytes];
  let offset = 0;
  let prepend = '';

  if (enc === ENC_BASE64 || enc === ENC_BASE64URL) {
    const urlSafe = enc === ENC_BASE64URL;
    if (bufferedBytes > 0) {
      const toCopy = Math.min(len, missingBytes);
      for (let i = 0; i < toCopy; i++) {
        state[bufferedBytes + i] = raw[i];
      }
      bufferedBytes += toCopy;
      missingBytes -= toCopy;
      offset += toCopy;
      if (missingBytes > 0) {
        state[kBufferedBytes] = bufferedBytes;
        state[kMissingBytes] = missingBytes;
        return '';
      }
      prepend = encodeBase64(state.subarray(0, 3), urlSafe);
      bufferedBytes = 0;
      missingBytes = 0;
    }
    const remaining = len - offset;
    const trail = remaining % 3;
    if (trail > 0) {
      bufferedBytes = trail;
      missingBytes = 3 - trail;
      for (let i = 0; i < trail; i++) {
        state[i] = raw[len - trail + i];
      }
    }
    const bodyEnd = len - trail;
    const body = bodyEnd > offset ? encodeBase64(raw.subarray(offset, bodyEnd), urlSafe) : '';
    state[kBufferedBytes] = bufferedBytes;
    state[kMissingBytes] = missingBytes;
    return prepend + body;
  }

  if (enc === ENC_UTF16LE) {
    if (bufferedBytes > 0) {
      const toCopy = Math.min(len, missingBytes);
      for (let i = 0; i < toCopy; i++) {
        state[bufferedBytes + i] = raw[i];
      }
      bufferedBytes += toCopy;
      missingBytes -= toCopy;
      offset += toCopy;
      if (missingBytes > 0) {
        state[kBufferedBytes] = bufferedBytes;
        state[kMissingBytes] = missingBytes;
        return '';
      }
      prepend = decodeUtf16LE(state, 0, bufferedBytes);
      bufferedBytes = 0;
      missingBytes = 0;
    }
    const remaining = len - offset;
    let bodyEnd = len;
    if (remaining % 2 === 1) {
      bufferedBytes = 1;
      missingBytes = 1;
      state[0] = raw[len - 1];
      bodyEnd = len - 1;
    } else if (remaining >= 2 && (raw[len - 1] & 0xfc) === 0xd8) {
      bufferedBytes = 2;
      missingBytes = 2;
      state[0] = raw[len - 2];
      state[1] = raw[len - 1];
      bodyEnd = len - 2;
    }
    const body = bodyEnd > offset ? decodeUtf16LE(raw, offset, bodyEnd) : '';
    state[kBufferedBytes] = bufferedBytes;
    state[kMissingBytes] = missingBytes;
    return prepend + body;
  }

  // Default / ENC_UTF8
  if (bufferedBytes > 0) {
    if (len === 0) return '';
    const limit = Math.min(len, missingBytes);
    let i = 0;
    for (; i < limit; i++) {
      if ((raw[i] & 0xc0) !== 0x80) break;
      state[bufferedBytes + i] = raw[i];
    }
    bufferedBytes += i;
    missingBytes -= i;
    offset += i;
    if (missingBytes === 0 || offset < len) {
      prepend = decodeUtf8(state.subarray(0, bufferedBytes));
      bufferedBytes = 0;
      missingBytes = 0;
    } else {
      state[kBufferedBytes] = bufferedBytes;
      state[kMissingBytes] = missingBytes;
      return '';
    }
  }

  const remaining = len - offset;
  let bodyEnd = len;
  if (remaining > 0) {
    const maxCheck = Math.min(remaining, 3);
    for (let j = 1; j <= maxCheck; j++) {
      const b = raw[len - j];
      if ((b & 0x80) === 0x00) break;
      if ((b & 0xc0) === 0x80) continue;
      if ((b & 0xe0) === 0xc0) {
        if (j < 2) {
          bufferedBytes = j;
          missingBytes = 2 - j;
        }
        break;
      }
      if ((b & 0xf0) === 0xe0) {
        if (j < 3) {
          bufferedBytes = j;
          missingBytes = 3 - j;
        }
        break;
      }
      if ((b & 0xf8) === 0xf0) {
        bufferedBytes = j;
        missingBytes = 4 - j;
        break;
      }
      break;
    }
    if (bufferedBytes > 0) {
      bodyEnd = len - bufferedBytes;
      for (let k = 0; k < bufferedBytes; k++) {
        state[k] = raw[bodyEnd + k];
      }
    }
  }

  const body = bodyEnd > offset ? decodeUtf8(raw.subarray(offset, bodyEnd)) : '';
  state[kBufferedBytes] = bufferedBytes;
  state[kMissingBytes] = missingBytes;
  return prepend + body;
}

function flush(state: Uint8Array): string {
  const bufferedBytes = state[kBufferedBytes];
  const enc = state[kEncodingField];
  state[kBufferedBytes] = 0;
  state[kMissingBytes] = 0;
  if (bufferedBytes === 0) return '';

  if (enc === ENC_BASE64 || enc === ENC_BASE64URL) {
    return encodeBase64(state.subarray(0, bufferedBytes), enc === ENC_BASE64URL);
  }
  if (enc === ENC_UTF16LE) {
    const evenBytes = bufferedBytes & ~1;
    return evenBytes > 0 ? decodeUtf16LE(state, 0, evenBytes) : '';
  }
  if (enc === ENC_UTF8) {
    return decodeUtf8(state.subarray(0, bufferedBytes));
  }
  return '';
}

export const stringDecoderBinding = {
  kIncompleteCharactersStart,
  kIncompleteCharactersEnd,
  kMissingBytes,
  kBufferedBytes,
  kEncodingField,
  kNumFields,
  encodings,
  kSize,
  decode,
  flush,
};
