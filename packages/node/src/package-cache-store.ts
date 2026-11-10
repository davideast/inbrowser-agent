import type { PackageCache } from './package-cache';
import { fault } from './protocol';
import { resourceLimits } from './resource-policy';

const DATABASE = 'inbrowser-node:package-cache:v1';
const STORE = 'packages';
const TIMEOUT = () => resourceLimits().timers.storeMs;
export function packageCacheKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    new TextEncoder().encode(value).length > 256
  )
    throw fault('EINVAL', 'Package cache name must contain 1–256 UTF-8 bytes without NUL');
  return value;
}
function openDatabase(signal: AbortSignal): Promise<IDBDatabase> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (typeof indexedDB === 'undefined')
    return Promise.reject(fault('ENOTSUP', 'IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let settled = false;
    const finish = (error?: unknown, db?: IDBDatabase) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (db) resolve(db);
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(
      () => finish(fault('ETIMEDOUT', 'Package cache database open timed out')),
      TIMEOUT(),
    );
    signal.addEventListener('abort', abort, { once: true });
    request.onblocked = () => finish(fault('EBUSY', 'Package cache database upgrade is blocked'));
    request.onerror = () =>
      finish(fault('EIO', 'Package cache database open failed: ' + request.error?.name));
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      finish(undefined, request.result);
    };
  });
}
async function transaction(
  key: string,
  signal: AbortSignal,
  operation: { type: 'read' } | { type: 'write'; cache: PackageCache } | { type: 'remove' },
): Promise<unknown> {
  const db = await openDatabase(signal);
  try {
    if (signal.aborted) throw signal.reason;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, operation.type === 'read' ? 'readonly' : 'readwrite');
      const store = tx.objectStore(STORE);
      let settled = false;
      let value: unknown;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = (error: unknown) => {
        try {
          tx.abort();
        } catch {
          /* A terminal transaction has no remaining work. */
        }
        finish(error);
      };
      const abort = () => cancel(signal.reason);
      const timer = setTimeout(
        () => cancel(fault('ETIMEDOUT', 'Package cache storage transaction timed out')),
        TIMEOUT(),
      );
      signal.addEventListener('abort', abort, { once: true });
      tx.oncomplete = () => finish();
      tx.onerror = tx.onabort = () =>
        finish(fault('EIO', 'Package cache storage transaction failed: ' + tx.error?.name));
      try {
        const request =
          operation.type === 'read'
            ? store.get(key)
            : operation.type === 'remove'
              ? store.delete(key)
              : store.put(operation.cache, key);
        request.onsuccess = () => {
          value = request.result;
        };
      } catch (error) {
        cancel(error);
      }
    });
  } finally {
    db.close();
  }
}
export async function writePackageCache(
  name: string,
  cache: PackageCache,
  signal: AbortSignal,
): Promise<void> {
  await transaction(packageCacheKey(name), signal, { type: 'write', cache });
}
export async function readPackageCache(name: string, signal: AbortSignal): Promise<unknown> {
  const value = await transaction(packageCacheKey(name), signal, { type: 'read' });
  if (value === undefined) throw fault('ENOENT', 'Saved cache does not exist');
  return value;
}

export async function removePackageCache(name: string, signal: AbortSignal): Promise<void> {
  await transaction(packageCacheKey(name), signal, { type: 'remove' });
}
