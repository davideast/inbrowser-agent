import { fault } from './protocol';
import { resourceLimits } from './resource-policy';
import { parseSnapshot } from './snapshot';
import {
  type CheckpointReceipt,
  type WorkspaceManifest,
  contentHash,
  parseManifest,
} from './workspace-checkpoint';

function openDatabase(signal: AbortSignal): Promise<IDBDatabase> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (typeof indexedDB === 'undefined')
    return Promise.reject(fault('ENOTSUP', 'IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('inbrowser-node:workspaces:v1', 1);
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
      () => finish(fault('ETIMEDOUT', 'Workspace database open timed out')),
      resourceLimits().timers.storeMs,
    );
    signal.addEventListener('abort', abort, { once: true });
    request.onblocked = () => finish(fault('EBUSY', 'Workspace database upgrade is blocked'));
    request.onerror = () =>
      finish(fault('EIO', 'Workspace database open failed: ' + request.error?.name));
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      for (const name of ['heads', 'blobs']) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      finish(undefined, request.result);
    };
  });
}

async function transact<T>(
  signal: AbortSignal,
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const db = await openDatabase(signal);
  try {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(['heads', 'blobs'], mode, { durability: 'strict' });
      let settled = false;
      let result: { value: T } | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else if (result) resolve(result.value);
        else reject(fault('EIO', 'Workspace transaction completed without a result'));
      };
      const fail = (error: unknown) => {
        try {
          tx.abort();
        } catch {
          /* Terminal transaction. */
        }
        finish(error);
      };
      const abort = () => fail(signal.reason);
      const timer = setTimeout(
        () => fail(fault('ETIMEDOUT', 'Workspace transaction timed out')),
        resourceLimits().timers.storeMs,
      );
      signal.addEventListener('abort', abort, { once: true });
      tx.oncomplete = () => finish();
      tx.onerror = tx.onabort = () =>
        finish(
          fault(
            tx.error?.name === 'QuotaExceededError' ? 'ENOSPC' : 'EIO',
            'Workspace transaction failed: ' + tx.error?.name,
          ),
        );
      try {
        work(
          tx,
          (value) => {
            result = { value };
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  } finally {
    db.close();
  }
}

export async function commitWorkspace(
  name: string,
  manifest: WorkspaceManifest,
  blobs: Map<string, Uint8Array>,
  signal: AbortSignal,
): Promise<CheckpointReceipt> {
  return transact(signal, 'readwrite', (tx, done, fail) => {
    const heads = tx.objectStore('heads');
    const contents = tx.objectStore('blobs');
    const request = heads.get(name);
    request.onsuccess = () => {
      try {
        const previous = request.result === undefined ? undefined : parseManifest(request.result);
        const oldHashes = new Set(Object.values(previous?.hashes ?? {}));
        const revision = (previous?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision))
          throw fault('EOVERFLOW', 'Checkpoint revision exhausted');
        let writtenBlobs = 0;
        let reusedBlobs = 0;
        let remaining = blobs.size;
        const publish = () => {
          for (const hash of oldHashes) if (!blobs.has(hash)) contents.delete([name, hash]);
          heads.put({ ...manifest, revision }, name);
          done({ revision, writtenBlobs, reusedBlobs });
        };
        if (!remaining) publish();
        for (const [hash, bytes] of blobs) {
          const existing = contents.get([name, hash]);
          existing.onsuccess = () => {
            try {
              const value: unknown = existing.result;
              if (
                value instanceof Uint8Array &&
                value.length === bytes.length &&
                bytes.every((byte, index) => byte === value[index])
              )
                reusedBlobs++;
              else {
                contents.put(bytes, [name, hash]);
                writtenBlobs++;
              }
              if (--remaining === 0) publish();
            } catch (error) {
              fail(error);
            }
          };
        }
      } catch (error) {
        fail(error);
      }
    };
  });
}

export async function loadWorkspace(name: string, signal: AbortSignal) {
  const stored = await transact<{ manifest: WorkspaceManifest; blobs: Map<string, Uint8Array> }>(
    signal,
    'readonly',
    (tx, done, fail) => {
      const request = tx.objectStore('heads').get(name);
      request.onsuccess = () => {
        try {
          if (request.result === undefined)
            throw fault('ENOENT', 'Workspace checkpoint does not exist');
          const manifest = parseManifest(request.result);
          const references = new Map<string, number>();
          for (const hash of Object.values(manifest.hashes))
            references.set(hash, (references.get(hash) ?? 0) + 1);
          const hashes = [...references.keys()];
          const encoder = new TextEncoder();
          let logicalBytes = manifest.snapshot.entries.reduce(
            (total, entry) =>
              total +
              encoder.encode(entry.path).length +
              (entry.type === 'symlink' ? encoder.encode(entry.target).length : 0),
            0,
          );
          const blobs = new Map<string, Uint8Array>();
          if (!hashes.length) done({ manifest, blobs });
          for (const hash of hashes) {
            const body = tx.objectStore('blobs').get([name, hash]);
            body.onsuccess = () => {
              if (!(body.result instanceof Uint8Array)) {
                fail(fault('EINTEGRITY', 'Checkpoint content is missing'));
                return;
              }
              logicalBytes += body.result.byteLength * references.get(hash)!;
              if (logicalBytes > resourceLimits().snapshot.bytes) {
                fail(fault('E2BIG', 'Checkpoint exceeds 128 MiB'));
                return;
              }
              blobs.set(hash, body.result);
              if (blobs.size === hashes.length) done({ manifest, blobs });
            };
          }
        } catch (error) {
          fail(error);
        }
      };
    },
  );
  for (const [hash, bytes] of stored.blobs) {
    signal.throwIfAborted();
    if ((await contentHash(bytes)) !== hash)
      throw fault('EINTEGRITY', 'Checkpoint content digest mismatch');
  }
  const entries = stored.manifest.snapshot.entries.map((entry) => {
    if (entry.type !== 'file') return entry;
    const bytes = stored.blobs.get(stored.manifest.hashes[entry.path]!);
    if (!bytes) throw fault('EINTEGRITY', 'Checkpoint content is missing');
    return { ...entry, data: bytes };
  });
  signal.throwIfAborted();
  return {
    revision: stored.manifest.revision,
    startup: stored.manifest.startup,
    snapshot: parseSnapshot(
      { version: 1, entries },
      resourceLimits().snapshot.entries,
      resourceLimits().snapshot.bytes,
    ),
  };
}
