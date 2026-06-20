/**
 * Client API for the per-tab durable-jobs worker (Phase 3 of the in-browser
 * resumable-streaming plan).
 *
 * One dedicated worker per tab hosts the resumable `JobEngine` over IndexedDB
 * (see `../workers/job-worker.ts`). This module is the main-thread face of it:
 * a lazy singleton `connectJobEngine` client plus `startJob` / `subscribeJob`
 * thin wrappers and a `runWithLeader` helper that uses `navigator.locks` to
 * elect a single driver across tabs sharing a job "key".
 *
 * The portable floor: every tab on the origin shares one IndexedDB database, so
 * a follower tab `subscribe`s the *same* jobId the leader started and the IDB
 * store's `BroadcastChannel` wakes its `watch` — both tabs render the same live
 * stream while exactly one tab drives the producer. (Android Chrome has
 * `navigator.locks` + dedicated Worker + IDB, so this works there with no
 * SharedWorker.)
 */
import {
  type ConnectedJobEngine,
  type JobEvent,
  type PortLike,
  connectJobEngine,
} from '@inbrowser/resumable';
import type { JobSpec } from './job-producer';

// Re-export so consumers of this module's API (e.g. the harness) get the event
// type from the same place as `subscribeJob` / `runWithLeader`.
export type { JobEvent };

// ── Lazy singleton worker + client ───────────────────────────────────────────
// Spawn the worker on first use (mirrors `loadOnDeviceEngine`'s spawn), then
// reuse the one client for the tab's lifetime.

let client: ConnectedJobEngine<string, JobSpec> | null = null;
let transport: 'shared' | 'dedicated' | null = null;

/** Which worker the client connected through ('shared' = cross-tab SharedWorker,
 *  'dedicated' = per-tab fallback). Null until the first job. For diagnostics. */
export function jobTransport(): 'shared' | 'dedicated' | null {
  return transport;
}

function jobClient(): ConnectedJobEngine<string, JobSpec> {
  if (client) return client;
  client = connectJobEngine<string, JobSpec>(spawnPort());
  return client;
}

/**
 * Prefer the cross-tab SharedWorker (one engine + IndexedDB store for the whole
 * origin; `extendedLifetime` on Chrome survives a sole-tab reload). Fall back to
 * a per-tab dedicated Worker where SharedWorker is unavailable (Android Chrome)
 * or blocked (some in-app WebViews) — same engine code, just one per tab,
 * coordinating across tabs through the shared IndexedDB log instead.
 */
function spawnPort(): PortLike {
  if (typeof SharedWorker !== 'undefined') {
    try {
      const sw = new SharedWorker(new URL('../workers/job-shared-worker.ts', import.meta.url), {
        name: 'inbrowser-jobs',
        type: 'module',
        extendedLifetime: true,
      } as WorkerOptions & { extendedLifetime?: boolean });
      sw.port.start();
      transport = 'shared';
      return sw.port as unknown as PortLike;
    } catch {
      // Construction can throw in restricted contexts; fall through to dedicated.
    }
  }
  const worker = new Worker(new URL('../workers/job-worker.ts', import.meta.url), {
    type: 'module',
  });
  transport = 'dedicated';
  return worker as unknown as PortLike;
}

/** Start a job in the worker from a serializable spec; resolves with its id. */
export async function startJob(spec: JobSpec): Promise<{ jobId: string }> {
  return jobClient().start(spec);
}

/**
 * Tail a job's event stream. Resumable: pass `from` to replay from a seq, and
 * abort `signal` (or break the for-await) to stop and free the host stream.
 */
export function subscribeJob(
  jobId: string,
  opts?: { from?: number; signal?: AbortSignal },
): AsyncIterable<JobEvent<string>> {
  return jobClient().subscribe(jobId, opts);
}

// ── Leader-election across tabs sharing a key ────────────────────────────────
// Tabs that want "the one job for key K" race a Web Lock. The winner starts the
// job and announces `key→jobId`; losers (and same-tab followers) resolve the
// jobId from that announce, then everyone subscribes to the same stream.

const KEYS_CHANNEL = 'inbrowser-jobkeys';
const LOCK_PREFIX = 'inbrowser-drive:';
/** How long a follower waits for the leader's announce before giving up. */
const ANNOUNCE_TIMEOUT_MS = 10_000;

/** Same-tab map of `key → jobId`, so a same-tab follower resolves without IPC. */
const localKeyJobs = new Map<string, string>();

interface KeyAnnounce {
  key: string;
  jobId: string;
}

/**
 * Run a keyed job under leader-election, feeding every event to `onEvent`.
 *
 * Control flow:
 *  - Request `navigator.locks` lock `inbrowser-drive:<key>` with
 *    `{ ifAvailable: true }`. The callback gets a truthy lock if granted, else
 *    `null` (the lock is held by another tab).
 *  - **Leader** (lock granted, or `navigator.locks` unavailable): `startJob`,
 *    publish `key→jobId` to the same-tab map AND a `BroadcastChannel` so
 *    followers resolve it, then `subscribe(jobId)` and hold the lock for the
 *    job's lifetime (the lock releases when this callback's promise settles).
 *  - **Follower** (lock null): resolve `key→jobId` — synchronously from the
 *    same-tab map if a leader in *this* tab already announced, else await the
 *    cross-tab `BroadcastChannel` announce (with a timeout) — then
 *    `subscribe(jobId)`.
 *
 * The returned promise resolves with the `jobId` as soon as it's known (leader:
 * right after `startJob`; follower: right after the announce resolves), not
 * when the stream ends — so callers learn the id without waiting on the job.
 * Subscription consumption continues in the background; pass `signal` to stop it
 * (and, for a follower, to abort a pending announce wait).
 */
