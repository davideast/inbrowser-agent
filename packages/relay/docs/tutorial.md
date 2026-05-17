# Tutorial: Create A Relay With A Fake Provider

This tutorial creates a relay that streams fake inference events through the
same start and SSE flow used by real providers. No API keys or external
services are required.

## 1. Create The Relay

```ts
import { createMemoryJobStore } from '@inbrowser/resumable/memory';
import {
  createRelay,
  type InferenceEvent,
  type InferenceProvider,
} from '@inbrowser/relay';

const fakeProvider: InferenceProvider = async function* (req) {
  yield { kind: 'text', chunk: `hello from ${req.provider}/${req.model}` };
  yield { kind: 'thinking', chunk: 'checking the durable log' };
  yield {
    kind: 'usage',
    promptTokens: 4,
    outputTokens: 8,
  };
};

const relay = createRelay({
  store: createMemoryJobStore<InferenceEvent>(),
  providers: {
    fake: fakeProvider,
  },
});
```

The provider is an async iterable. The relay will run it under a resumable job
engine and store every yielded event.

## 2. Start A Job

```ts
const startResponse = await relay.handleStart(
  new Request('http://localhost/api/inference/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'fake',
      model: 'demo-model',
      messages: [{ role: 'user', text: 'Say hello' }],
      tools: [],
      apiKey: 'demo-key',
    }),
  }),
);

const { jobId } = (await startResponse.json()) as { jobId: string };
console.log(jobId);
```

The response status is `201`. The returned `jobId` identifies the durable event
log for this generation.

## 3. Stream The Job

```ts
const streamResponse = await relay.handleStream(
  new Request(`http://localhost/api/inference/job/${jobId}/stream`),
  { jobId },
);

console.log(await streamResponse.text());
```

The stream is SSE text:

```text
: stream-open

data: {"kind":"text","chunk":"hello from fake/demo-model"}

data: {"kind":"thinking","chunk":"checking the durable log"}

data: {"kind":"usage","promptTokens":4,"outputTokens":8}

data: [DONE]
```

`[DONE]` appears only when the job reaches terminal state.

## 4. Resume From An Offset

Stream again from event `2`:

```ts
const resumed = await relay.handleStream(
  new Request(`http://localhost/api/inference/job/${jobId}/stream?from=2`),
  { jobId },
);

console.log(await resumed.text());
```

The relay skips events `0` and `1`, then returns the usage event and `[DONE]`.
That is the same replay rule used by `createResumableClient` when a browser
connection drops.

## 5. Stop The Relay

```ts
await relay.stop();
```

You now have the full relay shape: start a job, stream the event log, and
resume from the next event the client needs.
