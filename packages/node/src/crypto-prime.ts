import { captured } from './context-hook';
import { invalidArgType, outOfRange, typeList, validateInteger, viewBytes } from './crypto-args';
import { bytesToBigInt, modPow } from './crypto-asn1';

const fill = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

const SMALL_PRIMES: readonly bigint[] = (() => {
  const limit = 2000;
  const sieve = new Uint8Array(limit + 1);
  const out: bigint[] = [];
  for (let i = 2; i <= limit; i++) {
    if (sieve[i] === 0) {
      out.push(BigInt(i));
      for (let j = i * i; j <= limit; j += i) {
        sieve[j] = 1;
      }
    }
  }
  return out;
})();

const FIXED_BASES: readonly bigint[] = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];

function fillRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536) {
    fill(out.subarray(offset, Math.min(offset + 65536, length)));
  }
  return out;
}

function randomBaseBelow(nMinusOne: bigint, byteLen: number): bigint {
  const range = nMinusOne - 2n;
  if (range <= 1n) return 2n;
  const raw = bytesToBigInt(fillRandomBytes(byteLen));
  return 2n + (raw % range);
}

function millerRabinWitness(
  a: bigint,
  d: bigint,
  s: number,
  n: bigint,
  nMinusOne: bigint,
): boolean {
  let x = modPow(a, d, n);
  if (x === 1n || x === nMinusOne) return true;
  for (let r = 1; r < s; r++) {
    x = (x * x) % n;
    if (x === nMinusOne) return true;
    if (x === 1n) return false;
  }
  return false;
}

export function isProbablePrime(n: bigint, checks = 0): boolean {
  if (n < 2n) return false;
  if (n === 2n || n === 3n) return true;
  if ((n & 1n) === 0n) return false;

  for (let i = 1; i < SMALL_PRIMES.length; i++) {
    const p = SMALL_PRIMES[i]!;
    if (n === p) return true;
    if (n % p === 0n) return false;
    if (p * p > n) return true;
  }

  const nMinusOne = n - 1n;
  let d = nMinusOne;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }

  // First run the first 12 prime bases (deterministic for all 64-bit unsigned integers).
  for (const base of FIXED_BASES) {
    if (base >= nMinusOne) break;
    if (!millerRabinWitness(base, d, s, n, nMinusOne)) {
      return false;
    }
  }

  const extraRounds = checks > 0 ? checks : n > 1n << 64n ? 16 : 0;
  if (extraRounds > 0 && nMinusOne > 40n) {
    const byteLen = Math.max(8, Math.ceil(n.toString(16).length / 2));
    for (let i = 0; i < extraRounds; i++) {
      const a = randomBaseBelow(nMinusOne, byteLen);
      if (!millerRabinWitness(a, d, s, n, nMinusOne)) {
        return false;
      }
    }
  }
  return true;
}

function isSafePrimeCandidate(p: bigint): boolean {
  if ((p & 3n) !== 3n) return false;
  // Simultaneous small-prime sieve on p and q = (p - 1) / 2 (where q % r === 0 <=> p % r === 1).
  for (let i = 1; i < SMALL_PRIMES.length; i++) {
    const r = SMALL_PRIMES[i]!;
    if (p === r) return false;
    const rem = p % r;
    if (rem === 0n || rem === 1n) {
      if (rem === 1n && (p - 1n) / 2n === r) continue;
      return false;
    }
  }
  const q = (p - 1n) >> 1n;
  return isProbablePrime(q, 0) && isProbablePrime(p, 0);
}

const candidateExpectedTypes = typeList(
  ['bigint'],
  ['ArrayBuffer', 'TypedArray', 'Buffer', 'DataView'],
);

function parseCandidateOrModulus(value: unknown, name: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw outOfRange(name, '>= 0', `${value}n`);
    }
    return value;
  }
  const bytes = viewBytes(value);
  if (bytes === undefined) {
    throw invalidArgType(name, candidateExpectedTypes, value);
  }
  return bytesToBigInt(bytes);
}

function validatePlainOptions(options: unknown): Record<string, unknown> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw invalidArgType('options', 'of type object', options);
  }
  return options as Record<string, unknown>;
}

function validateBooleanField(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidArgType(name, 'of type boolean', value);
  }
  return value;
}

