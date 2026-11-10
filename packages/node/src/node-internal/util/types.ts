// Browser-safe `internal/util/types` integrating `util/` predicates with guest
// `KeyObject`, `CryptoKey`, `ContextPromise`, and lowered async/generator functions.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import * as utilPkg from 'util/';
import { isCryptoKey, isKeyObject } from '../../crypto-keys';
import { functionKind } from '../../util-inspect';

const baseTypes = utilPkg.types;

const typedArrayToStringTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;

export const isAnyArrayBuffer = baseTypes.isAnyArrayBuffer;
export const isArrayBufferView = baseTypes.isArrayBufferView;
export const isArgumentsObject = baseTypes.isArgumentsObject;
export const isArrayBuffer = baseTypes.isArrayBuffer;
export const isBigInt64Array = baseTypes.isBigInt64Array;
export const isBigIntObject = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  try {
    BigInt.prototype.valueOf.call(value);
    return true;
  } catch {
    return false;
  }
};
export const isBigUint64Array = baseTypes.isBigUint64Array;
export const isBooleanObject = baseTypes.isBooleanObject;
export const isBoxedPrimitive = (value: unknown): boolean =>
  baseTypes.isBoxedPrimitive(value) || isBigIntObject(value);
export const isDataView = baseTypes.isDataView;
export const isDate = baseTypes.isDate;
export const isExternal = (_value: unknown): boolean => false;
export const isFloat16Array = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || !typedArrayToStringTag) return false;
  try {
    return Reflect.apply(typedArrayToStringTag, value, []) === 'Float16Array';
  } catch {
    return false;
  }
};
export const isFloat32Array = baseTypes.isFloat32Array;
export const isFloat64Array = baseTypes.isFloat64Array;
export const isInt8Array = baseTypes.isInt8Array;
export const isInt16Array = baseTypes.isInt16Array;
export const isInt32Array = baseTypes.isInt32Array;
export const isMap = baseTypes.isMap;
export const isMapIterator = baseTypes.isMapIterator;
export const isModuleNamespaceObject = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  if (Object.getPrototypeOf(value) !== null || Object.isExtensible(value)) return false;
  const tagDesc = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
  return (
    tagDesc !== undefined &&
    tagDesc.value === 'Module' &&
    tagDesc.writable === false &&
    tagDesc.enumerable === false &&
    tagDesc.configurable === false
  );
};
export const isNativeError = baseTypes.isNativeError;
export const isNumberObject = baseTypes.isNumberObject;
export const isPromise = (value: unknown): boolean => {
  if (typeof globalThis.Promise === 'function' && value instanceof globalThis.Promise) {
    return true;
  }
  return baseTypes.isPromise(value);
};
export const isProxy = (_value: unknown): boolean => false;
export const isRegExp = baseTypes.isRegExp;
export const isSet = baseTypes.isSet;
export const isSetIterator = baseTypes.isSetIterator;
export const isSharedArrayBuffer = baseTypes.isSharedArrayBuffer;
export const isStringObject = baseTypes.isStringObject;
export const isSymbolObject = baseTypes.isSymbolObject;
export const isTypedArray = baseTypes.isTypedArray;
export const isUint8Array = baseTypes.isUint8Array;
export const isUint8ClampedArray = baseTypes.isUint8ClampedArray;
export const isUint16Array = baseTypes.isUint16Array;
export const isUint32Array = baseTypes.isUint32Array;
export const isWeakMap = baseTypes.isWeakMap;
export const isWeakSet = baseTypes.isWeakSet;

export { isCryptoKey, isKeyObject };

export function isAsyncFunction(value: unknown): boolean {
  const kind = functionKind(value);
  return kind === 'AsyncFunction' || kind === 'AsyncGeneratorFunction';
}

export function isGeneratorFunction(value: unknown): boolean {
  const kind = functionKind(value);
  return kind === 'GeneratorFunction' || kind === 'AsyncGeneratorFunction';
}

export function isGeneratorObject(value: unknown): boolean {
  return baseTypes.isGeneratorObject(value);
}

export const utilTypes = {
  ...baseTypes,
  isAnyArrayBuffer,
  isArrayBufferView,
  isArgumentsObject,
  isArrayBuffer,
  isAsyncFunction,
  isBigInt64Array,
  isBigIntObject,
  isBigUint64Array,
  isBooleanObject,
  isBoxedPrimitive,
  isCryptoKey,
  isDataView,
  isDate,
  isExternal,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isGeneratorFunction,
  isGeneratorObject,
  isInt8Array,
  isInt16Array,
  isInt32Array,
  isKeyObject,
  isMap,
  isMapIterator,
  isModuleNamespaceObject,
  isNativeError,
  isNumberObject,
  isPromise,
  isProxy,
  isRegExp,
  isSet,
  isSetIterator,
  isSharedArrayBuffer,
  isStringObject,
  isSymbolObject,
  isTypedArray,
  isUint8Array,
  isUint8ClampedArray,
  isUint16Array,
  isUint32Array,
  isWeakMap,
  isWeakSet,
};
