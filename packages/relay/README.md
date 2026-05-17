# @inbrowser/relay

`@inbrowser/relay` is a resumable LLM inference relay. It wraps
`@inbrowser/resumable` with LLM-specific request and event types, provider
plug-ins, Web-standard request handlers, framework adapters, and a
reconnecting browser-safe client.

The relay's primary value is resumability. A backgrounded browser tab, network
drop, or stream handler handoff does not have to lose the events already
produced by an in-flight generation. The provider runs server-side, writes
`InferenceEvent`s to a durable event log, and clients reconnect from their last
received offset.

## What It Provides

- `createRelay`, which exposes `handleStart(request)` and
  `handleStream(request, ctx)` as Web `Request` to `Response` handlers.
- A provider plug-in contract: `InferenceProvider` is an async iterable of
  `InferenceEvent`s.
- Built-in providers for Gemini, OpenRouter, and Anthropic native Messages.
- SSE helpers shared by providers, the relay, and the reconnecting client.
- Astro and Express adapters.
- `createResumableClient`, which starts a job, tails the SSE stream, and
  reconnects with `from=<offset>` when a stream drops.

## Quick Start

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

const relay = createRelay({
  store: createRtdbJobStore<InferenceEvent>({
    url: process.env.RTDB_URL!,
    auth: serviceAccountTokenProvider({ keyFile: './sa.json' }),
    rootPath: 'inference_jobs',
    defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
  }),
  providers: {
    gemini: geminiProvider,
    openrouter: openrouterProvider,
  },
});

// POST an inference request and allocate a job:
// await relay.handleStart(request)

// Stream the durable event log as SSE:
// await relay.handleStream(request, { jobId, from })
```

The relay preserves and replays the event log. It does not automatically
restart an upstream provider call if the process running that provider is
killed.

The relay does not choose URL paths for you. Common route shapes are:

- `POST /api/inference/job` - call `relay.handleStart(request)`.
- `GET /api/inference/job/:id/stream?from=N` - call
  `relay.handleStream(request, { jobId: id })`.

## Client

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
});

for await (const event of client.stream({
  provider: 'gemini',
  model: 'gemini-3-flash-preview',
  messages: [{ role: 'user', text: 'Hello' }],
  tools: [],
  apiKey: userApiKey,
})) {
  // Render text, thinking, tool calls, usage, or errors.
}
```

## Framework Adapters

- Hono, Bun, and Cloudflare Workers can call the Web-standard relay handlers
  directly.
- Astro uses `createAstroRoutes(relay)` from
  `@inbrowser/relay/adapters/astro`.
- Express and Cloud Functions Gen 2 use `createExpressHandlers(relay)` from
  `@inbrowser/relay/adapters/express`.

## Documentation

The documentation follows the Diataxis approach: each page serves one kind of
user need.

- [Tutorial: create a relay with a fake provider](docs/tutorial.md) - learn
  the relay flow without real API keys.
- [How to wire a web app](docs/how-to-wire-a-web-app.md) - connect server
  routes and the reconnecting client.
- [How to write a provider](docs/how-to-write-a-provider.md) - add another
  upstream LLM without changing the relay.
- [API reference](docs/reference.md) - facts about exports, types, handlers,
  adapters, providers, and SSE.
- [How the relay works](docs/how-it-works.md) - the design rationale and
  reconnection model.

## Package Exports

- `@inbrowser/relay` - relay factory, public types, and built-in providers.
- `@inbrowser/relay/sse` - SSE reader and encoder helpers.
- `@inbrowser/relay/adapters/astro` - Astro route adapter.
- `@inbrowser/relay/adapters/express` - Express-compatible adapter.
- `@inbrowser/relay/client` - reconnecting client and browser lifecycle helper.
