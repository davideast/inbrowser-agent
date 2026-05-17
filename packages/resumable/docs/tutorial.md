# Tutorial: Build A Resumable Stream

This tutorial creates a small streaming job with the in-memory store. You will
start a producer, read its events to completion, and then replay the tail of
the log from an offset.

The memory store is used so the example has no external services.

## 1. Create The Engine

```ts
import { createJobEngine } from '@inbrowser/resumable';
import { createMemoryJobStore } from '@inbrowser/resumable/memory';

type ChunkEvent = { kind: 'chunk'; text: string };

const store = createMemoryJobStore<ChunkEvent>();
const engine = createJobEngine<ChunkEvent>({ store });
```

The engine is typed with the event shape your producer yields. The store never
interprets this event; it only preserves the value and its sequence number.

## 2. Start A Producer

```ts
const { jobId } = await engine.start(async function* () {
  yield { kind: 'chunk', text: 'hello ' };
  yield { kind: 'chunk', text: 'resumable ' };
  yield { kind: 'chunk', text: 'world' };
});
```

The producer runs server-side. Each yielded value is appended to the job log at
sequence numbers `0`, `1`, and `2`.

## 3. Read The Stream

```ts
for await (const item of engine.subscribe(jobId)) {
  if (item.kind === 'event') {
    console.log(`[${item.seq}] ${item.value.text}`);
  }

  if (item.kind === 'terminal') {
    console.log(`finished with ${item.status}`);
  }
}
```

You will see the three chunk events followed by one terminal item:

```text
[0] hello
[1] resumable
[2] world
finished with done
```

The terminal item is not stored as an event. It is derived from the job status
so subscribers know when the stream is sealed.

## 4. Replay From An Offset

Subscribe again with `from: 2`:

```ts
for await (const item of engine.subscribe(jobId, { from: 2 })) {
  console.log(item);
}
```

This skips events `0` and `1`, then yields event `2` and the terminal marker:

```text
{ kind: "event", seq: 2, value: { kind: "chunk", text: "world" } }
{ kind: "terminal", status: "done" }
```

A reconnecting client uses the same rule. If it has already consumed events
`0` and `1`, it reconnects with `from: 2`.

## 5. Stop The Engine

```ts
await engine.stop();
```

`stop()` clears scheduled sweeps and waits for in-flight producers to settle.

You now have the core shape: a producer writes ordered events, subscribers tail
the log, and a later subscriber can resume from the next event it needs.
