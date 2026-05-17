# API Reference

This page describes the public surface of `@inbrowser/resumable`.

## Exports

| Import path | Exports |
| --- | --- |
| `@inbrowser/resumable` | `createJobEngine`, engine types, job types, `JobStore`, `silentLogger` |
| `@inbrowser/resumable/memory` | `createMemoryJobStore` |
| `@inbrowser/resumable/rtdb` | `createRtdbJobStore`, `staticTokenProvider`, `serviceAccountTokenProvider`, token provider types |
| `@inbrowser/resumable/testing` | `probeStoreDurability`, `probeSweepTtl`, probe result types |

## `createJobEngine`

```ts
function createJobEngine<TEvent>(
  opts: CreateJobEngineOpts<TEvent>,
): JobEngine<TEvent>;
```

`CreateJobEngineOpts<TEvent>`:

| Field | Type | Description |
| --- | --- | --- |
| `store` | `JobStore<TEvent>` | Required backing store. |
| `logger` | `Logger` | Optional structured logger. Defaults to a silent logger. |
| `sweep` | `SweepSchedule` | Optional periodic sweep. Requires `store.sweepExpired`. |
| `now` | `() => number` | Optional clock. Defaults to `Date.now`. |

`JobEngine<TEvent>`:

| Method | Description |
| --- | --- |
| `start(producer, meta?)` | Creates a job, drives the producer in the background, and returns `{ jobId }`. |
| `subscribe(jobId, opts?)` | Returns an async iterable of job events starting at `opts.from ?? 0`. |
| `get(jobId)` | Returns the current `JobSnapshot<TEvent>` or `null`. |
| `stop()` | Stops scheduled sweeps and waits for in-flight producers to settle. |

## Producer

```ts
type Producer<TEvent> = (ctx: ProducerCtx) => AsyncIterable<TEvent>;

interface ProducerCtx {
  jobId: string;
  signal: AbortSignal;
}
```

A producer yields the domain events for a job. If the producer throws, the
engine finishes the job with terminal status `error` and stores the thrown
message as the terminal reason.

## Subscription Events

```ts
type JobEvent<TEvent> =
  | { kind: 'event'; seq: number; value: TEvent }
  | { kind: 'terminal'; status: 'done' | 'error' | 'cancelled'; reason?: string };
```

The `from` option is the first sequence number to yield. Events before `from`
are skipped. The terminal marker is yielded once when the job status is no
longer `running`.

## Job Metadata And Snapshots

```ts
interface JobMeta {
  ttlMs?: number;
  data?: Record<string, unknown>;
}
```

`ttlMs` controls post-terminal retention. Running jobs do not expire.

```ts
interface JobSnapshot<TEvent> {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  reason: string | null;
  events: TEvent[];
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
}
```

## `JobStore<TEvent>`

```ts
interface JobStore<TEvent> {
  create(meta: JobMeta): Promise<{ jobId: string }>;
  append(jobId: string, seq: number, event: TEvent): Promise<void>;
  finish(
    jobId: string,
    status: 'done' | 'error' | 'cancelled',
    reason?: string,
  ): Promise<void>;
  snapshot(jobId: string): Promise<JobSnapshot<TEvent> | null>;
  watch(
    jobId: string,
    opts?: { from?: number; signal?: AbortSignal },
  ): AsyncIterable<JobSnapshot<TEvent>>;
  delete(jobId: string): Promise<void>;
  sweepExpired?(opts: SweepOpts): Promise<SweepResult>;
}
```

`watch()` yields at least one current snapshot when the job exists, then yields
again on subsequent mutations. It ends when the signal aborts, the job is
deleted, or the backing transport closes.

## Memory Store

```ts
function createMemoryJobStore<TEvent>(
  opts?: CreateMemoryJobStoreOpts,
): JobStore<TEvent>;
```

Options:

| Field | Description |
| --- | --- |
| `defaultTtlMs` | Default post-terminal TTL for jobs without `meta.ttlMs`. |
| `generateId` | Optional id generator. Defaults to `crypto.randomUUID()`. |
| `now` | Optional clock. Defaults to `Date.now`. |

The memory store is not durable across process restart. It implements
`sweepExpired`.

## RTDB Store

```ts
function createRtdbJobStore<TEvent>(
  opts: CreateRtdbJobStoreOpts,
): JobStore<TEvent>;
```

Options:

| Field | Description |
| --- | --- |
| `url` | RTDB base URL, for example `https://my-db.firebaseio.com`. |
| `auth` | `TokenProvider` used for REST and SSE requests. |
| `rootPath` | Job namespace. Defaults to `resumable_jobs`. |
| `defaultTtlMs` | Default post-terminal TTL. |
| `now` | Optional clock. Defaults to `Date.now`. |
| `generateId` | Optional id generator. Defaults to `crypto.randomUUID()`. |
| `onWarn` | Optional callback for non-fatal warnings. |

The RTDB layout under `{rootPath}/{jobId}` stores job metadata at the job root
and serialised events at `events/{seq}`. The store implements `sweepExpired`.

## Token Providers

```ts
interface TokenProvider {
  getToken(): Promise<string>;
}
```

`staticTokenProvider(token)` returns a fixed bearer token.

`serviceAccountTokenProvider(opts)` mints and caches OAuth access tokens from a
service account JSON file or parsed service account object.

## Sweep Types

```ts
interface SweepOpts {
  olderThan: number;
  statusFilter?: Array<'done' | 'error' | 'cancelled'>;
  batchSize?: number;
}

interface SweepResult {
  scanned: number;
  deleted: number;
  durationMs: number;
}
```

## Testing Utilities

`probeStoreDurability(opts)` runs a producer to terminal under one engine, then
subscribes from a new engine against the same underlying store data.

`probeSweepTtl(opts)` verifies that terminal jobs are swept after TTL and that
running jobs are not swept.
