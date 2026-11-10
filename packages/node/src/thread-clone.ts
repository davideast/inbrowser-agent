import { fault } from './protocol';
import { resourceLimits } from './resource-policy';
import { assertTransferableAllowed, isMarkedAsUncloneable } from './worker-threads-marks';

const views: Array<{
  new (buffer: ArrayBufferLike, offset: number, length: number): ArrayBufferView;
  BYTES_PER_ELEMENT: number;
}> = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
];

/** Evaluate accessors once; retain transferable storage until native dispatch. */
export function snapshotThreadValue(value: unknown, transfer: ArrayBuffer[] = []): unknown {
  const {
    threadCollectionEntries: ENTRIES,
    threadGraphNodes: NODES,
    threadGraphEdges: EDGES,
    threadGraphDepth: DEPTH,
  } = resourceLimits().child;
  assertTransferableAllowed(transfer);
  const transferred = new Set(transfer);
  const seen = new Map<object, unknown>();
  let visits = 0;
  let slots = 0;
  const clone = (value: unknown, depth: number): unknown => {
    if (++visits > EDGES || depth > DEPTH || seen.size > NODES)
      throw fault('E2BIG', 'Thread graph exceeds limits');
    if (isMarkedAsUncloneable(value))
      throw new DOMException('Cannot clone object of unsupported type.', 'DataCloneError');
    if (value === null || typeof value !== 'object') return structuredClone(value);
    if (seen.has(value)) return seen.get(value);
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      const result =
        value instanceof SharedArrayBuffer || transferred.has(value)
          ? value
          : structuredClone(value);
      seen.set(value, result);
      return result;
    }
    if (ArrayBuffer.isView(value)) {
      const buffer = clone(value.buffer, depth + 1);
      if (!(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer))
        throw fault('EPROTO', 'Invalid cloned view buffer');
      let result: ArrayBufferView;
      if (value instanceof DataView)
        result = new DataView(buffer, value.byteOffset, value.byteLength);
      else {
        const Constructor = views.find((Constructor) => value instanceof Constructor);
        if (!Constructor) throw fault('ENOSYS', 'Unsupported thread binary view');
        result = new Constructor(
          buffer,
          value.byteOffset,
          value.byteLength / Constructor.BYTES_PER_ELEMENT,
        );
      }
      seen.set(value, result);
      return result;
    }
    if (value instanceof Date || value instanceof RegExp) {
      const result: unknown = structuredClone(value);
      seen.set(value, result);
      return result;
    }
    if (value instanceof Map) {
      const result = new Map<unknown, unknown>();
      seen.set(value, result);
      if (value.size > ENTRIES) throw fault('E2BIG', 'Thread map exceeds limit');
      for (const [key, item] of Array.from(value))
        result.set(clone(key, depth + 1), clone(item, depth + 1));
      return result;
    }
    if (value instanceof Set) {
      const result = new Set<unknown>();
      seen.set(value, result);
      if (value.size > ENTRIES) throw fault('E2BIG', 'Thread set exceeds limit');
      for (const item of Array.from(value)) result.add(clone(item, depth + 1));
      return result;
    }
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw fault('ENOSYS', 'Unsupported thread message object');
    if (Array.isArray(value)) {
      slots += value.length;
      if (slots > 1048576) throw fault('E2BIG', 'Thread arrays exceed limit');
    }
    const result: object = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, result);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(value, key)) continue;
      Object.defineProperty(result, key, {
        value: clone(Reflect.get(value, key), depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  };
  return clone(value, 0);
}
