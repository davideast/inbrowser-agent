// Browser-safe `internal/util` helpers required by Wave 1 upstream Node `lib/` modules.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { stripVTControlCharacters } from '../util-format';
import { createDeprecate, createPromisify, kCustomPromisifiedSymbol } from '../util-promisify';
import { activeProcess } from './process-ref';
import { isNativeError } from './util/types';
import {
  cloneSystemErrorMap as getSystemErrorMap,
  lookupUvErrorMessage as getSystemErrorMessage,
  lookupUvErrorName as getSystemErrorName,
} from './uv-errmap';

export const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
export const kIsEncodingSymbol = Symbol('kIsEncodingSymbol');
export const isWindows = false;
export const isMacOS = false;
export const encodingsMap: Readonly<Record<string, number>> = Object.freeze({
  ascii: 0,
  utf8: 1,
  base64: 2,
  utf16le: 3,
  latin1: 4,
  hex: 5,
  buffer: 6,
  base64url: 7,
});
export { kCustomPromisifiedSymbol, getSystemErrorMap, getSystemErrorMessage, getSystemErrorName };

const nativeDispose: unknown = Reflect.get(Symbol, 'dispose');
export const SymbolDispose: symbol =
  typeof nativeDispose === 'symbol' ? nativeDispose : Symbol.for('nodejs.dispose');

const nativeAsyncDispose: unknown = Reflect.get(Symbol, 'asyncDispose');
export const SymbolAsyncDispose: symbol =
  typeof nativeAsyncDispose === 'symbol' ? nativeAsyncDispose : Symbol.for('nodejs.asyncDispose');

// Invariant: `Object.create(null)` frozen immediately has zero own or inherited properties.
export const kEmptyObject: Readonly<Record<string, never>> = Object.freeze(
  Object.create(null) as Record<string, never>,
);

export function isError(e: unknown): e is Error {
  return isNativeError(e) || e instanceof Error;
}

export const deprecate = createDeprecate(() => activeProcess());
export const promisify = createPromisify(() => activeProcess());

export function join(output: unknown[], separator: string): string {
  return Array.prototype.join.call(output, separator);
}

export const removeColors = stripVTControlCharacters;

export function spliceOne(list: unknown[], index: number): void {
  for (; index + 1 < list.length; index++) {
    list[index] = list[index + 1];
  }
  list.pop();
}

export function getLazy<T>(initializer: () => T): () => T {
  let value: T;
  let initialized = false;
  return function lazyValue(): T {
    if (!initialized) {
      value = initializer();
      initialized = true;
    }
    return value;
  };
}

export class WeakReference<T extends object> {
  #weak: WeakRef<T>;
  #strong: T | undefined = undefined;
  #refCount = 0;

  constructor(target: T) {
    this.#weak = new WeakRef(target);
  }

  get(): T | undefined {
    return this.#strong ?? this.#weak.deref();
  }

  incRef(): number {
    this.#refCount++;
    if (this.#refCount === 1) {
      this.#strong = this.#weak.deref();
    }
    return this.#refCount;
  }

  decRef(): number {
    if (this.#refCount > 0) {
      this.#refCount--;
      if (this.#refCount === 0) {
        this.#strong = undefined;
      }
    }
    return this.#refCount;
  }
}

export function assignFunctionName<T extends (...args: never[]) => unknown>(
  name: string | symbol,
  fn: T,
  descriptor: PropertyDescriptor = kEmptyObject,
): T {
  let resolvedName: string;
  if (typeof name !== 'string') {
    const symbolDescription = name.description;
    if (symbolDescription === undefined) {
      throw new TypeError('Attempted to name function after descriptionless Symbol');
    }
    resolvedName = `[${symbolDescription}]`;
  } else {
    resolvedName = name;
  }
  return Object.defineProperty(fn, 'name', {
    writable: false,
    enumerable: false,
    configurable: true,
    ...Object.getOwnPropertyDescriptor(fn, 'name'),
    ...descriptor,
    value: resolvedName,
  });
}

export function preserveFunctionNames(entries: ReadonlyArray<readonly [unknown, string]>): void {
  for (const [fn, expectedName] of entries) {
    if (typeof fn === 'function' && fn.name !== expectedName) {
      Object.defineProperty(fn, 'name', { value: expectedName, configurable: true });
    }
  }
}

export function normalizeEncoding(enc: unknown): string | undefined {
  if (enc == null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  if (typeof enc !== 'string') return undefined;
  const lowered = `${enc}`.toLowerCase();
  switch (lowered) {
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return 'utf16le';
    case 'latin1':
    case 'binary':
      return 'latin1';
    case 'base64':
      return 'base64';
    case 'base64url':
      return 'base64url';
    case 'hex':
      return 'hex';
    case 'ascii':
      return 'ascii';
    default:
      return undefined;
  }
}
