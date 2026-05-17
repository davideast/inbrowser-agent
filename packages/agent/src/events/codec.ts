/**
 * Event value codec — round-trip non-JSON-safe values through the log.
 *
 * The naive approach (`JSON.stringify` everything that lands in
 * `args`, `before`, `after`) is lossy for the exact types real
 * Firebase code uses:
 *
 *   - `Date` → ISO string. Replay writes `string` where `Date` was.
 *   - `Timestamp` (Firestore) → `{ seconds, nanoseconds }` map. Replay
 *     writes a MAP, not a Timestamp. Range queries break silently.
 *   - `FieldValue.serverTimestamp()` → `{}`. Sentinel never fires.
 *   - `Uint8Array` → array of numbers. Bytes corrupted.
 *   - `bigint` → throws (JSON.stringify can't serialize bigint).
 *
 * This module provides a small, extensible codec layer. The default
 * codec handles the universal cases (Date / Uint8Array / bigint) via
 * tagged envelopes. Hosts with domain-specific types (Firestore
 * Timestamp, FieldValue, DocumentReference) compose their own codec
 * on top — see `composeCodecs` + the AGENTS.md recipe.
 *
 * Not handled: `undefined`. Firestore doesn't write `undefined` to
 * docs (it throws), and JSON.stringify drops `undefined`-valued
 * object properties before we ever see them. Encoding it would
 * require a "no-transform" sentinel that the walker collides with;
 * not worth the complexity for a value real Firebase code never
 * produces.
 *
 * Tagged envelope shape: `{ "__pyric": "<tag>", ...fields }`. The
 * `__pyric` prefix makes encoded values self-describing and the
 * round-trip lossless. Hosts using `__pyric` for their own things
 * SHOULD pick a different prefix.
 */

export const ENVELOPE_KEY = '__pyric' as const;

export interface EventValueCodec {
  /** Convert a value into a JSON-safe shape. Identity on already-safe values. */
  encode(value: unknown): unknown;
  /** Invert `encode`. Identity on values that have no envelope. */
  decode(value: unknown): unknown;
}

/**
 * Walks a value tree, applying a per-node transform. Returns a new
 * tree (the input is NOT mutated). The transform returns `undefined`
 * for nodes it doesn't want to transform; the walker then recurses
 * into the node's children — BUT only when the node is a plain
 * object or an array. Class instances (anything whose prototype is
 * not `Object.prototype`) are returned as-is so composed codecs
 * don't accidentally Object.entries() through a typed value and
 * rebuild it as a bag-of-fields.
 *
 * Exported so codec authors can build their own codecs correctly —
 * see `codec.ts` header for the pattern.
 */
export function walkValue(value: unknown, transform: (v: unknown) => unknown): unknown {
  const replaced = transform(value);
  if (replaced !== undefined) return replaced;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => walkValue(v, transform));
  // Only descend into plain {} objects. A class instance reaches here
  // either because the transform doesn't recognize it (likely the
  // caller's own type — return unchanged), or because we already
  // decoded an envelope into an instance and a *later* pass shouldn't
  // re-walk its fields.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walkValue(v, transform);
  }
  return out;
}

/**
 * Default codec — handles universal non-JSON types every consumer
 * needs. Hosts compose Firestore-specific codecs on top via
 * `composeCodecs`.
 */
export const defaultEventValueCodec: EventValueCodec = {
  encode(value) {
    return walkValue(value, (v) => {
      if (v instanceof Date) {
        return { [ENVELOPE_KEY]: 'Date', iso: v.toISOString() };
      }
      if (v instanceof Uint8Array) {
        return {
          [ENVELOPE_KEY]: 'Uint8Array',
          b64: Buffer.from(v).toString('base64'),
        };
      }
      if (typeof v === 'bigint') {
        return { [ENVELOPE_KEY]: 'bigint', value: v.toString() };
      }
      return undefined;
    });
  },
  decode(value) {
    return walkValue(value, (v) => {
      if (v === null || typeof v !== 'object') return undefined;
      if (Array.isArray(v)) return undefined;
      const obj = v as Record<string, unknown>;
      const tag = obj[ENVELOPE_KEY];
      if (typeof tag !== 'string') return undefined;
      if (tag === 'Date' && typeof obj['iso'] === 'string') {
        return new Date(obj['iso']);
      }
      if (tag === 'Uint8Array' && typeof obj['b64'] === 'string') {
        return new Uint8Array(Buffer.from(obj['b64'], 'base64'));
      }
      if (tag === 'bigint' && typeof obj['value'] === 'string') {
        return BigInt(obj['value']);
      }
      return undefined;
    });
  },
};

/**
 * Identity codec — pass-through. Use when the host serializes args
 * itself before passing to a wrapped tool (e.g. tool args are
 * already JSON-safe by contract). Cheaper than `defaultEventValueCodec`
 * because it skips the walk.
 */
export const identityCodec: EventValueCodec = {
  encode: (v) => v,
  decode: (v) => v,
};

/**
 * Compose two codecs. The outer codec encodes first, decodes last.
 *
 *   composeCodecs(outer, inner)
 *     encode(v) → outer.encode(inner.encode(v))
 *     decode(v) → inner.decode(outer.decode(v))
 *
 * Typical usage: layer a Firestore codec over the default.
 *
 *   const codec = composeCodecs(firestoreCodec, defaultEventValueCodec);
 */
export function composeCodecs(outer: EventValueCodec, inner: EventValueCodec): EventValueCodec {
  return {
    encode: (v) => outer.encode(inner.encode(v)),
    decode: (v) => inner.decode(outer.decode(v)),
  };
}
