/// <reference lib="webworker" />
/**
 * Per-tab durable-jobs worker. Hosts one resumable `JobEngine` backed by
 * IndexedDB off the main thread, so producing + persisting events never
 * freezes the UI and survives a reload (the IDB store replays on restart).
 * The main thread talks to it via `connectJobEngine` (see `../lib/durable-jobs.ts`).
 *
 * Mirrors `model-worker.ts`: the entry hosts the engine and connects `self`
 * (the `DedicatedWorkerGlobalScope`) as the single client port.
 */
import { type PortLike, createIdbJobStore, hostJobEngine } from '@inbrowser/resumable';
import { type JobSpec, buildProducer } from '../lib/job-producer';

hostJobEngine<string, JobSpec>({
  store: createIdbJobStore({ dbName: 'inbrowser-jobs', defaultTtlMs: 3_600_000 }),
  buildProducer,
}).connect(self as unknown as PortLike);
