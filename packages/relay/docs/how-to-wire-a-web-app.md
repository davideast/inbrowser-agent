# How To Wire A Web App

This guide shows how to expose a relay from server routes and consume it with
the reconnecting client.

## Build A Shared Relay

Create one relay instance for the process:

```ts
import {
  createRelay,
  geminiProvider,
  openrouterProvider,
  type InferenceEvent,
} from '@inbrowser/relay';
import {
  createRtdbJobStore,
  serviceAccountTokenProvider,
} from '@inbrowser/resumable/rtdb';

export const relay = createRelay({
  store: createRtdbJobStore<InferenceEvent>({
    url: process.env.RTDB_URL!,
    auth: serviceAccountTokenProvider({
      keyFile: process.env.SERVICE_ACCOUNT_FILE!,
    }),
    rootPath: 'inference_jobs',
    defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
  }),
  providers: {
    gemini: geminiProvider,
    openrouter: openrouterProvider,
  },
  sweep: {
    intervalMs: 60 * 60 * 1000,
  },
});
```

Use a durable store in production. The memory store is useful for tests and
local demos, but it cannot survive process restart.

## Wire Web-Standard Runtimes Directly

For runtimes that already use Web `Request` and `Response`, call the relay
handlers directly:

```ts
export async function POST(request: Request): Promise<Response> {
  return relay.handleStart(request);
}

export async function GET(
  request: Request,
  params: { id: string },
): Promise<Response> {
  return relay.handleStream(request, { jobId: params.id });
}
```

The route shape is up to the host. The client helpers assume this common
shape:

- `POST /api/inference/job`
- `GET /api/inference/job/:id/stream?from=N`

## Wire Astro

```ts
import { createAstroRoutes } from '@inbrowser/relay/adapters/astro';
import { relay } from './relay';

export const { start, stream } = createAstroRoutes(relay);
```

Then re-export the routes:

```ts
// src/pages/api/inference/job.ts
export { start as POST } from '~/server/relay';

// src/pages/api/inference/job/[id]/stream.ts
export { stream as GET } from '~/server/relay';
```

## Wire Express Or Cloud Functions

```ts
import express from 'express';
import { createExpressHandlers } from '@inbrowser/relay/adapters/express';
import { relay } from './relay';

const app = express();
const { start, stream } = createExpressHandlers(relay, {
  cors: true,
});

app.use(express.json());
app.post('/api/inference/job', start);
app.get('/api/inference/job/:id/stream', stream);
```

Use `cors: true` when the browser calls a different origin directly, such as a
raw Cloud Run or Cloud Functions URL.

## Consume From The Browser

```ts
import {
  createResumableClient,
  installBrowserLifecycle,
} from '@inbrowser/relay/client';

const client = createResumableClient({
  startUrl: '/api/inference/job',
  streamUrl: (jobId, from) =>
    `/api/inference/job/${encodeURIComponent(jobId)}/stream?from=${from}`,
  installLifecycle: installBrowserLifecycle(),
  onReconnect: (info) => {
    console.debug('relay reconnect', info);
  },
});

for await (const event of client.stream({
  provider: 'gemini',
  model: 'gemini-3-flash-preview',
  messages: [{ role: 'user', text: 'Plan my next step' }],
  tools: [],
  apiKey: userApiKey,
})) {
  if (event.kind === 'text') {
    appendText(event.chunk);
  }
}
```

`installBrowserLifecycle()` is optional but useful in browsers. When a tab
returns to the foreground, it aborts the current connection so the client
reconnects immediately instead of waiting for a stale socket to time out.

## Handle Stream Buffering

SSE must reach the browser as a live stream. If a proxy buffers the response,
the relay can still run the job, but the user will not see incremental output.

For Firebase Hosting plus Cloud Run or Cloud Functions, prefer calling the raw
function URL from the browser and enabling CORS on the Express adapter. Hosting
rewrites may buffer SSE end to end.

## Shut Down Cleanly

Call `relay.stop()` during graceful shutdown:

```ts
process.on('SIGTERM', () => {
  void relay.stop().finally(() => process.exit(0));
});
```

This stops scheduled sweeps and waits for in-flight producers to settle.
