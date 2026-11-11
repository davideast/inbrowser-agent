import {
  invalidArgType,
  outOfRange,
  resolveDigest,
  stringBytes,
  typeList,
  validateInteger,
  validateString,
  viewBytes,
} from './crypto-args';
import { fipsEnabled } from './crypto-fips';
import { hmac } from './crypto-hmac';
import { extractHkdfSecretKeyBytes } from './crypto-keys';

// HKDF (RFC 5869) over the HMAC in crypto-hmac.ts, with Node 22's validation
// order, error codes and ArrayBuffer result.

const ikmTypes = typeList(
  ['string'],
  ['SecretKeyObject', 'ArrayBuffer', 'TypedArray', 'DataView', 'Buffer'],
);
const byteTypes = typeList(['string'], ['ArrayBuffer', 'TypedArray', 'DataView', 'Buffer']);

function byteSource(value: unknown, name: string): Uint8Array {
  if (typeof value === 'string') return stringBytes(value, undefined);
  const bytes = viewBytes(value);
  if (bytes === undefined) throw invalidArgType(name, byteTypes, value);
  return bytes;
}

interface Parameters {
  digest: string;
  ikm: Uint8Array;
  salt: Uint8Array;
  info: Uint8Array;
  length: number;
}

function validateParameters(
  digest: unknown,
  ikm: unknown,
  salt: unknown,
  info: unknown,
  length: unknown,
): Parameters {
  const digestName = validateString(digest, 'digest');
  let ikmBytes: Uint8Array;
  const secretBytes = extractHkdfSecretKeyBytes(ikm);
  if (secretBytes !== undefined) ikmBytes = secretBytes;
  else if (typeof ikm === 'string') ikmBytes = stringBytes(ikm, undefined);
  else {
    const bytes = viewBytes(ikm);
    if (bytes === undefined) throw invalidArgType('ikm', ikmTypes, ikm);
    ikmBytes = bytes;
  }
  const saltBytes = byteSource(salt, 'salt');
  const infoBytes = byteSource(info, 'info');
  const keyLength = validateInteger(length, 'length', 0, Number.MAX_SAFE_INTEGER);
  if (infoBytes.byteLength > 1024)
    throw outOfRange('info', 'must not contain more than 1024 bytes', infoBytes.byteLength);
  return { digest: digestName, ikm: ikmBytes, salt: saltBytes, info: infoBytes, length: keyLength };
}

/** Resolves the digest and key length the way Node's job constructor does. */
function prepare(parameters: Parameters) {
  const digest = resolveDigest(parameters.digest);
  if (parameters.length > 255 * digest.size)
    throw Object.assign(new RangeError('Invalid key length'), {
      code: 'ERR_CRYPTO_INVALID_KEYLEN',
    });
  return digest;
}

function derive(parameters: Parameters, digest: ReturnType<typeof resolveDigest>): ArrayBuffer {
  // Node's FIPS-without-provider state fails the derivation the same way a zero length does.
  if (parameters.length === 0 || fipsEnabled()) throw new Error('Deriving bits failed');
  const prk = hmac(
    digest,
    parameters.salt.length === 0 ? new Uint8Array(digest.size) : parameters.salt,
    parameters.ikm,
  );
  const output = new Uint8Array(parameters.length);
  let previous: Uint8Array = new Uint8Array(0);
  for (let counter = 1, offset = 0; offset < output.length; counter++, offset += digest.size) {
    previous = hmac(digest, prk, previous, parameters.info, Uint8Array.of(counter));
    output.set(previous.subarray(0, output.length - offset), offset);
  }
  return output.buffer;
}

export function createHkdf(defer: (callback: () => void) => void) {
  return {
    hkdfSync(digest: unknown, ikm: unknown, salt: unknown, info: unknown, length: unknown) {
      const parameters = validateParameters(digest, ikm, salt, info, length);
      return derive(parameters, prepare(parameters));
    },
    hkdf(
      digest: unknown,
      ikm: unknown,
      salt: unknown,
      info: unknown,
      length: unknown,
      callback: unknown,
    ) {
      const parameters = validateParameters(digest, ikm, salt, info, length);
      if (typeof callback !== 'function')
        throw invalidArgType('callback', 'of type function', callback);
      const resolved = prepare(parameters);
      defer(() => {
        let key: ArrayBuffer | undefined;
        let failure: Error | null = null;
        try {
          key = derive(parameters, resolved);
        } catch (error) {
          failure = error as Error;
        }
        // Node calls the callback with its internal job as `this`.
        if (failure === null) Reflect.apply(callback, {}, [null, key]);
        else Reflect.apply(callback, {}, [failure]);
      });
    },
  };
}
