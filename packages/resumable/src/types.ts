/**
 * Core types for @inbrowser/resumable.
 *
 * The shape is: a `Producer<TEvent>` yields events; the engine writes
 * them through a `JobStore<TEvent>` keyed by a monotonically increasing
 * `seq`; a `subscribe()` consumer tails the store via the engine and
 * receives `JobEvent<TEvent>` items it can resume from any `seq`.
 *
 * `TEvent` is whatever the producer yields — strings, JSON objects,
 * domain events. The engine and store never inspect it (except to
 * serialize for transit, which the store implementation owns).
 */

/**
 * Status of a job. A job is `running` from `create()` until `finish()`,
 * after which it holds one of the terminal statuses.
 */
export type JobStatus = 'running' | 'done' | 'error' | 'cancelled';

/** Terminal statuses — anything other than `running`. */
export type TerminalStatus = Exclude<JobStatus, 'running'>;

/**
 * Metadata supplied at `start()`/`create()` time.
 *
 * `data` is opaque to the engine — the LLM relay uses it for
 * `{ provider, model }`; an HTTP-job consumer might use it for the
 * original URL + headers. The store round-trips it on `snapshot()`.
 *
 * `ttlMs` is **post-mortem retention** — milliseconds after terminal
 * status to retain the job. A running job never expires. Omit for the
 * store's default policy. See `plans/job-ttl-store-contract.md`.
 */
export interface JobMeta {
  ttlMs?: number;
  data?: Record<string, unknown>;
}

/**
 * A consistent point-in-time view of a job. Returned by `store.snapshot()`
 * and yielded by `store.watch()`. `JobEngine.subscribe()` walks across
 * snapshots to produce a stream of `JobEvent`s.
 */
export interface JobSnapshot<TEvent> {
  id: string;
  status: JobStatus;
  /**
   * Reason for terminal status. `null` while running, on `done`, or
   * when no reason was supplied.
   */
  reason: string | null;
  /**
   * Ordered event buffer. A subscriber's `from` parameter indexes
   * into this — events at indexes `[0..from)` are skipped on resume.
   */
  events: TEvent[];
  /** Caller-supplied metadata from `JobMeta.data`, round-tripped. */
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** ms-since-epoch the job reached terminal status, or null while running. */
  finishedAt: number | null;
  /**
   * ms-since-epoch the job is eligible for cleanup, or null for no
   * expiry. Computed by the store as `finishedAt + (ttlMs ?? default)`.
   * Set at `finish()` time, not at `create()` — `expiresAt` is null
   * while running.
   */
  expiresAt: number | null;
}

/**
 * The event shape yielded by `JobEngine.subscribe()`. Resume offset
 * tracking: a subscriber that has seen up to seq N reconnects with
 * `from: N + 1`. The terminal marker is yielded exactly once when the
 * job reaches a non-`running` status.
 */
export type JobEvent<TEvent> =
  | { kind: 'event'; seq: number; value: TEvent }
  | { kind: 'terminal'; status: TerminalStatus; reason?: string };

/**
 * Context handed to a producer when the engine drives it. The `signal`
 * fires when the engine wants the producer to abandon work (job
 * cancelled, store finishing the job for any other reason).
 */
export interface ProducerCtx {
  jobId: string;
  signal: AbortSignal;
}

/**
 * A producer is an async generator of events. The engine drives it,
 * appending each yielded event to the store at a monotonically
 * increasing seq. A producer that throws → the engine writes
 * `finish(jobId, 'error', message)` and propagates nothing further.
 */
export type Producer<TEvent> = (ctx: ProducerCtx) => AsyncIterable<TEvent>;

/**
 * Minimal logger contract — exists so the engine can be silent by
 * default but emit structured events into a host's logger of choice.
 * The shape matches the common subset of bunyan / pino / Cloud
 * Logging without requiring any of them.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** No-op logger; default when none is supplied to `createJobEngine`. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
