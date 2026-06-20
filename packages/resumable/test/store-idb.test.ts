/**
 * IndexedDB store — runs the shared conformance suite (via the fake-indexeddb
 * polyfill, since bun has no IndexedDB) plus a cross-instance restart-replay
 * check that a fresh store over the same DB sees the durable log.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { type IdbJobStore, createIdbJobStore } from '../src/store/idb';
import { runJobStoreConformance } from './conformance';

// One DB per factory() call → isolated tests. The conformance suite uses a
// single store instance per test (within-instance watch); teardown closes it.
let n = 0;
runJobStoreConformance(
  'createIdbJobStore',
  () => createIdbJobStore<string>({ dbName: `idb-conf-${Date.now()}-${n++}`, defaultTtlMs: 1000 }),
  { teardown: async (store) => (store as IdbJobStore<string>).close() },
);

// The reason this store exists: a FRESH instance over the same DB replays the
// durable log — what a reloaded tab / restarted worker reads back.
test('persists across fresh store instances over the same DB (restart-replay)', async () => {
  const dbName = `idb-restart-${Date.now()}`;
  const a = createIdbJobStore<string>({ dbName });
  const { jobId } = await a.create({ data: { provider: 'gemini' } });
  await a.append(jobId, 0, 'one');
  await a.append(jobId, 1, 'two');
  await a.finish(jobId, 'done');
  a.close();

  const b = createIdbJobStore<string>({ dbName });
  const snap = await b.snapshot(jobId);
  expect(snap?.events).toEqual(['one', 'two']);
  expect(snap?.status).toBe('done');
  expect(snap?.data).toEqual({ provider: 'gemini' });
  b.close();
});
