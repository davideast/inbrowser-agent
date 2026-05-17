/**
 * `Storage` runtime helpers — adapters over the `Storage` interface
 * in `./types/storage.ts`. `noopStorage` and `createMemoryStorage`
 * are exported from the types module since they have no dependencies;
 * this file adds adapters that DO have host-specific deps.
 */

import type { Storage } from './types/storage.js';

/**
 * Browser-only adapter over `window.localStorage`. Errors (private
 * browsing, quota-exceeded) are swallowed silently — `get` returns
 * null, `set` is a no-op, the host doesn't crash.
 */
export function createLocalStorageAdapter(): Storage {
  return {
    get(key) {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        /* quota / private-mode */
      }
    },
    remove(key) {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        /* ignored */
      }
    },
    keys(prefix) {
      try {
        const ls = globalThis.localStorage;
        if (!ls) return [];
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k !== null && (prefix === undefined || k.startsWith(prefix))) {
            out.push(k);
          }
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}
