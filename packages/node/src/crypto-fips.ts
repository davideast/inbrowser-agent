import { invalidArgType, validateString } from './crypto-args';

// FIPS mode, the secure heap and engines, as Node 22.18.0 reports them for a
// build with OpenSSL 3, no FIPS provider and no engines. The pinned reference
// binary accepts setFips(true) without a provider, reports 1 afterwards, and
// then refuses every digest with ERR_OSSL_EVP_UNSUPPORTED; this module keeps
// that state and `fipsDigestError` produces that refusal so the guest observes
// the same sequence. Nothing here enforces FIPS validation: the digests are
// plain sha.js.

let enabled = false;

export function getFips(): number {
  return enabled ? 1 : 0;
}

export function setFips(value?: unknown): void {
  enabled = Boolean(value);
}

export function fipsEnabled(): boolean {
  return enabled;
}

const initialization = 'error:03000086:digital envelope routines::initialization error';
const unsupported = 'error:0308010C:digital envelope routines::unsupported';

/** The error Node raises for a digest created while FIPS mode is on. */
export function fipsDigestError(kind: 'hash' | 'hmac'): Error {
  return Object.assign(new Error(unsupported), {
    opensslErrorStack: kind === 'hash' ? [initialization, unsupported] : [initialization],
    library: 'digital envelope routines',
    reason: 'unsupported',
    code: 'ERR_OSSL_EVP_UNSUPPORTED',
  });
}

const ENGINE_METHOD_ALL = 0xffff;

/**
 * Adds getFips/setFips/fips/secureHeapUsed/setEngine to the guest crypto
 * module object. `fips` is a non-enumerable accessor over the same two
 * functions, as in Node.
 */
export function installFips<T extends object>(target: T): T {
  Object.assign(target, {
    getFips,
    setFips,
    secureHeapUsed: () => ({ total: 0, used: 0, utilization: 0, min: 0 }),
    setEngine(id: unknown, flags?: unknown) {
      const name = validateString(id, 'id');
      if (flags === undefined) flags = ENGINE_METHOD_ALL;
      if (typeof flags !== 'number') throw invalidArgType('flags', 'of type number', flags);
      // OpenSSL's built-in "dynamic" loader is the only engine the reference build has.
      if (name === 'dynamic') return;
      throw Object.assign(new Error(`Engine "${name}" was not found`), {
        code: 'ERR_CRYPTO_ENGINE_UNKNOWN',
      });
    },
  });
  return Object.defineProperty(target, 'fips', {
    get: getFips,
    set: setFips,
    enumerable: false,
    configurable: false,
  });
}
