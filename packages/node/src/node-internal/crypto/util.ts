// Browser-safe `internal/crypto/util` bridge enabling `isDeepStrictEqual` and
// `util.inspect` parity on `KeyObject` and WebCrypto `CryptoKey` instances.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { KeyObject, isCryptoKey, isKeyObject } from '../../crypto-keys';

export const kKeyObject = Symbol('kKeyObject');

const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
const kKeyType = Symbol('kKeyType');

type InspectFn = (value: unknown, options?: Record<string, unknown>) => string;

if (typeof globalThis.CryptoKey === 'function') {
  const cryptoKeyProto: object = globalThis.CryptoKey.prototype;

  if (!Object.getOwnPropertyDescriptor(cryptoKeyProto, kKeyObject)) {
    Object.defineProperty(cryptoKeyProto, kKeyObject, {
      get(this: CryptoKey): unknown {
        if (!isCryptoKey(this)) return undefined;
        try {
          return KeyObject.from(this);
        } catch {
          return undefined;
        }
      },
      enumerable: false,
      configurable: true,
    });
  }

  if (!Object.getOwnPropertyDescriptor(cryptoKeyProto, customInspectSymbol)) {
    Object.defineProperty(cryptoKeyProto, customInspectSymbol, {
      value: function inspectCryptoKey(
        this: CryptoKey,
        depth: number,
        options: Record<string, unknown> | undefined,
        inspect: InspectFn,
      ): unknown {
        if (!isCryptoKey(this)) return this;
        if (depth < 0) return this;
        const nextDepth = typeof options?.depth === 'number' ? options.depth - 1 : null;
        return `CryptoKey ${inspect(
          {
            type: this.type,
            extractable: this.extractable,
            algorithm: this.algorithm,
            usages: this.usages,
          },
          { ...options, depth: nextDepth },
        )}`;
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

const keyObjectProto: object = KeyObject.prototype;
if (!Object.getOwnPropertyDescriptor(keyObjectProto, customInspectSymbol)) {
  Object.defineProperty(keyObjectProto, customInspectSymbol, {
    value: function inspectKeyObject(
      this: KeyObject,
      depth: number,
      options: Record<string, unknown> | undefined,
      inspect: InspectFn,
    ): unknown {
      if (!isKeyObject(this)) return this;
      if (depth < 0) return this;
      const proto: unknown = Object.getPrototypeOf(this);
      const safeProto = typeof proto === 'object' ? proto : null;
      const standIn = Object.setPrototypeOf({ [kKeyType]: this.type }, safeProto);
      return inspect(standIn, { ...options, getters: false, customInspect: false });
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
