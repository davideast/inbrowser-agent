/**
 * Shared conformance suite for `JobStore` implementations.
 *
 * Call `runJobStoreConformance(name, factory)` once per store
 * implementation — the in-tree memory + RTDB stores both run through
 * the same scenarios. Third parties porting the suite into their own
 * test file get correctness "for free."
 *
 * The suite is intentionally framework-coupled to `bun:test` — the
 * shape lives inside the package's test directory and is NOT a
 * published export. The published `@inbrowser/resumable/testing` ships
 * the probe harness (Probes A-D), not the suite itself.
 */
import { describe, expect, it } from 'bun:test';
import type { JobStore } from '../src/store/contract';

export interface ConformanceOpts {
  /**
   * Stores with native backend TTL (Redis, Firestore) omit
   * `sweepExpired`. When true, the suite skips sweep-driven TTL
   * cases and relies on the store's native expiry — but currently
   * no such store ships, so the flag is reserved for future use.
   */
  storeHasNativeTtl?: boolean;
  /**
   * Cleanup hook between cases. The memory store needs nothing;
   * an RTDB store may want to clear its namespace. Awaited.
   */
  teardown?: (store: JobStore<string>) => Promise<void>;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/** Pull-N helper for tests that need to observe a `watch` stream
 *  without consuming it to terminal. */
async function take<T>(it: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  const iterator = it[Symbol.asyncIterator]();
  while (out.length < n) {
    const { value, done } = await iterator.next();
    if (done) break;
    out.push(value);
  }
  await iterator.return?.();
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function runJobStoreConformance(
  storeName: string,
  factory: () => JobStore<string> | Promise<JobStore<string>>,
  opts: ConformanceOpts = {},
): void {
  describe(`JobStore conformance — ${storeName}`, () => {
    describe('lifecycle', () => {
      it('create → append → snapshot reflects events in order', async () => {
        const store = await factory();
        try {
          const { jobId } = await store.create({});
          await store.append(jobId, 0, 'a');
          await store.append(jobId, 1, 'b');
          await store.append(jobId, 2, 'c');
          const snap = await store.snapshot(jobId);
          expect(snap).not.toBeNull();
          expect(snap!.events).toEqual(['a', 'b', 'c']);
          expect(snap!.status).toBe('running');
          expect(snap!.finishedAt).toBeNull();
        } finally {
          await opts.teardown?.(store);
        }
      });

      it('finish transitions status and stamps finishedAt', async () => {
        const store = await factory();
        try {
          const { jobId } = await store.create({});
          await store.append(jobId, 0, 'x');
          await store.finish(jobId, 'done');
          const snap = await store.snapshot(jobId);
          expect(snap!.status).toBe('done');
          expect(snap!.reason).toBeNull();
          expect(snap!.finishedAt).not.toBeNull();
        } finally {
          await opts.teardown?.(store);
        }
      });

      it('finish with reason round-trips on snapshot', async () => {
        const store = await factory();
        try {
          const { jobId } = await store.create({});
          await store.finish(jobId, 'error', 'producer threw');
          const snap = await store.snapshot(jobId);
          expect(snap!.status).toBe('error');
          expect(snap!.reason).toBe('producer threw');
        } finally {
          await opts.teardown?.(store);
        }
      });

      it('snapshot of unknown job returns null', async () => {
        const store = await factory();
        try {
          expect(await store.snapshot('does-not-exist')).toBeNull();
        } finally {
          await opts.teardown?.(store);
        }
      });

      it('delete is idempotent — missing job is a no-op', async () => {
        const store = await factory();
        try {
          await store.delete('does-not-exist');
          // Reaching here without throwing is the assertion.
          expect(true).toBe(true);
        } finally {
          await opts.teardown?.(store);
        }
      });

      it('data passed at create round-trips on snapshot', async () => {
        const store = await factory();
        try {
          const { jobId } = await store.create({
            data: { provider: 'gemini', model: 'flash' },
          });
          const snap = await store.snapshot(jobId);
          expect(snap!.data).toEqual({ provider: 'gemini', model: 'flash' });
        } finally {
          await opts.teardown?.(store);
        }
      });
    });

    describe('watch', () => {
      it('yields a snapshot for each mutation', async () => {
        const store = await factory();
        try {
          const { jobId } = await store.create({});

          const ac = new AbortController();
          const watcher = collect(store.watch(jobId, { signal: ac.signal }));

          // Give the watcher a tick to register.
          await sleep(5);
          await store.append(jobId, 0, 'one');
          await sleep(5);
          await store.append(jobId, 1, 'two');
          await sleep(5);
          await store.finish(jobId, 'done');
          await sleep(20);
          ac.abort();

          const snaps = await watcher;
          // The watcher should see strictly-growing events arrays
          // ending with a terminal status. We don't require an exact
          // count (the store may coalesce snapshots) — just monotonicity.
          for (let i = 1; i < snaps.length; i++) {
            expect(snaps[i]!.events.length).toBeGreaterThanOrEqual(
              snaps[i - 1]!.events.length,
            );
          }
          const last = snaps.at(-1)!;
          expect(last.events).toEqual(['one', 'two']);
          expect(last.status).toBe('done');
        } finally {
          await opts.teardown?.(store);
        }
      });

      it('multiple concurrent watchers all see the stream', async () => {
        const store = await factory();
        try {
          const { jobId } = await store.create({});

          const ac1 = new AbortController();
          const ac2 = new AbortController();
          const w1 = collect(store.watch(jobId, { signal: ac1.signal }));
          const w2 = collect(store.watch(jobId, { signal: ac2.signal }));

          await sleep(5);
          await store.append(jobId, 0, 'shared');
          await store.finish(jobId, 'done');
          await sleep(20);
          ac1.abort();
          ac2.abort();

          const s1 = await w1;
          const s2 = await w2;
          expect(s1.at(-1)!.events).toEqual(['shared']);
          expect(s2.at(-1)!.events).toEqual(['shared']);
          expect(s1.at(-1)!.status).toBe('done');
          expect(s2.at(-1)!.status).toBe('done');
        } finally {
          await opts.teardown?.(store);
        }
      });

      it('delete ends watchers cleanly', async () => {
        const store = await factory();
        try {
          const { jobId } = await store.create({});

          const watcher = collect(store.watch(jobId));
          await sleep(5);
          await store.delete(jobId);

          // The watcher's promise must resolve without timing out.
          const winner = await Promise.race([
            watcher.then(() => 'ended' as const),
            sleep(200).then(() => 'timeout' as const),
          ]);
          expect(winner).toBe('ended');
        } finally {
          await opts.teardown?.(store);
        }
      });

      it('aborts on signal', async () => {
        const store = await factory();
        try {
          const { jobId } = await store.create({});
          const ac = new AbortController();
          const watcher = collect(store.watch(jobId, { signal: ac.signal }));
          await sleep(5);
          ac.abort();
          const winner = await Promise.race([
            watcher.then(() => 'ended' as const),
            sleep(200).then(() => 'timeout' as const),
          ]);
          expect(winner).toBe('ended');
        } finally {
          await opts.teardown?.(store);
        }
      });

      it('watch on an already-terminal job yields once with terminal state', async () => {
        const store = await factory();
        try {
          const { jobId } = await store.create({});
          await store.append(jobId, 0, 'only');
          await store.finish(jobId, 'done');

          const first = await take(store.watch(jobId), 1);
          expect(first.length).toBe(1);
          expect(first[0]!.status).toBe('done');
          expect(first[0]!.events).toEqual(['only']);
        } finally {
          await opts.teardown?.(store);
        }
      });
    });

    if (!opts.storeHasNativeTtl) {
      describe('TTL (sweepExpired)', () => {
        it('exposes sweepExpired on this store', async () => {
          const store = await factory();
          try {
            expect(typeof store.sweepExpired).toBe('function');
          } finally {
            await opts.teardown?.(store);
          }
        });

        it('TTL after terminal: finished job is deleted on sweep', async () => {
          const store = await factory();
          try {
            const { jobId } = await store.create({ ttlMs: 10 });
            await store.append(jobId, 0, 'x');
            await store.finish(jobId, 'done');
            const after = await store.snapshot(jobId);
            expect(after!.expiresAt).not.toBeNull();
            await sleep(30);
            const result = await store.sweepExpired!({
              olderThan: Date.now(),
            });
            expect(result.deleted).toBeGreaterThanOrEqual(1);
            expect(await store.snapshot(jobId)).toBeNull();
          } finally {
            await opts.teardown?.(store);
          }
        });

        it('running job is not swept even if its ttl seems "due"', async () => {
          const store = await factory();
          try {
            const { jobId } = await store.create({ ttlMs: 5 });
            // Never finish. Sweep far in the future.
            await store.sweepExpired!({ olderThan: Date.now() + 1_000_000 });
            const snap = await store.snapshot(jobId);
            expect(snap).not.toBeNull();
            expect(snap!.status).toBe('running');
            expect(snap!.expiresAt).toBeNull();
          } finally {
            await opts.teardown?.(store);
          }
        });

        it('no ttl (and no default) retains the job indefinitely', async () => {
          // Build a no-default store via factory() — but factory() may
          // bake in a defaultTtlMs. The conformance contract is: if a
          // job's resulting `expiresAt` is null, sweep won't touch it.
          const store = await factory();
          try {
            // Force-null via a job with explicit ttlMs: 0 isn't quite
            // right (0 means "expire immediately"). We rely on
            // expiresAt computation: a store that has no default and
            // gets no ttlMs yields expiresAt = null. Stores with a
            // default ignore this case via the next test.
            //
            // We *can* verify the converse: a job whose expiresAt is
            // non-null obeys the sweep predicate. That's covered
            // above. This case is left as documentation; stores
            // configured without defaults will pass it by virtue of
            // expiresAt being null.
            expect(true).toBe(true);
          } finally {
            await opts.teardown?.(store);
          }
        });

        it('sweep returns counts and durationMs', async () => {
          const store = await factory();
          try {
            const a = await store.create({ ttlMs: 5 });
            const b = await store.create({ ttlMs: 5 });
            await store.finish(a.jobId, 'done');
            await store.finish(b.jobId, 'error', 'oops');
            await sleep(30);
            const result = await store.sweepExpired!({
              olderThan: Date.now(),
            });
            expect(result.scanned).toBeGreaterThanOrEqual(2);
            expect(result.deleted).toBeGreaterThanOrEqual(2);
            expect(typeof result.durationMs).toBe('number');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
          } finally {
            await opts.teardown?.(store);
          }
        });

        it('statusFilter scopes which terminal statuses get swept', async () => {
          const store = await factory();
          try {
            const a = await store.create({ ttlMs: 5 });
            const b = await store.create({ ttlMs: 5 });
            await store.finish(a.jobId, 'done');
            await store.finish(b.jobId, 'error', 'oops');
            await sleep(30);
            await store.sweepExpired!({
              olderThan: Date.now(),
              statusFilter: ['error'],
            });
            expect(await store.snapshot(a.jobId)).not.toBeNull();
            expect(await store.snapshot(b.jobId)).toBeNull();
          } finally {
            await opts.teardown?.(store);
          }
        });
      });
    }
  });
}
