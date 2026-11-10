const MAX_INT = 2147483647; // 0x7FFFFFFF
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128; // 0x80
const DELIMITER = '-';
const BASE_MINUS_T_MIN = BASE - T_MIN;

const REGEX_PUNYCODE = /^xn--/;
const REGEX_NON_ASCII = /[^\0-\x7F]/;
const REGEX_SEPARATORS = /[\x2E\u3002\uFF0E\uFF61]/g;

type PunycodeErrorKind = 'overflow' | 'not-basic' | 'invalid-input';

const ERROR_MESSAGES: Record<PunycodeErrorKind, string> = {
  overflow: 'Overflow: input needs wider integers to process',
  'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
  'invalid-input': 'Invalid input',
};

function punycodeError(kind: PunycodeErrorKind): never {
  throw new RangeError(ERROR_MESSAGES[kind]);
}

function mapLabels<T, R>(items: readonly T[], fn: (item: T) => R): R[] {
  const result = new Array<R>(items.length);
  for (let i = 0; i < items.length; i += 1) {
    result[i] = fn(items[i]);
  }
  return result;
}

function mapDomain(domain: string, fn: (label: string) => string): string {
  const parts = String(domain).split('@');
  let prefix = '';
  let host = String(domain);
  if (parts.length > 1) {
    prefix = `${parts[0]}@`;
    host = parts[1];
  }
  const normalized = host.replace(REGEX_SEPARATORS, '\x2E');
  const labels = normalized.split('.');
  return prefix + mapLabels(labels, fn).join('.');
}

function ucs2decode(str: string): number[] {
  const input = String(str);
  const output: number[] = [];
  let counter = 0;
  const length = input.length;
  while (counter < length) {
    const value = input.charCodeAt(counter);
    counter += 1;
    if (value >= 0xd800 && value <= 0xdbff && counter < length) {
      const extra = input.charCodeAt(counter);
      counter += 1;
      if ((extra & 0xfc00) === 0xdc00) {
        output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
      } else {
        output.push(value);
        counter -= 1;
      }
    } else {
      output.push(value);
    }
  }
  return output;
}

const ucs2encode = (codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);

function basicToDigit(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint < 0x3a) {
    return 26 + (codePoint - 0x30);
  }
  if (codePoint >= 0x41 && codePoint < 0x5b) {
    return codePoint - 0x41;
  }
  if (codePoint >= 0x61 && codePoint < 0x7b) {
    return codePoint - 0x61;
  }
  return BASE;
}

function digitToBasic(digit: number, flag: number): number {
  return digit + 22 + 75 * (digit < 26 ? 1 : 0) - ((flag !== 0 ? 1 : 0) << 5);
}

function adapt(deltaValue: number, numPoints: number, firstTime: boolean): number {
  let delta = firstTime ? Math.floor(deltaValue / DAMP) : deltaValue >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > (BASE_MINUS_T_MIN * T_MAX) >> 1) {
    delta = Math.floor(delta / BASE_MINUS_T_MIN);
    k += BASE;
  }
  return Math.floor(k + ((BASE_MINUS_T_MIN + 1) * delta) / (delta + SKEW));
}

function decode(rawInput: string): string {
  const input = String(rawInput);
  const output: number[] = [];
  const inputLength = input.length;
  let i = 0;
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;

  let basic = input.lastIndexOf(DELIMITER);
  if (basic < 0) {
    basic = 0;
  }

  for (let j = 0; j < basic; j += 1) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) {
      punycodeError('not-basic');
    }
    output.push(code);
  }

  for (let index = basic > 0 ? basic + 1 : 0; index < inputLength; ) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= inputLength) {
        punycodeError('invalid-input');
      }
      const digit = basicToDigit(input.charCodeAt(index));
      index += 1;
      if (digit >= BASE) {
        punycodeError('invalid-input');
      }
      if (digit > Math.floor((MAX_INT - i) / w)) {
        punycodeError('overflow');
      }
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) {
        break;
      }
      const baseMinusT = BASE - t;
      if (w > Math.floor(MAX_INT / baseMinusT)) {
        punycodeError('overflow');
      }
      w *= baseMinusT;
    }

    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (Math.floor(i / out) > MAX_INT - n) {
      punycodeError('overflow');
    }
    n += Math.floor(i / out);
    i %= out;
    output.splice(i, 0, n);
    i += 1;
  }

  return String.fromCodePoint(...output);
}

function encode(rawInput: string): string {
  const output: string[] = [];
  const codePoints = ucs2decode(String(rawInput));
  const inputLength = codePoints.length;

  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;

  for (const cp of codePoints) {
    if (cp < 0x80) {
      output.push(String.fromCharCode(cp));
    }
  }

  const basicLength = output.length;
  let handledCPCount = basicLength;

  if (basicLength > 0) {
    output.push(DELIMITER);
  }

  while (handledCPCount < inputLength) {
    let m = MAX_INT;
    for (const cp of codePoints) {
      if (cp >= n && cp < m) {
        m = cp;
      }
    }

    const handledPlusOne = handledCPCount + 1;
    if (m - n > Math.floor((MAX_INT - delta) / handledPlusOne)) {
      punycodeError('overflow');
    }

    delta += (m - n) * handledPlusOne;
    n = m;

    for (const cp of codePoints) {
      if (cp < n) {
        delta += 1;
        if (delta > MAX_INT) {
          punycodeError('overflow');
        }
      }
      if (cp === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
          if (q < t) {
            break;
          }
          const qMinusT = q - t;
          const baseMinusT = BASE - t;
          output.push(String.fromCharCode(digitToBasic(t + (qMinusT % baseMinusT), 0)));
          q = Math.floor(qMinusT / baseMinusT);
        }
        output.push(String.fromCharCode(digitToBasic(q, 0)));
        bias = adapt(delta, handledPlusOne, handledCPCount === basicLength);
        delta = 0;
        handledCPCount += 1;
      }
    }

    delta += 1;
    n += 1;
  }

  return output.join('');
}

function toUnicode(input: string): string {
  return mapDomain(input, (label) =>
    REGEX_PUNYCODE.test(label) ? decode(label.slice(4).toLowerCase()) : label,
  );
}

function toASCII(input: string): string {
  return mapDomain(input, (label) =>
    REGEX_NON_ASCII.test(label) ? `xn--${encode(label)}` : label,
  );
}

export interface PunycodeBuiltin {
  version: string;
  ucs2: {
    decode: (str: string) => number[];
    encode: (codePoints: readonly number[]) => string;
  };
  decode: (input: string) => string;
  encode: (input: string) => string;
  toASCII: (input: string) => string;
  toUnicode: (input: string) => string;
}

export function createPunycodeBuiltin(): PunycodeBuiltin {
  return {
    version: '2.1.0',
    ucs2: {
      decode: ucs2decode,
      encode: ucs2encode,
    },
    decode,
    encode,
    toASCII,
    toUnicode,
  };
}
