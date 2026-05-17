/**
 * `createJobEngine` — composes a producer-driving `start()`, a tail-
 * with-resume `subscribe()`, and a snapshot `get()`. The engine is the
 * only thing that knows how to *drive* a producer; everything else
 * (HTTP binding, framework adapters, reconnecting client) goes through
 * this surface.
 *
 * The engine deliberately depends on nothing more than the JobStore
 * contract + the core types — same shape works against memory, RTDB,
 * or any future store.
 */
import type {
  JobEvent,
  JobMeta,
  JobSnapshot,
  JobStatus,
  Logger,
  Producer,
  TerminalStatus,
} from './types.js';
import { silentLogger } from './types.js';
import type { JobStore, SweepResult } from './store/contract.js';

export interface SubscribeOpts {
  /** Seq of the last event the consumer has already seen. The engine
   *  yields events at seq > `from`. Default 0 (start from the top). */
  from?: number;
  signal?: AbortSignal;
}

export interface JobEngine<TEvent> {
  start(producer: Producer<TEvent>, meta?: JobMeta): Promise<{ jobId: string }>;
  subscribe(jobId: string, opts?: SubscribeOpts): AsyncIterable<JobEvent<TEvent>>;
  get(jobId: string): Promise<JobSnapshot<TEvent> | null>;
  /** Stop background work (scheduled sweep). Safe to call multiple times. */
  stop(): Promise<void>;
}

export interface SweepSchedule {
  intervalMs: number;
  statusFilter?: TerminalStatus[];
  /** Optional callback for telemetry / debugging. Errors thrown
   *  here are swallowed — the scheduler logs and continues. */
  onResult?: (result: SweepResult) => void;
}

export interface CreateJobEngineOpts<TEvent> {
  store: JobStore<TEvent>;
  logger?: Logger;
  /**
   * Opt-in periodic sweep. Requires `store.sweepExpired` to be
   * defined; throws at construction otherwise so misconfiguration
   * is caught early. Stores with native backend TTL (Redis,
   * Firestore) shouldn't pass this — they handle expiry at the
   * backend.
   */
  sweep?: SweepSchedule;
  /** Inject a clock for tests. Default `Date.now`. */
  now?: () => number;
}

export function createJobEngine<TEvent>(
  opts: CreateJobEngineOpts<TEvent>,
): JobEngine<TEvent> {
  const { store, sweep } = opts;
  const logger = opts.logger ?? silentLogger;
  const now = opts.now ?? Date.now;

  if (sweep && !store.sweepExpired) {
    throw new Error(
      'createJobEngine: `sweep` config supplied but `store.sweepExpired` ' +
        'is not implemented. This store handles TTL natively; remove `sweep`.',
    );
  }

  // Track in-flight producer drives so `stop()` can wait them out.
  const producerPromises = new Set<Promise<void>>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  if (sweep) {
    sweepTimer = setInterval(() => {
      void runSweep().catch((e) => {
        logger.error('sweep failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }, sweep.intervalMs);
  }

  async function runSweep(): Promise<void> {
    if (!store.sweepExpired || !sweep) return;
    const result = await store.sweepExpired({
      olderThan: now(),
      ...(sweep.statusFilter ? { statusFilter: sweep.statusFilter } : {}),
    });
    logger.debug('sweep', result as unknown as Record<string, unknown>);
    if (sweep.onResult) {
      try {
        sweep.onResult(result);
      } catch (e) {
        logger.warn('sweep onResult threw', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  async function driveProducer(
    jobId: string,
    producer: Producer<TEvent>,
  ): Promise<void> {
    const ac = new AbortController();
    let seq = 0;
    try {
      for await (const event of producer({ jobId, signal: ac.signal })) {
        if (ac.signal.aborted) break;
        await store.append(jobId, seq++, event);
      }
      await store.finish(jobId, ac.signal.aborted ? 'cancelled' : 'done');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error('producer threw', { jobId, error: message });
      try {
        await store.finish(jobId, 'error', message);
      } catch (finishErr) {
        logger.error('finish-after-error also failed', {
          jobId,
          error:
            finishErr instanceof Error
              ? finishErr.message
              : String(finishErr),
        });
      }
    }
  }

  return {
    async start(
      producer: Producer<TEvent>,
      meta?: JobMeta,
    ): Promise<{ jobId: string }> {
      if (stopped) throw new Error('engine stopped');
      const { jobId } = await store.create(meta ?? {});
      logger.info('job started', { jobId });
      const p = driveProducer(jobId, producer).finally(() => {
        producerPromises.delete(p);
      });
      producerPromises.add(p);
      return { jobId };
    },

    async *subscribe(
      jobId: string,
      opts?: SubscribeOpts,
    ): AsyncIterable<JobEvent<TEvent>> {
      const from = opts?.from ?? 0;
      let nextSeq = from;
      let yieldedTerminal = false;
      for await (const snap of store.watch(jobId, opts)) {
        // Yield all events the consumer hasn't seen yet.
        while (nextSeq < snap.events.length) {
          yield {
            kind: 'event',
            seq: nextSeq,
            value: snap.events[nextSeq] as TEvent,
          };
          nextSeq++;
        }
        // Terminal status seals the stream — yield the marker once
        // and stop watching. Subsequent re-subscribes will see the
        // same snapshot via the same code path.
        if (snap.status !== 'running' && !yieldedTerminal) {
          yieldedTerminal = true;
          yield snap.reason
            ? { kind: 'terminal', status: snap.status, reason: snap.reason }
            : { kind: 'terminal', status: snap.status };
          return;
        }
      }
      // store.watch ended without yielding a terminal — the iterable
      // dropped (deletion, transport close). Caller decides whether
      // to reconnect.
    },

    async get(jobId: string): Promise<JobSnapshot<TEvent> | null> {
      return store.snapshot(jobId);
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      // Best-effort drain — let in-flight producers settle.
      await Promise.allSettled(producerPromises);
    },
  };
}

export type { JobStatus };
