/**
 * The `JobStore` contract — the plug-in surface for any backing store.
 *
 * Two stores ship in this package: `createMemoryJobStore` (in-process,
 * zero-dep, the default for tests + local dev) and (Phase 2)
 * `createRtdbJobStore` (Firebase RTDB REST, the durable production
 * implementation). Third parties implement this contract against
 * Redis, Postgres, Firestore, etc.
 *
 * The shared conformance suite at `@inbrowser/resumable/testing` runs every
 * `JobStore` implementation through the same scenarios — passing the
 * suite *is* the correctness bar for a new store.
 */
import type { JobMeta, JobSnapshot, JobStatus, TerminalStatus } from '../types.js';

/**
 * Result of a sweep run. `scanned` is the number of candidate jobs the
 * store inspected; `deleted` is the subset that were eligible and
 * removed. `durationMs` is wall-clock for the whole call.
 */
export interface SweepResult {
  scanned: number;
  deleted: number;
  durationMs: number;
}

/** Options for a single sweep call. */
export interface SweepOpts {
  /** ms-since-epoch — jobs whose `expiresAt` is at-or-before this are eligible. */
  olderThan: number;
  /** Only sweep jobs in these statuses. Default: all terminal statuses. */
  statusFilter?: TerminalStatus[];
  /** Max jobs to delete in one call. Default is store-defined. */
  batchSize?: number;
}

export interface JobStore<TEvent> {
  /**
   * Allocate a new job. Returns the engine-side identifier. The store
   * is free to generate the id internally (memory store uses a counter;
   * RTDB store uses a uuid + RTDB push key).
   */
  create(meta: JobMeta): Promise<{ jobId: string }>;

  /**
   * Append an event at `seq` (0-based, monotonically increasing). The
   * caller (engine) owns the counter. Implementations must persist the
   * event such that a later `snapshot(jobId).events[seq]` returns it
   * intact — no coercion, no reshape, no drop.
   *
   * Behaviour for out-of-order seq is undefined. The engine never
   * appends out of order.
   */
  append(jobId: string, seq: number, event: TEvent): Promise<void>;

  /**
   * Mark the job terminal. After `finish()`:
   *   - `snapshot().status` reflects `status`
   *   - `snapshot().reason` reflects `reason ?? null`
   *   - `snapshot().finishedAt` is set
   *   - `snapshot().expiresAt` is set if a TTL applies
   * Calling `append` after `finish` is undefined behaviour.
   */
  finish(jobId: string, status: TerminalStatus, reason?: string): Promise<void>;

  /**
   * Read the current snapshot. `null` means the job doesn't exist
   * (never created, or already deleted/expired).
   */
  snapshot(jobId: string): Promise<JobSnapshot<TEvent> | null>;

  /**
   * Tail the job — yields a fresh snapshot whenever the job changes.
   * Implementations must yield at least once with the current state
   * even if the job doesn't change after the call begins (so callers
   * can synchronize), then yield again on every subsequent mutation.
   *
   * The iterable ends when:
   *   - `signal` aborts
   *   - the job is `delete()`d
   *   - the underlying transport closes (network drop, instance death)
   *
   * Reaching a terminal status does NOT end the iterable — the caller
   * (engine.subscribe) decides whether to keep tailing or close.
   *
   * `from` is an event seq the caller has already consumed; the store
   * MAY use it as an optimization hint (skip events before `from` in
   * the first yielded snapshot) but is not required to. The engine
   * dedupes on its own counter, so correctness doesn't depend on it.
   */
  watch(
    jobId: string,
    opts?: { from?: number; signal?: AbortSignal },
  ): AsyncIterable<JobSnapshot<TEvent>>;

  /**
   * Remove the job entirely. Idempotent — deleting a missing job is a
   * no-op, not an error. Any active `watch()` iterables for this job
   * end cleanly.
   */
  delete(jobId: string): Promise<void>;

  /**
   * Optional — stores with native backend TTL (Redis, Firestore) OMIT
   * this method and rely on the backend to delete expired jobs. Stores
   * without native TTL (memory, RTDB, Postgres) implement it.
   *
   * Implementations only delete jobs that are both:
   *   - in a terminal status (matching `statusFilter`)
   *   - have `expiresAt !== null && expiresAt <= opts.olderThan`
   *
   * Running jobs are never swept regardless of their `expiresAt`.
   *
   * See `plans/job-ttl-store-contract.md` for the full spec.
   */
  sweepExpired?(opts: SweepOpts): Promise<SweepResult>;
}

/** Re-exported for convenience. */
export type { JobMeta, JobSnapshot, JobStatus, TerminalStatus };
