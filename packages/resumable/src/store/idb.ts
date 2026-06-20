/**
 * IndexedDB `JobStore` — the browser-durable backing store.
 *
 * The durable event log lives in IndexedDB, so a *fresh* store instance over
 * the same database (a reloaded tab, a restarted worker) replays every job's
 * events and terminal state — the restart-replay guarantee. `snapshot()` and
 * `watch()` always read from IndexedDB, never an in-memory mirror.
 *
 * `watch()` mirrors the memory store's revision/Notifier wake: an in-context
 * `Notifier` wakes watchers in *this* instance immediately, and a
 * `BroadcastChannel` wakes watchers in *other* contexts (other tabs / a shared
 * worker on the same origin). Correctness never depends on the channel — every
 * wake re-reads IndexedDB, and a missed wake is caught by the next mutation.
 *
 * Hold one long-lived connection for the store's lifetime (it doubles as the
 * documented Energy-Saver freeze exemption in a worker).
 */
import { type IdGenerator, defaultGenerateId } from '../ids.js';
import type { JobMeta, JobSnapshot, TerminalStatus } from '../types.js';
import type { JobStore, SweepOpts, SweepResult } from './contract.js';

const JOBS = 'jobs';
const EVENTS = 'events';

interface JobRecord {
  id: string;
  status: 'running' | TerminalStatus;
  reason: string | null;
  data: Record<string, unknown>;
  ttlMs?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
  revision: number;
}

interface EventRecord<TEvent> {
  jobId: string;
  seq: number;
  value: TEvent;
}

/** Wakes pending `watch()` loops. Identical semantics to the memory store. */
class Notifier {
  private waiters = new Set<() => void>();

  notify(): void {
    const fired = [...this.waiters];
    this.waiters.clear();
    for (const f of fired) f();
  }

  end(): void {
    this.notify();
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const fire = () => {
        this.waiters.delete(fire);
        signal?.removeEventListener('abort', fire);
        resolve();
      };
      this.waiters.add(fire);
      signal?.addEventListener('abort', fire, { once: true });
    });
  }
}

export interface CreateIdbJobStoreOpts {
  /** IndexedDB database name. Default `inbrowser-resumable`. */
  dbName?: string;
  /** Default post-mortem retention (ms) for jobs whose `meta.ttlMs` is unset. */
  defaultTtlMs?: number;
  /** Override the id generator. Default `crypto.randomUUID()`. */
  generateId?: IdGenerator;
  /** Inject a clock for tests. Default `Date.now`. */
  now?: () => number;
}

/** `JobStore` + a `close()` for the long-lived connection / channel. */
export interface IdbJobStore<TEvent> extends JobStore<TEvent> {
  /** Close the IndexedDB connection + BroadcastChannel. Idempotent. */
  close(): void;
}