export async function runWithLeader(
  key: string,
  spec: JobSpec,
  onEvent: (e: JobEvent<string>) => void,
  signal?: AbortSignal,
): Promise<string> {
  // No Web Locks (older browsers / non-secure context) → just lead. There's no
  // cross-tab coordination available, so every tab drives its own job.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    return lead(key, spec, onEvent, signal);
  }

  // The outer promise resolves with the jobId as soon as it's known; the lock
  // callback keeps running (holding the lock) until the job's stream ends.
  return new Promise<string>((resolveJobId, rejectJobId) => {
    let settled = false;
    const resolveOnce = (jobId: string) => {
      if (settled) return;
      settled = true;
      resolveJobId(jobId);
    };
    const rejectOnce = (err: unknown) => {
      if (settled) return;
      settled = true;
      rejectJobId(err instanceof Error ? err : new Error(String(err)));
    };

    locks
      .request(LOCK_PREFIX + key, { ifAvailable: true }, async (lock) => {
        if (lock) {
          // This tab won the lock → it's the leader. Hold the lock (by not
          // returning) until the job's stream is done.
          await lead(key, spec, onEvent, signal, resolveOnce);
        } else {
          // Another tab holds the lock → follow its job. We don't hold a lock
          // here, so resolve and stream right away.
          await follow(key, onEvent, signal, resolveOnce);
        }
      })
      .catch(rejectOnce);
  });
}

/**
 * Lead a key: start the job, announce `key→jobId` (same-tab map + channel),
 * then drain the subscription, feeding `onEvent`. `onJobId`, when given, is
 * called once with the jobId immediately after start (used by `runWithLeader`
 * to resolve its outer promise without waiting for the stream to end).
 */
async function lead(
  key: string,
  spec: JobSpec,
  onEvent: (e: JobEvent<string>) => void,
  signal: AbortSignal | undefined,
  onJobId?: (jobId: string) => void,
): Promise<string> {
  const { jobId } = await startJob(spec);
  announceKey(key, jobId);
  onJobId?.(jobId);
  await drain(jobId, onEvent, signal);
  return jobId;
}

/**
 * Follow a key: resolve its jobId (same-tab map, else await the cross-tab
 * announce with a timeout), then drain the subscription, feeding `onEvent`.
 */
async function follow(
  key: string,
  onEvent: (e: JobEvent<string>) => void,
  signal: AbortSignal | undefined,
  onJobId?: (jobId: string) => void,
): Promise<string> {
  const jobId = await resolveKeyJobId(key, signal);
  onJobId?.(jobId);
  await drain(jobId, onEvent, signal);
  return jobId;
}

/** Consume the job's stream, feeding each event to `onEvent`, until it ends. */
async function drain(
  jobId: string,
  onEvent: (e: JobEvent<string>) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  for await (const event of subscribeJob(jobId, signal ? { signal } : undefined)) {
    onEvent(event);
  }
}

/** Publish `key→jobId` to the same-tab map and the cross-tab channel. */
function announceKey(key: string, jobId: string): void {
  localKeyJobs.set(key, jobId);
  const channel = keysChannel();
  channel?.postMessage({ key, jobId } satisfies KeyAnnounce);
  // A fresh leader announce supersedes any prior one for the key; the channel
  // stays open for the tab's lifetime so late followers still hear new keys.
}

/**
 * Resolve a key's jobId. Fast path: a leader in *this* tab already recorded it
 * in the same-tab map. Slow path: wait for the next cross-tab announce for this
 * key on the `BroadcastChannel`, racing a timeout and the abort signal.
 */
function resolveKeyJobId(key: string, signal: AbortSignal | undefined): Promise<string> {
  const local = localKeyJobs.get(key);
  if (local) return Promise.resolve(local);

  return new Promise<string>((resolve, reject) => {
    const channel = keysChannel();
    if (!channel) {
      reject(new Error('no BroadcastChannel to resolve job key; cannot follow leader'));
      return;
    }

    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onMessage = (e: MessageEvent) => {
      const data = e.data as KeyAnnounce | null;
      if (data && data.key === key) finish(() => resolve(data.jobId));
    };
    const onAbort = () => finish(() => reject(new Error('aborted waiting for job key')));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`timed out resolving job key "${key}"`))),
      ANNOUNCE_TIMEOUT_MS,
    );

    // A same-tab leader might announce between the map check and listener setup;
    // re-check so we don't park on a key whose announce we just missed.
    const raced = localKeyJobs.get(key);
    if (raced) {
      finish(() => resolve(raced));
      return;
    }

    channel.addEventListener('message', onMessage);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// One channel per tab, opened lazily and kept for the tab's lifetime.
let keysChannelInstance: BroadcastChannel | null = null;
let keysChannelInit = false;
function keysChannel(): BroadcastChannel | null {
  if (keysChannelInit) return keysChannelInstance;
  keysChannelInit = true;
  keysChannelInstance =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(KEYS_CHANNEL) : null;
  // Mirror every cross-tab announce into the same-tab map so a later follower in
  // this tab takes the fast path instead of waiting on the channel again.
  keysChannelInstance?.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as KeyAnnounce | null;
    if (data && typeof data.key === 'string' && typeof data.jobId === 'string') {
      localKeyJobs.set(data.key, data.jobId);
    }
  });
  return keysChannelInstance;
}
