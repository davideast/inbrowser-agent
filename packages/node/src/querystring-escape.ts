// querystring.escape, unescape and unescapeBuffer, ported from Node.js v22.18.0
// lib/querystring.js and lib/internal/querystring.js. Copyright Joyent, Inc. and
// other Node contributors. Released under the MIT license (see LICENSE in the
// Node.js repository). The querystring-es3 polyfill exports neither function.
// Changes: TypeScript types, and the Buffer class is injected so results are guest
// Buffers.

// The injected class is the guest Buffer, a Uint8Array subclass.
type BufferLike = Uint8Array;
interface BufferClass {
  allocUnsafe(size: number): BufferLike;
}

const hexTable: string[] = [];
for (let i = 0; i < 256; ++i)
  hexTable[i] = '%' + (i < 16 ? '0' : '') + i.toString(16).toUpperCase();

// Bytes that need no escaping: ! - . _ ~ ' ( ) * digits and ASCII letters.
const noEscape = new Int8Array(128);
for (const c of "!-._~'()*") noEscape[c.charCodeAt(0)] = 1;
for (let c = 48; c <= 57; c++) noEscape[c] = 1;
for (let c = 65; c <= 90; c++) noEscape[c] = 1;
for (let c = 97; c <= 122; c++) noEscape[c] = 1;

const unhexTable = new Int8Array(256).fill(-1);
for (let c = 0; c < 10; c++) unhexTable[48 + c] = c;
for (let c = 0; c < 6; c++) {
  unhexTable[65 + c] = 10 + c;
  unhexTable[97 + c] = 10 + c;
}

function uriMalformed(): URIError {
  return Object.assign(new URIError('URI malformed'), { code: 'ERR_INVALID_URI' });
}

function encodeStr(str: string): string {
  const len = str.length;
  if (len === 0) return '';
  let out = '';
  let lastPos = 0;
  let i = 0;
  outer: for (; i < len; i++) {
    let c = str.charCodeAt(i);
    while (c < 0x80) {
      if (noEscape[c] !== 1) {
        if (lastPos < i) out += str.slice(lastPos, i);
        lastPos = i + 1;
        out += hexTable[c];
      }
      if (++i === len) break outer;
      c = str.charCodeAt(i);
    }
    if (lastPos < i) out += str.slice(lastPos, i);
    if (c < 0x800) {
      lastPos = i + 1;
      out += hexTable[0xc0 | (c >> 6)] + hexTable[0x80 | (c & 0x3f)];
      continue;
    }
    if (c < 0xd800 || c >= 0xe000) {
      lastPos = i + 1;
      out +=
        hexTable[0xe0 | (c >> 12)] +
        hexTable[0x80 | ((c >> 6) & 0x3f)] +
        hexTable[0x80 | (c & 0x3f)];
      continue;
    }
    // Node treats any surrogate as the start of a pair and only rejects one at the end.
    ++i;
    if (i >= len) throw uriMalformed();
    const c2 = str.charCodeAt(i) & 0x3ff;
    lastPos = i + 1;
    c = 0x10000 + (((c & 0x3ff) << 10) | c2);
    out +=
      hexTable[0xf0 | (c >> 18)] +
      hexTable[0x80 | ((c >> 12) & 0x3f)] +
      hexTable[0x80 | ((c >> 6) & 0x3f)] +
      hexTable[0x80 | (c & 0x3f)];
  }
  if (lastPos === 0) return str;
  if (lastPos < len) return out + str.slice(lastPos);
  return out;
}

export function createQueryStringEscapes(Buffer: BufferClass) {
  function unescapeBuffer(s: string, decodeSpaces?: boolean): BufferLike {
    const out = Buffer.allocUnsafe(s.length);
    let index = 0;
    let outIndex = 0;
    let currentChar: number;
    const maxLength = s.length - 2;
    let hasHex = false;
    while (index < s.length) {
      currentChar = s.charCodeAt(index);
      if (currentChar === 43 /* '+' */ && decodeSpaces) {
        out[outIndex++] = 32;
        index++;
        continue;
      }
      if (currentChar === 37 /* '%' */ && index < maxLength) {
        currentChar = s.charCodeAt(++index);
        const hexHigh = unhexTable[currentChar];
        if (!(hexHigh >= 0)) {
          out[outIndex++] = 37;
          continue;
        }
        const nextChar = s.charCodeAt(++index);
        const hexLow = unhexTable[nextChar];
        if (!(hexLow >= 0)) {
          out[outIndex++] = 37;
          index--;
        } else {
          hasHex = true;
          currentChar = hexHigh * 16 + hexLow;
        }
      }
      out[outIndex++] = currentChar;
      index++;
    }
    return hasHex ? out.slice(0, outIndex) : out;
  }

  function qsUnescape(s: string, decodeSpaces?: boolean): string {
    try {
      return decodeURIComponent(s);
    } catch {
      // V8's UTF-8 decoder (as Node's Buffer#toString uses) replaces a truncated
      // sequence by one U+FFFD; the bundled buffer package emits one per byte.
      return new TextDecoder().decode(unescapeBuffer(s, decodeSpaces));
    }
  }

  function qsEscape(str: unknown): string {
    if (typeof str !== 'string') {
      if (typeof str === 'object') str = String(str);
      else str += '';
    }
    return encodeStr(str as string);
  }

  return { escape: qsEscape, unescape: qsUnescape, unescapeBuffer };
}
