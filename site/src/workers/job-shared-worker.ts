/// <reference lib="webworker" />
/**
 * Shared worker host for durable jobs — the desktop enhancement over the per-tab
 * dedicated worker (`job-worker.ts`). ONE `JobEngine` + IndexedDB store per
 * origin, fanned out to every connected tab over its `MessagePort`, so tabs
 * share a single live stream instead of each running their own engine.
 *
 * On Chrome, `extendedLifetime: true` (set by the client) keeps this worker
 * alive ~30s past the last tab unload, so a sole-tab reload doesn't drop an
 * in-flight job. Elsewhere it dies with the last connection and the durable
 * IndexedDB log is the recovery path (a fresh worker replays it).
 *
 * The client capability-gates between this and `job-worker.ts`; on a browser
 * with no SharedWorker (Android Chrome) it never loads.
 */
import { type PortLike, createIdbJobStore, hostJobEngine } from '@inbrowser/resumable';
import { type JobSpec, buildProducer } from '../lib/job-producer';

const host = hostJobEngine<string, JobSpec>({
  store: createIdbJobStore({ dbName: 'inbrowser-jobs', defaultTtlMs: 3_600_000 }),
  buildProducer,
});

// Each connecting tab hands us a MessagePort; attach the host's frame handler
// and start delivery. host.connect supports many ports (the fan-out).
(self as unknown as SharedWorkerGlobalScope).onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  host.connect(port as unknown as PortLike);
  port.start();
};
