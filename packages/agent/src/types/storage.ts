/**
 * `Storage` — the platform-level key/value abstraction over
 * `localStorage` / fs / in-memory. Used for BYOK keys, layout
 * prefs, last-used project id, recent-sessions cache.
 *
 * Distinct from `@pyric/storage` (Firebase Storage adapter for
 * user-owned cloud data). They live at different layers.
 */

export interface Storage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Optionally list keys with a prefix. Implementations may degrade to []. */
  keys(prefix?: string): string[];
}

/** No-op storage. Useful for tests + the headless CLI's default. */
export const noopStorage: Storage = Object.freeze({
  get: () => null,
  set: () => {
    /* ignored */
  },
  remove: () => {
    /* ignored */
  },
  keys: () => [],
});

/** In-memory storage. Thread-safe within one event loop. */
export function createMemoryStorage(seed?: Record<string, string>): Storage {
  const map = new Map<string, string>(seed ? Object.entries(seed) : []);
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v);
    },
    remove: (k) => {
      map.delete(k);
    },
    keys: (prefix) => {
      const out: string[] = [];
      for (const k of map.keys()) {
        if (prefix === undefined || k.startsWith(prefix)) out.push(k);
      }
      return out;
    },
  };
}