export function createIdbJobStore<TEvent>(opts: CreateIdbJobStoreOpts = {}): IdbJobStore<TEvent> {
  const dbName = opts.dbName ?? 'inbrowser-resumable';
  const generateId = opts.generateId ?? defaultGenerateId;
  const now = opts.now ?? Date.now;
  const defaultTtlMs = opts.defaultTtlMs;

  let conn: IDBDatabase | null = null;
  let dbPromise: Promise<IDBDatabase> | null = null;
  function db(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(JOBS)) d.createObjectStore(JOBS, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(EVENTS))
          d.createObjectStore(EVENTS, { keyPath: ['jobId', 'seq'] });
      };
      req.onsuccess = () => {
        conn = req.result;
        resolve(conn);
      };
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // Per-job in-context wake; the channel bridges other same-origin contexts.
  const notifiers = new Map<string, Notifier>();
  function notifier(jobId: string): Notifier {
    let n = notifiers.get(jobId);
    if (!n) {
      n = new Notifier();
      notifiers.set(jobId, n);
    }
    return n;
  }
  const channel =
    typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(`inbrowser-resumable:${dbName}`)
      : null;
  channel?.addEventListener('message', (e: MessageEvent) => {
    const jobId = (e.data as { jobId?: string } | null)?.jobId;
    if (typeof jobId === 'string') notifiers.get(jobId)?.notify();
  });
  function wake(jobId: string, ended = false): void {
    const n = notifiers.get(jobId);
    if (ended) n?.end();
    else n?.notify();
    channel?.postMessage({ jobId });
  }

  // Run ops in one transaction and await its commit. Never await between
  // opening the tx and using it (auto-commit would close it).
  function txComplete(stores: string[], fn: (t: IDBTransaction) => void): Promise<void> {
    return db().then(
      (d) =>
        new Promise<void>((resolve, reject) => {
          const t = d.transaction(stores, 'readwrite');
          let aborted = false;
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
          t.onabort = () => {
            if (!aborted) reject(t.error ?? new Error('transaction aborted'));
          };
          try {
            fn(t);
          } catch (err) {
            aborted = true;
            t.abort();
            reject(err);
          }
        }),
    );
  }

  async function readJob(jobId: string): Promise<JobRecord | null> {
    const d = await db();
    return new Promise<JobRecord | null>((resolve, reject) => {
      const r = d.transaction(JOBS, 'readonly').objectStore(JOBS).get(jobId);
      r.onsuccess = () => resolve((r.result as JobRecord | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
  }

  async function readEvents(jobId: string): Promise<TEvent[]> {
    const d = await db();
    return new Promise<TEvent[]>((resolve, reject) => {
      const range = IDBKeyRange.bound([jobId, 0], [jobId, Number.MAX_SAFE_INTEGER]);
      const r = d.transaction(EVENTS, 'readonly').objectStore(EVENTS).getAll(range);
      r.onsuccess = () => {
        const out: TEvent[] = [];
        for (const row of r.result as EventRecord<TEvent>[]) out[row.seq] = row.value;
        resolve(out);
      };
      r.onerror = () => reject(r.error);
    });
  }

  async function buildSnapshot(jobId: string): Promise<JobSnapshot<TEvent> | null> {
    const job = await readJob(jobId);
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      reason: job.reason,
      events: await readEvents(jobId),
      data: { ...job.data },
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      expiresAt: job.expiresAt,
    };
  }

  async function deleteJob(jobId: string): Promise<void> {
    const range = IDBKeyRange.bound([jobId, 0], [jobId, Number.MAX_SAFE_INTEGER]);
    await txComplete([JOBS, EVENTS], (t) => {
      t.objectStore(JOBS).delete(jobId);
      t.objectStore(EVENTS).delete(range);
    });
    wake(jobId, true);
  }

  return {
    async create(meta: JobMeta): Promise<{ jobId: string }> {
      const id = generateId();
      const t = now();
      const job: JobRecord = {
        id,
        status: 'running',
        reason: null,
        data: meta.data ? { ...meta.data } : {},
        ttlMs: meta.ttlMs ?? defaultTtlMs,
        createdAt: t,
        updatedAt: t,
        finishedAt: null,
        expiresAt: null,
        revision: 1,
      };
      await txComplete([JOBS], (tx) => tx.objectStore(JOBS).put(job));
      return { jobId: id };
    },

    async append(jobId: string, seq: number, event: TEvent): Promise<void> {
      const job = await readJob(jobId);
      if (!job) throw new Error(`unknown job: ${jobId}`);
      job.revision++;
      job.updatedAt = now();
      await txComplete([JOBS, EVENTS], (t) => {
        t.objectStore(EVENTS).put({ jobId, seq, value: event } satisfies EventRecord<TEvent>);
        t.objectStore(JOBS).put(job);
      });
      wake(jobId);
    },

    async finish(jobId: string, status: TerminalStatus, reason?: string): Promise<void> {
      const job = await readJob(jobId);
      if (!job) throw new Error(`unknown job: ${jobId}`);
      // Idempotent — a double-finish keeps the first terminal state.
      if (job.status !== 'running') return;
      job.status = status;
      job.reason = reason ?? null;
      job.finishedAt = now();
      if (typeof job.ttlMs === 'number') job.expiresAt = job.finishedAt + job.ttlMs;
      job.revision++;
      job.updatedAt = job.finishedAt;
      await txComplete([JOBS], (t) => t.objectStore(JOBS).put(job));
      wake(jobId);
    },

    async snapshot(jobId: string): Promise<JobSnapshot<TEvent> | null> {
      return buildSnapshot(jobId);
    },

    async *watch(
      jobId: string,
      watchOpts?: { from?: number; signal?: AbortSignal },
    ): AsyncIterable<JobSnapshot<TEvent>> {
      const signal = watchOpts?.signal;
      const n = notifier(jobId);
      let lastRevision = -1;
      while (true) {
        if (signal?.aborted) return;
        // Register the waiter BEFORE the async read so a mutation in the gap
        // wakes us rather than being missed.
        const waitP = n.wait(signal);
        const job = await readJob(jobId);
        if (!job) return; // never created or deleted
        if (job.revision > lastRevision) {
          lastRevision = job.revision;
          const snap = await buildSnapshot(jobId);
          if (!snap) return;
          yield snap;
          void waitP;
          continue;
        }
        await waitP;
      }
    },

    async delete(jobId: string): Promise<void> {
      const job = await readJob(jobId);
      if (!job) return; // idempotent
      await deleteJob(jobId);
    },

    async sweepExpired(sweepOpts: SweepOpts): Promise<SweepResult> {
      const t0 = now();
      const filter = new Set<TerminalStatus>(
        sweepOpts.statusFilter ?? ['done', 'error', 'cancelled'],
      );
      const batchSize = sweepOpts.batchSize ?? 200;
      const d = await db();
      const all = await new Promise<JobRecord[]>((resolve, reject) => {
        const r = d.transaction(JOBS, 'readonly').objectStore(JOBS).getAll();
        r.onsuccess = () => resolve(r.result as JobRecord[]);
        r.onerror = () => reject(r.error);
      });
      const eligible: string[] = [];
      for (const job of all) {
        if (job.status === 'running') continue;
        if (!filter.has(job.status)) continue;
        if (job.expiresAt === null || job.expiresAt > sweepOpts.olderThan) continue;
        eligible.push(job.id);
        if (eligible.length >= batchSize) break;
      }
      for (const id of eligible) await deleteJob(id);
      return { scanned: all.length, deleted: eligible.length, durationMs: now() - t0 };
    },

    close(): void {
      channel?.close();
      conn?.close();
      conn = null;
      dbPromise = null;
      notifiers.clear();
    },
  };
}
