// Browser-safe implementation of curated C++ `internalBinding(...)` namespaces
// needed by ported Node.js v22.18.0 `lib/` modules.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { offerUncaught } from '../uncaught-hook';
import { stringDecoderBinding } from './string_decoder-binding';
import { OS_SIGNALS, cloneSystemErrorMap } from './uv-errmap';

const ALL_PROPERTIES = 0;
const ONLY_WRITABLE = 1;
const ONLY_ENUMERABLE = 2;
const ONLY_CONFIGURABLE = 4;
const SKIP_STRINGS = 8;
const SKIP_SYMBOLS = 16;

const kPending = 0;
const kFulfilled = 1;
const kRejected = 2;

const canonicalIndexPattern = /^(?:0|[1-9]\d*)$/;
const MAX_ARRAY_INDEX = 4294967294;

function isArrayIndexKey(key: string): boolean {
  if (!canonicalIndexPattern.test(key)) return false;
  const num = Number(key);
  return num >= 0 && num <= MAX_ARRAY_INDEX;
}

function getOwnNonIndexProperties(obj: object, filter: number): PropertyKey[] {
  const result: PropertyKey[] = [];
  if ((filter & SKIP_STRINGS) === 0) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (isArrayIndexKey(key)) continue;
      if (filter !== ALL_PROPERTIES) {
        const desc = Object.getOwnPropertyDescriptor(obj, key);
        if (!desc) continue;
        if ((filter & ONLY_ENUMERABLE) !== 0 && !desc.enumerable) continue;
        if ((filter & ONLY_WRITABLE) !== 0 && !desc.writable) continue;
        if ((filter & ONLY_CONFIGURABLE) !== 0 && !desc.configurable) continue;
      }
      result.push(key);
    }
  }
  if ((filter & SKIP_SYMBOLS) === 0) {
    for (const sym of Object.getOwnPropertySymbols(obj)) {
      if (filter !== ALL_PROPERTIES) {
        const desc = Object.getOwnPropertyDescriptor(obj, sym);
        if (!desc) continue;
        if ((filter & ONLY_ENUMERABLE) !== 0 && !desc.enumerable) continue;
        if ((filter & ONLY_WRITABLE) !== 0 && !desc.writable) continue;
        if ((filter & ONLY_CONFIGURABLE) !== 0 && !desc.configurable) continue;
      }
      result.push(sym);
    }
  }
  return result;
}

function previewEntries(value: unknown, slowPath?: boolean): unknown[] | [unknown[], boolean] {
  if (value instanceof Map) {
    const flat: unknown[] = [];
    for (const [k, v] of value.entries()) {
      flat.push(k, v);
    }
    return slowPath ? [flat, true] : flat;
  }
  if (value instanceof Set) {
    const items = [...value.values()];
    return slowPath ? [items, false] : items;
  }
  return slowPath ? [[], false] : [];
}

function compareUint8Arrays(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    const diff = a[i] - b[i];
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (a.byteLength === b.byteLength) return 0;
  return a.byteLength < b.byteLength ? -1 : 1;
}

const utilBinding = {
  constants: {
    kPending,
    kFulfilled,
    kRejected,
    kExiting: 0,
    kExitCode: 1,
    kHasExitCode: 2,
    ALL_PROPERTIES,
    ONLY_WRITABLE,
    ONLY_ENUMERABLE,
    ONLY_CONFIGURABLE,
    SKIP_STRINGS,
    SKIP_SYMBOLS,
    kDisallowCloneAndTransfer: 0,
    kTransferable: 1,
    kCloneable: 2,
  },
  privateSymbols: {
    arrow_message_private_symbol: Symbol('arrow_message_private_symbol'),
  },
  getOwnNonIndexProperties,
  getPromiseDetails: (_value: unknown): [number, unknown] => [kPending, undefined],
  getProxyDetails: (_value: unknown, _fullProxy?: boolean): undefined => undefined,
  previewEntries,
  getConstructorName(value: object): string {
    const tag = Object.prototype.toString.call(value);
    return tag.slice(8, -1) || 'Object';
  },
  getExternalValue: (): bigint => 0n,
};

const bufferBinding = {
  compare: compareUint8Arrays,
};

const uvBinding: {
  errmap?: Map<number, [string, string]>;
  getErrorMap(): Map<number, [string, string]>;
  UV_EAI_NODATA: number;
  UV_EAI_NONAME: number;
} = {
  getErrorMap: cloneSystemErrorMap,
  UV_EAI_NODATA: -3007,
  UV_EAI_NONAME: -3008,
};

const constantsBinding = {
  os: {
    signals: OS_SIGNALS,
  },
};

const configBinding = {
  hasIntl: false,
};

const errorsBinding = {
  triggerUncaughtException(err: unknown, _fromPromise?: boolean): void {
    if (offerUncaught(err)) return;
    throw err;
  },
};

export function internalBinding(name: string): unknown {
  switch (name) {
    case 'util':
      return utilBinding;
    case 'buffer':
      return bufferBinding;
    case 'uv':
      return uvBinding;
    case 'constants':
      return constantsBinding;
    case 'config':
      return configBinding;
    case 'errors':
      return errorsBinding;
    case 'string_decoder':
      return stringDecoderBinding;
    default:
      throw new Error(`Unsupported internalBinding('${name}') in browser runtime`);
  }
}
