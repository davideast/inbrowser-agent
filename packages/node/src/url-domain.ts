// url.domainToASCII and url.domainToUnicode after Node.js v22.18.0 (lib/url.js and
// src/node_url.cc, Copyright Joyent, Inc. and other Node contributors, MIT license).
//
// Node parses the input as the hostname of a `ws://x` URL (ada's set_hostname)
// and answers the empty string when that fails. The platform's URL hostname
// setter applies the same WHATWG host parser (UTS-46 mapping, punycode,
// IPv4/IPv6), but it fails silently, so failure is detected with two throwaway
// URLs that start from different hosts: a rejected input leaves them different.
// domainToUnicode then decodes each `xn--` label with the punycode decoder from
// Node's lib/punycode.js (Copyright Mathias Bynens, MIT license).
import { nodeError } from './node-errors';

function setHostname(domain: string): string {
  const first = new URL('ws://x');
  const second = new URL('ws://y');
  first.hostname = domain;
  second.hostname = domain;
  return first.hostname === second.hostname ? first.hostname : '';
}

// Canonical combining class 9 (a virama), found through normalization: a mark
// reorders past a mark of higher class (U+05B0, class 10) and behind one of
// lower class (U+3099, class 8) exactly when its own class is 9.
function isVirama(character: string): boolean {
  return (
    `\u05b0${character}`.normalize('NFD') === `${character}\u05b0` &&
    `${character}\u3099`.normalize('NFD') === `\u3099${character}`
  );
}

const cursive =
  /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Mandaic}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Phags_Pa}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Manichaean}\p{Script=Psalter_Pahlavi}\p{Script=Sogdian}]$/u;
const mark = /^\p{Mn}$/u;

/** A ZWNJ at `at` between cursive letters, skipping non-spacing marks. */
function joined(points: string[], at: number): boolean {
  let before = at - 1;
  while (before >= 0 && mark.test(points[before])) before--;
  let after = at + 1;
  while (after < points.length && mark.test(points[after])) after++;
  return (
    before >= 0 &&
    after < points.length &&
    cursive.test(points[before]) &&
    cursive.test(points[after])
  );
}

/**
 * The ASCII host ada's set_hostname would produce, or '' when it fails. Chromium's
 * host parser is more lenient than ada in three observable ways, which are
 * rejected here: it percent-encodes forbidden code points (so a `%` in the
 * result means one was present), it accepts any `xn--` label, and it accepts a
 * ZWJ without a preceding virama (UTS 46 CheckJoiners). A ZWNJ is accepted after
 * a virama or between two letters of a cursive script; the exact rule needs
 * joining types that JavaScript does not expose, so non-joining letters such as
 * Arabic alef are not told apart.
 */
function hostnameOf(domain: string): string {
  if (domain === '') return '';
  const hostname = setHostname(domain);
  if (hostname === '' || hostname.includes('%')) return '';
  const labels = hostname.split('.');
  for (const [index, label] of labels.entries()) {
    if (!label.startsWith('xn--')) continue;
    const decoded = decode(label.slice(4));
    // A valid label is its own UTS 46 mapping and encodes back to itself. It is
    // checked in place: the bidi rules depend on the other labels.
    if (decoded === undefined) return '';
    const unicode = labels.map((other, at) => (at === index ? decoded : other)).join('.');
    if (setHostname(unicode) !== hostname) return '';
    const points = Array.from(decoded);
    for (let i = 0; i < points.length; i++) {
      if (points[i] === '\u200d' && (i === 0 || !isVirama(points[i - 1]))) return '';
      if (points[i] === '\u200c' && !(i > 0 && isVirama(points[i - 1])) && !joined(points, i))
        return '';
    }
  }
  return hostname;
}

const base = 36;
const tMin = 1;
const tMax = 26;
const skew = 38;
const damp = 700;
const initialBias = 72;
const initialN = 128;
const maxInt = 0x7fffffff;

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let k = 0;
  delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
  return Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
}

function basicToDigit(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint < 0x3a) return 26 + (codePoint - 0x30);
  if (codePoint >= 0x41 && codePoint < 0x5b) return codePoint - 0x41;
  if (codePoint >= 0x61 && codePoint < 0x7b) return codePoint - 0x61;
  return base;
}

/** Punycode decode (RFC 3492); undefined when the input is not valid punycode. */
function decode(input: string): string | undefined {
  const output: number[] = [];
  let i = 0;
  let n = initialN;
  let bias = initialBias;
  const basic = Math.max(input.lastIndexOf('-'), 0);
  for (let j = 0; j < basic; ++j) {
    if (input.charCodeAt(j) >= 0x80) return undefined;
    output.push(input.charCodeAt(j));
  }
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= input.length) return undefined;
      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= base || digit > Math.floor((maxInt - i) / w)) return undefined;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      if (w > Math.floor(maxInt / (base - t))) return undefined;
      w *= base - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (Math.floor(i / out) > maxInt - n) return undefined;
    n += Math.floor(i / out);
    i %= out;
    output.splice(i++, 0, n);
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return undefined;
  }
}

function missingDomain() {
  return nodeError(TypeError, 'ERR_MISSING_ARGS', 'The "domain" argument must be specified');
}

// Named as Node's functions; the bundler may rename declarations.
function named<T extends (...args: never[]) => unknown>(fn: T, name: string): T {
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

export const domainToASCII = named(function domainToASCII(domain: unknown): string {
  if (arguments.length < 1) throw missingDomain();
  return hostnameOf(`${domain as string}`);
}, 'domainToASCII');

export const domainToUnicode = named(function domainToUnicode(domain: unknown): string {
  if (arguments.length < 1) throw missingDomain();
  const hostname = hostnameOf(`${domain as string}`);
  return hostname
    .split('.')
    .map((label) => {
      if (!label.startsWith('xn--')) return label;
      return decode(label.slice(4)) ?? label;
    })
    .join('.');
}, 'domainToUnicode');
