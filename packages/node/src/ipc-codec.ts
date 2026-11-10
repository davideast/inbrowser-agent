import { Buffer } from 'buffer';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';
const views: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
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
  DataView,
};

/** Semantic graph transport for fork; this is not V8's binary wire format. */
export function encodeAdvanced(value: unknown): string {
  const {
    ipcGraphNodes: MAX_NODES,
    ipcGraphEdges: MAX_EDGES,
    ipcGraphDepth: MAX_DEPTH,
    ipcArraySlots: MAX_ARRAY,
  } = resourceLimits().child;
  const nodes: unknown[][] = [];
  const seen = new Map<object, number>();
  let edges = 0;
  let arraySlots = 0;
  const atom = (value: unknown, depth = 0): unknown => {
    if (++edges > MAX_EDGES || depth > MAX_DEPTH) throw fault('E2BIG', 'IPC graph exceeds limits');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'undefined') return ['undefined'];
    if (typeof value === 'bigint') return ['bigint', String(value)];
    if (typeof value === 'number')
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : ['number', Object.is(value, -0) ? '-0' : String(value)];
    if (typeof value !== 'object') throw fault('ENOSYS', 'Unsupported advanced IPC value');
    const prior = seen.get(value);
    if (prior !== undefined) return ['ref', prior];
    if (nodes.length >= MAX_NODES) throw fault('E2BIG', 'IPC graph exceeds node limit');
    const id = nodes.length;
    const node: unknown[] = [];
    nodes.push(node);
    seen.set(value, id);
    const next = (entry: unknown) => atom(entry, depth + 1);
    if (Buffer.isBuffer(value)) node.push('bytes', 'Buffer', value.toString('base64'));
    else if (value instanceof ArrayBuffer)
      node.push('bytes', 'ArrayBuffer', Buffer.from(new Uint8Array(value)).toString('base64'));
    else if (ArrayBuffer.isView(value)) {
      const name = Object.keys(views).find((name) => value instanceof views[name]);
      if (!name) throw fault('ENOSYS', 'Unsupported IPC binary view');
      node.push(
        'bytes',
        name,
        Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).toString(
          'base64',
        ),
      );
    } else if (value instanceof Map)
      node.push(
        'map',
        Array.from(value, ([key, item]) => [next(key), next(item)]),
      );
    else if (value instanceof Set) node.push('set', Array.from(value, next));
    else if (value instanceof Date) node.push('date', String(value.getTime()));
    else if (value instanceof RegExp) node.push('regexp', value.source, value.flags);
    else if (Array.isArray(value)) {
      arraySlots += value.length;
      if (arraySlots > MAX_ARRAY) throw fault('E2BIG', 'IPC arrays exceed aggregate length limit');
      node.push(
        'array',
        value.length,
        Object.keys(value).map((key) => [key, next(Reflect.get(value, key))]),
      );
    } else if (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    )
      node.push(
        'object',
        Object.keys(value).map((key) => [key, next(Reflect.get(value, key))]),
      );
    else throw fault('ENOSYS', 'Unsupported advanced IPC object');
    return ['ref', id];
  };
  const root = atom(value);
  return JSON.stringify({ root, nodes });
}

