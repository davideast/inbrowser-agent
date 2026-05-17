# @inbrowser/resumable

`@inbrowser/resumable` is a generic engine for resumable streaming jobs. A
producer yields typed events, a `JobStore` appends those events to an ordered
log, and subscribers can tail the log again from a known offset after a
network drop, route handoff, or page reload.

The package has no LLM knowledge. LLM inference is one consumer through
`@inbrowser/relay`; the same engine can back any long-running job that reports
incremental events.

## What It Provides

- `createJobEngine`, which starts producers, appends their events, exposes
  snapshots, and returns a terminal marker when work finishes.
- A `JobStore<TEvent>` contract for durable backends.
- `createMemoryJobStore` for tests and local development.
- `createRtdbJobStore` for Firebase Realtime Database persistence through REST
  writes and RTDB SSE watches.
- Post-terminal TTL support through `ttlMs`, `expiresAt`, and `sweepExpired`.
- `@inbrowser/resumable/testing` probes for durability and TTL sweep behaviour.

## Quick Start

```ts
import { createJobEngine } from '@inbrowser/resumable';
import { createMemoryJobStore } from '@inbrowser/resumable/memory';

type ChunkEvent = { kind: 'chunk'; text: string };

const engine = createJobEngine<ChunkEvent>({
  store: createMemoryJobStore<ChunkEvent>(),
});

const { jobId } = await engine.start(async function* () {
  yield { kind: 'chunk', text: 'hello ' };
  yield { kind: 'chunk', text: 'world' };
});

for await (const item of engine.subscribe(jobId)) {
  if (item.kind === 'event') {
    console.log(item.seq, item.value);
  }
  if (item.kind === 'terminal') {
    console.log(item.status);
  }
}

await engine.stop();
```

Use `subscribe(jobId, { from })` to resume from an offset. Events before
`from` are skipped, so a client that has consumed events `0` and `1`
reconnects with `from: 2`.

## Durable Store

Use RTDB when the event log must survive process restart or a subscriber
reconnecting through another server instance:

```ts
import { createJobEngine } from '@inbrowser/resumable';
import {
  createRtdbJobStore,
  serviceAccountTokenProvider,
} from '@inbrowser/resumable/rtdb';

type ChunkEvent = { kind: 'chunk'; text: string };

const store = createRtdbJobStore<ChunkEvent>({
  url: process.env.RTDB_URL!,
  auth: serviceAccountTokenProvider({ keyFile: './service-account.json' }),
  rootPath: 'resumable_jobs',
  defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
});

const engine = createJobEngine<ChunkEvent>({
  store,
  sweep: { intervalMs: 60 * 60 * 1000 },
});
```

The durable store preserves the event log. It does not automatically restart a
producer if the process running that producer is killed.

For efficient RTDB sweeps, add an index on the store root path:

```json
{
  "rules": {
    "resumable_jobs": {
      ".indexOn": ["expiresAt"]
    }
  }
}
```

## Documentation

The documentation follows the Diataxis approach: each page serves one kind of
user need.

- [Tutorial: build a resumable stream](docs/tutorial.md) - learn by doing with
  the memory store.
- [How to use RTDB for durable jobs](docs/how-to-use-rtdb.md) - wire the
  production store, sweeps, and probes.
- [API reference](docs/reference.md) - facts about exports, types, stores, and
  probes.
- [How resumable jobs work](docs/how-it-works.md) - the design rationale and
  failure model.

## Package Exports

- `@inbrowser/resumable` - `createJobEngine` plus core types.
- `@inbrowser/resumable/memory` - in-process `JobStore`.
- `@inbrowser/resumable/rtdb` - Firebase RTDB `JobStore` and token providers.
- `@inbrowser/resumable/testing` - durability and TTL probe helpers.

## Relationship To `@inbrowser/relay`

`@inbrowser/relay` uses this package to keep an LLM generation running on the
server while browsers disconnect and reconnect. This package intentionally
stops below HTTP framework concerns and below any LLM provider protocol.
