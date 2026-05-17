/**
 * In-memory `JobStore` — zero dependencies, the default for tests and
 * local development.
 *
 * Not durable across process restart. Use `createRtdbJobStore`
 * (Phase 2) for production.
 *
 * Implementation notes:
 *   - Each job carries a monotonic `revision` counter bumped on every
 *     mutation. `watch()` yields whenever revision moves past the
 *     consumer's last-seen value.
 *   - A small `Notifier` per job wakes pending `watch()` calls. The
 *     race between "check revision" and "register waiter" is closed
 *     by registering the waiter BEFORE the check — a notify that
 *     fires in the gap wakes our waiter; a notify that fired before
 *     we registered already bumped the revision we re-check.
 *   - TTL is opt-in: pass `defaultTtlMs` to the factory, or set
 *     `meta.ttlMs` per job. `sweepExpired` deletes terminal jobs
 *     whose `expiresAt <= olderThan`.
 */
import type {
  JobMeta,
  JobSnapshot,
  TerminalStatus,
} from '../types.js';
import type {
  JobStore,
  SweepOpts,
  SweepResult,
} from './contract.js';
import { defaultGenerateId, type IdGenerator } from '../ids.js';

interface MemoryJob<TEvent> {
  id: string;
  status: 'running' | TerminalStatus;
  reason: string | null;
  events: TEvent[];
  data: Record<string, unknown>;
  ttlMs?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
  revision: number;
  notifier: Notifier;
}

class Notifier {
  private waiters = new Set<() => void>();

  notify(): void {
    const fired = [...this.waiters];
    this.waiters.clear();
    for (const f of fired) f();
  }

  end(): void {
    // Same as notify() — used when the job is deleted so all watchers
    // wake and observe the missing job on their next iteration.
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

export interface CreateMemoryJobStoreOpts {
  /**
   * Default TTL in milliseconds applied to jobs whose `meta.ttlMs` is
   * unset. Omit for no default (jobs are retained until `delete()`
   * or `sweepExpired()` with a finite `olderThan`).
   */
  defaultTtlMs?: number;
  /**
   * Override the id generator. Default uses `crypto.randomUUID()`.
   * Test harnesses inject a deterministic counter here.
   */
  generateId?: IdGenerator;
  /** Inject a clock for tests. Default `Date.now`. */
  now?: () => number;
}

export function createMemoryJobStore<TEvent>(
  opts: CreateMemoryJobStoreOpts = {},
): JobStore<TEvent> {
  const jobs = new Map<string, MemoryJob<TEvent>>();
  const generateId = opts.generateId ?? defaultGenerateId;
  const now = opts.now ?? Date.now;
  const defaultTtlMs = opts.defaultTtlMs;

  function getOrThrow(jobId: string): MemoryJob<TEvent> {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    return job;
  }

  function snapshotOf(job: MemoryJob<TEvent>): JobSnapshot<TEvent> {
    return {
      id: job.id,
      status: job.status,
      reason: job.reason,
      // Defensive copy: consumers shouldn't be able to mutate the
      // store via the snapshot they received.
      events: [...job.events],
      data: { ...job.data },
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      expiresAt: job.expiresAt,
    };
  }

  function bump(job: MemoryJob<TEvent>): void {
    job.revision++;
    job.updatedAt = now();
    job.notifier.notify();
  }

  return {
    async create(meta: JobMeta): Promise<{ jobId: string }> {
      const id = generateId();
      const t = now();
      const job: MemoryJob<TEvent> = {
        id,
        status: 'running',
        reason: null,
        events: [],
        data: meta.data ? { ...meta.data } : {},
        ttlMs: meta.ttlMs ?? defaultTtlMs,
        createdAt: t,
        updatedAt: t,
        finishedAt: null,
        expiresAt: null,
        revision: 1,
        notifier: new Notifier(),
      };
      jobs.set(id, job);
      return { jobId: id };
    },

    async append(jobId: string, seq: number, event: TEvent): Promise<void> {
      const job = getOrThrow(jobId);
      // The engine drives seq monotonically from 0. Tolerate gaps by
      // extending the array; a gap would be a producer-side bug we
      // don't try to repair.
      job.events[seq] = event;
      bump(job);
    },

    async finish(
      jobId: string,
      status: TerminalStatus,
      reason?: string,
    ): Promise<void> {
      const job = getOrThrow(jobId);
      // Idempotent — a double-finish (e.g. producer throws AFTER
      // already finishing cleanly) keeps the first terminal state.
      if (job.status !== 'running') return;
      job.status = status;
      job.reason = reason ?? null;
      job.finishedAt = now();
      if (typeof job.ttlMs === 'number') {
        job.expiresAt = job.finishedAt + job.ttlMs;
      }
      bump(job);
    },

    async snapshot(jobId: string): Promise<JobSnapshot<TEvent> | null> {
      const job = jobs.get(jobId);
      return job ? snapshotOf(job) : null;
    },

    async *watch(
      jobId: string,
      opts?: { from?: number; signal?: AbortSignal },
    ): AsyncIterable<JobSnapshot<TEvent>> {
      let lastRevision = -1;
      const signal = opts?.signal;
      while (true) {
        if (signal?.aborted) return;
        const job = jobs.get(jobId);
        if (!job) return;

        // Register the waiter BEFORE the revision check so a notify
        // in the gap wakes us. If the revision has already moved,
        // we yield and continue without awaiting; the leftover
        // waiter resolves on the next notify and is GC'd.
        const waitP = job.notifier.wait(signal);

        if (job.revision > lastRevision) {
          lastRevision = job.revision;
          yield snapshotOf(job);
          // void-await the leftover waiter to keep the microtask
          // queue cleanly drained on terminal exits.
          void waitP;
          continue;
        }

        await waitP;
      }
    },

    async delete(jobId: string): Promise<void> {
      const job = jobs.get(jobId);
      if (!job) return;
      jobs.delete(jobId);
      job.notifier.end();
    },

    async sweepExpired(opts: SweepOpts): Promise<SweepResult> {
      const t0 = now();
      const filter = new Set<TerminalStatus>(
        opts.statusFilter ?? ['done', 'error', 'cancelled'],
      );
      const batchSize = opts.batchSize ?? 200;
      let scanned = 0;
      let deleted = 0;
      for (const [id, job] of jobs) {
        scanned++;
        if (job.status === 'running') continue;
        if (!filter.has(job.status)) continue;
        if (job.expiresAt === null || job.expiresAt > opts.olderThan) continue;
        jobs.delete(id);
        job.notifier.end();
        deleted++;
        if (deleted >= batchSize) break;
      }
      return { scanned, deleted, durationMs: now() - t0 };
    },
  };
}