export function decodeAdvanced(text: string): unknown {
  const {
    ipcGraphNodes: MAX_NODES,
    ipcGraphEdges: MAX_EDGES,
    ipcArraySlots: MAX_ARRAY,
  } = resourceLimits().child;
  const invalid = () => fault('EPROTO', 'Invalid advanced IPC graph');
  const wire: unknown = JSON.parse(text);
  if (!record(wire) || !Array.isArray(wire.nodes) || wire.nodes.length > MAX_NODES) throw invalid();
  const nodes = wire.nodes;
  const objects: unknown[] = [];
  let edges = 0;
  const atom = (value: unknown): unknown => {
    if (++edges > MAX_EDGES) throw invalid();
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    )
      return value;
    if (!Array.isArray(value)) throw invalid();
    if (value[0] === 'undefined' && value.length === 1) return undefined;
    if (
      value[0] === 'bigint' &&
      value.length === 2 &&
      typeof value[1] === 'string' &&
      /^-?\d+$/.test(value[1])
    )
      return BigInt(value[1]);
    if (
      value[0] === 'number' &&
      value.length === 2 &&
      ['-0', 'NaN', 'Infinity', '-Infinity'].includes(value[1])
    )
      return Number(value[1]);
    if (
      value[0] === 'ref' &&
      value.length === 2 &&
      Number.isSafeInteger(value[1]) &&
      value[1] >= 0 &&
      value[1] < objects.length
    )
      return objects[value[1]];
    throw invalid();
  };
  // Sparse arrays consume storage even though their wire representation is tiny.
  // Validate the aggregate budget before allocating any receiver graph objects.
  let arraySlots = 0;
  for (const node of nodes) {
    if (!Array.isArray(node)) throw invalid();
    if (node[0] === 'array') {
      const length: unknown = node[1];
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
        throw invalid();
      arraySlots += length;
      if (arraySlots > MAX_ARRAY) throw invalid();
    }
  }
  // Allocate before linking, preserving cycles and repeated object identities.
  for (const node of nodes) {
    if (!Array.isArray(node)) throw invalid();
    const [kind, data, extra] = node;
    if (kind === 'object' && node.length === 2) objects.push({});
    else if (
      kind === 'array' &&
      node.length === 3 &&
      Number.isSafeInteger(data) &&
      data >= 0 &&
      data <= MAX_ARRAY
    )
      objects.push(new Array(data));
    else if (kind === 'map' && node.length === 2) objects.push(new Map());
    else if (kind === 'set' && node.length === 2) objects.push(new Set());
    else if (
      kind === 'date' &&
      node.length === 2 &&
      typeof data === 'string' &&
      (data === 'NaN' || Number.isFinite(Number(data)))
    )
      objects.push(new Date(Number(data)));
    else if (
      kind === 'regexp' &&
      node.length === 3 &&
      typeof data === 'string' &&
      typeof extra === 'string'
    )
      objects.push(new RegExp(data, extra));
    else if (
      kind === 'bytes' &&
      node.length === 3 &&
      typeof data === 'string' &&
      typeof extra === 'string' &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(extra)
    ) {
      const bytes = Buffer.from(extra, 'base64');
      if (data === 'Buffer') objects.push(bytes);
      else {
        const buffer = Uint8Array.from(bytes).buffer;
        if (data === 'ArrayBuffer') objects.push(buffer);
        else if (Object.hasOwn(views, data)) {
          try {
            objects.push(new views[data](buffer));
          } catch {
            throw invalid();
          }
        } else throw invalid();
      }
    } else throw invalid();
  }
  for (let i = 0; i < nodes.length; i++) {
    const node: unknown = nodes[i];
    if (!Array.isArray(node)) throw invalid();
    const target = objects[i];
    if (node[0] === 'object' || node[0] === 'array') {
      const entries: unknown = node[node[0] === 'array' ? 2 : 1];
      if (!Array.isArray(entries) || typeof target !== 'object' || target === null) throw invalid();
      for (const entry of entries) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          (Array.isArray(target) && entry[0] === 'length')
        )
          throw invalid();
        Object.defineProperty(target, entry[0], {
          value: atom(entry[1]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    } else if (node[0] === 'map') {
      if (!(target instanceof Map) || !Array.isArray(node[1])) throw invalid();
      for (const entry of node[1]) {
        if (!Array.isArray(entry) || entry.length !== 2) throw invalid();
        target.set(atom(entry[0]), atom(entry[1]));
      }
    } else if (node[0] === 'set') {
      if (!(target instanceof Set) || !Array.isArray(node[1])) throw invalid();
      for (const value of node[1]) target.add(atom(value));
    }
  }
  return atom(wire.root);
}