function bitsTooSmallError(): Error {
  return new Error('error:01800076:bignum routines::bits too small');
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function bigIntToPrimeArrayBuffer(value: bigint): ArrayBuffer {
  const hex = value.toString(16);
  const padded = hex.length % 2 === 1 ? `0${hex}` : hex;
  const byteLen = padded.length / 2;
  const ab = new ArrayBuffer(byteLen);
  const out = new Uint8Array(ab);
  for (let i = 0; i < byteLen; i++) {
    out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return ab;
}

function generatePrimeCore(
  size: number,
  safe: boolean,
  addVal: bigint | undefined,
  remVal: bigint | undefined,
): bigint {
  if (size < 2) {
    throw bitsTooSmallError();
  }
  const upperBound = 1n << BigInt(size);
  const lowerBound = 1n << BigInt(size - 1);

  if (addVal === undefined || addVal === 0n) {
    if (safe) {
      if (size < 3 || size === 4) {
        throw bitsTooSmallError();
      }
      if (size === 3) {
        return 7n;
      }
      if (size === 5) {
        // Only 5-bit safe prime with MSB=1 is 23 (since (23-1)/2 = 11; 27 & 31 fail).
        return 23n;
      }
    } else if (size === 2) {
      return 3n;
    } else if (size === 3) {
      return 7n;
    }

    const byteLen = Math.ceil(size / 8);
    const topMaskBits = size % 8 === 0 ? 8 : size % 8;
    const topByteMask = (1 << topMaskBits) - 1;
    // OpenSSL sets the top two bits of generated primes so p*q has exact 2*size bits.
    const minWithTopTwo = lowerBound | (1n << BigInt(size - 2));

    for (;;) {
      const randBytes = fillRandomBytes(byteLen);
      randBytes[0] &= topByteMask;
      let candidate = bytesToBigInt(randBytes) | minWithTopTwo | (safe ? 3n : 1n);
      const step = safe ? 4n : 2n;
      while (candidate < upperBound) {
        if (safe ? isSafePrimeCandidate(candidate) : isProbablePrime(candidate, 0)) {
          return candidate;
        }
        candidate += step;
      }
    }
  }

  // Constrained generation: p % addVal === targetRem
  if (addVal >= upperBound) {
    throw new Error('error:0180006B:bignum routines::invalid range');
  }
  const defaultRem = safe ? 3n : 1n;
  const targetRem = (remVal !== undefined ? remVal : defaultRem) % addVal;
  const g = gcdBigInt(addVal, targetRem === 0n ? addVal : targetRem);
  if (g > 1n && lowerBound > g) {
    throw new Error('error:01800065:bignum routines::bad reciprocal');
  }

  const byteLen = Math.ceil(size / 8);
  const topMaskBits = size % 8 === 0 ? 8 : size % 8;
  const topByteMask = (1 << topMaskBits) - 1;

  for (let outer = 0; outer < 4096; outer++) {
    const randBytes = fillRandomBytes(byteLen);
    randBytes[0] &= topByteMask;
    let candidate = bytesToBigInt(randBytes) | lowerBound;
    const curRem = candidate % addVal;
    const delta = targetRem >= curRem ? targetRem - curRem : addVal - (curRem - targetRem);
    candidate += delta;
    if ((candidate & 1n) === 0n) {
      if ((addVal & 1n) === 0n) {
        throw new Error('error:01800065:bignum routines::bad reciprocal');
      }
      candidate += addVal;
    }
    const step = (addVal & 1n) === 1n ? addVal * 2n : addVal;
    while (candidate < upperBound) {
      if (safe ? isSafePrimeCandidate(candidate) : isProbablePrime(candidate, 0)) {
        return candidate;
      }
      candidate += step;
    }
  }
  throw bitsTooSmallError();
}

export function createPrimes(retain: () => () => void) {
  function checkPrimeSync(candidate: unknown, options: unknown = {}): boolean {
    const n = parseCandidateOrModulus(candidate, 'candidate');
    const opts = validatePlainOptions(options);
    const checksRaw = opts.checks ?? 0;
    const checks = validateInteger(checksRaw, 'options.checks', 0, 0x7fffffff);
    return isProbablePrime(n, checks);
  }

  function checkPrime(candidate: unknown, optionsArg?: unknown, callbackArg?: unknown): void {
    const n = parseCandidateOrModulus(candidate, 'candidate');
    let options: unknown = optionsArg ?? {};
    let callback: unknown = callbackArg;
    if (typeof optionsArg === 'function') {
      callback = optionsArg;
      options = {};
    }
    if (typeof callback !== 'function') {
      throw invalidArgType('callback', 'of type function', callback);
    }
    const opts = validatePlainOptions(options);
    const checksRaw = opts.checks ?? 0;
    const checks = validateInteger(checksRaw, 'options.checks', 0, 0x7fffffff);

    const done = captured(callback as (err: Error | undefined, result?: boolean) => void);
    const release = retain();
    queueMicrotask(() => {
      try {
        const res = isProbablePrime(n, checks);
        done(undefined, res);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      } finally {
        release();
      }
    });
  }

  function parseGenerateOptions(options: unknown): {
    safe: boolean;
    bigint: boolean;
    addVal: bigint | undefined;
    remVal: bigint | undefined;
  } {
    const opts = validatePlainOptions(options);
    const safe = validateBooleanField(opts.safe ?? false, 'options.safe');
    const bigint = validateBooleanField(opts.bigint ?? false, 'options.bigint');
    const addVal =
      opts.add !== undefined ? parseCandidateOrModulus(opts.add, 'options.add') : undefined;
    const remVal =
      opts.rem !== undefined ? parseCandidateOrModulus(opts.rem, 'options.rem') : undefined;
    return { safe, bigint, addVal, remVal };
  }

  function generatePrimeSync(sizeArg: unknown, options: unknown = {}): ArrayBuffer | bigint {
    const size = validateInteger(sizeArg, 'size', 1, 0x7fffffff);
    const { safe, bigint, addVal, remVal } = parseGenerateOptions(options);
    const prime = generatePrimeCore(size, safe, addVal, remVal);
    return bigint ? prime : bigIntToPrimeArrayBuffer(prime);
  }

  function generatePrime(sizeArg: unknown, optionsArg?: unknown, callbackArg?: unknown): void {
    const size = validateInteger(sizeArg, 'size', 1, 0x7fffffff);
    let options: unknown = optionsArg ?? {};
    let callback: unknown = callbackArg;
    if (typeof optionsArg === 'function') {
      callback = optionsArg;
      options = {};
    }
    if (typeof callback !== 'function') {
      throw invalidArgType('callback', 'of type function', callback);
    }
    const { safe, bigint, addVal, remVal } = parseGenerateOptions(options);

    const done = captured(
      callback as (err: Error | undefined, result?: ArrayBuffer | bigint) => void,
    );
    const release = retain();
    queueMicrotask(() => {
      try {
        const prime = generatePrimeCore(size, safe, addVal, remVal);
        done(undefined, bigint ? prime : bigIntToPrimeArrayBuffer(prime));
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      } finally {
        release();
      }
    });
  }

  return { checkPrime, checkPrimeSync, generatePrime, generatePrimeSync };
}
